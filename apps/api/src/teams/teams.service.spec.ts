import { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, type Settings } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { ColorsService } from '../colors/colors.service';
import { CryptoService } from '../crypto/crypto.service';
import { canManageMemberIn, canReadTeam, memberScopeWhere } from './team-dto';
import { resolveCreateLeaders } from './team-leaders';
import { TeamsService, type CreateTeamData } from './teams.service';

const ctx: RequestContext = { actorId: 'u1', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };
const OTHER_SUP = 'sup-2';
const THIRD_SUP = 'sup-3';
const COLOR = '11111111-1111-4111-8111-111111111111';

const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

interface LeaderRow {
  id: string;
  teamId: string;
  userId: string;
  isPrimary: boolean;
  validFrom: Date;
  validTo: Date | null;
  addedById: string | null;
  reason: string | null;
}

const p2002 = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0', meta: { target } });

/**
 * In-memory `team_supervisors` that enforces what the database enforces: one open row per
 * (team, user), one open primary per team, and non-empty intervals (CHECK).
 */
function fakeLeaders(seed: Array<Partial<LeaderRow> & { teamId: string; userId: string }> = []) {
  let n = 0;
  const rows: LeaderRow[] = seed.map((r) => ({
    id: `ls-${++n}`,
    isPrimary: false,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    addedById: null,
    reason: null,
    ...r,
  }));
  const check = () => {
    const open = rows.filter((r) => r.validTo === null);
    const pairs = new Set<string>();
    for (const r of open) {
      const k = `${r.teamId}:${r.userId}`;
      if (pairs.has(k)) throw p2002('team_supervisors_one_open_uq');
      pairs.add(k);
    }
    const prim = new Set<string>();
    for (const r of open.filter((x) => x.isPrimary)) {
      if (prim.has(r.teamId)) throw p2002('team_supervisors_one_primary_uq');
      prim.add(r.teamId);
    }
    for (const r of rows) if (r.validTo && r.validTo <= r.validFrom) throw new Error('team_supervisors_interval_chk');
  };
  const match = (r: LeaderRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  const delegate = {
    rows,
    open: (teamId: string) => rows.filter((r) => r.teamId === teamId && r.validTo === null),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((r) => match(r, where))
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.validFrom.getTime() - b.validFrom.getTime())
        .map((r) => ({ ...r, user: { id: r.userId, fullName: `مشرف ${r.userId}` } })),
    ),
    create: jest.fn(async ({ data }: { data: Partial<LeaderRow> & { teamId: string; userId: string } }) => {
      const row: LeaderRow = { id: `ls-${++n}`, isPrimary: false, validFrom: new Date(), validTo: null, addedById: null, reason: null, ...data };
      rows.push(row);
      try {
        check();
      } catch (e) {
        rows.pop();
        throw e;
      }
      return row;
    }),
    createMany: jest.fn(async ({ data }: { data: Array<Partial<LeaderRow> & { teamId: string; userId: string }> }) => {
      for (const d of data) await delegate.create({ data: d });
      return { count: data.length };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<LeaderRow> }) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) Object.assign(r, data);
      check();
      return { count: hit.length };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<LeaderRow> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      check();
      return r;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const i = rows.findIndex((x) => x.id === where.id);
      return rows.splice(i, 1)[0];
    }),
  };
  return delegate;
}

function setup(
  opts: {
    settings?: Partial<Settings>;
    existingTeam?: { supervisorId: string; status?: string };
    coSupervisors?: string[];
  } = {},
) {
  let createdData: Record<string, unknown> = {};
  const leaders = fakeLeaders(
    opts.existingTeam
      ? [
          { teamId: 't-1', userId: opts.existingTeam.supervisorId, isPrimary: true },
          ...(opts.coSupervisors ?? []).map((userId) => ({ teamId: 't-1', userId })),
        ]
      : [],
  );
  const teamState = { supervisorId: opts.existingTeam?.supervisorId ?? SUP.id };
  const teamRow = (id = opts.existingTeam ? 't-1' : 't-new') => ({
    id,
    name: String(createdData.name ?? 'فريق'),
    status: createdData.status ?? opts.existingTeam?.status ?? 'ACTIVE',
    supervisorId: String(createdData.supervisorId ?? teamState.supervisorId),
    createdAt: new Date('2026-10-12T08:00:00Z'),
    color: { id: COLOR, name: 'أزرق', hex: '#1D4ED8', isActive: true },
    supervisor: { id: SUP.id, fullName: 'مشرف' },
    supervisors: leaders.open(id).map((r) => ({
      userId: r.userId,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom,
      user: { id: r.userId, fullName: `مشرف ${r.userId}`, photoFileId: null },
    })),
    orgUnit: null,
    visibility: null,
    _count: { memberships: 0 },
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 't-1' }]),
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
            ? {
                id: 't-1',
                name: 'قديم',
                colorId: COLOR,
                status: 'ACTIVE',
                orgUnitId: null,
                ...opts.existingTeam,
                supervisorId: teamState.supervisorId,
                supervisors: leaders.open('t-1').map((r) => ({ userId: r.userId })),
              }
            : null,
        ),
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(teamRow(where.id))),
      update: jest.fn(({ data }: { data: { supervisorId?: string } }) => {
        if (data.supervisorId) teamState.supervisorId = data.supervisorId;
        return Promise.resolve(teamRow());
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    teamColor: {
      findUnique: jest.fn().mockResolvedValue({ isActive: true }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    teamSupervisor: leaders,
    teamMember: { findMany: jest.fn().mockResolvedValue([]), createManyAndReturn: jest.fn().mockResolvedValue([]) },
    teamMembership: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ role: 'SUPERVISOR', status: 'ACTIVE' }),
      // A12: "an ACTIVE SUPERVISOR of this workspace" — derived from the findUnique fixture above.
      findFirst: jest.fn(async (args: { where: { id: string } }): Promise<{ id: string } | null> => {
        const u = (await tx.user.findUnique(args as never)) as { role: string; status: string } | null;
        return u && u.role === 'SUPERVISOR' && u.status === 'ACTIVE' ? { id: args.where.id } : null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orgUnit: { findUnique: jest.fn().mockResolvedValue({ archivedAt: null }) },
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
    // A12 round 2: a supervisor's inline workers in a team active at once become requests.
    { requestAdd: jest.fn().mockResolvedValue(undefined) } as never,
  );
  const actions = () => tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
  return { svc, tx, prisma, notifications, users, leaders, teamState, actions, created: () => createdData };
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
    const dto = await s.svc.create(input({ supervisorId: 'ignored-other-user', supervisorIds: ['also-ignored'] }), SUP, ctx);
    expect(s.created()).toMatchObject({ status: 'PENDING_APPROVAL', supervisorId: SUP.id });
    expect(s.leaders.open('t-new').map((r) => [r.userId, r.isPrimary])).toEqual([[SUP.id, true]]);
    expect(s.created().approvedAt).toBeUndefined();
    expect(dto.status).toBe('PENDING_APPROVAL');
    expect(s.notifications.notifyAdmins).toHaveBeenCalledWith(
      'TEAM_PENDING_APPROVAL',
      expect.objectContaining({ teamId: 't-new' }),
    );
    expect(s.actions()).toContain('team.created');
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
    s.tx.team.findFirst.mockImplementation(({ where }: { where: { supervisors?: unknown } }) =>
      Promise.resolve(where.supervisors ? { id: 'other-team' } : null),
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
    s.tx.team.create.mockRejectedValue(p2002('teams_color_reserved_uq'));
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

describe('A9 — several supervisors at creation (ADR-100)', () => {
  it('resolveCreateLeaders: primary = explicit, else the new supervisor, else supervisorId, else the first id', () => {
    expect(resolveCreateLeaders({ isAdmin: true, viewerId: 'a', supervisorIds: ['x', 'y'] })).toEqual({ ids: ['x', 'y'], primary: 'x' });
    expect(resolveCreateLeaders({ isAdmin: true, viewerId: 'a', supervisorIds: ['x', 'y'], primarySupervisorId: 'y' }).primary).toBe('y');
    expect(resolveCreateLeaders({ isAdmin: true, viewerId: 'a', supervisorId: 'z', supervisorIds: ['x', 'z'] })).toEqual({
      ids: ['z', 'x'],
      primary: 'z',
    });
    expect(resolveCreateLeaders({ isAdmin: true, viewerId: 'a', newSupervisorId: 'n', supervisorIds: ['x'] }).primary).toBe('n');
    expect(() => resolveCreateLeaders({ isAdmin: true, viewerId: 'a', supervisorIds: ['x'], primarySupervisorId: 'q' })).toThrow(AppError);
    expect(() => resolveCreateLeaders({ isAdmin: true, viewerId: 'a' })).toThrow(AppError);
    expect(resolveCreateLeaders({ isAdmin: false, viewerId: 'me', supervisorIds: ['x'] })).toEqual({ ids: ['me'], primary: 'me' });
  });

  it('admin with supervisorIds opens one row each at the same instant, exactly one primary, synced to teams.supervisor_id', async () => {
    const s = setup();
    await s.svc.create(input({ supervisorIds: [OTHER_SUP, THIRD_SUP], primarySupervisorId: THIRD_SUP }), ADMIN, ctx);
    const open = s.leaders.open('t-new');
    expect(open.map((r) => r.userId).sort()).toEqual([OTHER_SUP, THIRD_SUP]);
    expect(open.filter((r) => r.isPrimary).map((r) => r.userId)).toEqual([THIRD_SUP]);
    expect(new Set(open.map((r) => r.validFrom.getTime())).size).toBe(1);
    expect(s.created().supervisorId).toBe(THIRD_SUP);
    const audit = s.tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string; after: unknown } }).data).find((d) => d.action === 'team.created');
    expect(audit?.after).toMatchObject({ supervisorId: THIRD_SUP, supervisorIds: [OTHER_SUP, THIRD_SUP] });
  });

  it('every named supervisor must be an active SUPERVISOR; ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR is checked per person', async () => {
    const s = setup();
    s.tx.user.findUnique.mockImplementation((({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === THIRD_SUP ? { role: 'MONITOR', status: 'ACTIVE' } : { role: 'SUPERVISOR', status: 'ACTIVE' })) as never);
    await expectCode(s.svc.create(input({ supervisorIds: [OTHER_SUP, THIRD_SUP] }), ADMIN, ctx), 'NOT_A_SUPERVISOR');

    const t = setup({ settings: { ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR: false } });
    t.tx.team.findFirst.mockImplementation((({ where }: { where: { supervisors?: { some: { userId: string } } } }) =>
      Promise.resolve(where.supervisors?.some.userId === THIRD_SUP ? { id: 'busy' } : null)) as never);
    const err = await t.svc.create(input({ supervisorIds: [OTHER_SUP, THIRD_SUP] }), ADMIN, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('MULTIPLE_TEAMS_DISABLED');
    expect((err as AppError).details).toEqual({ userId: THIRD_SUP });
  });

  it('a supervisor may not link an organisational unit', async () => {
    await expectCode(setup().svc.create(input({ orgUnitId: '22222222-2222-4222-8222-222222222222' }), SUP, ctx), 'FORBIDDEN');
  });
});

describe('A9 — managing supervisors (ADR-100)', () => {
  it('add: a co-supervisor gets an open non-primary row; the primary is unchanged', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    const dto = await s.svc.addSupervisor('t-1', { userId: OTHER_SUP, isPrimary: false }, ADMIN, ctx);
    expect(s.leaders.open('t-1').map((r) => [r.userId, r.isPrimary])).toEqual([
      [SUP.id, true],
      [OTHER_SUP, false],
    ]);
    expect(dto.supervisors?.map((x) => [x.id, x.isPrimary])).toEqual([
      [SUP.id, true],
      [OTHER_SUP, false],
    ]);
    expect(s.teamState.supervisorId).toBe(SUP.id);
    expect(s.actions()).toEqual(['team.supervisor_added']);
  });

  it('add twice → SUPERVISOR_ALREADY_IN_TEAM; add with isPrimary switches the primary and keeps the old one as co-supervisor', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    await s.svc.addSupervisor('t-1', { userId: OTHER_SUP, isPrimary: false }, ADMIN, ctx);
    await expectCode(s.svc.addSupervisor('t-1', { userId: OTHER_SUP, isPrimary: false }, ADMIN, ctx), 'SUPERVISOR_ALREADY_IN_TEAM');
    await s.svc.addSupervisor('t-1', { userId: THIRD_SUP, isPrimary: true }, ADMIN, ctx);
    const open = s.leaders.open('t-1');
    expect(open.filter((r) => r.isPrimary).map((r) => r.userId)).toEqual([THIRD_SUP]);
    expect(open.map((r) => r.userId).sort()).toEqual([SUP.id, OTHER_SUP, THIRD_SUP].sort());
    expect(s.teamState.supervisorId).toBe(THIRD_SUP);
    // History: the old primary's row was closed and reopened as non-primary at the same instant.
    const sup = s.leaders.rows.filter((r) => r.userId === SUP.id);
    expect(sup).toHaveLength(2);
    expect(sup[0]!.validTo).toEqual(sup[1]!.validFrom);
  });

  it('remove: the primary cannot go without a new primary; the last supervisor cannot go at all', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP] });
    await expectCode(s.svc.removeSupervisor('t-1', SUP.id, { reason: 'نقل' }, ADMIN, ctx), 'PRIMARY_SUPERVISOR_REQUIRED');
    await expectCode(
      s.svc.removeSupervisor('t-1', SUP.id, { reason: 'نقل', newPrimaryUserId: THIRD_SUP }, ADMIN, ctx),
      'VALIDATION_FAILED',
    );
    await s.svc.removeSupervisor('t-1', SUP.id, { reason: 'نقل', newPrimaryUserId: OTHER_SUP }, ADMIN, ctx);
    expect(s.leaders.open('t-1').map((r) => [r.userId, r.isPrimary])).toEqual([[OTHER_SUP, true]]);
    expect(s.teamState.supervisorId).toBe(OTHER_SUP);
    await expectCode(s.svc.removeSupervisor('t-1', OTHER_SUP, { reason: 'نقل' }, ADMIN, ctx), 'LAST_SUPERVISOR');
    expect(s.actions()).toEqual(['team.supervisor_removed']);
  });

  it('remove a co-supervisor closes only their row; an unknown user → NOT_FOUND', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP] });
    await s.svc.removeSupervisor('t-1', OTHER_SUP, { reason: 'انتهى التكليف' }, ADMIN, ctx);
    expect(s.leaders.open('t-1').map((r) => r.userId)).toEqual([SUP.id]);
    expect(s.leaders.rows.find((r) => r.userId === OTHER_SUP)!.validTo).toBeInstanceOf(Date);
    await expectCode(s.svc.removeSupervisor('t-1', THIRD_SUP, { reason: 'x x x' }, ADMIN, ctx), 'NOT_FOUND');
  });

  it('set primary: one primary invariant holds after every change; teams.supervisor_id follows', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP, THIRD_SUP] });
    for (const next of [OTHER_SUP, THIRD_SUP, SUP.id, SUP.id]) {
      await s.svc.setPrimarySupervisor('t-1', next, {}, ADMIN, ctx);
      const open = s.leaders.open('t-1');
      expect(open.filter((r) => r.isPrimary).map((r) => r.userId)).toEqual([next]);
      expect(open).toHaveLength(3);
      expect(s.teamState.supervisorId).toBe(next);
    }
    // The last call was a no-op (already primary): three changes audited.
    expect(s.actions()).toEqual(Array(3).fill('team.primary_supervisor_changed'));
    await expectCode(s.svc.setPrimarySupervisor('t-1', 'stranger', {}, ADMIN, ctx), 'NOT_FOUND');
  });

  it('legacy changeSupervisor replaces the primary and keeps co-supervisors', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP] });
    await s.svc.changeSupervisor('t-1', { supervisorId: THIRD_SUP, reason: 'إجازة' }, ADMIN, ctx);
    expect(s.leaders.open('t-1').map((r) => [r.userId, r.isPrimary]).sort()).toEqual(
      [
        [OTHER_SUP, false],
        [THIRD_SUP, true],
      ].sort(),
    );
    const closed = s.leaders.rows.find((r) => r.userId === SUP.id)!;
    const opened = s.leaders.rows.find((r) => r.userId === THIRD_SUP)!;
    expect(closed.validTo).toEqual(opened.validFrom); // ADR-013: one instant
    expect(s.teamState.supervisorId).toBe(THIRD_SUP);
    expect(s.actions()).toEqual(['team.supervisor_changed']);
  });

  it('only an admin path: a supervisor of the team may not add supervisors (the guard needs teams.manageAll; the service scope refuses others)', async () => {
    const s = setup({ existingTeam: { supervisorId: OTHER_SUP } });
    await expectCode(s.svc.addSupervisor('t-1', { userId: THIRD_SUP, isPrimary: false }, SUP, ctx), 'NOT_FOUND');
  });
});

describe('A9 — "leads the team" = any open row (ADR-100)', () => {
  const team = { supervisors: [{ userId: SUP.id }, { userId: OTHER_SUP }] };
  const second = { id: OTHER_SUP, role: 'SUPERVISOR' as const, status: 'ACTIVE' };

  it('a second supervisor reads and manages the team and its members', () => {
    expect(canReadTeam(second, team)).toBe(true);
    expect(canManageMemberIn(second, team)).toBe(true);
    expect(canReadTeam({ id: THIRD_SUP, role: 'SUPERVISOR', status: 'ACTIVE' }, team)).toBe(false);
    expect(memberScopeWhere(second)).toEqual({
      OR: [
        { memberships: { some: { validTo: null, team: { supervisors: { some: { userId: OTHER_SUP, validTo: null } } } } } },
        { memberships: { none: { validTo: null } } },
      ],
    });
  });

  it('the second supervisor may rename the team, and list filters on any open row', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP] });
    await s.svc.update('t-1', { name: 'اسم جديد' }, second, ctx);
    expect(s.tx.team.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'اسم جديد' } }));
    await s.svc.list({}, second);
    expect(s.tx.team.findMany.mock.calls[0]![0].where).toMatchObject({ supervisors: { some: { userId: OTHER_SUP, validTo: null } } });
  });

  it('a supervisor may not change the organisational link', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    await expectCode(s.svc.update('t-1', { orgUnitId: '22222222-2222-4222-8222-222222222222' }, SUP, ctx), 'FORBIDDEN');
    await s.svc.update('t-1', { orgUnitId: '22222222-2222-4222-8222-222222222222' }, ADMIN, ctx);
    expect(s.actions()).toEqual(['team.updated']);
  });
});

describe('A9 — worker foreman (ADR-101)', () => {
  it('set: a current member becomes FOREMAN; the previous foreman returns to WORKER; audited', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    s.tx.teamMembership.findFirst
      .mockResolvedValueOnce({ id: 'ms-new', role: 'WORKER', member: { userId: null } } as never)
      .mockResolvedValueOnce({ id: 'ms-old', memberId: 'm-old' } as never);
    await s.svc.setForeman('t-1', 'm-new', SUP, ctx);
    expect(s.tx.teamMembership.update.mock.calls).toEqual([
      [{ where: { id: 'ms-old' }, data: { role: 'WORKER' } }],
      [{ where: { id: 'ms-new' }, data: { role: 'FOREMAN' } }],
    ]);
    const entry = s.tx.auditLog.create.mock.calls[0]![0].data;
    expect(entry).toMatchObject({ action: 'team.foreman_set', before: { foremanId: 'm-old' }, after: { foremanId: 'm-new' } });
  });

  it('not a current member → FOREMAN_NOT_MEMBER; a member with an account → FOREMAN_HAS_ACCOUNT', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    s.tx.teamMembership.findFirst.mockResolvedValueOnce(null);
    await expectCode(s.svc.setForeman('t-1', 'm-x', ADMIN, ctx), 'FOREMAN_NOT_MEMBER');
    s.tx.teamMembership.findFirst.mockResolvedValueOnce({ id: 'ms', role: 'WORKER', member: { userId: 'u-9' } } as never);
    await expectCode(s.svc.setForeman('t-1', 'm-x', ADMIN, ctx), 'FOREMAN_HAS_ACCOUNT');
    expect(s.tx.teamMembership.update).not.toHaveBeenCalled();
  });

  it("another supervisor's team → NOT_FOUND; the same foreman again changes nothing", async () => {
    await expectCode(setup({ existingTeam: { supervisorId: OTHER_SUP } }).svc.setForeman('t-1', 'm', SUP, ctx), 'NOT_FOUND');
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    s.tx.teamMembership.findFirst.mockResolvedValueOnce({ id: 'ms', role: 'FOREMAN', member: { userId: null } } as never);
    await s.svc.setForeman('t-1', 'm', SUP, ctx);
    expect(s.tx.teamMembership.update).not.toHaveBeenCalled();
    expect(s.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('a concurrent second foreman (partial unique index) maps to 409 CONFLICT_VERSION', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    s.tx.teamMembership.findFirst
      .mockResolvedValueOnce({ id: 'ms-new', role: 'WORKER', member: { userId: null } } as never)
      .mockResolvedValueOnce(null);
    s.tx.teamMembership.update.mockRejectedValueOnce(p2002('team_memberships_one_foreman_uq'));
    await expectCode(s.svc.setForeman('t-1', 'm-new', SUP, ctx), 'CONFLICT_VERSION');
  });

  it('clear: back to WORKER (audited); no foreman → nothing to do', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    s.tx.teamMembership.findFirst.mockResolvedValueOnce({ id: 'ms', memberId: 'm-1' } as never);
    await s.svc.clearForeman('t-1', ADMIN, ctx);
    expect(s.tx.teamMembership.update).toHaveBeenCalledWith({ where: { id: 'ms' }, data: { role: 'WORKER' } });
    expect(s.actions()).toEqual(['team.foreman_cleared']);
    const t = setup({ existingTeam: { supervisorId: SUP.id } });
    await t.svc.clearForeman('t-1', ADMIN, ctx);
    expect(t.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('team detail lists the foreman first and flags him', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id } });
    const member = (id: string, fullName: string, role: string) => ({
      id,
      fullName,
      nationalIdEnc: Buffer.from(''),
      nationalIdHash: id,
      nationalIdFirst: '1',
      nationalIdLast4: '1234',
      jobTitleId: null,
      jobTitleText: null,
      departmentId: null,
      departmentText: null,
      photoFileId: null,
      status: 'ACTIVE',
      jobTitle: null,
      department: null,
      memberships: [{ teamId: 't-1', role, team: { id: 't-1', name: 'ف', status: 'ACTIVE', supervisors: [], color: { id: COLOR, name: 'أزرق', hex: '#1D4ED8', isActive: true } } }],
    });
    s.tx.team.findUnique.mockResolvedValueOnce({ ...(await s.tx.team.findUniqueOrThrow({ where: { id: 't-1' } })) } as never);
    s.tx.teamMember.findMany.mockResolvedValueOnce([member('a', 'أحمد', 'WORKER'), member('b', 'بدر', 'FOREMAN')] as never);
    const detail = await s.svc.get('t-1', SUP);
    expect(detail.members.map((m) => [m.id, m.isForeman])).toEqual([
      ['b', true],
      ['a', false],
    ]);
    expect(detail.foreman).toEqual({ id: 'b', fullName: 'بدر' });
  });
});

describe('TeamsService — supervisor scope (teams.readOwn / manageOwn)', () => {
  it("get: another supervisor's team is NOT_FOUND (existence not revealed)", async () => {
    const s = setup();
    s.tx.team.findUnique.mockResolvedValue({ id: 't-1', supervisors: [{ userId: OTHER_SUP }] } as never);
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
  it('archive frees the colour (status ARCHIVED) and closes memberships and every leadership row with one timestamp', async () => {
    const s = setup({ existingTeam: { supervisorId: SUP.id }, coSupervisors: [OTHER_SUP] });
    await s.svc.archive('t-1', 'انتهى المشروع', ADMIN, ctx);
    const archivedAt = s.tx.team.updateMany.mock.calls[0]![0].data.archivedAt as Date;
    expect(s.tx.team.updateMany.mock.calls[0]![0].data.status).toBe('ARCHIVED');
    expect(s.tx.teamMembership.updateMany.mock.calls[0]![0].data.validTo).toBe(archivedAt);
    expect(s.leaders.open('t-1')).toHaveLength(0);
    expect(s.leaders.rows.every((r) => r.validTo === archivedAt)).toBe(true);
    expect(s.tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({ action: 'team.archived' });
  });

  it('approve only works on a pending team; approval notifies every supervisor', async () => {
    const s = setup();
    s.tx.team.findUnique.mockResolvedValue({ status: 'ACTIVE' } as never);
    await expectCode(s.svc.approve('t-1', ADMIN, ctx), 'NOT_PENDING_TEAM');

    const t = setup({ existingTeam: { supervisorId: SUP.id, status: 'PENDING_APPROVAL' }, coSupervisors: [OTHER_SUP] });
    t.tx.team.findUnique.mockResolvedValue({ status: 'PENDING_APPROVAL' } as never);
    await t.svc.approve('t-1', ADMIN, ctx);
    expect(t.notifications.notify).toHaveBeenCalledWith([SUP.id, OTHER_SUP], 'TEAM_APPROVED', expect.anything());
  });
});
