import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { nationalIdCheckDigit } from '@nuzli/shared';
import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

/** Suites use `describeInt` so they are skipped (not failed) when Docker is missing. */
export const describeInt: jest.Describe =
  process.env.NUZLI_INT_SKIP === '1' || !process.env.DATABASE_URL ? describe.skip : describe;

export const BOOTSTRAP = {
  email: 'admin@nuzli.test',
  password: 'Bootstrap123',
  name: 'مدير التأسيس',
  mobile: '0500000001',
  nationalId: validNationalId('100000001'),
};

export function validNationalId(first9: string): string {
  return first9 + nationalIdCheckDigit(first9);
}

function ensureEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL ??= 'silent';
  process.env.MAIL_TRANSPORT = 'noop';
  process.env.COOKIE_SECURE = 'false';
  process.env.THROTTLE_AUTH_LIMIT = '1000';
  process.env.SWAGGER_ENABLED = 'false';
  // A9: the OCR engine is exercised by the unit smoke test; integration runs keep jobs PENDING.
  process.env.OCR_ENABLED ??= 'false';
  process.env.JWT_ACCESS_SECRET ??= randomBytes(32).toString('hex');
  process.env.NATIONAL_ID_ENC_KEY ??= randomBytes(32).toString('base64');
  process.env.NATIONAL_ID_HMAC_KEY ??= randomBytes(32).toString('base64');
  Object.assign(process.env, {
    BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP.email,
    BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP.password,
    BOOTSTRAP_ADMIN_NAME: BOOTSTRAP.name,
    BOOTSTRAP_ADMIN_MOBILE: BOOTSTRAP.mobile,
    BOOTSTRAP_ADMIN_NATIONAL_ID: BOOTSTRAP.nationalId,
  });
}

export interface IntApp {
  app: INestApplication;
  prisma: PrismaClient;
  sentMail: Array<{ to: string; subject: string; text: string }>;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** Fresh database (all rows removed) + system seed + the real AppModule. */
export async function startApp(): Promise<IntApp> {
  ensureEnv();
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/main');
  const { AppConfig } = await import('../../src/config/app-config');
  const { PrismaService } = await import('../../src/prisma/prisma.service');
  const { MailService } = await import('../../src/notifications/mail.service');
  const { runSeed } = await import('../../src/seed/seed');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, app.get(AppConfig));
  await app.init();

  const prisma = app.get(PrismaService);
  await resetDatabase(prisma);
  await runSeed(prisma, process.env as never, () => undefined);

  return {
    app,
    prisma,
    sentMail: app.get(MailService).sent,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  // TRUNCATE does not fire the append-only row trigger on audit_log.
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export interface Session {
  accessToken: string;
  cookie: string;
  csrf: string;
  body: Record<string, unknown>;
}

/** Turns Set-Cookie headers into a Cookie header + the CSRF value. */
export function cookiesFrom(res: request.Response): { cookie: string; csrf: string } {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const pairs = (raw ?? []).map((c) => c.split(';')[0] ?? '').filter((p) => p && !p.endsWith('='));
  const csrf = pairs.find((p) => p.startsWith('nz_csrf='))?.slice('nz_csrf='.length) ?? '';
  return { cookie: pairs.join('; '), csrf };
}

export async function login(ctx: IntApp, identifier: string, password: string): Promise<Session> {
  const res = await ctx.http().post('/api/v1/auth/login').send({ identifier, password }).expect(200);
  return { accessToken: res.body.accessToken, ...cookiesFrom(res), body: res.body };
}

/** Logs the bootstrap admin in and performs the forced first password change. */
export async function bootstrapAdminSession(ctx: IntApp, newPassword = 'AdminPass456'): Promise<Session> {
  const first = await login(ctx, BOOTSTRAP.email, BOOTSTRAP.password);
  const res = await ctx
    .http()
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${first.accessToken}`)
    .send({ currentPassword: BOOTSTRAP.password, newPassword })
    .expect(200);
  return { accessToken: res.body.accessToken, ...cookiesFrom(res), body: res.body };
}

export const bearer = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });

/** Extracts the one-time token from the last e-mail sent to `to`. */
export function tokenFromMail(ctx: IntApp, to: string): string {
  const mail = [...ctx.sentMail].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([A-Za-z0-9_%-]+)/);
  if (!match?.[1]) throw new Error(`No token e-mail for ${to}`);
  return decodeURIComponent(match[1]);
}
