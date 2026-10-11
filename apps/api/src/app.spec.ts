/**
 * Boots the real AppModule (guards, pipes, filter, helmet, CORS, Swagger) with Prisma mocked,
 * so the HTTP pipeline is tested without Docker. Database flows are in test/int.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  JWT_ACCESS_SECRET: 'test-secret-'.padEnd(48, 'x'),
  NATIONAL_ID_ENC_KEY: randomBytes(32).toString('base64'),
  NATIONAL_ID_HMAC_KEY: randomBytes(32).toString('base64'),
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'nuzli-test',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  MAIL_TRANSPORT: 'noop',
  CORS_ORIGINS: 'https://app.example.sa',
  SWAGGER_ENABLED: 'false',
});

type Role = 'ADMIN' | 'SUPERVISOR' | 'MONITOR';

describe('HTTP pipeline (AppModule, mocked Prisma)', () => {
  let app: INestApplication;
  let tokenFor: (id: string, role: Role) => string;
  const users = new Map<string, { id: string; role: Role; status: string; fullName: string; mustChangePassword: boolean }>();

  const prismaMock = {
    ping: jest.fn().mockResolvedValue(true),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    user: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(users.get(where.id) ?? null)) },
    setting: { findMany: jest.fn().mockResolvedValue([]) },
  };

  beforeAll(async () => {
    const { AppModule } = await import('./app.module');
    const { PrismaService } = await import('./prisma/prisma.service');
    const { StorageService } = await import('./storage/storage.service');
    const { AccessTokenService } = await import('./auth/access-token.service');
    const { configureApp } = await import('./main');
    const { AppConfig } = await import('./config/app-config');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(StorageService)
      .useValue({ ping: jest.fn().mockResolvedValue(false), bucket: 'nuzli-test' })
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(nest, nest.get(AppConfig));
    await nest.init();
    app = nest;

    const access = nest.get(AccessTokenService);
    tokenFor = (id, role) => {
      users.set(id, { id, role, status: 'ACTIVE', fullName: 'x', mustChangePassword: false });
      return access.sign({ id, role });
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health is public and carries a request id and security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('reuses a sane incoming X-Request-Id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').set('X-Request-Id', 'abc-123-xyz');
    expect(res.headers['x-request-id']).toBe('abc-123-xyz');
  });

  it('GET /ready reports 503 when storage is unreachable', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    expect(res.body.checks).toEqual({ db: true, storage: false });
  });

  it('rejects anonymous calls with the Arabic error shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.body).toEqual({ code: 'UNAUTHENTICATED', message_ar: expect.stringMatching(/[؀-ۿ]/) });
  });

  it('validates bodies with the shared zod schemas → details.fieldErrors', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: 'a' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.details.fieldErrors)).toEqual(expect.arrayContaining(['identifier', 'password']));
  });

  it('malformed JSON is a validation error, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"identifier":')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('refresh without the CSRF header is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'nz_rt=abc; nz_csrf=def')
      .expect(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('enforces permissions from the shared matrix', async () => {
    const monitor = tokenFor('7f000000-0000-4000-8000-000000000001', 'MONITOR');
    const res = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${monitor}`)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('settings are readable by any active user', async () => {
    const sup = tokenFor('7f000000-0000-4000-8000-000000000002', 'SUPERVISOR');
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${sup}`)
      .expect(200);
    expect(res.body.REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS).toBe(true);
    expect(res.body.PRESIGNED_URL_TTL_SECONDS).toBe(300);
  });

  it('non-UUID ids are 404 without touching the database', async () => {
    const admin = tokenFor('7f000000-0000-4000-8000-000000000003', 'ADMIN');
    const res = await request(app.getHttpServer())
      .get('/api/v1/users/not-a-uuid')
      .set('Authorization', `Bearer ${admin}`)
      .expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('CORS allows only configured origins', async () => {
    const ok = await request(app.getHttpServer()).options('/api/v1/health').set('Origin', 'https://app.example.sa').set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.sa');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app.getHttpServer()).options('/api/v1/health').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Phase 2: moving members is ADMIN-only (guard), PDF export is 501 until configured', async () => {
    const sup = tokenFor('00000000-0000-4000-8000-0000000000a1', 'SUPERVISOR');
    const move = await request(app.getHttpServer())
      .post('/api/v1/members/move')
      .set('Authorization', `Bearer ${sup}`)
      .send({ memberIds: ['00000000-0000-4000-8000-0000000000b1'], toTeamId: '00000000-0000-4000-8000-0000000000c1' })
      .expect(403);
    expect(move.body.code).toBe('FORBIDDEN');

    const admin = tokenFor('00000000-0000-4000-8000-0000000000a2', 'ADMIN');
    const pdf = await request(app.getHttpServer())
      .get('/api/v1/cards/batches/00000000-0000-4000-8000-0000000000d1/pdf')
      .set('Authorization', `Bearer ${admin}`)
      .expect(501);
    expect(pdf.body).toMatchObject({ code: 'PDF_NOT_CONFIGURED', message_ar: expect.stringContaining('PDF') });
  });

  it('generates an OpenAPI document from the zod schemas', () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('t').build());
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/auth/login', '/api/v1/users', '/api/v1/registrations/{id}/approve', '/api/v1/files/presign']),
    );
    // Phase 2 routes are documented from the same schemas.
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/colors/available', '/api/v1/teams', '/api/v1/teams/{id}/members', '/api/v1/members/move', '/api/v1/members/import', '/api/v1/reference/{kind}', '/api/v1/cards/preview', '/api/v1/cards/batches/{id}/pdf', '/api/v1/logos']),
    );
    const login = doc.paths['/api/v1/auth/login']?.post?.requestBody as { content: Record<string, { schema: { required?: string[] } }> };
    expect(login.content['application/json']?.schema.required).toEqual(['identifier', 'password']);
  });
});
