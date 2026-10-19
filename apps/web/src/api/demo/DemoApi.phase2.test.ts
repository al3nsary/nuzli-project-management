import { beforeEach, describe, expect, it } from 'vitest';
import { ERRORS, nationalIdCheckDigit, type ColorTakenDetails } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';

let n = 0;
let api: DemoApi;

beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-p2-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP2 = 'supervisor2@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const seedId = (prefix: string, k: number) =>
  `00000000-0000-4000-8000-${prefix}${String(k).padStart(12 - prefix.length, '0')}`;
const TEAM = (k: number) => seedId('a', k);
const COLOR = (k: number) => seedId('c', k);
const MEMBER = (k: number) => seedId('b', k);

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function codeOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

describe('DemoApi Phase 2 — team colours (brief §5.2)', () => {
  it('never lists a colour held by an ACTIVE or PENDING team, and archiving frees it', async () => {
    await loginAs(ADMIN);
    const teams = await api.teams.list({ status: 'ALL' });
    const reserved = teams
      .filter((t) => t.status === 'ACTIVE' || t.status === 'PENDING_APPROVAL')
      .map((t) => t.color.id);
    const available = (await api.colors.available()).map((c) => c.id);
    for (const id of reserved) expect(available).not.toContain(id);
    // The archived seed team's colour is free again.
    expect(available).toContain(COLOR(8));
    // The pending team's colour stays reserved.
    expect(available).not.toContain(COLOR(7));

    await api.teams.archive(TEAM(1), { reason: 'اختبار الأرشفة' });
    expect((await api.colors.available()).map((c) => c.id)).toContain(COLOR(2));
    // Members of the archived team are now unassigned.
    const unassigned = await api.members.list({ unassigned: true, pageSize: 200 });
    expect(unassigned.items.some((m) => m.id === MEMBER(1))).toBe(true);
  });

  it('includes the edited team its own colour (excludeTeamId) but nobody else’s', async () => {
    await loginAs(ADMIN);
    const ids = (await api.colors.available(TEAM(1))).map((c) => c.id);
    expect(ids).toContain(COLOR(2));
    expect(ids).not.toContain(COLOR(3));
  });

  it('two simultaneous creations with the same colour: exactly one wins, the other gets COLOR_TAKEN with a fresh list', async () => {
    await loginAs(ADMIN);
    const colorId = (await api.colors.available())[0]!.id;
    const results = await Promise.allSettled([
      api.teams.create({ name: 'فريق السباق الأول', colorId, supervisorId: SUP1_ID }),
      api.teams.create({ name: 'فريق السباق الثاني', colorId, supervisorId: SUP1_ID }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = failed[0]!.reason as ApiError;
    expect(err.code).toBe('COLOR_TAKEN');
    expect(err.status).toBe(409);
    expect(err.message_ar).toBe(ERRORS.COLOR_TAKEN);
    const details = err.details as ColorTakenDetails;
    expect(details.refresh).toBe('colors');
    expect(details.fieldErrors.colorId[0]).toBe(ERRORS.COLOR_TAKEN);
    expect(details.available.map((c) => c.id)).not.toContain(colorId);
    expect(details.available.length).toBeGreaterThan(0);
  });
});

describe('DemoApi Phase 2 — teams and scope', () => {
  it('a supervisor’s team waits for approval (setting on), admins are notified, approval activates it', async () => {
    await loginAs(SUP2);
    const colorId = (await api.colors.available())[0]!.id;
    const team = await api.teams.create({ name: 'فريق جديد للمشرفة', colorId });
    expect(team.status).toBe('PENDING_APPROVAL');
    expect(team.supervisor?.fullName).toContain('سارة');

    await loginAs(ADMIN);
    const notes = await api.notifications.list({ unread: true, pageSize: 50 });
    expect(notes.items.some((x) => x.type === 'TEAM_PENDING_APPROVAL' && x.payload.teamId === team.id)).toBe(true);
    expect((await api.teams.approve(team.id)).status).toBe('ACTIVE');

    await api.settings.update({ REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: false });
    await loginAs(SUP2);
    const second = await api.teams.create({
      name: 'فريق ثانٍ دون اعتماد',
      colorId: (await api.colors.available())[0]!.id,
    });
    expect(second.status).toBe('ACTIVE');
  });

  it('MULTIPLE_TEAMS setting off: a supervisor who leads a team cannot lead another', async () => {
    await loginAs(ADMIN);
    await api.settings.update({ ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR: false });
    const err = await codeOf(
      api.teams.create({
        name: 'فريق إضافي',
        colorId: (await api.colors.available())[0]!.id,
        supervisorId: SUP1_ID,
      }),
    );
    expect(err.code).toBe('MULTIPLE_TEAMS_DISABLED');
  });

  it('a supervisor sees only the teams they lead; another team is 404', async () => {
    const me = await loginAs(SUP1);
    const teams = await api.teams.list({ status: 'ALL' });
    expect(teams.length).toBeGreaterThan(0);
    // A9 (ADR-100): «leads» = primary or co-supervisor; SUP1 co-leads team 4 in the demo seed.
    expect(teams.every((t) => t.supervisors?.some((s) => s.id === me.id))).toBe(true);
    expect(teams.some((t) => t.id === TEAM(4) && t.supervisor?.id !== me.id)).toBe(true);
    expect((await codeOf(api.teams.get(TEAM(3)))).code).toBe('NOT_FOUND');
    // Members: own teams and unassigned only.
    const members = await api.members.list({ pageSize: 200 });
    expect(members.items.every((m) => !m.team || teams.some((t) => t.id === m.team!.id))).toBe(true);
    // Moving members is admin-only.
    expect((await codeOf(api.members.move({ memberIds: [MEMBER(1)], toTeamId: TEAM(2) }))).code).toBe(
      'FORBIDDEN',
    );
  });

  it('GET /teams without status returns active and pending teams only', async () => {
    await loginAs(ADMIN);
    const open = await api.teams.list();
    expect(open.some((t) => t.status === 'ARCHIVED')).toBe(false);
    expect(open.some((t) => t.status === 'PENDING_APPROVAL')).toBe(true);
    expect((await api.teams.list({ status: 'ALL' })).some((t) => t.status === 'ARCHIVED')).toBe(true);
  });

  it('changing the supervisor closes and opens history rows with one timestamp', async () => {
    await loginAs(ADMIN);
    await api.teams.changeSupervisor(TEAM(1), {
      supervisorId: '00000000-0000-4000-8000-000000000005',
      reason: 'إعادة توزيع',
    });
    const rows = await api.teams.supervisorHistory(TEAM(1));
    const open = rows.filter((r) => r.validTo === null);
    expect(open).toHaveLength(1);
    const closed = rows.find((r) => r.validTo !== null)!;
    expect(closed.validTo).toBe(open[0]!.validFrom);
    expect(open[0]!.changedBy?.fullName).toBeTruthy();
  });
});

describe('DemoApi Phase 2 — membership history (brief §5.3)', () => {
  it('a move closes the open row and opens a new one at the same instant; exactly one row is open', async () => {
    await loginAs(ADMIN);
    const before = await api.members.history(MEMBER(1));
    expect(before.filter((h) => h.validTo === null)).toHaveLength(1);

    const moved = await api.members.move({
      memberIds: [MEMBER(1), MEMBER(2)],
      toTeamId: TEAM(3),
      reason: 'تغطية وردية',
    });
    expect(moved.every((m) => m.team?.id === TEAM(3))).toBe(true);

    for (const id of [MEMBER(1), MEMBER(2)]) {
      const rows = await api.members.history(id);
      const open = rows.filter((h) => h.validTo === null);
      expect(open).toHaveLength(1);
      expect(open[0]!.team.id).toBe(TEAM(3));
      expect(open[0]!.reason).toBe('تغطية وردية');
      const closed = rows.find((h) => h.team.id === TEAM(1) && h.validTo !== null)!;
      expect(closed.validTo).toBe(open[0]!.validFrom);
    }
    const audit = await api.audit.list({ action: 'members.moved' });
    expect(audit.total).toBe(1);
  });

  it('rejects the whole move when a member is already in the target team (details.memberIds)', async () => {
    await loginAs(ADMIN);
    const err = await codeOf(
      api.members.move({ memberIds: [MEMBER(1), MEMBER(8)], toTeamId: TEAM(1) }),
    );
    expect(err.code).toBe('MEMBER_ALREADY_IN_TEAM');
    expect((err.details as { memberIds: string[] }).memberIds).toEqual([MEMBER(1)]);
    // Nothing moved.
    expect((await api.members.get(MEMBER(8))).team?.id).not.toBe(TEAM(1));
  });

  it('cannot move into a pending team', async () => {
    await loginAs(ADMIN);
    expect((await codeOf(api.members.move({ memberIds: [MEMBER(1)], toTeamId: TEAM(6) }))).code).toBe(
      'TEAM_NOT_ACTIVE',
    );
  });

  it('a national ID belongs to one member only', async () => {
    await loginAs(ADMIN);
    const existing = await api.members.get(MEMBER(1));
    const err = await codeOf(
      api.teams.addMember(TEAM(2), { fullName: 'عضو مكرر الهوية', nationalId: existing.nationalId! }),
    );
    expect(err.code).toBe('NATIONAL_ID_TAKEN');
  });
});

describe('DemoApi Phase 2 — import preview', () => {
  it('previews per-row errors without saving, then commits only the valid rows', async () => {
    await loginAs(ADMIN);
    const taken = (await api.members.get(MEMBER(1))).nationalId!;
    const good = validId('198765432');
    const rows = [
      { fullName: 'سالم بن ناصر التجريبي', nationalId: good, jobTitle: 'سائق', department: 'قسم غير مدرج' },
      { fullName: 'اسم صحيح ورقم خاطئ', nationalId: '1234567890' },
      { fullName: 'تكرار في الملف', nationalId: good },
      { fullName: 'هوية مسجلة', nationalId: taken },
      { fullName: '', nationalId: validId('287654321') },
    ];
    const preview = await api.teams.importMembers({ teamId: TEAM(2), rows, commit: false });
    expect(preview.committed).toBe(0);
    expect(preview.results.map((r) => r.ok)).toEqual([true, false, false, false, false]);
    expect(preview.results[0]!.value?.jobTitleMatched).toBe(true);
    expect(preview.results[0]!.value?.departmentMatched).toBe(false);
    expect(preview.results[0]!.value?.nationalIdMasked).toMatch(/^1•+\d\d$/);
    expect(preview.results[2]!.errors.join(' ')).toContain('مكرّر');
    expect(preview.results[3]!.errors).toContain(ERRORS.NATIONAL_ID_TAKEN);
    const before = (await api.teams.get(TEAM(2))).memberCount;

    const commit = await api.teams.importMembers({ teamId: TEAM(2), rows, commit: true });
    expect(commit.committed).toBe(1);
    expect((await api.teams.get(TEAM(2))).memberCount).toBe(before + 1);
    expect((await api.audit.list({ action: 'members.imported' })).total).toBe(1);
  });
});

describe('DemoApi Phase 2 — work cards (brief §8)', () => {
  it('previews supervisors and members; the ID is masked per template and the QR holds the UUID', async () => {
    await loginAs(ADMIN);
    const templates = await api.cards.templates();
    const tpl = templates.find((x) => x.isDefault)!;
    const res = await api.cards.preview({ templateId: tpl.id, teamIds: [TEAM(1)] });
    expect(res.template.id).toBe(tpl.id);
    expect(res.subjects[0]!.userId).toBe(SUP1_ID);
    const member = res.subjects.find((s) => s.memberId)!;
    expect(member.data.nationalId).toMatch(/^[12]•{7}\d\d$/);
    expect(member.data.qrValue).toBe(member.memberId);

    await api.cards.updateTemplate(tpl.id, { config: { ...tpl.config, maskNationalId: false } });
    const full = await api.cards.preview({ templateId: tpl.id, teamIds: [TEAM(1)], includeSupervisors: false });
    expect(full.subjects.every((s) => s.memberId)).toBe(true);
    expect(full.subjects[0]!.data.nationalId).toMatch(/^[12]\d{9}$/);
  });

  it('a print batch is idempotent by key, and saveBack updates the member record', async () => {
    await loginAs(ADMIN);
    const tpl = (await api.cards.templates())[0]!;
    const preview = await api.cards.preview({ templateId: tpl.id, memberIds: [MEMBER(3)] });
    const subject = preview.subjects[0]!;
    const idempotencyKey = crypto.randomUUID();
    const input = {
      idempotencyKey,
      templateId: tpl.id,
      items: [
        {
          memberId: subject.memberId,
          data: { ...subject.data, fullName: 'اسم معدّل للكرت', jobTitle: 'فني كهرباء' },
          saveBack: true,
        },
      ],
    };
    const first = await api.cards.createBatch(input);
    const second = await api.cards.createBatch(input);
    expect(second.id).toBe(first.id);
    expect(first.idempotencyKey).toBe(idempotencyKey);
    expect((await api.cards.batches()).total).toBe(1);
    expect((await api.audit.list({ action: 'cards.printed' })).total).toBe(1);

    const member = await api.members.get(MEMBER(3));
    expect(member.fullName).toBe('اسم معدّل للكرت');
    expect(member.jobTitle).toBe('فني كهرباء');
    expect(member.jobTitleId).not.toBeNull();

    const detail = await api.cards.batch(first.id);
    expect(detail.items[0]!.savedBack).toBe(true);
    expect(detail.items[0]!.data.nationalId).toMatch(/•/);
    expect(detail.templateSnapshot).toMatchObject({ layoutKey: tpl.layoutKey });
    expect((await codeOf(api.cards.pdf(first.id))).code).toBe('PDF_NOT_CONFIGURED');
  });

  it('edits without saveBack stay in the batch only', async () => {
    await loginAs(ADMIN);
    const tpl = (await api.cards.templates())[0]!;
    const before = await api.members.get(MEMBER(4));
    const subject = (await api.cards.preview({ templateId: tpl.id, memberIds: [MEMBER(4)] })).subjects[0]!;
    await api.cards.createBatch({
      idempotencyKey: crypto.randomUUID(),
      templateId: tpl.id,
      items: [{ memberId: subject.memberId, data: { ...subject.data, fullName: 'اسم مؤقت' } }],
    });
    expect((await api.members.get(MEMBER(4))).fullName).toBe(before.fullName);
  });

  it('logos: rejects SVG, accepts PNG by its bytes; built-in sizes are locked', async () => {
    await loginAs(ADMIN);
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' });
    expect((await codeOf(api.logos.upload({ name: 'شعار متجه', file: svg }))).code).toBe('LOGO_FILE_INVALID');
    const fakePng = new Blob(['<svg/>'], { type: 'image/png' });
    expect((await codeOf(api.logos.upload({ name: 'شعار مزيف', file: fakePng }))).code).toBe(
      'LOGO_FILE_INVALID',
    );
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], {
      type: 'image/png',
    });
    const logo = await api.logos.upload({ name: 'شعار صحيح', file: png, isDefault: true });
    expect(logo.url).toMatch(/^data:image\/png;base64,/);
    expect((await api.logos.list()).filter((l) => l.isDefault).map((l) => l.id)).toEqual([logo.id]);

    const builtin = (await api.cards.sizes()).find((s) => s.isBuiltin)!;
    expect((await codeOf(api.cards.deleteSize(builtin.id))).code).toBe('BUILTIN_LOCKED');
  });
});

describe('DemoApi Phase 2 — reference data and audit vocabulary', () => {
  it('deleting a referenced item deactivates it; an unused one is deleted', async () => {
    await loginAs(ADMIN);
    const jobs = await api.reference.list('job-titles');
    const used = jobs.find((j) => j.name === 'عامل ميداني')!;
    expect(await api.reference.remove('job-titles', used.id)).toMatchObject({ result: 'DEACTIVATED' });
    const fresh = await api.reference.create('job-titles', { name: 'مسمى للحذف' });
    expect(await api.reference.remove('job-titles', fresh.id)).toMatchObject({ result: 'DELETED' });
    expect((await codeOf(api.reference.create('job-titles', { name: 'سائق' }))).code).toBe('NAME_TAKEN');

    const actions = new Set((await api.audit.list({ pageSize: 100 })).items.map((a) => a.action));
    for (const a of ['reference.created', 'reference.deleted']) expect(actions.has(a)).toBe(true);
  });

  it('a monitor cannot reach teams or cards', async () => {
    await loginAs('monitor1@demo.nuzli.example');
    expect((await codeOf(api.teams.list())).code).toBe('FORBIDDEN');
    expect((await codeOf(api.cards.batches())).code).toBe('FORBIDDEN');
  });
});
