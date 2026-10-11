import { randomBytes } from 'node:crypto';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { assertNotLastAdmin, guardLastAdmin, lockActiveAdmins, removesActiveAdmin } from './last-admin';
import { UsersService } from './users.service';

const ctx: RequestContext = { actorId: 'a1', ip: '10.0.0.1', requestId: 'req-1', userAgent: 'jest' };
const viewer = { id: 'a1', role: 'ADMIN' as const, status: 'ACTIVE' };

describe('last-admin rules (ADR-009)', () => {
  it('only demotion, suspension or deletion of an ACTIVE ADMIN counts as removal', () => {
    const admin = { role: 'ADMIN', status: 'ACTIVE' };
    expect(removesActiveAdmin(admin, { role: 'SUPERVISOR', status: 'ACTIVE' })).toBe(true);
    expect(removesActiveAdmin(admin, { role: 'ADMIN', status: 'SUSPENDED' })).toBe(true);
    expect(removesActiveAdmin(admin, admin)).toBe(false);
    expect(removesActiveAdmin({ role: 'SUPERVISOR', status: 'ACTIVE' }, { role: 'MONITOR', status: 'ACTIVE' })).toBe(false);
    expect(removesActiveAdmin({ role: 'ADMIN', status: 'PENDING' }, { role: 'SUPERVISOR', status: 'PENDING' })).toBe(false);
  });

  it('blocks removing the only active admin', () => {
    expect(() => assertNotLastAdmin(['a1'], 'a1')).toThrow(AppError);
    try {
      assertNotLastAdmin(['a1'], 'a1');
    } catch (e) {
      expect((e as AppError).code).toBe('LAST_ADMIN');
      expect((e as AppError).status).toBe(409);
    }
    expect(() => assertNotLastAdmin(['a1', 'a2'], 'a1')).not.toThrow();
    // Target already not an active admin (a concurrent tx demoted it) → nothing to protect.
    expect(() => assertNotLastAdmin(['a2'], 'a1')).not.toThrow();
  });

  it('locks the active admin rows with SELECT … FOR UPDATE', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]) };
    await expect(lockActiveAdmins(tx as never)).resolves.toEqual(['a1', 'a2']);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/role = 'ADMIN'/);
    expect(sql).toMatch(/status = 'ACTIVE'/);
  });

  it('does not lock anything when the change keeps the admin set intact', async () => {
    const tx = { $queryRaw: jest.fn() };
    await guardLastAdmin(tx as never, 'u1', { role: 'MONITOR', status: 'ACTIVE' }, { role: 'SUPERVISOR', status: 'ACTIVE' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

/** UsersService with a mocked Prisma transaction. */
function makeService(activeAdmins: string[], target: { id: string; role: string; status: string }) {
  const crypto = new CryptoService({
    encKey: randomBytes(32).toString('base64'),
    hmacKey: randomBytes(32).toString('base64'),
  });
  const row = {
    ...target,
    fullName: 'مستخدم',
    email: `${target.id}@x.sa`,
    mobile: '+966500000000',
    nationalIdEnc: crypto.encrypt('1234567823'),
    nationalIdFirst: '1',
    nationalIdLast2: '23',
    requestedRole: null,
    requestedTeamName: null,
    rejectionReason: null,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    preferences: {},
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(activeAdmins.map((id) => ({ id }))),
    user: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ ...row, ...data })),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { logCtx: jest.fn().mockResolvedValue(undefined) };
  const svc = new UsersService(prisma as never, crypto, audit as never, {} as never, {} as never, {} as never);
  return { svc, tx, audit };
}

describe('UsersService last-admin protection', () => {
  it('refuses to demote the last active admin and writes nothing', async () => {
    const { svc, tx, audit } = makeService(['a1'], { id: 'a1', role: 'ADMIN', status: 'ACTIVE' });
    await expect(svc.changeRole('a1', 'SUPERVISOR', viewer, ctx)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.logCtx).not.toHaveBeenCalled();
  });

  it('refuses to suspend the last active admin', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'a1', role: 'ADMIN', status: 'ACTIVE' });
    await expect(svc.suspend('a1', undefined, viewer, ctx)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another active admin exists, and audits it', async () => {
    const { svc, tx, audit } = makeService(['a1', 'a2'], { id: 'a2', role: 'ADMIN', status: 'ACTIVE' });
    const dto = await svc.changeRole('a2', 'MONITOR', viewer, ctx);
    expect(dto.role).toBe('MONITOR');
    expect(dto.nationalIdMasked).toBe('1•••••••23');
    // Admin viewers get the full value (decrypted on demand).
    expect(dto.nationalId).toBe('1234567823');
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a2' } }));
    expect(audit.logCtx).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        action: 'user.role_changed',
        before: { role: 'ADMIN' },
        after: { role: 'MONITOR' },
      }),
      tx,
    );
  });

  it('suspending a non-admin revokes every refresh token without locking admins', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'u9', role: 'SUPERVISOR', status: 'ACTIVE' });
    const dto = await svc.suspend('u9', 'سبب', viewer, ctx);
    expect(dto.status).toBe('SUSPENDED');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u9', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('promoting to admin never needs the lock', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'u9', role: 'SUPERVISOR', status: 'ACTIVE' });
    await svc.changeRole('u9', 'ADMIN', viewer, ctx);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
