/**
 * A12: the real AppModule (guards, pipes, services, Prisma with the workspace scoping layer) on a
 * PGlite database with the full migration chain. Only the edges are replaced: the S3 bucket is an
 * in-memory map, mail is a no-op, OCR is off.
 *
 * `rls: true`  — the session runs as nuzli_app: PostgreSQL Row Level Security is enforced.
 * `rls: false` — the session stays superuser: RLS is bypassed, so only the APPLICATION scoping
 *                layer stands between the workspaces (proves it is sufficient on its own).
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { nationalIdCheckDigit } from '@nuzli/shared';
import type { PGlite } from './pglite';
import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { asAppRole, migratedDb, pgliteAdapter } from './pglite';

export function validNationalId(first9: string): string {
  return first9 + nationalIdCheckDigit(first9);
}

export const OWNER = {
  email: 'owner@nuzli.test',
  username: 'mmansary',
  password: 'Bootstrap123',
  newPassword: 'OwnerPass456',
  name: 'المالك',
  mobile: '0500000001',
  nationalId: validNationalId('100000001'),
};

function ensureEnv(): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://pglite:pglite@localhost:5432/pglite',
    MAIL_TRANSPORT: 'noop',
    COOKIE_SECURE: 'false',
    THROTTLE_AUTH_LIMIT: '100000',
    THROTTLE_DEFAULT_LIMIT: '100000',
    SWAGGER_ENABLED: 'false',
    OCR_ENABLED: 'false',
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_BUCKET: 'nuzli-test',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
    BOOTSTRAP_ADMIN_EMAIL: OWNER.email,
    BOOTSTRAP_ADMIN_PASSWORD: OWNER.password,
    BOOTSTRAP_ADMIN_NAME: OWNER.name,
    BOOTSTRAP_ADMIN_MOBILE: OWNER.mobile,
    BOOTSTRAP_ADMIN_NATIONAL_ID: OWNER.nationalId,
    BOOTSTRAP_OWNER_USERNAME: OWNER.username,
  });
  process.env.JWT_ACCESS_SECRET ??= randomBytes(32).toString('hex');
  process.env.NATIONAL_ID_ENC_KEY ??= randomBytes(32).toString('base64');
  process.env.NATIONAL_ID_HMAC_KEY ??= randomBytes(32).toString('base64');
}

/** The bucket as a Map: presigned PUTs are simulated by `put`. */
export class MemoryStorage {
  readonly bucket = 'nuzli-test';
  readonly objects = new Map<string, Buffer>();
  put(key: string, bytes: Buffer): void {
    this.objects.set(key, bytes);
  }
  async presignPut(key: string): Promise<string> {
    return `memory://put/${key}`;
  }
  async presignGet(key: string): Promise<string> {
    return `memory://get/${key}`;
  }
  async head(key: string): Promise<{ exists: boolean; size: number; contentType?: string }> {
    const o = this.objects.get(key);
    return o ? { exists: true, size: o.length } : { exists: false, size: 0 };
  }
  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    return (this.objects.get(key) ?? Buffer.alloc(0)).subarray(start, end + 1);
  }
  async readAll(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return o;
  }
  async copy(from: string, to: string): Promise<void> {
    const o = this.objects.get(from);
    if (!o) throw new Error('NoSuchKey');
    this.objects.set(to, Buffer.from(o));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async ping(): Promise<boolean> {
    return true;
  }
  onModuleDestroy(): void {}
}

export interface PgApp {
  app: INestApplication;
  db: PGlite;
  /** The scoped PrismaService of the app (needs a workspace context for business tables). */
  prisma: PrismaClient;
  storage: MemoryStorage;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startPgApp(opts: { rls: boolean }): Promise<PgApp> {
  ensureEnv();
  const db = await migratedDb();
  if (opts.rls) await asAppRole(db);

  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/main');
  const { AppConfig } = await import('../../src/config/app-config');
  const { PrismaService, PRISMA_CLIENT_OPTIONS } = await import('../../src/prisma/prisma.service');
  const { StorageService } = await import('../../src/storage/storage.service');
  const { runSeed } = await import('../../src/seed/seed');

  const storage = new MemoryStorage();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PRISMA_CLIENT_OPTIONS)
    .useValue({ adapter: pgliteAdapter(db) })
    .overrideProvider(StorageService)
    .useValue(storage)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: process.env.NUZLI_TEST_LOG ? ['error', 'warn'] : false });
  configureApp(app, app.get(AppConfig));
  await app.init();
  const prisma = app.get(PrismaService) as unknown as PrismaClient;
  await runSeed(prisma, process.env as never, () => undefined);
  return {
    app,
    db,
    prisma,
    storage,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export interface Session {
  accessToken: string;
  cookie: string;
  csrf: string;
  body: Record<string, unknown>;
}

export function cookiesFrom(res: request.Response): { cookie: string; csrf: string } {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const pairs = (raw ?? []).map((c) => c.split(';')[0] ?? '').filter((p) => p && !p.endsWith('='));
  const csrf = pairs.find((p) => p.startsWith('nz_csrf='))?.slice('nz_csrf='.length) ?? '';
  return { cookie: pairs.join('; '), csrf };
}

export async function login(ctx: PgApp, identifier: string, password: string): Promise<Session> {
  const res = await ctx.http().post('/api/v1/auth/login').send({ identifier, password });
  if (res.status !== 200) throw new Error(`login ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessToken: res.body.accessToken, ...cookiesFrom(res), body: res.body };
}

export const bearer = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });

/** The bootstrap owner logs in with the username and performs the forced password change. */
export async function ownerSession(ctx: PgApp): Promise<Session> {
  const first = await login(ctx, OWNER.username, OWNER.password);
  const res = await ctx
    .http()
    .post('/api/v1/auth/change-password')
    .set(bearer(first))
    .send({ currentPassword: OWNER.password, newPassword: OWNER.newPassword });
  if (res.status !== 200) throw new Error(`change-password: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessToken: res.body.accessToken, ...cookiesFrom(res), body: res.body };
}
