import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { ViolationAssignService } from './violation-assign.service';
import { violationScopeWhere } from './violation-scope';

const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});
const ctx: RequestContext = { actorId: 'x', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const MONITOR = { id: 'mon-1', role: 'MONITOR' as const, status: 'ACTIVE' };
const OTHER_MONITOR = { id: 'mon-2', role: 'MONITOR' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };
const V = 'v1';
const TEAM = 'team-a';
const CAPTURED = new Date('2026-10-01T06:30:00Z');
const RESIDENT = '2345678904';

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

const memberRow = (id: string, fullName: string) => ({
  id,
  fullName,
  nationalIdEnc: crypto.encrypt(RESIDENT),
  nationalIdHash: crypto.blindIndex(RESIDENT),
  nationalIdFirst: '2',
  nationalIdLast4: '8904',
  jobTitleId: null,
  jobTitleText: null,
  departmentId: null,
  departmentText: null,
  photoFileId: null,
  status: 'ACTIVE',
  jobTitle: null,
  department: null,
  memberships: [
    { teamId: TEAM, role: 'WORKER', team: { id: TEAM, name: 'فريق أ', status: 'ACTIVE', supervisors: [{ userId: SUP.id }], color: { id: 'c', name: 'أزرق', hex: '#1D4ED8', isActive: true } } },
  ],
});

function setup(opts: { violation?: Record<string, unknown>; lockedMember?: string | null; ocr?: Record<string, unknown> | null; stored?: unknown; leads?: boolean; teamStatus?: string; dup?: boolean; personPhoto?: boolean } = {}) {
  const violation = {
    id: V,
    memberId: null,
    recordedById: MONITOR.id,
    capturedAt: CAPTURED,
    teamIdSnapshot: null,
    supervisorIdsSnapshot: [],
    ...opts.violation,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ member_id: opts.lockedMember ?? null, captured_at: CAPTURED }]),
    violation: {
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...violation, memberId: 'm-1' }),
    },
    team: {
      findUnique: jest.fn().mockResolvedValue({
        status: opts.teamStatus ?? 'ACTIVE',
        supervisors: opts.leads === false ? [{ userId: 'someone-else' }] : [{ userId: SUP.id }],
      }),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue(opts.dup ? { id: 'existing-member' } : null),
      create: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn(async () => memberRow('new-m', 'راجيش كومار')),
    },
    teamMembership: { create: jest.fn().mockResolvedValue({}) },
    file: { create: jest.fn().mockResolvedValue({}) },
    jobTitle: { findMany: jest.fn().mockResolvedValue([]) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...tx,
    violation: { ...tx.violation, findUnique: jest.fn().mockResolvedValue(violation) },
    violationOcr: { findUnique: jest.fn().mockResolvedValue(opts.ocr === undefined ? null : opts.ocr) },
    violationFile: {
      findFirst: jest.fn().mockResolvedValue(
        opts.personPhoto === false
          ? null
          : { file: { storageKey: 'violations/2026/10/p.jpg', mimeType: 'image/jpeg', sizeBytes: 120_000, sha256: 'ab' } },
      ),
    },
    teamMember: {
      ...tx.teamMember,
      findUnique: jest.fn().mockResolvedValue({ archivedAt: null }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const violations = {
    findScoped: jest.fn(async (_id: string, viewer: { id: string; role: string }) => {
      // Mirrors the real scope: admin all, monitor what they recorded, a supervisor never an unassigned row.
      if (viewer.role === 'ADMIN') return violation;
      if (viewer.role === 'MONITOR' && violation.recordedById === viewer.id) return violation;
      throw new AppError('NOT_FOUND');
    }),
    resolveSnapshot: jest.fn().mockResolvedValue({ teamId: TEAM, supervisorId: SUP.id, supervisorIds: [SUP.id, 'sup-2'] }),
    toDto: jest.fn(async (row: { id: string }) => ({ id: row.id })),
  };
  const audit = new AuditService(prisma as never);
  const storage = { bucket: 'b', copy: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
  const ocr = { read: jest.fn(() => opts.stored ?? null), retry: jest.fn() };
  const svc = new ViolationAssignService(prisma as never, violations as never, audit, crypto, storage as never, ocr as never);
  const actions = () => tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
  const entry = (action: string) =>
    tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string; after: Record<string, unknown> } }).data).find((d) => d.action === action);
  return { svc, tx, prisma, violations, storage, ocr, actions, entry };
}

describe('assign later (A9, ADR-103)', () => {
  it('the recorder assigns a member: the snapshot is resolved at captured_at and stored with every supervisor', async () => {
    const s = setup();
    await s.svc.assign(V, 'm-1', MONITOR, ctx);
    expect(s.violations.resolveSnapshot).toHaveBeenCalledWith(s.tx, 'm-1', CAPTURED);
    expect(s.tx.violation.update).toHaveBeenCalledWith({
      where: { id: V },
      data: expect.objectContaining({
        memberId: 'm-1',
        teamIdSnapshot: TEAM,
        supervisorIdSnapshot: SUP.id,
        supervisorIdsSnapshot: [SUP.id, 'sup-2'],
        assignedById: MONITOR.id,
        assignedAt: expect.any(Date),
      }),
    });
    expect((s.tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    expect(s.entry('violation.assigned')?.after).toMatchObject({ memberId: 'm-1', via: 'assign', teamIdSnapshot: TEAM });
  });

  it('an admin may assign any time; another monitor cannot (404)', async () => {
    await expect(setup().svc.assign(V, 'm-1', ADMIN, ctx)).resolves.toBeDefined();
    await expectCode(setup().svc.assign(V, 'm-1', OTHER_MONITOR, ctx), 'NOT_FOUND');
  });

  it('already assigned to someone else → 409; to the same member → no change', async () => {
    await expectCode(setup({ violation: { memberId: 'm-9' } }).svc.assign(V, 'm-1', ADMIN, ctx), 'VIOLATION_ALREADY_ASSIGNED');
    const s = setup({ violation: { memberId: 'm-1' } });
    await s.svc.assign(V, 'm-1', ADMIN, ctx);
    expect(s.tx.violation.update).not.toHaveBeenCalled();
    // A concurrent assignment that won the row lock first.
    await expectCode(setup({ lockedMember: 'm-7' }).svc.assign(V, 'm-1', ADMIN, ctx), 'VIOLATION_ALREADY_ASSIGNED');
  });

  it('an archived or unknown member is a validation error', async () => {
    const s = setup();
    s.prisma.teamMember.findUnique.mockResolvedValueOnce({ archivedAt: new Date() });
    await expectCode(s.svc.assign(V, 'm-1', ADMIN, ctx), 'VALIDATION_FAILED');
  });

  it('unassign (admin) clears the member and the snapshot; audited with the old values', async () => {
    const s = setup({ violation: { memberId: 'm-1', teamIdSnapshot: TEAM, supervisorIdsSnapshot: [SUP.id] } });
    await s.svc.unassign(V, 'شخص خطأ', ADMIN, ctx);
    expect(s.tx.violation.update).toHaveBeenCalledWith({
      where: { id: V },
      data: { memberId: null, teamIdSnapshot: null, supervisorIdSnapshot: null, supervisorIdsSnapshot: [], assignedAt: null, assignedById: null },
    });
    expect(s.entry('violation.unassigned')?.after).toEqual({ memberId: null, reason: 'شخص خطأ' });
  });

  it('supervisors never see unassigned violations: their scope requires a team snapshot', () => {
    const where = violationScopeWhere(SUP, true) as { team: { is: Record<string, unknown> } };
    expect(where.team.is).toMatchObject({ supervisors: { some: { userId: SUP.id, validTo: null } } });
    // An unassigned row has team_id_snapshot NULL (CHECK violations_unassigned_no_team_chk), so `team: { is }` never matches it.
  });
});

describe('register a member from the card (A9, ADR-103)', () => {
  const body = { fullName: 'راجيش كومار', nationalId: RESIDENT, teamId: TEAM, usePersonPhoto: true };

  it('admin: creates the member in the team from captured_at, copies the PERSON photo, assigns; all audited', async () => {
    const s = setup();
    const out = await s.svc.registerMember(V, body, ADMIN, ctx);
    expect(s.storage.copy).toHaveBeenCalledWith('violations/2026/10/p.jpg', expect.stringMatching(/^member-photos\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/));
    const file = s.tx.file.create.mock.calls[0]![0].data;
    expect(file).toMatchObject({ entityType: 'member_photo', kind: 'PHOTO', status: 'READY', mimeType: 'image/jpeg' });
    const member = s.tx.teamMember.create.mock.calls[0]![0].data;
    expect(member).toMatchObject({ fullName: 'راجيش كومار', photoFileId: file.id, nationalIdFirst: '2', nationalIdLast4: '8904' });
    expect(member.nationalIdHash).toBe(crypto.blindIndex(RESIDENT));
    expect(file.entityId).toBe(member.id);
    expect(s.tx.teamMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ memberId: member.id, teamId: TEAM, validFrom: CAPTURED }),
    });
    expect(s.violations.resolveSnapshot).toHaveBeenCalledWith(s.tx, member.id, CAPTURED);
    expect(s.actions()).toEqual(['member.created', 'member.photo_updated', 'violation.member_registered', 'violation.assigned']);
    expect(JSON.stringify(s.tx.auditLog.create.mock.calls)).not.toContain(RESIDENT); // masked only
    expect(out.member).toMatchObject({ id: 'new-m', nationalId: RESIDENT }); // admins see the full ID
  });

  it('a supervisor leading the team may register (the unassigned violation is outside their scope otherwise)', async () => {
    const s = setup();
    await s.svc.registerMember(V, body, SUP, ctx);
    expect(s.prisma.violation.findUnique).toHaveBeenCalled();
    expect(s.violations.findScoped).toHaveBeenCalledTimes(1); // only for the answer, which they may not see
    expect(s.actions()).toContain('violation.assigned');
  });

  it('a supervisor not leading the team → 404 and the copied photo is removed; without a team → 403', async () => {
    const s = setup({ leads: false });
    await expectCode(s.svc.registerMember(V, body, SUP, ctx), 'NOT_FOUND');
    expect(s.storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^member-photos\//));
    expect(s.tx.teamMember.create).not.toHaveBeenCalled();
    await expectCode(setup().svc.registerMember(V, { ...body, teamId: undefined }, SUP, ctx), 'FORBIDDEN');
  });

  it('a national ID already registered: the admin learns which member, the supervisor gets the generic answer', async () => {
    const a = await setup({ dup: true }).svc.registerMember(V, body, ADMIN, ctx).catch((e: AppError) => e);
    expect(a).toMatchObject({ code: 'NATIONAL_ID_TAKEN', details: expect.objectContaining({ existingMemberId: 'existing-member' }) });
    await expectCode(setup({ dup: true }).svc.registerMember(V, body, SUP, ctx), 'NATIONAL_ID_NOT_ACCEPTED');
  });

  it('an already assigned violation or an archived team is refused; no PERSON photo → member without photo', async () => {
    await expectCode(setup({ violation: { memberId: 'm-1' } }).svc.registerMember(V, body, ADMIN, ctx), 'VIOLATION_ALREADY_ASSIGNED');
    await expectCode(setup({ teamStatus: 'ARCHIVED' }).svc.registerMember(V, body, ADMIN, ctx), 'TEAM_ARCHIVED');
    const s = setup({ personPhoto: false });
    await s.svc.registerMember(V, body, ADMIN, ctx);
    expect(s.storage.copy).not.toHaveBeenCalled();
    expect(s.tx.teamMember.create.mock.calls[0]![0].data.photoFileId).toBeNull();
  });

  it('admin without a team: the member is created unassigned and the snapshot stays empty', async () => {
    const s = setup();
    s.violations.resolveSnapshot.mockResolvedValueOnce({ teamId: null, supervisorId: null, supervisorIds: [] });
    await s.svc.registerMember(V, { ...body, teamId: undefined }, ADMIN, ctx);
    expect(s.tx.teamMembership.create).not.toHaveBeenCalled();
    expect(s.tx.violation.update.mock.calls[0]![0].data).toMatchObject({ teamIdSnapshot: null, supervisorIdsSnapshot: [] });
  });
});

describe('OCR view and suggestions (A9, ADR-104)', () => {
  const stored = {
    v: 1,
    engine: 'tesseract.js@5 ara+eng',
    meanConfidence: 80,
    fields: {
      nationalId: { value: RESIDENT, confidence: 92 },
      name: { value: 'راجيش كومار', confidence: 88 },
      nameLatin: null,
      birthDate: { value: '1408-03-15', calendar: 'HIJRI', confidence: 80 },
      expiryDate: null,
      nationality: { value: 'هندي', confidence: 85 },
      idCandidates: 1,
    },
  };
  const ocr = { status: 'DONE', attempts: 1, extractedAt: new Date(), extractedEnc: Buffer.from('x'), idNumberHash: crypto.blindIndex(RESIDENT), error: null };

  it('no job yet → status NONE', async () => {
    await expect(setup().svc.ocrView(V, MONITOR, ctx)).resolves.toMatchObject({ status: 'NONE', suggestedMembers: [] });
  });

  it('the recorder sees the ID masked; the admin in full; every view is audited with the flag', async () => {
    const m = setup({ ocr, stored });
    const asMonitor = await m.svc.ocrView(V, MONITOR, ctx);
    expect(asMonitor.fields.nationalId).toMatchObject({ value: '2•••••••04', masked: '2•••••••04', full: false, kind: 'RESIDENT' });
    expect(m.entry('violation.ocr_viewed')?.after).toMatchObject({ fullNationalId: false });
    expect(asMonitor.suggestedUsers).toEqual([]);

    const a = setup({ ocr, stored });
    const asAdmin = await a.svc.ocrView(V, ADMIN, ctx);
    expect(asAdmin.fields.nationalId).toMatchObject({ value: RESIDENT, full: true, confidence: 92 });
    expect(a.entry('violation.ocr_viewed')?.after).toMatchObject({ fullNationalId: true });
    expect(JSON.stringify(a.tx.auditLog.create.mock.calls)).not.toContain(RESIDENT);
  });

  it('suggestions: an exact blind-index match first, then name similarity among active members', async () => {
    const s = setup({ ocr, stored });
    s.prisma.teamMember.findMany
      .mockResolvedValueOnce([memberRow('exact', 'راجيش كومار سينغ')] as never) // blind index
      .mockResolvedValueOnce([
        { id: 'near', fullName: 'راجيش كمار' },
        { id: 'far', fullName: 'خالد الغامدي' },
      ] as never) // name pool
      .mockResolvedValueOnce([memberRow('near', 'راجيش كمار')] as never); // details
    const out = await s.svc.ocrView(V, ADMIN, ctx);
    expect(out.suggestedMembers.map((m) => [m.memberId, m.match])).toEqual([
      ['exact', 'NATIONAL_ID'],
      ['near', 'NAME'],
    ]);
    expect(out.suggestedMembers[0]).toMatchObject({ score: 1, nationalIdMasked: '2•••••••04', team: { id: TEAM } });
    expect(s.prisma.teamMember.findMany.mock.calls[0]![0].where).toEqual({ nationalIdHash: crypto.blindIndex(RESIDENT), archivedAt: null });
    expect(s.prisma.teamMember.findMany.mock.calls[1]![0].where).toMatchObject({ archivedAt: null, status: 'ACTIVE', id: { notIn: ['exact'] } });
  });

  it('a FAILED job reports its reason; an assigned violation gets no suggestions', async () => {
    const f = await setup({ ocr: { ...ocr, status: 'FAILED', extractedEnc: null, error: 'FILE_GONE' } }).svc.ocrView(V, ADMIN, ctx);
    expect(f).toMatchObject({ status: 'FAILED', error: 'FILE_GONE', fields: { nationalId: null } });
    const s = setup({ ocr, stored, violation: { memberId: 'm-1' } });
    const out = await s.svc.ocrView(V, ADMIN, ctx);
    expect(out.suggestedMembers).toEqual([]);
    expect(s.prisma.teamMember.findMany).not.toHaveBeenCalled();
  });

  it('another monitor cannot read the OCR of a violation they did not record', async () => {
    await expectCode(setup({ ocr, stored }).svc.ocrView(V, OTHER_MONITOR, ctx), 'NOT_FOUND');
  });
});
