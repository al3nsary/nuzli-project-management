import { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, type Settings } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { sanitizeDeviceInfo } from './violation-dto';
import { snapshotSql, ViolationsService, type CreateViolationData } from './violations.service';

const ctx: RequestContext = { actorId: 'mon-1', ip: null, requestId: 'r1', userAgent: null };
const MONITOR = { id: 'mon-1', role: 'MONITOR' as const, status: 'ACTIVE' };
const OTHER_MONITOR = { id: 'mon-2', role: 'MONITOR' as const, status: 'ACTIVE' };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };

const MEMBER = '10000000-0000-4000-8000-000000000001';
const TYPE = '20000000-0000-4000-8000-000000000001';
const TEAM_A = 'a0000000-0000-4000-8000-00000000000a';
const TEAM_B = 'b0000000-0000-4000-8000-00000000000b';
const SUP_A = 'ca000000-0000-4000-8000-0000000000aa';
const UUID = 'c1000000-0000-4000-8000-000000000001';

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

/** A stored violation as VIOLATION_SELECT returns it. */
function violationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    clientUuid: UUID,
    memberId: MEMBER,
    teamIdSnapshot: TEAM_A,
    supervisorIdsSnapshot: [SUP_A],
    assignedAt: null,
    assignedBy: null,
    ocr: null,
    expectedPerson: 1,
    recordedById: MONITOR.id,
    description: 'وصف المخالفة',
    notes: null,
    latitude: 24.7,
    longitude: 46.7,
    accuracyM: 8,
    capturedAt: new Date('2026-10-12T06:00:00Z'),
    receivedAt: new Date('2026-10-12T06:05:00Z'),
    clientSentAt: null,
    clockDriftSuspect: false,
    deviceInfo: {},
    expectedIdPhotos: 1,
    expectedEvidence: 2,
    status: 'SUBMITTED',
    cancelReason: null,
    typeId: TYPE,
    member: { id: MEMBER, fullName: 'عامر سالم', nationalIdFirst: '1', nationalIdLast4: '1234' },
    team: { id: TEAM_A, name: 'فريق أ', color: { id: 'c', name: 'أزرق', hex: '#1D4ED8', isActive: true } },
    supervisor: { id: SUP_A, fullName: 'مشرف أ' },
    recordedBy: { id: MONITOR.id, fullName: 'مراقب' },
    type: { id: TYPE, name: 'نوع', severity: 'HIGH', isActive: true },
    files: [
      { kind: 'ID_CARD', file: { id: 'f-id', mimeType: 'image/jpeg', status: 'READY', deletedAt: null } },
      { kind: 'EVIDENCE', file: { id: 'f-ev', mimeType: 'image/jpeg', status: 'READY', deletedAt: null } },
      { kind: 'PERSON', file: { id: 'f-person', mimeType: 'image/jpeg', status: 'READY', deletedAt: null } },
    ],
    responses: [],
    ...over,
  };
}

/**
 * Membership + supervisor history fixtures. The `$queryRaw` mock evaluates the snapshot query
 * against them using the instants bound in the SQL, so the test exercises the real parameters.
 */
interface Interval {
  teamId: string;
  from: string;
  to: string | null;
}

function setup(
  opts: {
    settings?: Partial<Settings>;
    existing?: Record<string, unknown> | null;
    memberships?: Interval[];
    supervisors?: Array<{ teamId: string; supervisorId: string; from: string; to: string | null; isPrimary?: boolean }>;
    found?: Record<string, unknown> | null;
  } = {},
) {
  const all = { ...DEFAULT_SETTINGS, ...opts.settings };
  const settings = { get: jest.fn((k: keyof Settings) => Promise.resolve(all[k])) };
  let created: Record<string, unknown> | null = null;
  const within = (from: string, to: string | null, t: Date) =>
    new Date(from) <= t && (to === null || new Date(to) > t);

  const tx = {
    $queryRaw: jest.fn((sql: Prisma.Sql) => {
      const at = sql.values[0] as Date;
      const memberships = (opts.memberships ?? []).filter((m) => within(m.from, m.to, at));
      const m = memberships.sort((a, b) => b.from.localeCompare(a.from))[0];
      if (!m) return Promise.resolve([]);
      const open = (opts.supervisors ?? []).filter((s) => s.teamId === m.teamId && within(s.from, s.to, at));
      const primary = open.find((s) => s.isPrimary !== false);
      const ids = [...open].sort((a, b) => Number(b.isPrimary !== false) - Number(a.isPrimary !== false)).map((s) => s.supervisorId);
      return Promise.resolve([{ team_id: m.teamId, supervisor_id: primary?.supervisorId ?? null, supervisor_ids: ids }]);
    }),
    violation: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created = data;
        return Promise.resolve({ id: 'v-new' });
      }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve(
          violationRow({
            ...(created
              ? {
                  id: 'v-new',
                  teamIdSnapshot: created.teamIdSnapshot,
                  clockDriftSuspect: created.clockDriftSuspect,
                  team: created.teamIdSnapshot ? violationRow().team : null,
                }
              : {}),
          }),
        ),
      ),
    },
    violationResponse: { create: jest.fn().mockResolvedValue({ id: 'resp-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...tx,
    violation: {
      ...tx.violation,
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.found === undefined ? violationRow() : opts.found),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ id: MEMBER, status: 'ACTIVE', archivedAt: null }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    violationType: { findUnique: jest.fn().mockResolvedValue({ id: TYPE, isActive: true }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]) },
    file: { findUnique: jest.fn().mockResolvedValue({ storageKey: 'violations/2026/10/x.jpg' }) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = new AuditService(prisma as never);
  const notifications = { notify: jest.fn().mockResolvedValue(undefined), safe: jest.fn() };
  const storage = { presignGet: jest.fn().mockResolvedValue('https://signed.example/get') };
  const cfg = { PDF_SERVICE_URL: undefined, PDF_SERVICE_TIMEOUT_MS: 1000 };
  const svc = new ViolationsService(
    prisma as never,
    settings as never,
    audit,
    notifications as never,
    storage as never,
    cfg as never,
  );
  return { svc, prisma, tx, notifications, storage, created: () => created };
}

const input = (over: Partial<CreateViolationData> = {}): CreateViolationData => ({
  clientUuid: UUID,
  memberId: MEMBER,
  typeId: TYPE,
  description: 'وصف المخالفة',
  latitude: 24.7,
  longitude: 46.7,
  accuracyM: 8,
  capturedAt: '2026-10-12T06:00:00Z',
  deviceInfo: {},
  expectedIdPhotos: 1,
  expectedEvidencePhotos: 2,
  ...over,
});

describe('ViolationsService.create — idempotent by clientUuid (brief §7.4, §12)', () => {
  it('a new clientUuid creates the violation (created = true) with the recorder = current user', async () => {
    const s = setup({ memberships: [{ teamId: TEAM_A, from: '2026-01-01T00:00:00Z', to: null }] });
    const out = await s.svc.create(input(), MONITOR, ctx);
    expect(out.created).toBe(true);
    expect(s.created()).toMatchObject({ clientUuid: UUID, recordedById: MONITOR.id, teamIdSnapshot: TEAM_A });
    expect(s.tx.violation.create).toHaveBeenCalledTimes(1);
  });

  it('a repeated clientUuid returns the stored row (created = false) and writes nothing', async () => {
    const s = setup({ existing: violationRow() });
    const out = await s.svc.create(input(), MONITOR, ctx);
    expect(out).toMatchObject({ created: false, violation: { id: 'v1', clientUuid: UUID } });
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the loser of a concurrent first attempt (P2002 on client_uuid) returns the winner', async () => {
    const s = setup({ memberships: [{ teamId: TEAM_A, from: '2026-01-01T00:00:00Z', to: null }] });
    s.prisma.violation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(violationRow({ id: 'winner' }));
    s.tx.violation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5',
        meta: { target: ['client_uuid'] },
      }),
    );
    const out = await s.svc.create(input(), MONITOR, ctx);
    expect(out).toMatchObject({ created: false, violation: { id: 'winner' } });
  });

  it("another user's clientUuid is never revealed", async () => {
    const s = setup({ existing: violationRow({ recordedById: OTHER_MONITOR.id }) });
    await expectCode(s.svc.create(input(), MONITOR, ctx), 'CONFLICT_VERSION');
  });

  it('inactive member or type → VALIDATION_FAILED with field errors; too many expected photos → TOO_MANY_PHOTOS', async () => {
    const s = setup();
    s.prisma.teamMember.findUnique.mockResolvedValueOnce({ id: MEMBER, status: 'INACTIVE', archivedAt: null });
    s.prisma.violationType.findUnique.mockResolvedValueOnce({ id: TYPE, isActive: false });
    const err = await s.svc.create(input(), MONITOR, ctx).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(Object.keys((err as AppError & { details: { fieldErrors: object } }).details.fieldErrors)).toEqual(['memberId', 'typeId']);

    const t = setup({ settings: { VIOLATION_MAX_PHOTOS: 3 } });
    await expectCode(t.svc.create(input({ expectedEvidencePhotos: 4 }), MONITOR, ctx), 'TOO_MANY_PHOTOS');
  });

  it('stores only UA / platform / app version / online from deviceInfo', async () => {
    const s = setup();
    await s.svc.create(
      input({ deviceInfo: { userAgent: 'UA', platform: 'iPhone', appVersion: '1.0', online: false, imei: '123', email: 'x@y' } }),
      MONITOR,
      ctx,
    );
    expect(s.created()!.deviceInfo).toEqual({ userAgent: 'UA', platform: 'iPhone', appVersion: '1.0', online: false });
    expect(sanitizeDeviceInfo(null)).toEqual({});
  });
});

describe('team / supervisor snapshot at captured_at (brief §7.3, ADR-014)', () => {
  const history = {
    // Member was in team A until 10:00 then moved to team B.
    memberships: [
      { teamId: TEAM_A, from: '2026-01-01T00:00:00Z', to: '2026-10-12T10:00:00Z' },
      { teamId: TEAM_B, from: '2026-10-12T10:00:00Z', to: null },
    ],
    supervisors: [
      { teamId: TEAM_A, supervisorId: 'old-sup', from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
      { teamId: TEAM_A, supervisorId: SUP_A, from: '2026-06-01T00:00:00Z', to: null },
      { teamId: TEAM_B, supervisorId: 'sup-b', from: '2026-01-01T00:00:00Z', to: null },
    ],
  };

  it('the SQL uses half-open intervals for both histories, bound to captured_at', () => {
    const at = new Date('2026-10-12T06:00:00Z');
    const sql = snapshotSql(MEMBER, at);
    const text = sql.text.replace(/\s+/g, ' ');
    expect(text).toContain('m.valid_from <= $');
    expect(text).toContain('(m.valid_to IS NULL OR m.valid_to > $');
    // A9 (ADR-100): the primary and every supervisor come from team_supervisors at the same instant.
    expect(text).toContain('FROM team_supervisors s');
    expect(text).toContain('s.valid_from <= $');
    expect(text).toContain('(s.valid_to IS NULL OR s.valid_to > $');
    expect(text).toContain('s.is_primary');
    expect(sql.values.filter((v) => v instanceof Date)).toEqual([at, at, at, at, at, at]);
    expect(sql.values).toContain(MEMBER);
  });

  it('a violation captured offline before a move keeps the OLD team and its supervisor at that time', async () => {
    const s = setup(history);
    // Synced after the move (now), captured before it.
    await s.svc.create(input({ capturedAt: '2026-10-12T09:59:59.999Z' }), MONITOR, ctx);
    expect(s.created()).toMatchObject({ teamIdSnapshot: TEAM_A, supervisorIdSnapshot: SUP_A });
    expect((s.tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql).values[0]).toEqual(new Date('2026-10-12T09:59:59.999Z'));
  });

  it('the move instant itself belongs to the new team (half-open [from, to))', async () => {
    const s = setup(history);
    await s.svc.create(input({ capturedAt: '2026-10-12T10:00:00Z' }), MONITOR, ctx);
    expect(s.created()).toMatchObject({ teamIdSnapshot: TEAM_B, supervisorIdSnapshot: 'sup-b' });
  });

  it('the supervisor snapshot follows supervisor history, not the current leader', async () => {
    const s = setup(history);
    await s.svc.create(input({ capturedAt: '2026-03-01T08:00:00Z' }), MONITOR, ctx);
    expect(s.created()).toMatchObject({ teamIdSnapshot: TEAM_A, supervisorIdSnapshot: 'old-sup' });
  });

  it('no membership at captured_at → null snapshot is allowed (not an error)', async () => {
    const s = setup(history);
    const out = await s.svc.create(input({ capturedAt: '2025-12-31T23:00:00Z' }), MONITOR, ctx);
    expect(out.created).toBe(true);
    expect(s.created()).toMatchObject({ teamIdSnapshot: null, supervisorIdSnapshot: null, supervisorIdsSnapshot: [] });
  });

  it('A9: several supervisors at captured_at → the primary in supervisor_id_snapshot, all of them in supervisor_ids_snapshot', async () => {
    const s = setup({
      memberships: history.memberships,
      supervisors: [
        ...history.supervisors,
        { teamId: TEAM_A, supervisorId: 'co-sup', from: '2026-07-01T00:00:00Z', to: null, isPrimary: false },
        { teamId: TEAM_A, supervisorId: 'gone-co', from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z', isPrimary: false },
      ],
    });
    await s.svc.create(input({ capturedAt: '2026-08-01T08:00:00Z' }), MONITOR, ctx);
    expect(s.created()).toMatchObject({ teamIdSnapshot: TEAM_A, supervisorIdSnapshot: SUP_A, supervisorIdsSnapshot: [SUP_A, 'co-sup'] });
  });
});

describe('A9: violations without a person (ADR-103)', () => {
  it('memberId is optional: no snapshot query, member null, person photo expected', async () => {
    const s = setup();
    const out = await s.svc.create(input({ memberId: undefined }), MONITOR, ctx);
    expect(out.created).toBe(true);
    expect(s.tx.$queryRaw).not.toHaveBeenCalled();
    expect(s.prisma.teamMember.findUnique).not.toHaveBeenCalled();
    expect(s.created()).toMatchObject({
      memberId: null,
      teamIdSnapshot: null,
      supervisorIdSnapshot: null,
      supervisorIdsSnapshot: [],
      expectedPerson: 1,
    });
  });

  it('the DTO says assigned = false and member = null for such a row', async () => {
    const s = setup({ found: violationRow({ memberId: null, member: null, teamIdSnapshot: null, team: null, supervisor: null, supervisorIdsSnapshot: [] }) });
    const dto = await s.svc.get('v1', ADMIN);
    expect(dto).toMatchObject({ assigned: false, member: null, team: null, supervisors: [] });
    const assigned = await setup().svc.get('v1', ADMIN);
    expect(assigned.assigned).toBe(true);
    expect(assigned.expectedPhotos).toEqual({ idCard: 1, evidence: 2, person: 1 });
  });

  it('the OCR state is shown to admins and the recorder only', async () => {
    const row = violationRow({ ocr: { status: 'DONE' } });
    expect((await setup({ found: row }).svc.get('v1', ADMIN)).ocrStatus).toBe('DONE');
    expect((await setup({ found: row }).svc.get('v1', MONITOR)).ocrStatus).toBe('DONE');
    expect((await setup({ found: row }).svc.get('v1', SUP)).ocrStatus).toBeUndefined();
  });

  it('the filter assigned=false / true maps to member_id IS NULL / NOT NULL', async () => {
    const s = setup();
    await s.svc.list({ page: 1, pageSize: 25, assigned: 'false' }, ADMIN);
    expect(JSON.stringify(s.prisma.violation.findMany.mock.calls[0]![0].where)).toContain('{"memberId":null}');
    await s.svc.list({ page: 1, pageSize: 25, assigned: 'true' }, ADMIN);
    expect(JSON.stringify(s.prisma.violation.findMany.mock.calls[1]![0].where)).toContain('{"memberId":{"not":null}}');
  });
});

describe('clock drift flag (brief §7.3)', () => {
  it('flags when the device clock at send time differs from received_at beyond the threshold', async () => {
    const s = setup({ settings: { CLOCK_DRIFT_THRESHOLD_MINUTES: 10 } });
    const wrong = new Date(Date.now() - 60 * 60_000).toISOString(); // device one hour behind
    await s.svc.create(input({ clientSentAt: wrong }), MONITOR, ctx);
    expect(s.created()!.clockDriftSuspect).toBe(true);
    expect(s.created()!.clientSentAt).toEqual(new Date(wrong));
  });

  it('an old offline capture with a correct clock is NOT flagged', async () => {
    const s = setup({ settings: { CLOCK_DRIFT_THRESHOLD_MINUTES: 10 } });
    await s.svc.create(
      input({ capturedAt: new Date(Date.now() - 6 * 3600_000).toISOString(), clientSentAt: new Date().toISOString() }),
      MONITOR,
      ctx,
    );
    expect(s.created()!.clockDriftSuspect).toBe(false);
  });

  it('without clientSentAt only a capture time in the future is flagged', async () => {
    const s = setup({ settings: { CLOCK_DRIFT_THRESHOLD_MINUTES: 10 } });
    await s.svc.create(input({ capturedAt: new Date(Date.now() + 30 * 60_000).toISOString() }), MONITOR, ctx);
    expect(s.created()!.clockDriftSuspect).toBe(true);
  });
});

describe('scope is part of the query (list, detail)', () => {
  it('supervisor with visibility hidden: the query carries the SHOW-only team filter', async () => {
    const s = setup({ settings: { SUPERVISORS_CAN_SEE_VIOLATIONS: false } });
    await s.svc.list({ page: 1, pageSize: 25 }, SUP);
    const where = s.prisma.violation.findMany.mock.calls[0]![0].where;
    expect(where.AND[0]).toEqual({
      team: { is: { supervisors: { some: { userId: SUP.id, validTo: null } }, status: { not: 'ARCHIVED' }, visibility: { is: { mode: 'SHOW' } } } },
    });
    expect(s.prisma.violation.count.mock.calls[0]![0].where).toEqual(where);
  });

  it('monitor list and /mine are limited to recorded_by = me; admin is unrestricted', async () => {
    const s = setup();
    await s.svc.list({ page: 1, pageSize: 25 }, MONITOR, { mine: true });
    expect(s.prisma.violation.findMany.mock.calls[0]![0].where.AND).toEqual([
      { recordedById: MONITOR.id },
      {},
      { recordedById: MONITOR.id },
    ]);
    await s.svc.list({ page: 2, pageSize: 10, status: 'CONFIRMED' }, ADMIN);
    const call = s.prisma.violation.findMany.mock.calls[1]![0];
    expect(call.where.AND).toEqual([{}, { AND: [{ status: 'CONFIRMED' }] }]);
    expect(call).toMatchObject({ skip: 10, take: 10 });
  });

  it('detail outside the scope is 404', async () => {
    const s = setup({ found: null });
    await expectCode(s.svc.get('v1', SUP), 'NOT_FOUND');
    expect(s.prisma.violation.findFirst.mock.calls[0]![0].where.AND[0]).toEqual({ id: 'v1' });
  });
});

describe('edit window (brief §7.3)', () => {
  const received = new Date('2026-10-12T06:05:00Z');

  it('the recorder may edit within VIOLATION_EDIT_WINDOW_MINUTES of received_at; audited with before/after', async () => {
    const s = setup({ settings: { VIOLATION_EDIT_WINDOW_MINUTES: 15 } });
    await s.svc.update('v1', { description: 'وصف جديد' }, MONITOR, ctx, new Date(received.getTime() + 14 * 60_000));
    expect(s.tx.violation.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { description: 'وصف جديد' } });
    expect(s.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'violation.updated',
        before: { description: 'وصف المخالفة' },
        after: { description: 'وصف جديد' },
      }),
    });
  });

  it('after the window the recorder gets EDIT_WINDOW_CLOSED; an admin may still edit', async () => {
    const s = setup({ settings: { VIOLATION_EDIT_WINDOW_MINUTES: 15 } });
    const late = new Date(received.getTime() + 15 * 60_000);
    await expectCode(s.svc.update('v1', { description: 'متأخر' }, MONITOR, ctx, late), 'EDIT_WINDOW_CLOSED');
    expect(s.tx.violation.update).not.toHaveBeenCalled();
    await s.svc.update('v1', { description: 'من المدير' }, ADMIN, ctx, late);
    expect(s.tx.violation.update).toHaveBeenCalledTimes(1);
  });

  it('nothing changed → no write, no audit', async () => {
    const s = setup();
    await s.svc.update('v1', { description: 'وصف المخالفة' }, ADMIN, ctx);
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('status changes (admin)', () => {
  it('CANCELLED requires a reason', async () => {
    const s = setup();
    await expectCode(s.svc.changeStatus('v1', { status: 'CANCELLED' }, ADMIN, ctx), 'CANCEL_REASON_REQUIRED');
    await expectCode(s.svc.changeStatus('v1', { status: 'CANCELLED', reason: '  ' }, ADMIN, ctx), 'CANCEL_REASON_REQUIRED');
    expect(s.tx.violation.update).not.toHaveBeenCalled();
  });

  it('cancel with a reason is stored and audited; leaving CANCELLED clears it', async () => {
    const s = setup();
    await s.svc.changeStatus('v1', { status: 'CANCELLED', reason: 'سُجّلت بالخطأ' }, ADMIN, ctx);
    expect(s.tx.violation.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'CANCELLED', cancelReason: 'سُجّلت بالخطأ' },
    });
    expect(s.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'violation.status_changed', after: { status: 'CANCELLED', cancelReason: 'سُجّلت بالخطأ' } }),
    });
    const t = setup({ found: violationRow({ status: 'CANCELLED', cancelReason: 'x y z' }) });
    await t.svc.changeStatus('v1', { status: 'UNDER_REVIEW' }, ADMIN, ctx);
    expect(t.tx.violation.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { status: 'UNDER_REVIEW', cancelReason: null } });
  });
});

describe('supervisor responses and photo URLs', () => {
  it('a response is stored, audited and notifies the admins (VIOLATION_OBJECTION)', async () => {
    const s = setup({ settings: { SUPERVISORS_CAN_SEE_VIOLATIONS: true } });
    await s.svc.respond('v1', 'أعترض على هذه المخالفة', SUP, ctx);
    expect(s.tx.violationResponse.create).toHaveBeenCalledWith({
      data: { violationId: 'v1', supervisorId: SUP.id, body: 'أعترض على هذه المخالفة' },
      select: { id: true },
    });
    expect(s.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'violation.response_added' }) });
    expect(s.notifications.notify).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      'VIOLATION_OBJECTION',
      expect.objectContaining({ violationId: 'v1', teamName: 'فريق أ' }),
    );
  });

  it('a hidden violation cannot be answered (404 from the scoped query)', async () => {
    const s = setup({ found: null, settings: { SUPERVISORS_CAN_SEE_VIOLATIONS: false } });
    await expectCode(s.svc.respond('v1', 'رد', SUP, ctx), 'NOT_FOUND');
    expect(s.tx.violationResponse.create).not.toHaveBeenCalled();
  });

  it('ID-card URL: audited for the recorder; refused to a supervisor; evidence is not audited', async () => {
    const s = setup();
    const out = await s.svc.fileUrl('v1', 'f-id', MONITOR, ctx);
    expect(out.url).toBe('https://signed.example/get');
    expect(s.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'violation.id_photo_viewed', entityId: 'v1' }),
    });
    s.prisma.auditLog.create.mockClear();
    await s.svc.fileUrl('v1', 'f-ev', MONITOR, ctx);
    expect(s.prisma.auditLog.create).not.toHaveBeenCalled();
    // Security review A9 L7: PERSON (face) photo URLs are audited as well.
    await s.svc.fileUrl('v1', 'f-person', MONITOR, ctx);
    expect(s.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'violation.person_photo_viewed', entityId: 'v1' }),
    });

    const t = setup({ settings: { SUPERVISORS_CAN_SEE_VIOLATIONS: true } });
    await expectCode(t.svc.fileUrl('v1', 'f-id', SUP, ctx), 'FORBIDDEN');
    await t.svc.fileUrl('v1', 'f-ev', SUP, ctx);
    await expectCode(t.svc.fileUrl('v1', 'not-linked', SUP, ctx), 'NOT_FOUND');
  });
});

describe('roster — A10 worker foreman', () => {
  it('marks the worker foreman (مشرف عمّال) of the current team; other members are not', async () => {
    const s = setup();
    const row = (id: string, role: 'WORKER' | 'FOREMAN') => ({
      id,
      fullName: id,
      nationalIdFirst: '1',
      nationalIdLast4: '2345',
      photoFileId: null,
      memberships: [{ role, team: { id: 't1', name: 'فريق', color: { hex: '#123456' } } }],
    });
    s.prisma.teamMember.findMany.mockResolvedValue([row('m-1', 'FOREMAN'), row('m-2', 'WORKER')] as never);
    const out = await s.svc.roster();
    expect(out.items.map((i) => [i.memberId, i.isForeman])).toEqual([
      ['m-1', true],
      ['m-2', false],
    ]);
    const args = s.prisma.teamMember.findMany.mock.calls.at(-1)![0] as { select: { memberships: { select: { role: boolean } } } };
    expect(args.select.memberships.select.role).toBe(true);
  });
});

describe('calculations audit L13 — one edit-window boundary', () => {
  it('open 1 ms before editableUntil, closed at exactly editableUntil (shared isEditWindowOpen)', async () => {
    const received = new Date('2026-10-12T06:05:00Z');
    const s = setup({ settings: { VIOLATION_EDIT_WINDOW_MINUTES: 15 } });
    await s.svc.update('v1', { description: 'قبل الحد' }, MONITOR, ctx, new Date(received.getTime() + 15 * 60_000 - 1));
    expect(s.tx.violation.update).toHaveBeenCalledTimes(1);
    await expectCode(s.svc.update('v1', { description: 'عند الحد' }, MONITOR, ctx, new Date(received.getTime() + 15 * 60_000)), 'EDIT_WINDOW_CLOSED');
  });
});
