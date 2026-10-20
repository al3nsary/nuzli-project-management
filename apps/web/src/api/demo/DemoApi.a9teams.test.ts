/**
 * DemoApi parity for the A9 teams/org/violations round (docs/API.md "A9 — teams, org,
 * violations", ADR-100..104): several supervisors with one primary, the worker foreman, the
 * organisational structure (cycles refused), violations without a person (PERSON photo, OCR,
 * assignment resolved at captured_at, register-member), and the hub/attachments scopes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { isMemberRequestAccepted } from '../client';
import { uuidv4 } from '../../lib/uuid';
import { OfflineDb } from '../../features/violations/offline/db';
import { enqueueViolation } from '../../features/violations/offline/outbox';
import { SyncEngine } from '../../features/violations/offline/sync';
import type { OcrEngine } from '../../features/violations/ocr/engine';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-a9t-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example'; // primary of teams 1, 2; co-supervisor of team 4
const SUP3 = 'supervisor3@demo.nuzli.example'; // primary of team 5; co-supervisor of team 1
const MONITOR = 'monitor1@demo.nuzli.example';
const MONITOR2 = 'monitor2@demo.nuzli.example';
const id = (prefix: string, k: number) => `00000000-0000-4000-8000-${prefix}${String(k).padStart(12 - prefix.length, '0')}`;
const TEAM = (k: number) => id('a', k);
const MEMBER = (k: number) => id('b', k);
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const SUP2_ID = '00000000-0000-4000-8000-000000000004';
const SUP3_ID = '00000000-0000-4000-8000-000000000005';
const TYPE_1 = id('d1', 1);
const UNASSIGNED = (k: number) => id('d9', k);

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function codeOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

function jpeg(size = 96): Blob {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return new Blob([b], { type: 'image/jpeg' });
}

/** A fake OCR engine: returns the text of a card for the given ID number and name. */
function fakeEngine(lines: string[]): OcrEngine & { calls: number } {
  const e = {
    calls: 0,
    async recognize() {
      e.calls++;
      return { text: lines.join('\n'), confidence: 91, lines: lines.map((text) => ({ text, confidence: 91 })) };
    },
    async terminate() {},
  };
  return e;
}

const validId = (first9: string) => `${first9}${nationalIdCheckDigit(first9)}`;

// ---------------------------------------------------------------- several supervisors (ADR-100)

describe('teams with several supervisors (ADR-100)', () => {
  it('seed: two teams with two supervisors each, the primary first, mirrored in TeamDto.supervisor', async () => {
    await loginAs(ADMIN);
    const teams = await api.teams.list({ status: 'ACTIVE' });
    const multi = teams.filter((t) => (t.supervisors?.length ?? 0) >= 2);
    expect(multi.map((t) => t.id).sort()).toEqual([TEAM(1), TEAM(4)].sort());
    for (const t of teams) {
      expect(t.supervisors![0]!.isPrimary).toBe(true);
      expect(t.supervisors!.filter((s) => s.isPrimary)).toHaveLength(1);
      expect(t.supervisor?.id).toBe(t.supervisors![0]!.id);
    }
  });

  it('a co-supervisor leads the team: reads it, manages its members, sees its violations when shown', async () => {
    await loginAs(SUP3);
    const mine = await api.teams.list({});
    expect(mine.map((t) => t.id)).toContain(TEAM(1));
    const detail = await api.teams.get(TEAM(1));
    expect(detail.supervisors!.map((s) => s.id)).toEqual([SUP1_ID, SUP3_ID]);
    // A12 round 2: a supervisor's new worker is a request for the team (202) until an approver accepts.
    const added = await api.teams.addMember(TEAM(1), { fullName: 'عضو مساعد تجريبي', nationalId: validId('109111222') });
    expect(isMemberRequestAccepted(added) ? added.request.team?.id : null).toBe(TEAM(1));
    // Adding supervisors is admin-only.
    expect((await codeOf(api.teams.addSupervisor(TEAM(1), { userId: SUP2_ID }))).code).toBe('FORBIDDEN');
  });

  it('add / set primary / remove with the API rules and Arabic errors; history keeps primary changes', async () => {
    await loginAs(ADMIN);
    // Already leading → 409.
    expect((await codeOf(api.teams.addSupervisor(TEAM(1), { userId: SUP1_ID }))).code).toBe('SUPERVISOR_ALREADY_IN_TEAM');
    // A monitor is not a supervisor → 400.
    expect((await codeOf(api.teams.addSupervisor(TEAM(1), { userId: '00000000-0000-4000-8000-000000000007' }))).code).toBe('NOT_A_SUPERVISOR');
    // Removing the primary without a successor → 409 with the Arabic message.
    const noSuccessor = await codeOf(api.teams.removeSupervisor(TEAM(1), SUP1_ID, { reason: 'إعادة توزيع' }));
    expect(noSuccessor.code).toBe('PRIMARY_SUPERVISOR_REQUIRED');
    expect(noSuccessor.message_ar).toMatch(/[؀-ۿ]/);
    // Set the co-supervisor as primary: the old one stays as co-supervisor.
    let team = await api.teams.setPrimarySupervisor(TEAM(1), SUP3_ID, { reason: 'تجربة' });
    expect(team.supervisors!.map((s) => [s.id, s.isPrimary])).toEqual([
      [SUP3_ID, true],
      [SUP1_ID, false],
    ]);
    expect(team.supervisor?.id).toBe(SUP3_ID);
    // Remove the primary with a successor.
    team = await api.teams.removeSupervisor(TEAM(1), SUP3_ID, { reason: 'انتهاء التكليف', newPrimaryUserId: SUP1_ID });
    expect(team.supervisors!.map((s) => s.id)).toEqual([SUP1_ID]);
    // The last supervisor cannot be removed.
    expect((await codeOf(api.teams.removeSupervisor(TEAM(1), SUP1_ID, { reason: 'تجربة الحذف' }))).code).toBe('LAST_SUPERVISOR');
    // History: every row, with the primary flag, and a primary change at one instant.
    const { history, current } = await api.teams.supervisorsOf(TEAM(1));
    expect(current.map((s) => s.id)).toEqual([SUP1_ID]);
    const sup3Rows = history.filter((h) => h.supervisor.id === SUP3_ID);
    expect(sup3Rows.some((h) => h.isPrimary)).toBe(true);
    expect(sup3Rows.some((h) => !h.isPrimary)).toBe(true);
    expect(history.every((h) => typeof h.isPrimary === 'boolean')).toBe(true);
    const actions = (await api.audit.list({ entityId: TEAM(1), pageSize: 50 })).items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['team.primary_supervisor_changed', 'team.supervisor_removed']));
  });

  it('create with several supervisors and an explicit primary', async () => {
    await loginAs(ADMIN);
    const colors = await api.colors.available();
    await api.settings.update({ ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR: true });
    const team = await api.teams.create({
      name: 'فريق متعدد المشرفين',
      colorId: colors[0]!.id,
      supervisorIds: [SUP1_ID, SUP2_ID],
      primarySupervisorId: SUP2_ID,
    });
    expect(team.supervisor?.id).toBe(SUP2_ID);
    expect(team.supervisors!.map((s) => [s.id, s.isPrimary])).toEqual([
      [SUP2_ID, true],
      [SUP1_ID, false],
    ]);
  });
});

// ---------------------------------------------------------------- worker foreman (ADR-101)

describe('the worker foreman (ADR-101)', () => {
  it('one per active team in the seed, first in the member list, flagged on MemberDto', async () => {
    await loginAs(ADMIN);
    for (const k of [1, 2, 3, 4, 5]) {
      const t = await api.teams.get(TEAM(k));
      expect(t.members.filter((m) => m.isForeman)).toHaveLength(1);
      expect(t.members[0]!.isForeman).toBe(true);
      expect(t.foreman?.id).toBe(t.members[0]!.id);
    }
  });

  it('setting another member replaces the foreman (exactly one); not a member → 409; clear is idempotent', async () => {
    await loginAs(SUP1); // leads team 1
    const before = await api.teams.get(TEAM(1));
    const other = before.members.find((m) => !m.isForeman)!;
    const after = await api.teams.setForeman(TEAM(1), other.id);
    expect(after.members.filter((m) => m.isForeman).map((m) => m.id)).toEqual([other.id]);
    expect(after.foreman?.id).toBe(other.id);
    expect((await codeOf(api.teams.setForeman(TEAM(1), MEMBER(14)))).code).toBe('FOREMAN_NOT_MEMBER');
    const cleared = await api.teams.clearForeman(TEAM(1));
    expect(cleared.foreman).toBeNull();
    expect((await api.teams.clearForeman(TEAM(1))).foreman).toBeNull();
    // Another team's supervisor cannot touch it.
    expect((await codeOf(api.teams.setForeman(TEAM(3), MEMBER(14)))).code).toBe('NOT_FOUND');
  });

  it('moving the foreman to another team ends the flag (audited) and the new membership is a worker', async () => {
    await loginAs(ADMIN);
    const t1 = await api.teams.get(TEAM(1));
    const foreman = t1.foreman!;
    await api.members.move({ memberIds: [foreman.id], toTeamId: TEAM(2) });
    expect((await api.teams.get(TEAM(1))).foreman).toBeNull();
    const moved = await api.members.get(foreman.id);
    expect(moved.team?.id).toBe(TEAM(2));
    expect(moved.isForeman).toBe(false);
    const actions = (await api.audit.list({ entityId: TEAM(1), pageSize: 50 })).items.map((a) => a.action);
    expect(actions).toContain('team.foreman_cleared');
  });
});

// ---------------------------------------------------------------- organisational structure (ADR-102)

describe('organisational structure (ADR-102)', () => {
  it('seed: a tree with positions held by users and members, one vacant, and linked teams', async () => {
    await loginAs(SUP1);
    const { units } = await api.org.tree();
    expect(units[0]!.parentId).toBeNull();
    expect(units.map((u) => u.name)).toEqual(expect.arrayContaining(['إدارة العمليات الميدانية', 'قسم الحدائق', 'وحدة الصيانة']));
    const positions = units.flatMap((u) => u.positions);
    expect(positions.filter((p) => !p.holder)).toHaveLength(1);
    expect(positions.some((p) => p.holder?.type === 'USER')).toBe(true);
    expect(positions.some((p) => p.holder?.type === 'MEMBER')).toBe(true);
    expect(units.find((u) => u.name === 'وحدة الصيانة')!.teams.map((t) => t.id)).toEqual([TEAM(1)]);
    // Read-only for supervisors.
    expect((await codeOf(api.org.createUnit({ name: 'وحدة', kind: 'UNIT' }))).code).toBe('FORBIDDEN');
  });

  it('move: under another unit is fine; under itself or a descendant → ORG_CYCLE and nothing changes', async () => {
    await loginAs(ADMIN);
    const { units } = await api.org.tree();
    const dept = units.find((u) => u.name === 'إدارة العمليات الميدانية')!;
    const section = units.find((u) => u.name === 'قسم الحدائق')!;
    const unit = units.find((u) => u.name === 'وحدة الصيانة')!;
    expect((await codeOf(api.org.moveUnit(dept.id, { parentId: unit.id }))).code).toBe('ORG_CYCLE');
    expect((await codeOf(api.org.moveUnit(section.id, { parentId: section.id }))).code).toBe('ORG_CYCLE');
    expect((await api.org.tree()).units.find((u) => u.id === dept.id)!.parentId).toBeNull();
    const support = units.find((u) => u.name === 'إدارة الدعم والرقابة')!;
    const moved = await api.org.moveUnit(unit.id, { parentId: support.id });
    expect(moved.parentId).toBe(support.id);
    const audit = (await api.audit.list({ entityId: unit.id, pageSize: 10 })).items.map((a) => a.action);
    expect(audit).toContain('org.unit_moved');
  });

  it('positions: reporting loops → ORG_REPORTS_CYCLE; one holder at a time; delete detaches reports; non-empty unit cannot be deleted', async () => {
    await loginAs(ADMIN);
    const unit = await api.org.createUnit({ name: 'وحدة الاختبار', kind: 'UNIT' });
    const head = await api.org.createPosition({ unitId: unit.id, title: 'رئيس الوحدة', holderUserId: SUP1_ID });
    const deputy = await api.org.createPosition({ unitId: unit.id, title: 'نائب الرئيس', reportsToPositionId: head.id });
    expect(deputy.holder).toBeNull();
    expect((await codeOf(api.org.updatePosition(head.id, { reportsToPositionId: deputy.id }))).code).toBe('ORG_REPORTS_CYCLE');
    const asMember = await api.org.updatePosition(head.id, { holderMemberId: MEMBER(2) });
    expect(asMember.holder).toMatchObject({ type: 'MEMBER', id: MEMBER(2) });
    expect((await codeOf(api.org.deleteUnit(unit.id))).code).toBe('ORG_UNIT_NOT_EMPTY');
    await api.org.deletePosition(head.id);
    const rest = (await api.org.tree()).units.find((u) => u.id === unit.id)!.positions;
    expect(rest).toHaveLength(1);
    expect(rest[0]!.reportsToPositionId).toBeNull();
    await api.org.deletePosition(deputy.id);
    await api.org.deleteUnit(unit.id);
    expect((await api.org.tree()).units.some((u) => u.id === unit.id)).toBe(false);
  });

  it('teams link to units (admin only); an archived unit takes nothing new', async () => {
    await loginAs(ADMIN);
    const unit = await api.org.createUnit({ name: 'وحدة مؤقتة', kind: 'TEAM_GROUP' });
    const team = await api.teams.update(TEAM(3), { orgUnitId: unit.id });
    expect(team.orgUnit).toMatchObject({ id: unit.id, kind: 'TEAM_GROUP' });
    expect((await codeOf(api.org.updateUnit(unit.id, { archived: true }))).code).toBe('ORG_UNIT_NOT_EMPTY');
    await api.teams.update(TEAM(3), { orgUnitId: null });
    await api.org.updateUnit(unit.id, { archived: true });
    expect((await codeOf(api.org.createUnit({ parentId: unit.id, name: 'تحت المؤرشفة', kind: 'UNIT' }))).code).toBe('ORG_UNIT_ARCHIVED');
    await loginAs(SUP1);
    expect((await codeOf(api.teams.update(TEAM(1), { orgUnitId: null }))).code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------- violations without a person (ADR-103/104)

function baseInput(over: Record<string, unknown> = {}) {
  return {
    clientUuid: uuidv4(),
    typeId: TYPE_1,
    description: 'مخالفة دون تحديد الشخص',
    latitude: 24.71,
    longitude: 46.67,
    accuracyM: 9,
    capturedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    deviceInfo: {},
    expectedIdPhotos: 1,
    expectedEvidencePhotos: 1,
    expectedPersonPhotos: 1,
    ...over,
  };
}

/** Records offline (person + ID card + evidence, no member) and syncs. */
async function recordUnassigned(over: Record<string, unknown> = {}) {
  const monitor = await loginAs(MONITOR);
  const db = new OfflineDb(`off-a9t-${Date.now()}-${n++}`);
  const engine = new SyncEngine({ api, db, getUserId: () => monitor.id });
  const payload = baseInput(over);
  await enqueueViolation(db, {
    userId: monitor.id,
    payload: payload as never,
    display: { memberName: '', nationalIdMasked: '', teamName: null, teamColor: null, typeName: '', unassigned: true },
    photos: [
      { kind: 'EVIDENCE', blob: jpeg(140) },
      { kind: 'ID_CARD', blob: jpeg(120) },
      { kind: 'PERSON', blob: jpeg(100) },
    ],
  });
  const presigned: string[] = [];
  const orig = api.files.presign;
  api.files.presign = async (input) => {
    presigned.push(String(input.kind));
    return orig(input);
  };
  const report = await engine.runNow();
  api.files.presign = orig;
  expect(report.synced).toBe(1);
  const v = (await api.violations.mine({ pageSize: 200 })).items.find((x) => x.clientUuid === payload.clientUuid)!;
  return { v, presigned, monitor };
}

describe('violations recorded without a person (ADR-103)', () => {
  it('sync uploads PERSON, then ID_CARD, then EVIDENCE with their kinds; the violation has no member and no team', async () => {
    api.ocrEngine = async () => fakeEngine(['الاسم: شخص تجريبي']);
    const { v, presigned } = await recordUnassigned();
    expect(presigned).toEqual(['PERSON', 'ID_CARD', 'EVIDENCE']);
    expect(v.member).toBeNull();
    expect(v.assigned).toBe(false);
    expect(v.team).toBeNull();
    expect(v.supervisors).toEqual([]);
    expect(v.expectedPhotos).toEqual({ idCard: 1, evidence: 1, person: 1 });
    expect(v.files.map((f) => f.kind).sort()).toEqual(['EVIDENCE', 'ID_CARD', 'PERSON']);
  });

  it('a second PERSON photo is refused (one per violation)', async () => {
    api.ocrEngine = async () => fakeEngine([]);
    const { v } = await recordUnassigned();
    expect((await codeOf(api.files.presign({ entityType: 'violation', entityId: v.id, kind: 'PERSON', contentType: 'image/jpeg', sizeBytes: 100 }))).code).toBe('TOO_MANY_PHOTOS');
  });

  it('the in-browser OCR reads the card after sync: fields, masked ID for the recorder, exact-ID suggestion first', async () => {
    // Member 2 (team 1) is «إبراهيم سعد الجهني», national ID 1412345678.
    api.ocrEngine = async () =>
      fakeEngine(['المملكة العربية السعودية', 'الاسم: إبراهيم سعد الجهنى', 'رقم الهوية', '1412345678', 'الجنسية: سعودي', 'تاريخ الميلاد: 1412/03/18']);
    const { v } = await recordUnassigned();
    await api.ocrRunner.idle();
    expect((await api.violations.get(v.id)).ocrStatus).toBe('DONE');
    const recorderView = await api.violations.ocr(v.id);
    expect(recorderView.status).toBe('DONE');
    expect(recorderView.fields.nationalId?.full).toBe(false);
    expect(recorderView.fields.nationalId?.value).toBe('1•••••••78');
    expect(recorderView.fields.name?.value).toBe('إبراهيم سعد الجهنى');
    expect(recorderView.fields.birthDate).toMatchObject({ value: '1412-03-18', calendar: 'HIJRI' });
    expect(recorderView.suggestedMembers[0]).toMatchObject({ memberId: MEMBER(2), match: 'NATIONAL_ID', score: 1 });
    await loginAs(ADMIN);
    const adminView = await api.violations.ocr(v.id);
    expect(adminView.fields.nationalId?.value).toBe('1412345678');
    expect(adminView.fields.nationalId?.full).toBe(true);
    const audit = (await api.audit.list({ entityId: v.id, pageSize: 50 })).items.filter((a) => a.action === 'violation.ocr_viewed');
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('a failing engine ends FAILED after three attempts; an admin retries', async () => {
    let calls = 0;
    api.ocrEngine = async () => ({
      async recognize() {
        calls++;
        throw new Error('boom');
      },
      async terminate() {},
    });
    const { v } = await recordUnassigned();
    await api.ocrRunner.idle();
    expect(calls).toBe(3);
    await loginAs(ADMIN);
    const failed = await api.violations.ocr(v.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/^ENGINE_/);
    api.ocrEngine = async () => fakeEngine(['1412345678']);
    await api.violations.retryOcr(v.id);
    await api.ocrRunner.idle();
    expect((await api.violations.ocr(v.id)).status).toBe('DONE');
    await loginAs(MONITOR);
    expect((await codeOf(api.violations.retryOcr(v.id))).code).toBe('FORBIDDEN');
  });

  it('assignment resolves team and every supervisor at captured_at, not now (moves later do not change it)', async () => {
    api.ocrEngine = async () => fakeEngine([]);
    // Captured an hour ago: member 2 was in team 1 (SUP1 primary + SUP3 co-supervisor).
    const { v } = await recordUnassigned();
    await loginAs(ADMIN);
    // The member moves to team 3 after the capture…
    await api.members.move({ memberIds: [MEMBER(2)], toTeamId: TEAM(3) });
    await loginAs(MONITOR);
    const assigned = await api.violations.assign(v.id, { memberId: MEMBER(2) });
    expect(assigned.member?.id).toBe(MEMBER(2));
    expect(assigned.assigned).toBe(true);
    expect(assigned.team?.id).toBe(TEAM(1));
    expect(assigned.supervisor?.id).toBe(SUP1_ID);
    expect(assigned.supervisors!.map((s) => s.id)).toEqual([SUP1_ID, SUP3_ID]);
    expect(assigned.assignedBy?.fullName).toBeTruthy();
    // Same member again: no-op; another member: 409.
    expect((await api.violations.assign(v.id, { memberId: MEMBER(2) })).member?.id).toBe(MEMBER(2));
    expect((await codeOf(api.violations.assign(v.id, { memberId: MEMBER(3) }))).code).toBe('VIOLATION_ALREADY_ASSIGNED');
    // Only an admin un-assigns.
    expect((await codeOf(api.violations.unassign(v.id))).code).toBe('FORBIDDEN');
    await loginAs(ADMIN);
    const back = await api.violations.unassign(v.id, { reason: 'شخص آخر' });
    expect(back.member).toBeNull();
    expect(back.team).toBeNull();
    const actions = (await api.audit.list({ entityId: v.id, pageSize: 50 })).items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['violation.assigned', 'violation.unassigned']));
  });

  it('another monitor cannot assign or read it; supervisors never see unassigned violations', async () => {
    api.ocrEngine = async () => fakeEngine([]);
    const { v } = await recordUnassigned();
    await loginAs(MONITOR2);
    expect((await codeOf(api.violations.assign(v.id, { memberId: MEMBER(2) }))).code).toBe('NOT_FOUND');
    expect((await codeOf(api.violations.ocr(v.id))).code).toBe('NOT_FOUND');
    await loginAs(ADMIN);
    await api.settings.update({ SUPERVISORS_CAN_SEE_VIOLATIONS: true });
    for (const who of [SUP1, SUP3]) {
      await loginAs(who);
      const seen = await api.violations.list({ pageSize: 200 });
      expect(seen.items.some((x) => !x.member)).toBe(false);
      expect((await codeOf(api.violations.get(v.id))).code).toBe('NOT_FOUND');
      expect((await codeOf(api.violations.get(UNASSIGNED(1)))).code).toBe('NOT_FOUND');
    }
  });

  it('register a new member from the card: membership from captured_at, the person photo copied, then assigned', async () => {
    api.ocrEngine = async () => fakeEngine([]);
    const { v } = await recordUnassigned();
    await loginAs(ADMIN);
    const nationalId = validId('109384756');
    const res = await api.violations.registerMember(v.id, {
      fullName: 'سلمان عبدالكريم الدوسري',
      nationalId,
      teamId: TEAM(5),
      jobTitleText: 'عامل تشجير',
      usePersonPhoto: true,
    });
    expect(res.member.fullName).toBe('سلمان عبدالكريم الدوسري');
    expect(res.member.team?.id).toBe(TEAM(5));
    expect(res.member.hasPhoto).toBe(true);
    expect(res.violation?.member?.id).toBe(res.member.id);
    expect(res.violation?.team?.id).toBe(TEAM(5));
    expect(res.violation?.supervisor?.id).toBe(SUP3_ID);
    const ms = (await api.db.memberships.where('memberId').equals(res.member.id).toArray())[0]!;
    expect(ms.validFrom).toBe(v.capturedAt);
    // The photo is a copy: the violation keeps its own PERSON file.
    const person = v.files.find((f) => f.kind === 'PERSON')!;
    expect((await api.db.files.get(person.id))?.violationId).toBe(v.id);
    const photo = await api.db.files.get((await api.db.members.get(res.member.id))!.photoFileId!);
    expect(photo).toMatchObject({ entityType: 'member_photo', entityId: res.member.id });
    // A duplicate ID tells an admin which member holds it.
    const { v: second } = await recordUnassigned();
    await loginAs(ADMIN);
    const dup = await codeOf(api.violations.registerMember(second.id, { fullName: 'شخص آخر', nationalId, teamId: TEAM(5) }));
    expect(dup.code).toBe('NATIONAL_ID_TAKEN');
    expect((dup.details as { existingMemberId?: string }).existingMemberId).toBe(res.member.id);
    // Monitors cannot register members.
    await loginAs(MONITOR);
    expect((await codeOf(api.violations.registerMember(second.id, { fullName: 'شخص', nationalId: validId('109384700'), teamId: TEAM(5) }))).code).toBe('FORBIDDEN');
  });

  it('security review A9 (ADR-118): register-member is admin-only, and a capture older than VIOLATION_REGISTER_MAX_AGE_DAYS cannot backdate a membership (409)', async () => {
    api.ocrEngine = async () => fakeEngine([]);
    const { v } = await recordUnassigned();
    await loginAs(SUP1);
    expect((await codeOf(api.violations.registerMember(v.id, { fullName: 'شخص', nationalId: validId('109384711'), teamId: TEAM(1) }))).code).toBe('FORBIDDEN');
    await loginAs(ADMIN);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await api.db.violations.update(v.id, { capturedAt: old });
    const err = await codeOf(api.violations.registerMember(v.id, { fullName: 'شخص', nationalId: validId('109384722'), teamId: TEAM(5) }));
    expect([err.code, err.status]).toEqual(['VIOLATION_TOO_OLD_TO_REGISTER', 409]);
    expect(err.details).toMatchObject({ maxAgeDays: 30, capturedAt: old });
    await api.settings.update({ VIOLATION_REGISTER_MAX_AGE_DAYS: 60 });
    expect((await api.violations.registerMember(v.id, { fullName: 'شخص', nationalId: validId('109384733'), teamId: TEAM(5) })).member.fullName).toBe('شخص');
  });

  it('stats count unassigned violations; the assigned filter works on list, mine and stats', async () => {
    await loginAs(ADMIN);
    const all = await api.violations.stats({});
    const unassigned = await api.violations.list({ assigned: 'false', pageSize: 200 });
    expect(all.unassigned).toBe(unassigned.total);
    expect(unassigned.items.every((x) => !x.member)).toBe(true);
    expect((await api.violations.list({ assigned: 'true', pageSize: 200 })).items.every((x) => x.member)).toBe(true);
    expect((await api.violations.stats({ assigned: 'false' })).total).toBe(unassigned.total);
    // byTeam leaves out unassigned rows (no team) like the API.
    const withTeam = (await api.db.violations.toArray()).filter((x) => x.teamIdSnapshot).length;
    expect(all.byTeam.reduce((a, r) => a + r.count, 0)).toBe(withTeam);
    await loginAs(MONITOR);
    const mine = await api.violations.mine({ assigned: 'false', pageSize: 200 });
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.items.every((x) => !x.member && x.ocrStatus !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------- hub and attachments scopes (ADR-097)

describe('hub and attachments scopes (ADR-092, ADR-097)', () => {
  it('a supervisor sees only the conversations and files of their own tasks', async () => {
    await loginAs(ADMIN);
    const adminHub = await api.hub.list({ filter: 'all', pageSize: 100 });
    const adminFiles = await api.hub.attachments({ pageSize: 100 });
    const me = await loginAs(SUP1);
    const hub = await api.hub.list({ filter: 'all', pageSize: 100 });
    expect(hub.items.length).toBeGreaterThan(0);
    // A12 round 2: own tasks and the team's (the other supervisors of the same teams) — «مهامي» lists both.
    const mine = await api.tasks.mine();
    const myTaskIds = new Set(mine.map((t) => t.id));
    expect(hub.items.every((i) => myTaskIds.has(i.task.id))).toBe(true);
    expect(hub.items.some((i) => i.task.assignee?.id === me.id)).toBe(true);
    expect(hub.items.length).toBeLessThanOrEqual(adminHub.items.length);
    const files = await api.hub.attachments({ pageSize: 100 });
    expect(files.items.every((f) => myTaskIds.has(f.task.id))).toBe(true);
    expect(files.total).toBeLessThanOrEqual(adminFiles.total);
  });

  it('the «new» tab counts unread threads and opening one marks it read', async () => {
    await loginAs(SUP1);
    const before = await api.hub.list({ filter: 'new' });
    expect(before.counts.new).toBe(before.total);
    if (!before.items.length) return;
    const first = before.items[0]!;
    expect(first.unreadCount).toBeGreaterThan(0);
    await api.tasks.markRead(first.task.id);
    const after = await api.hub.list({ filter: 'new' });
    expect(after.items.some((i) => i.task.id === first.task.id)).toBe(false);
    expect(after.counts.new).toBe(before.counts.new - 1);
  });
});
