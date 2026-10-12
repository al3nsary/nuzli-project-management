import { DEFAULT_SETTINGS, type Settings } from '@nuzli/shared';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser } from '../common/request';
import { FilesService } from './files.service';

const ADMIN: AuthUser = { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', fullName: 'x', mustChangePassword: false };
const SUPERVISOR: AuthUser = { id: 'sup-1', role: 'SUPERVISOR', status: 'ACTIVE', fullName: 'x', mustChangePassword: false };
const ID = '44444444-4444-4444-8444-444444444444';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

function setup(row: Record<string, unknown> = {}, bytes: Buffer = PNG) {
  const fileRow = {
    id: ID,
    storageKey: `pending/${ID}.png`,
    bucket: 'b',
    mimeType: 'image/png',
    sizeBytes: PNG.length,
    sha256: null as string | null,
    status: 'PENDING',
    uploadedById: ADMIN.id,
    entityType: 'logo',
    kind: 'LOGO',
    entityId: null,
    createdAt: new Date('2026-10-05T10:00:00Z'),
    updatedAt: new Date(),
    deletedAt: null,
    ...row,
  };
  const prisma = {
    file: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(fileRow),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const storage = {
    bucket: 'b',
    presignPut: jest.fn().mockResolvedValue('https://put'),
    head: jest.fn().mockResolvedValue({ exists: true, size: bytes.length, contentType: 'image/png' }),
    readRange: jest.fn().mockResolvedValue(new Uint8Array(bytes)),
    readAll: jest.fn().mockResolvedValue(new Uint8Array(bytes)),
    copy: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const settings = { get: jest.fn((k: keyof Settings) => Promise.resolve(DEFAULT_SETTINGS[k])) };
  const files = new FilesService(prisma as never, storage as never, settings as never, new AuditService(prisma as never));
  return { files, prisma, storage, fileRow };
}

const FINAL = `logos/2026/10/${ID}.png`;

describe('upload confirm copies to a final key (security review M1)', () => {
  it('presign hands out a PUT URL for a pending/ key only', async () => {
    const s = setup();
    await s.files.presign({ entityType: 'logo', kind: 'LOGO', contentType: 'image/png', sizeBytes: PNG.length }, ADMIN);
    const key = s.prisma.file.create.mock.calls[0]![0].data.storageKey as string;
    expect(key).toMatch(/^pending\/[0-9a-f-]{36}\.png$/);
    expect(s.storage.presignPut).toHaveBeenCalledWith(key, 'image/png', PNG.length, expect.any(Number));
  });

  it('confirm copies pending → final, verifies the COPY, deletes the pending object and stores key + sha256', async () => {
    const s = setup();
    await expect(s.files.confirm(ID, ADMIN)).resolves.toEqual({ id: ID, status: 'READY' });
    expect(s.storage.copy).toHaveBeenCalledWith(`pending/${ID}.png`, FINAL);
    // Verification reads the final object, which never had a presigned PUT.
    expect(s.storage.readAll).toHaveBeenCalledWith(FINAL);
    expect(s.storage.head).toHaveBeenLastCalledWith(FINAL);
    expect(s.storage.delete).toHaveBeenCalledWith(`pending/${ID}.png`);
    expect(s.storage.delete).not.toHaveBeenCalledWith(FINAL);
    expect(s.prisma.file.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: 'PENDING' },
      data: { status: 'READY', storageKey: FINAL, sha256: sha(PNG) },
    });
  });

  it('a declared sha256 that does not match the copied bytes rejects and removes both objects', async () => {
    const s = setup({ sha256: 'f'.repeat(64) });
    await expectCode(s.files.confirm(ID, ADMIN), 'FILE_NOT_UPLOADED');
    expect(s.storage.delete).toHaveBeenCalledWith(FINAL);
    expect(s.storage.delete).toHaveBeenCalledWith(`pending/${ID}.png`);
    expect(s.prisma.file.update).toHaveBeenCalledWith({ where: { id: ID }, data: { deletedAt: expect.any(Date) } });
    expect(s.prisma.file.updateMany).not.toHaveBeenCalled();
  });

  it('wrong magic bytes in the copy → FILE_TYPE_NOT_ALLOWED and both objects deleted', async () => {
    const svg = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(PNG.length - 40, 32)]);
    const s = setup({}, svg);
    await expectCode(s.files.confirm(ID, ADMIN), 'FILE_TYPE_NOT_ALLOWED');
    expect(s.storage.delete).toHaveBeenCalledWith(FINAL);
    expect(s.storage.delete).toHaveBeenCalledWith(`pending/${ID}.png`);
  });

  it('nothing uploaded yet → FILE_NOT_UPLOADED without copying', async () => {
    const s = setup();
    s.storage.head.mockResolvedValue({ exists: false, size: 0, contentType: null });
    await expectCode(s.files.confirm(ID, ADMIN), 'FILE_NOT_UPLOADED');
    expect(s.storage.copy).not.toHaveBeenCalled();
  });

  it('a repeated confirm of a READY file does not copy again', async () => {
    const s = setup({ status: 'READY', storageKey: FINAL });
    await s.files.confirm(ID, ADMIN);
    expect(s.storage.copy).not.toHaveBeenCalled();
  });
});

describe('logo and member-photo uploads (security review L3)', () => {
  it('photo uploads are refused while their scope hook is not registered (A8 supersedes the L3 closure)', async () => {
    const s = setup();
    for (const entityType of ['member_photo', 'user_photo'] as const) {
      const input = { entityType, entityId: ID, kind: 'PHOTO' as const, contentType: 'image/png' as const, sizeBytes: 10 };
      await expectCode(s.files.presign(input, ADMIN), 'FORBIDDEN');
    }
    const hook = { beforePresign: jest.fn().mockResolvedValue(undefined), onConfirmed: jest.fn() };
    s.files.registerHook('member_photo', hook);
    const input = { entityType: 'member_photo' as const, entityId: ID, kind: 'PHOTO' as const, contentType: 'image/png' as const, sizeBytes: 10 };
    await expect(s.files.presign(input, SUPERVISOR)).resolves.toBeDefined();
    expect(hook.beforePresign).toHaveBeenCalledWith(input, SUPERVISOR);
  });

  it('logos are admin-only and carry no entityId', async () => {
    const s = setup();
    const logo = { entityType: 'logo' as const, kind: 'LOGO' as const, contentType: 'image/png' as const, sizeBytes: 10 };
    await expectCode(s.files.presign(logo, SUPERVISOR), 'FORBIDDEN');
    await expectCode(s.files.presign({ ...logo, entityId: ID }, ADMIN), 'FORBIDDEN');
    await expect(s.files.presign(logo, ADMIN)).resolves.toBeDefined();
  });

  it('the orphan job removes READY logos and user/member photos nothing links to after 24 h', async () => {
    const s = setup();
    s.prisma.file.findMany.mockResolvedValue([{ id: ID, storageKey: FINAL }]);
    const now = new Date('2026-10-12T00:00:00Z');
    await expect(s.files.cleanupOrphans(now)).resolves.toBe(1);
    const where = s.prisma.file.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ status: 'READY', deletedAt: null, createdAt: { lt: new Date('2026-10-11T00:00:00Z') } });
    expect(where.OR).toEqual([
      { entityType: 'logo', logo: { is: null } },
      { entityType: 'member_photo', memberPhotos: { none: {} } },
      { entityType: 'user_photo', userPhotos: { none: {} } },
    ]);
    expect(s.storage.delete).toHaveBeenCalledWith(FINAL);
  });
});
