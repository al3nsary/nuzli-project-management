import { DEFAULT_SETTINGS, type PresignUploadInput, type Settings } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser } from '../common/request';
import { FilesService } from '../storage/files.service';
import { ViolationFilesService } from './violation-files.service';

const V = '30000000-0000-4000-8000-000000000001';
const user = (id: string, role: AuthUser['role']): AuthUser => ({
  id,
  role,
  status: 'ACTIVE',
  fullName: 'x',
  mustChangePassword: false,
});
const MONITOR = user('mon-1', 'MONITOR');
const OTHER = user('mon-2', 'MONITOR');
const ADMIN = user('admin-1', 'ADMIN');

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

// JPEG magic bytes followed by padding.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

function setup(opts: { settings?: Partial<Settings>; linked?: number; inFlight?: number; existingLink?: boolean } = {}) {
  const all = { ...DEFAULT_SETTINGS, ...opts.settings };
  const settings = { get: jest.fn((k: keyof Settings) => Promise.resolve(all[k])) };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: V }]),
    violationFile: {
      findUnique: jest.fn().mockResolvedValue(opts.existingLink ? { id: 'link' } : null),
      count: jest.fn().mockResolvedValue(opts.linked ?? 0),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const fileRow = {
    id: 'f1',
    storageKey: 'violations/2026/10/f1.jpg',
    bucket: 'b',
    mimeType: 'image/jpeg',
    sizeBytes: JPEG.length,
    sha256: null,
    status: 'PENDING',
    uploadedById: MONITOR.id,
    entityType: 'violation',
    kind: 'EVIDENCE',
    entityId: V,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const prisma = {
    ...tx,
    violation: { findUnique: jest.fn().mockResolvedValue({ id: V, recordedById: MONITOR.id }) },
    violationFile: { ...tx.violationFile },
    file: {
      count: jest.fn().mockResolvedValue(opts.inFlight ?? 0),
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(fileRow),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const storage = {
    bucket: 'b',
    presignPut: jest.fn().mockResolvedValue('https://put'),
    head: jest.fn().mockResolvedValue({ exists: true, size: JPEG.length, contentType: 'image/jpeg' }),
    readRange: jest.fn().mockResolvedValue(new Uint8Array(JPEG)),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const audit = new AuditService(prisma as never);
  const files = new FilesService(prisma as never, storage as never, settings as never, audit);
  const svc = new ViolationFilesService(prisma as never, files, storage as never, settings as never, audit);
  svc.onModuleInit();
  return { svc, files, prisma, tx, storage, fileRow };
}

const presign = (over: Partial<PresignUploadInput> = {}): PresignUploadInput => ({
  entityType: 'violation',
  entityId: V,
  kind: 'EVIDENCE',
  contentType: 'image/jpeg',
  sizeBytes: JPEG.length,
  ...over,
});

describe('violation photo presign (brief §7.2)', () => {
  it('the recorder gets a URL under violations/{yyyy}/{mm}/{uuid}.jpg', async () => {
    const s = setup();
    const out = await s.files.presign(presign(), MONITOR);
    expect(out.url).toBe('https://put');
    const data = s.prisma.file.create.mock.calls[0]![0].data;
    expect(data.storageKey).toMatch(/^violations\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(data).toMatchObject({ entityType: 'violation', entityId: V, kind: 'EVIDENCE' });
  });

  it("someone else's violation is 404; an admin may upload to any", async () => {
    const s = setup();
    await expectCode(s.files.presign(presign(), OTHER), 'NOT_FOUND');
    await expect(s.files.presign(presign(), ADMIN)).resolves.toBeDefined();
  });

  it('images only, and entityId + kind are required', async () => {
    const s = setup();
    await expectCode(s.files.presign(presign({ contentType: 'application/pdf' }), MONITOR), 'FILE_TYPE_NOT_ALLOWED');
    await expectCode(s.files.presign(presign({ entityId: undefined }), MONITOR), 'VALIDATION_FAILED');
    await expectCode(s.files.presign(presign({ kind: 'ATTACHMENT' }), MONITOR), 'VALIDATION_FAILED');
  });

  it('limits: one ID card; VIOLATION_MAX_PHOTOS evidence (linked + uploads in flight) → TOO_MANY_PHOTOS', async () => {
    await expectCode(setup({ linked: 1 }).files.presign(presign({ kind: 'ID_CARD' }), MONITOR), 'TOO_MANY_PHOTOS');
    await expectCode(setup({ inFlight: 1 }).files.presign(presign({ kind: 'ID_CARD' }), MONITOR), 'TOO_MANY_PHOTOS');
    const s = setup({ settings: { VIOLATION_MAX_PHOTOS: 3 }, linked: 2, inFlight: 1 });
    await expectCode(s.files.presign(presign(), MONITOR), 'TOO_MANY_PHOTOS');
    await expect(setup({ settings: { VIOLATION_MAX_PHOTOS: 3 }, linked: 2 }).files.presign(presign(), MONITOR)).resolves.toBeDefined();
    // Uploads in flight are only those whose URL has not expired yet.
    const where = s.prisma.file.count.mock.calls[0]![0].where;
    expect(where).toMatchObject({ entityType: 'violation', entityId: V, kind: 'EVIDENCE', status: 'PENDING' });
    expect(where.createdAt.gt).toBeInstanceOf(Date);
  });
});

describe('violation photo confirm links the file idempotently', () => {
  it('confirm verifies the bytes, marks READY and links the file under a row lock', async () => {
    const s = setup();
    await expect(s.files.confirm('f1', MONITOR)).resolves.toEqual({ id: 'f1', status: 'READY' });
    expect(s.tx.$queryRaw).toHaveBeenCalled();
    expect((s.tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    expect(s.tx.violationFile.create).toHaveBeenCalledWith({ data: { violationId: V, fileId: 'f1', kind: 'EVIDENCE' } });
  });

  it('a repeated confirm of a READY file links it once (no duplicate row)', async () => {
    const s = setup({ existingLink: true });
    s.prisma.file.findUnique.mockResolvedValue({ ...s.fileRow, status: 'READY' });
    await s.files.confirm('f1', MONITOR);
    await s.files.confirm('f1', MONITOR);
    expect(s.storage.head).not.toHaveBeenCalled();
    expect(s.tx.violationFile.create).not.toHaveBeenCalled();
  });

  it('a READY but unlinked file (lost answer) gets linked on retry', async () => {
    const s = setup();
    s.prisma.file.findUnique.mockResolvedValue({ ...s.fileRow, status: 'READY' });
    await s.files.confirm('f1', MONITOR);
    expect(s.tx.violationFile.create).toHaveBeenCalledTimes(1);
  });

  it('over the limit at confirm time → TOO_MANY_PHOTOS, the object is deleted and the row marked deleted', async () => {
    const s = setup({ settings: { VIOLATION_MAX_PHOTOS: 2 }, linked: 2 });
    await expectCode(s.files.confirm('f1', MONITOR), 'TOO_MANY_PHOTOS');
    expect(s.storage.delete).toHaveBeenCalledWith('violations/2026/10/f1.jpg');
    expect(s.prisma.file.update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { deletedAt: expect.any(Date) } });
    expect(s.tx.violationFile.create).not.toHaveBeenCalled();
  });
});

describe('photo retention job (brief §13)', () => {
  it('VIOLATION_PHOTO_RETENTION_DAYS = 0 keeps everything', async () => {
    const s = setup({ settings: { VIOLATION_PHOTO_RETENTION_DAYS: 0 } });
    await expect(s.svc.purgeExpiredPhotos()).resolves.toBe(0);
    expect(s.prisma.file.findMany).not.toHaveBeenCalled();
  });

  it('deletes expired photo objects, marks the rows deleted and writes one system audit entry', async () => {
    const s = setup({ settings: { VIOLATION_PHOTO_RETENTION_DAYS: 30 } });
    s.prisma.file.findMany.mockResolvedValueOnce([
      { id: 'a', storageKey: 'violations/2026/01/a.jpg' },
      { id: 'b', storageKey: 'violations/2026/01/b.jpg' },
    ]);
    const now = new Date('2026-10-12T00:00:00Z');
    await expect(s.svc.purgeExpiredPhotos(now)).resolves.toBe(2);
    const where = s.prisma.file.findMany.mock.calls[0]![0].where;
    expect(where.entityType).toBe('violation');
    expect(where.OR[0]).toEqual({
      violationFile: { is: { violation: { capturedAt: { lt: new Date('2026-09-12T00:00:00Z') } } } },
    });
    expect(s.storage.delete).toHaveBeenCalledTimes(2);
    expect(s.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null, action: 'violations.photos_purged' }),
    });
  });
});
