import { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, type Settings } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { ColorsService } from '../colors/colors.service';
import { CryptoService } from '../crypto/crypto.service';
import { TeamsService, type CreateTeamData } from './teams.service';

const ctx: RequestContext = { actorId: 'u1', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };
const OTHER_SUP = 'sup-2';
const COLOR = '11111111-1111-4111-8111-111111111111';

const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

function setup(opts: { settings?: Partial<Settings>; existingTeam?: { supervisorId: string; status?: string } } = {}) {
  let createdData: Record<string, unknown> = {};
  const teamRow = () => ({
    id: 't-new',
    name: String(createdData.name ?? 'فريق'),
    status: createdData.status ?? opts.existingTeam?.status ?? 'ACTIVE',
    supervisorId: String(createdData.supervisorId ?? opts.existingTeam?.supervisorId ?? SUP.id),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    color: { id: COLOR, name: 'أزرق', hex: '#1D4ED8', isActive: true },
    supervisor: { id: SUP.id, fullName: 'مشرف' },
    visibility: null,
    _count: { memberships: 0 },
  });
  const tx = {
    team: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return Promise.resolve({ id: 't-new' });
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.existingTeam
            ? { id: 't-1', name: 'قديم', colorId: COLOR, status: 'ACTIVE', ...opts.existingTeam }
            : null,
        ),
      ),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(teamRow())),
      update: jest.fn(() => Promise.resolve(teamRow())),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    teamColor: {
      findUnique: jest.fn().mockResolvedValue({ isActive: true }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    teamSupervisorHistory: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    teamMember: { findMany: jest.fn().mockResolvedValue([]), createManyAndReturn: jest.fn().mockResolvedValue([]) },
    teamMembership: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ role: 'SUPERVISOR', status: 'ACTIVE' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    jobTitle: { findMany: jest.fn().mockResolvedValue([]) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    violationVisibility: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = new AuditService(prisma as never);
  const all = { ...DEFAULT_SETTINGS, ...opts.settings };
  const settings = { get: jest.fn((k: keyof Settings) => Promise.resolve(all[k])) };
  const notifications = {
    notify: jest.fn().mockResolvedValue(undefined),
    notifyAdmins: jest.fn().mockResolvedValue(undefined),
    safe: jest.fn(),
  };
  const users = {
    createInTx: jest.fn().mockResolvedValue({ user: { id: 'new-sup', email: 'n@x.sa', fullName: 'جديد' }, token: 'tok' }),
    sendSetPasswordEmail: jest.fn().mockResolvedValue(undefined),
  };
  const colors = new ColorsService(prisma as never, audit);
  const svc = new TeamsService(
    prisma as never,
    crypto,
    audit,
    notifications as never,
    settings as never,
    users as never,
    colors,
  );
  return { svc, tx, prisma, notifications, users, created: () => createdData };
}

const input = (extra: Partial<CreateTeamData> = {}): CreateTeamData => ({
  name: 'فريق الصيانة',
  colorId: COLOR,
  members: [],
  existingMemberIds: [],
  ...extra,
});

describe('TeamsService.create — status by role and setting (brief §5.1)', () => {
  it('supervisor + REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS on → PENDING_APPROVAL, self as leader, admins notified', async () => {
    const s = setup({ settings: { REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: true } });
    const dto = await s.svc.create(input({ supervisorId: 'ignored-other-user' }), SUP, ctx);
    expect(s.created()).toMatchObject({ status: 'PENDING_APPROVAL', supervisorId: SUP.id });
    expect(s.created().approvedAt).toBeUndefined();
    expect(dto.status).toBe('PENDING_APPROVAL');
    expect(s.notifications.notifyAdmins).toHaveBeenCalledWith(
      'TEAM_PENDING_APPROVAL',
      expect.objectContaining({ teamId: 't-new' }),
    );
    expect(s.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'team.created' }) }),
    );
  });

  it('supervisor + setting off → ACTIVE at once, nobody notified', async () => {
    const s = setup({ settings: { REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: false } });
    await s.svc.create(input(), SUP, ctx);
    expect(s.created()).toMatchObject({ status: 'ACTIVE', supervisorId: SUP.id });
    expect(s.notifications.notifyAdmins).not.toHaveBeenCalled();
  });

  it('admin → ACTIVE with the chosen supervisor', async () => {
    const s = setup();
    await s.svc.create(input({ supervisorId: OTHER_SUP }), ADMIN, ctx);
    expect(s.created()).toMatchObject({ status: 'ACTIVE', supervisorId: OTHER_SUP, approvedById: ADMIN.id });
  });

  it('admin must pick or create a supervisor', async () => {
    await expectCode(setup().svc.create(input(), ADMIN, ctx), 'VALIDATION_FAILED');
  });

  it('admin with an inline new supervisor creates an ACTIVE SUPERVISOR user and e-mails the link after commit', async () => {
    const s = setup();
    const newSupervisor = { fullName: 'مشرف جديد', email: 'n@x.sa', mobile: '+966500000009', nationalId: '1000000008' };
    await s.svc.create(input({ newSupervisor }), ADMIN, ctx);
    expect(s.users.createInTx).toHaveBeenCalledWith(s.tx, { ...newSupervisor, role: 'SUPERVISOR' }, ADMIN, ctx);
    expect(s.created().supervisorId).toBe('new-sup');
    expect(s.users.sendSetPasswordEmail).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-sup' }), 'tok');
  });

  it('the leader of an existing team is refused when ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR is off', async () => {
    const s = setup({ settings: { ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR: false, REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: false } });
    s.tx.team.findFirst.mockImplementation(({ where }: { where: { supervisorId?: string } }) =>
      Promise.resolve(where.supervisorId ? { id: 'other-team' } : null),
    );
    await expectCode(s.svc.create(input(), SUP, ctx), 'MULTIPLE_TEAMS_DISABLED');
    expect(s.tx.team.create).not.toHaveBeenCalled();
  });

  it('a colour already reserved is refused before insert with COLOR_TAKEN', async () => {
    const s = setup();
    s.tx.team.findFirst.mockImplementation(({ where }: { where: { colorId?: string } }) =>
      Promise.resolve(where.colorId ? { id: 'holder' } : null),
    );
    await expectCode(s.svc.create(input({ supervisorId: OTHER_SUP }), ADMIN, ctx), 'COLOR_TAKEN');
  });

  it('the concurrent loser (partial unique index) gets 409 COLOR_TAKEN with a refreshed picker', async () => {
    const s = setup();
    s.tx.team.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: 'teams_color_reserved_uq' },
      }),
    );
    const err = await s.svc.create(input({ supervisorId: OTHER_SUP }), ADMIN, ctx).catch((e: AppError) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('COLOR_TAKEN');
    expect((err as AppError).status).toBe(409);
    expect((err as AppError).details).toMatchObject({ refresh: 'colors', available: [] });
  });

  it('a retired colour is refused', async () => {
    const s = setup();
    s.tx.teamColor.findUnique.mockResolvedValue({ isActive: false });
    await expectCode(s.svc.create(input({ supervisorId: OTHER_SUP }), ADMIN, ctx), 'COLOR_INACTIVE');
  });
});

describe('TeamsService — supervisor scope (teams.readOwn / manageOwn)', () => {
  it('list: a supervisor is filtered to the teams they lead; an admin is not', async () => {
    const s = setup();
    await s.svc.list({}, SUP);
    expect(s.tx.team.findMany.mock.calls[0]![0].where).toMatchObject({ supervisorId: SUP.id });
    await s.svc.list({ status: 'ALL' }, ADMIN);
    expect(s.tx.team.findMany.mock.calls[1]![0].where.supervisorId).toBeUndefined();
  });

  it("get: another supervisor's team is NOT_FOUND (existence not revealed)", async () => {
    const s = setup();
    s.tx.team.findUnique.mockResolvedValue({ id: 't-1', supervisorId: OTHER_SUP } as never);
    await expectCode(s.svc.get('t-1', SUP), 'NOT_FOUND');
  });

  it("update/archive: a supervisor cannot touch another supervisor's team", async () => {
    const s = setup({ existingTeam: { supervisorId: OTHER_SUP } });
    await expectCode(s.svc.update('t-1', { name: 'جديد' }, SUP, ctx), 'NOT_FOUND');
    await expectCode(s.svc.archive('t-1', 'سبب كافٍ', SUP, ctx), 'NOT_FOUND');
    expect(s.tx.team.update).not.toHaveBeenCalled();
  });

  it('update: a supervisor may rename their own team (audited)', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    await s.svc.update('t-1', { name: 'اسم جديد' }, SUP, ctx);
    expect(s.tx.team.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'اسم جديد' } }));
    expect(s.tx.auditLog.create.mock.calls[0]![0].data.action).toBe('team.updated');
  });
});

describe('TeamsService — history with one timestamp (ADR-013)', () => {
  it('changeSupervisor closes and opens team_supervisor_history at the same instant', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    await s.svc.changeSupervisor('t-1', { supervisorId: OTHER_SUP, reason: 'إجازة' }, ADMIN, ctx);
    const closedAt = s.tx.teamSupervisorHistory.updateMany.mock.calls[0]![0].data.validTo as Date;
    const openedAt = s.tx.teamSupervisorHistory.create.mock.calls[0]![0].data.validFrom as Date;
    expect(closedAt).toBeInstanceOf(Date);
    expect(openedAt).toBe(closedAt);
    expect(s.tx.team.update).toHaveBeenCalledWith(expect.objectContaining({ data: { supervisorId: OTHER_SUP } }));
    expect(s.tx.auditLog.create.mock.calls[0]![0].data.action).toBe('team.supervisor_changed');
  });

  it('archive frees the colour (status ARCHIVED) and closes memberships with one timestamp', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    await s.svc.archive('t-1', 'انتهى المشروع', ADMIN, ctx);
    const archivedAt = s.tx.team.updateMany.mock.calls[0]![0].data.archivedAt as Date;
    expect(s.tx.team.updateMany.mock.calls[0]![0].data.status).toBe('ARCHIVED');
    expect(s.tx.teamMembership.updateMany.mock.calls[0]![0].data.validTo).toBe(archivedAt);
    expect(s.tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({ action: 'team.archived' });
  });

  it('approve only works on a pending team', async () => {
    const s = setup();
    s.tx.team.findUnique.mockResolvedValue({ status: 'ACTIVE' } as never);
    await expectCode(s.svc.approve('t-1', ADMIN, ctx), 'NOT_PENDING_TEAM');
  });
});
