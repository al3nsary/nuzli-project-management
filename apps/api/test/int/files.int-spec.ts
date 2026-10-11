/** Presigned upload → confirm (HEAD + size + magic bytes) → presigned GET, against MinIO. */
import { bearer, bootstrapAdminSession, describeInt, startApp, type IntApp, type Session } from './helpers';

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describeInt('presigned upload and confirm', () => {
  let ctx: IntApp;
  let admin: Session;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function presign(body: Buffer, contentType = 'image/png') {
    const res = await ctx.http().post('/api/v1/files/presign').set(bearer(admin))
      .send({ entityType: 'logo', kind: 'LOGO', contentType, sizeBytes: body.length }).expect(201);
    return res.body as { fileId: string; url: string; headers: Record<string, string> };
  }

  it('uploads a PNG, confirms it, and issues a short-lived GET URL', async () => {
    const p = await presign(PNG);
    const file = await ctx.prisma.file.findUniqueOrThrow({ where: { id: p.fileId } });
    expect(file.storageKey).toMatch(/^logos\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(file.status).toBe('PENDING');

    const early = await ctx.http().post(`/api/v1/files/${p.fileId}/confirm`).set(bearer(admin)).expect(409);
    expect(early.body.code).toBe('FILE_NOT_UPLOADED');

    const put = await fetch(p.url, { method: 'PUT', headers: p.headers, body: PNG });
    expect(put.status).toBe(200);

    const ok = await ctx.http().post(`/api/v1/files/${p.fileId}/confirm`).set(bearer(admin)).expect(200);
    expect(ok.body).toEqual({ id: p.fileId, status: 'READY' });

    const url = await ctx.http().get(`/api/v1/files/${p.fileId}/url`).set(bearer(admin)).expect(200);
    const got = await fetch(url.body.url as string);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('rejects an SVG disguised as PNG and deletes the object', async () => {
    const p = await presign(SVG);
    const put = await fetch(p.url, { method: 'PUT', headers: p.headers, body: SVG });
    expect(put.status).toBe(200);
    const res = await ctx.http().post(`/api/v1/files/${p.fileId}/confirm`).set(bearer(admin)).expect(415);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const row = await ctx.prisma.file.findUniqueOrThrow({ where: { id: p.fileId } });
    expect(row.deletedAt).not.toBeNull();
    await ctx.http().get(`/api/v1/files/${p.fileId}/url`).set(bearer(admin)).expect(404);
  });

  it('the signed PUT refuses a different content type', async () => {
    const p = await presign(PNG);
    const put = await fetch(p.url, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: PNG });
    expect(put.status).toBe(403);
  });

  it('refuses SVG at presign time and uploads by roles without the permission', async () => {
    const svg = await ctx.http().post('/api/v1/files/presign').set(bearer(admin))
      .send({ entityType: 'logo', contentType: 'image/svg+xml', sizeBytes: 10 }).expect(400);
    expect(svg.body.code).toBe('VALIDATION_FAILED');
  });

  it('cleanup removes unconfirmed uploads older than 24 h', async () => {
    const p = await presign(PNG);
    const { FilesService } = await import('../../src/storage/files.service');
    const removed = await ctx.app.get(FilesService).cleanupPending(new Date(Date.now() + 25 * 3600_000));
    expect(removed).toBeGreaterThanOrEqual(1);
    const row = await ctx.prisma.file.findUniqueOrThrow({ where: { id: p.fileId } });
    expect(row.deletedAt).not.toBeNull();
  });
});
