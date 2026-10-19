import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTeamAt } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { blobToArrayBuffer } from '../../lib/bytes';
import { uuidv4 } from '../../lib/uuid';
import { OfflineDb } from '../../features/violations/offline/db';
import { enqueueViolation } from '../../features/violations/offline/outbox';
import { SyncEngine } from '../../features/violations/offline/sync';
import { buildViolationsWorkbook } from '../../features/violations/excel';
import { riyadhWeekBounds } from '../../features/violations/time';

let n = 0;
let api: DemoApi;

beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-p3-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example'; // leads teams 1 and 2
const MONITOR = 'monitor1@demo.nuzli.example';
const seedId = (prefix: string, k: number) =>
  `00000000-0000-4000-8000-${prefix}${String(k).padStart(12 - prefix.length, '0')}`;
const TEAM = (k: number) => seedId('a', k);
const MEMBER = (k: number) => seedId('b', k);
const TYPE_1 = seedId('d1', 1);

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function errorOf(p: Promise<unknown>) {
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

function input(over: Record<string, unknown> = {}) {
  return {
    clientUuid: uuidv4(),
    memberId: MEMBER(1),
    typeId: TYPE_1,
    description: 'وصف مخالفة للاختبار',
    latitude: 24.7,
    longitude: 46.7,
    accuracyM: 9,
    capturedAt: new Date().toISOString(),
    deviceInfo: { userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test', secret: 'x' },
    expectedIdPhotos: 1,
    expectedEvidencePhotos: 1,
    ...over,
  };
}

describe('DemoApi Phase 3 — seed', () => {
  it('seeds the demo types and ~60 violations with snapshots from membership history', async () => {
    await loginAs(ADMIN);
    const types = await api.violationTypes.list();
    expect(types.length).toBeGreaterThanOrEqual(3);
    expect(types.every((ty) => ty.name.includes('(تجريبي)'))).toBe(true);
    const all = await api.violations.list({ pageSize: 200 });
    // 60 seeded with a person + 8 recorded without one (A9, seed/demo/a9-teams.json).
    expect(all.total).toBe(68);
    const unassigned = all.items.filter((v) => !v.member);
    expect(unassigned).toHaveLength(8);
    for (const v of unassigned) {
      expect(v.assigned).toBe(false);
      expect(v.team).toBeNull();
      expect(v.files.filter((f) => f.kind === 'PERSON')).toHaveLength(1);
      expect(v.files.filter((f) => f.kind === 'ID_CARD')).toHaveLength(1);
      expect(v.files.filter((f) => f.kind === 'EVIDENCE').length).toBeGreaterThanOrEqual(1);
      expect(v.ocrStatus).toBe('PENDING');
    }
    const memberships = await api.db.memberships.toArray();
    for (const v of await api.db.violations.toArray()) {
      const expected = resolveTeamAt(
        memberships.filter((m) => m.memberId === v.memberId),
        v.capturedAt,
      );
      expect(v.teamIdSnapshot).toBe(expected?.teamId ?? null);
      expect(Date.parse(v.capturedAt)).toBeLessThanOrEqual(Date.now());
    }
    // Placeholder photos are generated, never real files from the repository.
    const files = await api.db.files.toArray();
    expect(files.every((f) => f.placeholder)).toBe(true);
  });
});

describe('DemoApi Phase 3 — Phase 3 acceptance (brief §16)', () => {
  it('3 violations recorded in airplane mode sync exactly once with location, team snapshot and photos', async () => {
    const monitor = await loginAs(MONITOR);
    const db = new OfflineDb(`offline-acc-${Date.now()}-${n++}`);
    const engine = new SyncEngine({ api, db, getUserId: () => monitor.id });
    api.network.offline = true; // airplane mode

    const recorded = [
      { member: MEMBER(1), lat: 24.71, lng: 46.67, photos: 1 },
      { member: MEMBER(2), lat: 24.72, lng: 46.68, photos: 2 },
      { member: MEMBER(3), lat: 24.73, lng: 46.69, photos: 3 },
    ];
    const ids: string[] = [];
    for (const r of recorded) {
      const item = await enqueueViolation(db, {
        userId: monitor.id,
        payload: input({
          memberId: r.member,
          latitude: r.lat,
          longitude: r.lng,
          accuracyM: 11,
          expectedEvidencePhotos: r.photos,
        }) as never,
        display: { memberName: '', nationalIdMasked: '', teamName: null, teamColor: null, typeName: '' },
        photos: [
          { kind: 'PERSON', blob: jpeg(90) },
          { kind: 'ID_CARD', blob: jpeg() },
          ...Array.from({ length: r.photos }, () => ({ kind: 'EVIDENCE' as const, blob: jpeg(120) })),
        ],
      });
      ids.push(item.id);
      // Saving triggers a sync attempt; offline it changes nothing on the server.
      const report = await engine.run();
      expect(report.offline).toBe(true);
    }
    for (const id of ids) expect(await api.db.violations.where('clientUuid').equals(id).count()).toBe(0);
    expect((await db.outbox.toArray()).every((i) => i.status === 'pending')).toBe(true);

    // Reconnect: the `online` trigger runs the engine immediately.
    api.network.offline = false;
    const report = await engine.runNow();
    expect(report.synced).toBe(3);
    // A second trigger (focus, timer…) sends nothing again.
    await engine.runNow();

    await loginAs(ADMIN);
    const memberships = await api.db.memberships.toArray();
    const mine = (await api.violations.list({ recordedBy: monitor.id, pageSize: 200 })).items.filter((v) =>
      ids.includes(v.clientUuid),
    );
    expect(mine).toHaveLength(3);
    for (const id of ids) expect(await api.db.violations.where('clientUuid').equals(id).count()).toBe(1);
    for (const [i, r] of recorded.entries()) {
      const v = mine.find((x) => x.clientUuid === ids[i])!;
      expect(v).toBeTruthy();
      expect(v.latitude).toBe(r.lat);
      expect(v.longitude).toBe(r.lng);
      expect(v.accuracyM).toBe(11);
      const team = resolveTeamAt(
        memberships.filter((m) => m.memberId === r.member),
        v.capturedAt,
      );
      expect(v.team?.id).toBe(team?.teamId);
      expect(v.files.filter((f) => f.kind === 'ID_CARD' && f.ready)).toHaveLength(1);
      expect(v.files.filter((f) => f.kind === 'EVIDENCE' && f.ready)).toHaveLength(r.photos);
      // A9: the person's photo travels with the kind PERSON (owner decision 4).
      expect(v.files.filter((f) => f.kind === 'PERSON' && f.ready)).toHaveLength(1);
      expect(v.expectedPhotos).toEqual({ idCard: 1, evidence: r.photos, person: 1 });
      // Captured offline long before it synced is not "clock drift" (ADR-014).
      expect(v.clockDriftSuspect).toBe(false);
      // The stored photo is the one the device sent.
      const obj = await api.db.objects.get(v.files[0]!.id);
      expect(new Uint8Array(obj!.data).slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    }
  });

  it('keeps the old team when the member moved between recording and sync', async () => {
    const monitor = await loginAs(MONITOR);
    const before = new Date(Date.now() - 60 * 60_000).toISOString();
    // The member moves to team 3 after the violation was captured…
    await api.db.transaction('rw', api.db.memberships, async () => {
      const open = (await api.db.memberships.where('memberId').equals(MEMBER(1)).toArray()).find((m) => !m.validTo)!;
      const at = new Date(Date.now() - 30 * 60_000).toISOString();
      await api.db.memberships.update(open.id, { validTo: at });
      await api.db.memberships.add({ id: uuidv4(), memberId: MEMBER(1), teamId: TEAM(3), validFrom: at, validTo: null, movedById: null, reason: null });
    });
    // …and the device syncs now.
    const { violation, created } = await api.violations.create(input({ capturedAt: before }));
    expect(created).toBe(true);
    expect(violation.team?.id).toBe(TEAM(1));
    expect(violation.recordedBy.id).toBe(monitor.id);
    expect(violation.deviceInfo).toBeUndefined(); // admins only
  });
});

describe('DemoApi Phase 3 — create and photos', () => {
  it('is idempotent by clientUuid and never reveals another user’s UUID', async () => {
    await loginAs(MONITOR);
    const body = input();
    const a = await api.violations.create(body);
    const b = await api.violations.create(body);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.violation.id).toBe(a.violation.id);
    await loginAs('monitor2@demo.nuzli.example');
    expect((await errorOf(api.violations.create(body))).code).toBe('CONFLICT_VERSION');
  });

  it('keeps only the whitelisted device info and flags a wrong device clock', async () => {
    await loginAs(MONITOR);
    const skewed = new Date(Date.now() + 60 * 60_000).toISOString();
    const { violation } = await api.violations.create(input({ clientSentAt: skewed }));
    expect(violation.clockDriftSuspect).toBe(true);
    await loginAs(ADMIN);
    const v = await api.violations.get(violation.id);
    expect(v.deviceInfo).toEqual({ userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test' });
  });

  it('enforces one ID card and the photo limit, checks magic bytes, and confirms idempotently', async () => {
    await loginAs(MONITOR);
    const { violation } = await api.violations.create(input());
    const presign = (kind: 'ID_CARD' | 'EVIDENCE') =>
      api.files.presign({ entityType: 'violation', entityId: violation.id, kind, contentType: 'image/jpeg', sizeBytes: 96 });
    const id = await presign('ID_CARD');
    expect((await errorOf(presign('ID_CARD'))).code).toBe('TOO_MANY_PHOTOS');
    await api.files.upload(id, jpeg());
    expect((await api.files.confirm(id.fileId)).status).toBe('READY');
    expect((await api.files.confirm(id.fileId)).status).toBe('READY');
    // A PNG declared as JPEG is refused on confirm.
    const ev = await presign('EVIDENCE');
    await api.files.upload(ev, new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], { type: 'image/jpeg' }));
    expect((await errorOf(api.files.confirm(ev.fileId))).code).toBe('FILE_TYPE_NOT_ALLOWED');
    // Too many evidence photos announced up front.
    expect((await errorOf(api.violations.create(input({ expectedEvidencePhotos: 6 })))).code).toBe('TOO_MANY_PHOTOS');
  });

  it('fails like the network when offline', async () => {
    await loginAs(MONITOR);
    api.network.offline = true;
    const err = await errorOf(api.violations.create(input()));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
    expect((await errorOf(api.violations.roster())).code).toBe('NETWORK_ERROR');
  });
});

describe('DemoApi Phase 3 — review, edit window and audit', () => {
  it('lets the recorder edit within the window only; admins always, with an audit entry', async () => {
    await loginAs(MONITOR);
    const { violation } = await api.violations.create(input());
    const edited = await api.violations.update(violation.id, { description: 'وصف معدّل' });
    expect(edited.description).toBe('وصف معدّل');
    await api.db.violations.update(violation.id, { receivedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    const closed = await errorOf(api.violations.update(violation.id, { description: 'محاولة متأخرة' }));
    expect(closed.code).toBe('EDIT_WINDOW_CLOSED');
    expect(closed.status).toBe(403);
    await loginAs(ADMIN);
    await api.violations.update(violation.id, { description: 'تعديل المدير' });
    const audit = await api.audit.list({ entityType: 'violation', entityId: violation.id });
    expect(audit.items.map((a) => a.action)).toContain('violation.updated');
  });

  it('requires a reason to cancel and audits status changes and ID-card views', async () => {
    await loginAs(ADMIN);
    const v = (await api.violations.list({ pageSize: 1 })).items[0]!;
    expect((await errorOf(api.violations.setStatus(v.id, { status: 'CANCELLED' }))).code).toBe('VALIDATION_FAILED');
    const cancelled = await api.violations.setStatus(v.id, { status: 'CANCELLED', reason: 'سُجّلت بالخطأ' });
    expect(cancelled.cancelReason).toBe('سُجّلت بالخطأ');
    const back = await api.violations.setStatus(v.id, { status: 'UNDER_REVIEW' });
    expect(back.cancelReason).toBeNull();
    const idCard = back.files.find((f) => f.kind === 'ID_CARD')!;
    const evidence = back.files.find((f) => f.kind === 'EVIDENCE')!;
    expect((await api.violations.fileUrl(v.id, evidence.id)).url).toBeTruthy();
    expect((await api.violations.fileUrl(v.id, idCard.id)).url).toBeTruthy();
    const actions = (await api.audit.list({ entityId: v.id })).items.map((a) => a.action);
    expect(actions.filter((a) => a === 'violation.status_changed')).toHaveLength(2);
    // Only the ID-card view is audited (ADR-050).
    expect(actions.filter((a) => a === 'violation.id_photo_viewed')).toHaveLength(1);
  });
});

describe('DemoApi Phase 3 — supervisor visibility (brief §7.6)', () => {
  async function ownTeamViolation() {
    await loginAs(ADMIN);
    const all = (await api.violations.list({ pageSize: 200 })).items;
    // SUP1 leads teams 1 and 2 and co-leads team 4 (A9 seed): every one of them counts.
    const led = [TEAM(1), TEAM(2), TEAM(4)];
    return {
      own: all.filter((v) => v.team && led.includes(v.team.id)),
      other: all.filter((v) => v.team && !led.includes(v.team.id)),
    };
  }

  it('returns nothing while hidden (the default), enforced in the adapter not the UI', async () => {
    const { own } = await ownTeamViolation();
    expect(own.length).toBeGreaterThan(0);
    await loginAs(SUP1);
    expect((await api.violations.list({})).total).toBe(0);
    expect((await errorOf(api.violations.get(own[0]!.id))).code).toBe('NOT_FOUND');
  });

  it('shows only the supervisor’s own teams when the setting or the team override says SHOW', async () => {
    const { own, other } = await ownTeamViolation();
    await api.settings.update({ SUPERVISORS_CAN_SEE_VIOLATIONS: true });
    await loginAs(SUP1);
    const seen = await api.violations.list({ pageSize: 200 });
    expect(seen.total).toBe(own.length);
    expect(seen.items.every((v) => v.team && [TEAM(1), TEAM(2), TEAM(4)].includes(v.team.id))).toBe(true);
    // A9: unassigned violations have no team, so no supervisor ever sees them.
    expect(seen.items.some((v) => !v.member)).toBe(false);
    expect((await errorOf(api.violations.get(other[0]!.id))).code).toBe('NOT_FOUND');
    // Supervisors never get ID-card photos.
    const v = await api.violations.get(own[0]!.id);
    const idCard = v.files.find((f) => f.kind === 'ID_CARD')!;
    expect((await errorOf(api.violations.fileUrl(v.id, idCard.id))).code).toBe('FORBIDDEN');

    // A team override HIDE wins over the global setting.
    await loginAs(ADMIN);
    await api.teams.setViolationVisibility(TEAM(1), 'HIDE');
    await loginAs(SUP1);
    const partial = await api.violations.list({ pageSize: 200 });
    expect(partial.items.every((x) => x.team?.id === TEAM(2) || x.team?.id === TEAM(4))).toBe(true);

    // And SHOW wins when the global setting is off.
    await loginAs(ADMIN);
    await api.settings.update({ SUPERVISORS_CAN_SEE_VIOLATIONS: false });
    await api.teams.setViolationVisibility(TEAM(1), 'SHOW');
    await loginAs(SUP1);
    const onlyOne = await api.violations.list({ pageSize: 200 });
    expect(onlyOne.total).toBeGreaterThan(0);
    expect(onlyOne.items.every((x) => x.team?.id === TEAM(1))).toBe(true);
  });

  it('lets a supervisor respond on a visible violation and notifies the admins', async () => {
    const { own } = await ownTeamViolation();
    await api.teams.setViolationVisibility(TEAM(1), 'SHOW');
    const target = own.find((v) => v.team?.id === TEAM(1))!;
    await loginAs(SUP1);
    const after = await api.violations.respond(target.id, { body: 'العضو كان في استراحة رسمية.' });
    expect(after.responses).toHaveLength(1);
    await loginAs(ADMIN);
    const notes = await api.notifications.list({ unread: true });
    const n1 = notes.items.find((x) => x.type === 'VIOLATION_OBJECTION');
    expect(n1?.payload.violationId).toBe(target.id);
    expect(n1?.payload.supervisorName).toBeTruthy();
  });
});

describe('DemoApi Phase 3 — statistics and Excel (ADR-049, ADR-019)', () => {
  it('computes the dashboard with the API semantics', async () => {
    await loginAs(ADMIN);
    const s = await api.violations.stats({});
    expect(s.total).toBe(68);
    expect(s.unassigned).toBe(8);
    const withTeam = (await api.db.violations.toArray()).filter((v) => v.teamIdSnapshot).length;
    expect(s.byTeam.reduce((a, r) => a + r.count, 0)).toBe(withTeam);
    expect(s.topMembers.every((m) => m.count > 1)).toBe(true);
    expect(s.topMembers.length).toBeLessThanOrEqual(10);
    expect(s.byMonitor.reduce((a, r) => a + r.count, 0)).toBe(68);
    expect(s.heatmap.reduce((a, c) => a + c.count, 0)).toBe(68);
    expect(s.heatmap.every((c) => c.weekday >= 0 && c.weekday <= 6 && c.hour >= 0 && c.hour <= 23)).toBe(true);
    expect(s.points).toHaveLength(68);
    // This/previous week ignore the date range but keep other filters.
    const week = riyadhWeekBounds(new Date());
    const inWeek = (await api.db.violations.toArray()).filter(
      (v) => Date.parse(v.capturedAt) >= week.thisStart.getTime(),
    ).length;
    const narrowed = await api.violations.stats({ from: '2000-01-01', to: '2000-01-02' });
    expect(narrowed.total).toBe(0);
    expect(narrowed.thisWeek).toBe(inWeek);
    // A bbox filter applies to every chart.
    const boxed = await api.violations.stats({ bbox: '24.70,46.66,24.73,46.69' });
    expect(boxed.points.every((p) => p.lat >= 24.7 && p.lat <= 24.73)).toBe(true);
    expect(boxed.byMonitor.reduce((a, r) => a + r.count, 0)).toBe(boxed.total);
  });

  it('exports the filtered list as an RTL workbook with no freeze panes', async () => {
    await loginAs(ADMIN);
    const blob = await api.violations.exportXlsx({ status: 'CONFIRMED' });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blobToArrayBuffer(blob));
    expect(wb.worksheets.length).toBe(2);
    for (const ws of wb.worksheets) {
      expect(ws.views.length).toBeGreaterThan(0);
      for (const view of ws.views) {
        expect(view.rightToLeft).toBe(true);
        expect(view.state).not.toBe('frozen');
        expect((view as { xSplit?: number }).xSplit ?? 0).toBe(0);
        expect((view as { ySplit?: number }).ySplit ?? 0).toBe(0);
      }
    }
    const sheet = wb.worksheets[0]!;
    expect(sheet.getRow(1).getCell(1).value).toBe('تاريخ ووقت الرصد');
    expect(sheet.getRow(2).getCell(1).value).toBeInstanceOf(Date);
    const confirmed = (await api.db.violations.toArray()).filter((v) => v.status === 'CONFIRMED').length;
    expect(sheet.rowCount).toBe(confirmed + 1);
    // Only masked national IDs leave the system.
    for (let r = 2; r <= sheet.rowCount; r++) {
      expect(String(sheet.getRow(r).getCell(4).value)).toMatch(/^[12]•{7}\d{2}$/);
    }
    const audit = await api.audit.list({ action: 'violations.exported' });
    expect(audit.total).toBe(1);
  });

  it('builds RTL sheets without a frozen view even for an empty export (unit)', async () => {
    const wb = await buildViolationsWorkbook([], { generatedAt: new Date(), filterLabels: [] });
    for (const ws of wb.worksheets) {
      expect(ws.views).toEqual([{ rightToLeft: true }]);
    }
  });

  it('answers 501 for the dashboard PDF until the pdf service exists', async () => {
    await loginAs(ADMIN);
    const err = await errorOf(api.violations.dashboardPdf({}));
    expect(err.status).toBe(501);
    expect(err.code).toBe('PDF_NOT_CONFIGURED');
  });
});

describe('DemoApi Phase 3 — types', () => {
  it('lets the admin add, rename and deactivate types; monitors only see active ones', async () => {
    await loginAs(ADMIN);
    const created = await api.violationTypes.create({ name: 'نوع جديد (تجريبي)', severity: 'LOW' });
    expect((await errorOf(api.violationTypes.create({ name: 'نوع جديد (تجريبي)' }))).code).toBe('NAME_TAKEN');
    await api.violationTypes.update(created.id, { isActive: false });
    expect((await api.violationTypes.list()).some((ty) => ty.id === created.id)).toBe(true);
    await loginAs(MONITOR);
    expect((await api.violationTypes.list()).some((ty) => ty.id === created.id)).toBe(false);
    expect((await errorOf(api.violationTypes.create({ name: 'ممنوع' }))).code).toBe('FORBIDDEN');
  });
});
