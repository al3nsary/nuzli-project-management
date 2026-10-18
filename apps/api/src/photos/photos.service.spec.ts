import { DEFAULT_SETTINGS, PHOTO_MAX_BYTES, type PresignUploadInput, type Settings } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { FilesService } from '../storage/files.service';
import { memberPhotoRead, memberPhotoWrite, userPhotoRead, userPhotoWrite } from './photo-policy';
import { PhotosService } from './photos.service';

const user = (id: string, role: AuthUser['role']): AuthUser => ({ id, role, status: 'ACTIVE', fullName: 'x', mustChangePassword: false });
const ADMIN = user('aaaaaaaa-0000-4000-8000-000000000001', 'ADMIN');
const SUP = user('aaaaaaaa-0000-4000-8000-000000000002', 'SUPERVISOR');
const OTHER_SUP = user('aaaaaaaa-0000-4000-8000-000000000003', 'SUPERVISOR');
const MONITOR = user('aaaaaaaa-0000-4000-8000-000000000004', 'MONITOR');
const SUSPENDED = 'aaaaaaaa-0000-4000-8000-000000000005';

const M_OWN = 'bbbbbbbb-0000-4000-8000-000000000001'; // team led by SUP
const M_OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'; // team led by OTHER_SUP
const M_FREE = 'bbbbbbbb-0000-4000-8000-000000000003'; // no open membership
const M_ARCH = 'bbbbbbbb-0000-4000-8000-000000000004'; // archived team led by SUP

const OLD_FILE = 'cccccccc-0000-4000-8000-000000000001';
const NEW_FILE = 'cccccccc-0000-4000-8000-000000000002';
const OLD_KEY = `user-photos/2026/10/${OLD_FILE}.jpg`;
const ctx: RequestContext = { actorId: ADMIN.id, ip: '127.0.0.1', requestId: 'r1', userAgent: null };

const photoRow = (id: string | null) =>
  id ? { storageKey: id === OLD_FILE ? OLD_KEY : `x/${id}.jpg`, status: 'READY', deletedAt: null } : null;

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

function setup(opts: { userPhoto?: string | null; memberPhoto?: string | null } = {}) {
  const userPhoto = opts.userPhoto ?? null;
  const memberPhoto = opts.memberPhoto ?? null;
  const users: Record<string, { status: string }> = {
    [ADMIN.id]: { status: 'ACTIVE' },
    [SUP.id]: { status: 'ACTIVE' },
    [OTHER_SUP.id]: { status: 'ACTIVE' },
    [MONITOR.id]: { status: 'ACTIVE' },
    [SUSPENDED]: { status: 'SUSPENDED' },
  };
  // A9 (ADR-100): the open leadership rows of the team.
  const team = (supervisorId: string, status = 'ACTIVE') => [{ team: { supervisors: [{ userId: supervisorId }], status } }];
  const members: Record<string, Array<{ team: { supervisors: Array<{ userId: string }>; status: string } }>> = {
    [M_OWN]: team(SUP.id),
    [M_OTHER]: team(OTHER_SUP.id),
    [M_FREE]: [],
    [M_ARCH]: team(SUP.id, 'ARCHIVED'),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        users[where.id]
          ? { id: where.id, status: users[where.id]!.status, archivedAt: null, photoFileId: userPhoto, photo: photoRow(userPhoto) }
          : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    teamMember: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        members[where.id]
          ? { archivedAt: null, status: 'ACTIVE', photoFileId: memberPhoto, photo: photoRow(memberPhoto), memberships: members[where.id] }
          : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    file: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, ...photoRow(where.id) })),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const storage = {
    bucket: 'b',
    presignPut: jest.fn().mockResolvedValue('https://put'),
    presignGet: jest.fn(async (key: string) => `https://get/${key}`),
    delete: jest.fn().mockResolvedValue(undefined),
    readAll: jest.fn(),
  };
  const settings = { get: jest.fn((k: keyof Settings) => Promise.resolve(DEFAULT_SETTINGS[k])) };
  const audit = new AuditService(prisma as never);
  const files = new FilesService(prisma as never, storage as never, settings as never, audit);
  const photos = new PhotosService(prisma as never, files, storage as never, settings as never, audit);
  photos.onModuleInit();
  return { photos, files, prisma, storage };
}

const presign = (entityType: 'user_photo' | 'member_photo', entityId: string, extra: Partial<PresignUploadInput> = {}): PresignUploadInput => ({
  entityType,
  entityId,
  kind: 'PHOTO',
  contentType: 'image/jpeg',
  sizeBytes: 50_000,
  ...extra,
});

const fileRow = (entityType: string, entityId: string, id = NEW_FILE) => ({
  id,
  storageKey: `x/${id}.jpg`,
  bucket: 'b',
  mimeType: 'image/jpeg',
  sizeBytes: 50_000,
  sha256: null,
  status: 'READY' as const,
  uploadedById: ADMIN.id,
  entityType,
  entityId,
  kind: 'PHOTO',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
});

describe('photo policy matrix (owner request A8)', () => {
  const scope = (supervisorId: string | null, status = 'ACTIVE', co: string[] = []) => ({
    status: 'ACTIVE',
    team: supervisorId ? { supervisors: [supervisorId, ...co].map((userId) => ({ userId })), status } : null,
  });

  it('A9: a second (non-primary) supervisor of the team may change and see member photos', () => {
    expect(memberPhotoWrite(OTHER_SUP, scope(SUP.id, 'ACTIVE', [OTHER_SUP.id]))).toBe('ALLOW');
    expect(memberPhotoRead(OTHER_SUP, scope(SUP.id, 'ACTIVE', [OTHER_SUP.id]))).toBe(true);
    expect(memberPhotoWrite(OTHER_SUP, scope(SUP.id, 'ARCHIVED', [OTHER_SUP.id]))).toBe('FORBIDDEN');
  });

  it('user photos: self and admin may change; others may not', () => {
    expect(userPhotoWrite(SUP, SUP.id)).toBe('ALLOW');
    expect(userPhotoWrite(MONITOR, MONITOR.id)).toBe('ALLOW');
    expect(userPhotoWrite(ADMIN, SUP.id)).toBe('ALLOW');
    expect(userPhotoWrite(SUP, OTHER_SUP.id)).toBe('FORBIDDEN');
    expect(userPhotoWrite(MONITOR, SUP.id)).toBe('FORBIDDEN');
  });

  it('member photos: admin, or the supervisor leading the current non-archived team', () => {
    expect(memberPhotoWrite(ADMIN, scope(OTHER_SUP.id))).toBe('ALLOW');
    expect(memberPhotoWrite(ADMIN, scope(null))).toBe('ALLOW');
    expect(memberPhotoWrite(SUP, scope(SUP.id))).toBe('ALLOW');
    expect(memberPhotoWrite(OTHER_SUP, scope(SUP.id))).toBe('NOT_FOUND');
    expect(memberPhotoWrite(SUP, scope(null))).toBe('FORBIDDEN');
    expect(memberPhotoWrite(SUP, scope(SUP.id, 'ARCHIVED'))).toBe('FORBIDDEN');
    expect(memberPhotoWrite(MONITOR, scope(SUP.id))).toBe('FORBIDDEN');
  });

  it('reads: active users see active users; members are visible to admin, leading supervisor and recorders', () => {
    expect(userPhotoRead(MONITOR, { id: SUP.id, status: 'ACTIVE' })).toBe(true);
    expect(userPhotoRead(MONITOR, { id: SUSPENDED, status: 'SUSPENDED' })).toBe(false);
    expect(userPhotoRead(ADMIN, { id: SUSPENDED, status: 'SUSPENDED' })).toBe(true);
    expect(userPhotoRead({ ...SUP, status: 'SUSPENDED' }, { id: ADMIN.id, status: 'ACTIVE' })).toBe(false);
    expect(memberPhotoRead(ADMIN, scope(OTHER_SUP.id))).toBe(true);
    expect(memberPhotoRead(SUP, scope(SUP.id))).toBe(true);
    expect(memberPhotoRead(OTHER_SUP, scope(SUP.id))).toBe(false);
    expect(memberPhotoRead(MONITOR, scope(SUP.id))).toBe(true);
    expect(memberPhotoRead(MONITOR, scope(null))).toBe(false);
    expect(memberPhotoRead(MONITOR, scope(SUP.id, 'ARCHIVED'))).toBe(false);
  });
});

describe('photo uploads through presign (owner request A8)', () => {
  it('user_photo: self and admin may presign; another supervisor or a monitor may not', async () => {
    const s = setup();
    await expect(s.files.presign(presign('user_photo', SUP.id), SUP)).resolves.toMatchObject({ method: 'PUT' });
    await expect(s.files.presign(presign('user_photo', MONITOR.id), MONITOR)).resolves.toBeDefined();
    await expect(s.files.presign(presign('user_photo', SUP.id), ADMIN)).resolves.toBeDefined();
    await expectCode(s.files.presign(presign('user_photo', SUP.id), OTHER_SUP), 'FORBIDDEN');
    await expectCode(s.files.presign(presign('user_photo', SUP.id), MONITOR), 'FORBIDDEN');
    await expectCode(s.files.presign(presign('user_photo', 'aaaaaaaa-0000-4000-8000-0000000000ff'), ADMIN), 'NOT_FOUND');
  });

  it('member_photo: admin and the leading supervisor; other supervisor 404; monitor 403; archived team 403', async () => {
    const s = setup();
    await expect(s.files.presign(presign('member_photo', M_OTHER), ADMIN)).resolves.toBeDefined();
    await expect(s.files.presign(presign('member_photo', M_OWN), SUP)).resolves.toBeDefined();
    await expectCode(s.files.presign(presign('member_photo', M_OWN), OTHER_SUP), 'NOT_FOUND');
    await expectCode(s.files.presign(presign('member_photo', M_OWN), MONITOR), 'FORBIDDEN');
    await expectCode(s.files.presign(presign('member_photo', M_FREE), SUP), 'FORBIDDEN');
    await expectCode(s.files.presign(presign('member_photo', M_ARCH), SUP), 'FORBIDDEN');
  });

  it('images only, at most 2 MB, an entity id is required', async () => {
    const s = setup();
    await expectCode(s.files.presign(presign('user_photo', SUP.id, { contentType: 'application/pdf' }), SUP), 'FILE_TYPE_NOT_ALLOWED');
    await expectCode(s.files.presign(presign('user_photo', SUP.id, { sizeBytes: PHOTO_MAX_BYTES + 1 }), SUP), 'FILE_TOO_LARGE');
    await expectCode(s.files.presign(presign('user_photo', SUP.id, { kind: 'EVIDENCE' }), SUP), 'VALIDATION_FAILED');
    await expectCode(s.files.presign({ ...presign('user_photo', SUP.id), entityId: undefined }, SUP), 'VALIDATION_FAILED');
    expect(s.prisma.file.create).not.toHaveBeenCalled();
  });

  it('an SVG uploaded under an image content type is rejected at confirm and never linked', async () => {
    const s = setup();
    const svg = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(24, 32)]);
    const pending = { ...fileRow('user_photo', SUP.id), status: 'PENDING', storageKey: `pending/${NEW_FILE}.jpg`, sizeBytes: svg.length, uploadedById: SUP.id };
    s.prisma.file.findUnique.mockResolvedValueOnce(pending as never);
    Object.assign(s.storage, {
      head: jest.fn().mockResolvedValue({ exists: true, size: svg.length, contentType: 'image/jpeg' }),
      copy: jest.fn().mockResolvedValue(undefined),
    });
    s.storage.readAll.mockResolvedValue(new Uint8Array(svg));
    await expectCode(s.files.confirm(NEW_FILE, SUP, ctx), 'FILE_TYPE_NOT_ALLOWED');
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('confirm links and replaces (owner request A8)', () => {
  it('replace: links the new file, marks the old one deleted, audits file ids only, deletes the old object after commit', async () => {
    const s = setup({ userPhoto: OLD_FILE });
    await s.photos.onConfirmed('user_photo', fileRow('user_photo', SUP.id) as never, SUP, ctx);
    expect(s.prisma.$queryRaw).toHaveBeenCalled(); // row lock
    expect(s.prisma.user.update).toHaveBeenCalledWith({ where: { id: SUP.id }, data: { photoFileId: NEW_FILE } });
    expect(s.prisma.file.update).toHaveBeenCalledWith({ where: { id: OLD_FILE }, data: { deletedAt: expect.any(Date) } });
    expect(s.storage.delete).toHaveBeenCalledWith(OLD_KEY);
    const txDone = (s.prisma.$transaction.mock.results[0]!.value as Promise<unknown>);
    await txDone;
    expect(s.storage.delete.mock.invocationCallOrder[0]!).toBeGreaterThan(s.prisma.auditLog.create.mock.invocationCallOrder[0]!);
    const entry = s.prisma.auditLog.create.mock.calls[0]![0].data;
    expect(entry).toMatchObject({
      action: 'user.photo_updated',
      entityType: 'user',
      entityId: SUP.id,
      before: { photoFileId: OLD_FILE },
      after: { photoFileId: NEW_FILE },
      requestId: 'r1',
    });
  });

  it('member photo by the leading supervisor: member.photo_updated; first photo deletes nothing', async () => {
    const s = setup();
    await s.photos.onConfirmed('member_photo', fileRow('member_photo', M_OWN) as never, SUP, ctx);
    expect(s.prisma.teamMember.update).toHaveBeenCalledWith({ where: { id: M_OWN }, data: { photoFileId: NEW_FILE } });
    expect(s.storage.delete).not.toHaveBeenCalled();
    expect(s.prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({ action: 'member.photo_updated', before: { photoFileId: null } });
  });

  it('a repeated confirm of the linked file changes nothing', async () => {
    const s = setup({ userPhoto: NEW_FILE });
    await s.photos.onConfirmed('user_photo', fileRow('user_photo', SUP.id) as never, SUP, ctx);
    expect(s.prisma.user.update).not.toHaveBeenCalled();
    expect(s.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('confirm re-checks the scope: a supervisor who no longer leads the team cannot link', async () => {
    const s = setup();
    await expectCode(s.photos.onConfirmed('member_photo', fileRow('member_photo', M_OTHER) as never, SUP, ctx), 'NOT_FOUND');
    expect(s.prisma.teamMember.update).not.toHaveBeenCalled();
  });
});

describe('remove and read (owner request A8)', () => {
  it('remove unlinks, marks the file deleted, deletes the object and audits *.photo_removed', async () => {
    const s = setup({ memberPhoto: OLD_FILE });
    await s.photos.remove('member_photo', M_OWN, SUP, ctx);
    expect(s.prisma.teamMember.update).toHaveBeenCalledWith({ where: { id: M_OWN }, data: { photoFileId: null } });
    expect(s.prisma.file.update).toHaveBeenCalledWith({ where: { id: OLD_FILE }, data: { deletedAt: expect.any(Date) } });
    expect(s.storage.delete).toHaveBeenCalledWith(OLD_KEY);
    expect(s.prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'member.photo_removed',
      before: { photoFileId: OLD_FILE },
      after: { photoFileId: null },
    });
  });

  it('remove follows the write matrix and is a no-op without a photo', async () => {
    const s = setup({ userPhoto: OLD_FILE });
    await expectCode(s.photos.remove('user_photo', SUP.id, OTHER_SUP, ctx), 'FORBIDDEN');
    await expectCode(s.photos.remove('member_photo', M_OWN, OTHER_SUP, ctx), 'NOT_FOUND');
    await s.photos.remove('user_photo', SUP.id, ADMIN, ctx);
    expect(s.prisma.auditLog.create.mock.calls[0]![0].data.action).toBe('user.photo_removed');
    const empty = setup();
    await empty.photos.remove('user_photo', SUP.id, SUP, ctx);
    expect(empty.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(empty.storage.delete).not.toHaveBeenCalled();
  });

  it('photo-url: short-lived presigned GET after the scope check', async () => {
    const s = setup({ userPhoto: OLD_FILE, memberPhoto: OLD_FILE });
    const own = await s.photos.photoUrl('user_photo', SUP.id, SUP);
    expect(own.url).toBe(`https://get/${OLD_KEY}`);
    expect(new Date(own.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(DEFAULT_SETTINGS.PRESIGNED_URL_TTL_SECONDS * 1000);
    await expect(s.photos.photoUrl('user_photo', SUP.id, MONITOR)).resolves.toBeDefined();
    await expectCode(s.photos.photoUrl('user_photo', SUSPENDED, MONITOR), 'NOT_FOUND');
    await expect(s.photos.photoUrl('user_photo', SUSPENDED, ADMIN)).resolves.toBeDefined();
    await expect(s.photos.photoUrl('member_photo', M_OWN, SUP)).resolves.toBeDefined();
    await expect(s.photos.photoUrl('member_photo', M_OWN, MONITOR)).resolves.toBeDefined();
    await expect(s.photos.photoUrl('member_photo', M_OTHER, ADMIN)).resolves.toBeDefined();
    await expectCode(s.photos.photoUrl('member_photo', M_OWN, OTHER_SUP), 'NOT_FOUND');
    await expectCode(s.photos.photoUrl('member_photo', M_FREE, MONITOR), 'NOT_FOUND');
  });

  it('photo-url without a photo is 404', async () => {
    const s = setup();
    await expectCode(s.photos.photoUrl('user_photo', SUP.id, SUP), 'NOT_FOUND');
    expect(s.storage.presignGet).not.toHaveBeenCalled();
  });
});
