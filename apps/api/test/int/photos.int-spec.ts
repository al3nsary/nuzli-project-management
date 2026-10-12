/** Owner request A8: personal photo upload → confirm → photo-url → replace → remove, against MinIO. */
import { bearer, bootstrapAdminSession, describeInt, startApp, type IntApp, type Session } from './helpers';

// Two different 1×1 PNGs (opaque and transparent).
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describeInt('personal photos (A8)', () => {
  let ctx: IntApp;
  let admin: Session;
  let adminId: string;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    adminId = (await ctx.http().get('/api/v1/auth/me').set(bearer(admin)).expect(200)).body.id as string;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function upload(bytes: Buffer): Promise<string> {
    const p = await ctx.http().post('/api/v1/files/presign').set(bearer(admin))
      .send({ entityType: 'user_photo', entityId: adminId, kind: 'PHOTO', contentType: 'image/png', sizeBytes: bytes.length })
      .expect(201);
    const put = await fetch(p.body.url as string, { method: 'PUT', headers: p.body.headers, body: bytes });
    expect(put.status).toBe(200);
    await ctx.http().post(`/api/v1/files/${p.body.fileId}/confirm`).set(bearer(admin)).expect(200);
    return p.body.fileId as string;
  }

  it('upload → confirm links the photo; photo-url serves the bytes; replace deletes the old file', async () => {
    const first = await upload(PNG_A);
    const me = await ctx.http().get('/api/v1/auth/me').set(bearer(admin)).expect(200);
    expect(me.body).toMatchObject({ photoFileId: first, hasPhoto: true });

    const url = await ctx.http().get('/api/v1/me/photo-url').set(bearer(admin)).expect(200);
    expect(typeof url.body.expiresAt).toBe('string');
    const got = await fetch(url.body.url as string);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG_A)).toBe(true);

    const second = await upload(PNG_B);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(user.photoFileId).toBe(second);
    const old = await ctx.prisma.file.findUniqueOrThrow({ where: { id: first } });
    expect(old.deletedAt).not.toBeNull();
    const stale = await fetch(url.body.url as string);
    expect(stale.status).toBe(404);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'user.photo_updated', entityId: adminId } });
    expect(audit).toHaveLength(2);

    const again = await ctx.http().get(`/api/v1/users/${adminId}/photo-url`).set(bearer(admin)).expect(200);
    const fresh = await fetch(again.body.url as string);
    expect(Buffer.from(await fresh.arrayBuffer()).equals(PNG_B)).toBe(true);
  });

  it('remove unlinks the photo and photo-url answers 404', async () => {
    await upload(PNG_A);
    await ctx.http().delete('/api/v1/me/photo').set(bearer(admin)).expect(204);
    const me = await ctx.http().get('/api/v1/auth/me').set(bearer(admin)).expect(200);
    expect(me.body).toMatchObject({ photoFileId: null, hasPhoto: false });
    await ctx.http().get('/api/v1/me/photo-url').set(bearer(admin)).expect(404);
  });

  it('a photo above 2 MB is refused at presign', async () => {
    const res = await ctx.http().post('/api/v1/files/presign').set(bearer(admin))
      .send({ entityType: 'user_photo', entityId: adminId, contentType: 'image/jpeg', sizeBytes: 2 * 1024 * 1024 + 1 });
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});
