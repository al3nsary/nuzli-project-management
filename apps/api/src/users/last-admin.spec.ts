import { randomBytes } from 'node:crypto';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { assertNotLastAdmin, guardLastAdmin, lockActiveAdmins, removesActiveAdmin } from './last-admin';
import { UsersService } from './users.service';
import { UNIT_TEST_WORKSPACE_ID } from '../../test/unit/workspace-setup';

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
    await expect(lockActiveAdmins(tx as never, 'ws-1')).resolves.toEqual(['a1', 'a2']);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/FOR UPDATE/);
    // Security review A12 L3: the USERS rows are locked too — a concurrent global suspension of one
    // admin (users.status) and a workspace suspension of the other (membership) serialise, and the
    // re-check after the wait sees the suspended account (no workspace left without an admin).
    expect(sql).toMatch(/FOR UPDATE OF m, u$/);
    expect(sql).toMatch(/u.status = 'ACTIVE'/);
    // A12: the admins of ONE workspace (the id is a bound parameter).
    expect(sql).toContain("m.workspace_id = ?::uuid");
    expect(sql).toMatch(/role = 'ADMIN'/);
    expect(sql).toMatch(/status = 'ACTIVE'/);
    expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['ws-1']);
  });

  it('does not lock anything when the change keeps the admin set intact', async () => {
    const tx = { $queryRaw: jest.fn() };
    await guardLastAdmin(tx as never, 'u1', { role: 'MONITOR', status: 'ACTIVE' }, { role: 'SUPERVISOR', status: 'ACTIVE' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});


const WS = UNIT_TEST_WORKSPACE_ID;
const OTHER_WS = '0b120000-0000-4000-8000-000000000002';

/**
 * UsersService with a stateful fake (A12: roles are workspace memberships). `memberships` holds
 * the target's live memberships; the service may only touch those of the active workspace.
 */
function makeService(activeAdmins: string[], target: { id: string; role: string; status: string; elsewhere?: boolean }) {
  const crypto = new CryptoService({
    encKey: randomBytes(32).toString('base64'),
    hmacKey: randomBytes(32).toString('base64'),
  });
  let memberships = [
    { workspaceId: WS, role: target.role, status: 'ACTIVE' },
    ...(target.elsewhere ? [{ workspaceId: OTHER_WS, role: 'SUPERVISOR', status: 'ACTIVE' }] : []),
  ];
  let status = target.status;
  const row = () => ({
    id: target.id,
    username: target.id,
    accountRole: 'USER',
    fullName: 'مستخدم',
    email: `${target.id}@x.sa`,
    mobile: '+966500000000',
    nationalIdEnc: crypto.encrypt('1234567823'),
    nationalIdFirst: '1',
    nationalIdLast2: '23',
    requestedRole: null,
    requestedTeamName: null,
    requestedWorkspaceId: null,
    status,
    rejectionReason: null,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    preferences: {},
    photoFileId: null,
    memberships: memberships.map((m) => ({ ...m })),
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(activeAdmins.map((id) => ({ id }))),
    user: {
      findFirst: jest.fn().mockImplementation(() => Promise.resolve(row())),
      findUniqueOrThrow: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(({ data }: { data: { status?: string } }) => {
        if (data.status) status = data.status;
        return Promise.resolve(row());
      }),
    },
    workspaceMembership: {
      updateMany: jest.fn().mockImplementation(
        ({ where, data }: { where: { workspaceId: string; role?: { in: string[] } }; data: { archivedAt?: Date; status?: string } }) => {
          memberships = memberships
            .filter((m) => !(data.archivedAt && m.workspaceId === where.workspaceId && (!where.role || where.role.in.includes(m.role))))
            .map((m) => (data.status && m.workspaceId === where.workspaceId ? { ...m, status: data.status } : m));
          return Promise.resolve({ count: 1 });
        },
      ),
      upsert: jest.fn().mockImplementation(({ create }: { create: { workspaceId: string; role: string; status?: string } }) => {
        memberships.push({ workspaceId: create.workspaceId, role: create.role, status: create.status ?? 'ACTIVE' });
        return Promise.resolve({});
      }),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { logCtx: jest.fn().mockResolvedValue(undefined) };
  const svc = new UsersService(prisma as never, crypto, audit as never, {} as never, {} as never, {} as never);
  return { svc, tx, audit, memberships: () => memberships };
}

describe('UsersService last-admin protection (per workspace since A12)', () => {
  it('refuses to demote the last active admin of the workspace and writes nothing', async () => {
    const { svc, tx, audit } = makeService(['a1'], { id: 'a1', role: 'ADMIN', status: 'ACTIVE' });
    await expect(svc.changeRole('a1', 'SUPERVISOR', viewer, ctx)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual([WS]);
    expect(tx.workspaceMembership.updateMany).not.toHaveBeenCalled();
    expect(audit.logCtx).not.toHaveBeenCalled();
  });

  it('refuses to suspend the last active admin', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'a1', role: 'ADMIN', status: 'ACTIVE' });
    await expect(svc.suspend('a1', undefined, viewer, ctx)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another active admin exists, and audits it', async () => {
    const { svc, tx, audit, memberships } = makeService(['a1', 'a2'], { id: 'a2', role: 'ADMIN', status: 'ACTIVE' });
    const dto = await svc.changeRole('a2', 'MONITOR', viewer, ctx);
    expect(dto.role).toBe('MONITOR');
    expect(dto.workspaceRoles).toEqual(['MONITOR']);
    expect(dto.nationalIdMasked).toBe('1•••••••23');
    // Admin viewers get the full value (decrypted on demand).
    expect(dto.nationalId).toBe('1234567823');
    // Only memberships of the active workspace are touched.
    expect(tx.workspaceMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, userId: 'a2' }) }),
    );
    expect(memberships()).toEqual([{ workspaceId: WS, role: 'MONITOR', status: 'ACTIVE' }]);
    expect(audit.logCtx).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: 'user.role_changed', before: { role: 'ADMIN' }, after: { role: 'MONITOR' } }),
      tx,
    );
  });

  it('suspending a non-admin of a single workspace suspends the account and revokes every refresh token', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'u9', role: 'SUPERVISOR', status: 'ACTIVE' });
    const dto = await svc.suspend('u9', 'reason', viewer, ctx);
    expect(dto.status).toBe('SUSPENDED');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u9' }, data: { status: 'SUSPENDED' } });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u9', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('A12: a user who also works in another workspace loses only this membership and its sessions', async () => {
    const { svc, tx, memberships } = makeService(['a1'], { id: 'u9', role: 'MONITOR', status: 'ACTIVE', elsewhere: true });
    const dto = await svc.suspend('u9', undefined, viewer, ctx);
    expect(dto.status).toBe('SUSPENDED'); // as seen from this workspace
    expect(tx.user.update).not.toHaveBeenCalled(); // the account stays ACTIVE for the other workspace
    expect(memberships()).toEqual([
      { workspaceId: WS, role: 'MONITOR', status: 'SUSPENDED' },
      { workspaceId: OTHER_WS, role: 'SUPERVISOR', status: 'ACTIVE' },
    ]);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u9', revokedAt: null, workspaceId: WS },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('promoting to admin never needs the lock', async () => {
    const { svc, tx } = makeService(['a1'], { id: 'u9', role: 'SUPERVISOR', status: 'ACTIVE' });
    await svc.changeRole('u9', 'ADMIN', viewer, ctx);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
