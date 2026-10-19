/**
 * DemoApi A9 imports / exports / hours parity (docs/API.md «A9 — imports, exports, hours»,
 * ADR-109..112, ADR-117): upload → preview → commit with the API's rules (scope, 410, mapping to
 * ACTIVE supervisors only, calendar reuse/creation, re-base), the server-only paths (.mpp 501,
 * Jira Cloud), exports that re-import identically, the create form's working days/hours and the
 * DAY ↔ HOUR conversion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { isDemoJiraError } from './imports';
import { ApiError } from '../errors';
import { blobToArrayBuffer } from '../../lib/bytes';
import { buildPreview, previewTasksDto } from '../../features/imports/model';
import { parseMspdi } from '../../features/imports/mspdi';
import type { ImportContentType } from '../../features/imports/files';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-imports-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const SUSPENDED_ID = '00000000-0000-4000-8000-000000000006';

const fx = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'src/features/imports/__fixtures__', name)));
const XML: ImportContentType = 'application/xml';
const CSV: ImportContentType = 'text/csv';

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function errOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

async function upload(name: string, type: ImportContentType) {
  const bytes = fx(name);
  return (await api.imports.upload(new Blob([bytes], { type }), type)).fileId;
}

describe('imports — upload, preview, commit', () => {
  it('MS Project XML: preview (stats, calendar, warnings, names) → commit an HOUR project with the lunch-break calendar, hierarchy, links and the mapped assignee', async () => {
    await loginAs(ADMIN);
    const fileId = await upload('mspdi-hours.xml', XML);
    const pv = await api.imports.preview({ fileId, format: 'xml' });
    expect(pv.stats).toMatchObject({ taskCount: 5, groupCount: 1, milestoneCount: 1, dependencyCount: 3, maxLevel: 2, colorCount: 0, coloredCount: 0 });
    expect(pv.detectedFormat).toBe('xml');
    expect(pv.project).toMatchObject({ name: 'تشطيب البرج', durationUnit: 'HOUR', calendar: { workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] } });
    expect(pv.unmappedAssignees.map((a) => [a.name, a.taskCount, a.suggestedUserId])).toEqual([
      ['أحمد', 1, null],
      ['علي', 1, null],
    ]);
    expect(pv.warnings.map((w) => w.code).sort()).toEqual(['ASSIGNEE_MULTIPLE', 'DEPENDENCY_TYPE_IGNORED', 'HOURS_DETECTED']);
    expect(pv.warnings.every((w) => /[؀-ۿ]/.test(w.message_ar))).toBe(true);
    expect(new Date(pv.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);

    const res = await api.imports.commit({ previewId: pv.previewId, assigneeMap: { علي: SUP1_ID, أحمد: null } });
    expect(res).toMatchObject({ taskCount: 5, dependencyCount: 3, calendarCreated: true });
    const g = await api.projects.gantt(res.projectId);
    expect(g.project).toMatchObject({ name: 'تشطيب البرج', durationUnit: 'HOUR', status: 'PLANNING', autoSchedule: true, calendarId: res.calendarId });
    expect(g.calendar).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] });
    expect(g.calendar.exceptions.map((e) => [e.date, e.isWorking])).toEqual([['2026-10-20', false]]);
    const t = (name: string) => g.tasks.find((x) => x.name === name)!;
    expect(g.tasks.map((x) => [x.wbs, x.name, x.type])).toEqual([
      ['1', 'المرحلة الأولى', 'GROUP'],
      ['1.1', 'تجهيز الموقع & العزل', 'TASK'],
      ['1.2', 'التمديدات', 'TASK'],
      ['2', 'فحص', 'TASK'],
      ['3', 'اعتماد', 'MILESTONE'],
    ]);
    expect(t('التمديدات')).toMatchObject({ parentId: t('المرحلة الأولى').id, startDate: '2026-10-11T13:00', endDate: '2026-10-12T12:00', durationHours: 8 });
    expect(t('التمديدات').assignee?.id).toBe(SUP1_ID);
    expect(t('تجهيز الموقع & العزل').assignee).toBeNull();
    expect(t('اعتماد').startDate).toBe('2026-10-13T13:00');
    expect(g.dependencies.map((d) => [d.type, d.lagHours]).sort()).toEqual([
      ['FS', 0],
      ['FS', 8],
      ['SS', 1],
    ]);
    const audit = await api.db.audit.toArray();
    expect(audit.find((a) => a.action === 'project.import_previewed')?.after).toMatchObject({ format: 'xml', tasks: 5, dependencies: 3, durationUnit: 'HOUR' });
    expect(audit.find((a) => a.action === 'project.imported')).toMatchObject({ entityId: res.projectId, after: { format: 'xml', tasks: 5, dependencies: 3, calendarCreated: true, assigneesMapped: 1 } });
    // The preview is consumed and the upload deleted.
    expect((await api.db.files.get(fileId))?.deletedAt).toBeTruthy();
    const again = await errOf(api.imports.commit({ previewId: pv.previewId }));
    expect([again.code, again.status]).toEqual(['IMPORT_PREVIEW_EXPIRED', 410]);
  });

  it('Arabic CSV: options (project name), re-base to a new start, only ACTIVE supervisors, the default calendar reused, expired previews → 410', async () => {
    await loginAs(ADMIN);
    const fileId = await upload('tasks-ar.csv', CSV);
    const pv = await api.imports.preview({ fileId, format: 'csv', options: { projectName: 'مشروع الفيلا' } });
    expect(pv.project.name).toBe('مشروع الفيلا');
    const bad = await errOf(api.imports.commit({ previewId: pv.previewId, assigneeMap: { 'مشرف ١': SUSPENDED_ID } }));
    expect(bad.code).toBe('ASSIGNEE_NOT_SUPERVISOR');
    const res = await api.imports.commit({ previewId: pv.previewId, assigneeMap: {}, startDate: '2026-11-01' });
    expect(res.calendarCreated).toBe(false);
    const g = await api.projects.gantt(res.projectId);
    expect(g.project).toMatchObject({ name: 'مشروع الفيلا', durationUnit: 'DAY' });
    expect(g.tasks.find((x) => x.name === 'الحفر')).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-03', durationDays: 3, plannedCost: 1500, description: 'حفر الأساسات' });

    const file2 = await upload('tasks-ar.csv', CSV);
    const pv2 = await api.imports.preview({ fileId: file2, format: 'csv' });
    api.imports.expirePreview(pv2.previewId);
    expect((await errOf(api.imports.commit({ previewId: pv2.previewId }))).status).toBe(410);
  });

  it('Excel (sheet choice, hours column) and Jira CSV (forced HOUR) go through the same path', async () => {
    await loginAs(ADMIN);
    const xlsx = await upload('tasks.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const pv = await api.imports.preview({ fileId: xlsx, format: 'xlsx', options: { sheetName: 'الخطة' } });
    expect(pv.stats.taskCount).toBe(5);
    expect(pv.project.durationUnit).toBe('HOUR');
    const jira = await upload('jira-export.csv', CSV);
    const pj = await api.imports.preview({ fileId: jira, format: 'jira-csv', options: { durationUnit: 'HOUR' } });
    expect(pj.format).toBe('jira-csv');
    expect(pj.tasks.find((x) => x.sourceId === 'OPS-2')).toMatchObject({ durationHours: 16 });
    const res = await api.imports.commit({ previewId: pj.previewId });
    const g = await api.projects.gantt(res.projectId);
    expect(g.tasks.map((x) => x.wbs)).toEqual(['1', '1.1', '1.2', '2', '2.1']);
    expect(g.dependencies).toHaveLength(3);
  });

  it('errors: format mismatch, someone else’s file, a broken structure, supervisors refused, .mpp → 501, Jira Cloud needs the server', async () => {
    await loginAs(ADMIN);
    const fileId = await upload('mspdi-hours.xml', XML);
    // A10 (ADR-124): MS Project XML is read as XML whatever was chosen; a CSV chosen as Excel is still refused.
    const asXlsx = await api.imports.preview({ fileId, format: 'xlsx' });
    expect(asXlsx.detectedFormat).toBe('xml');
    expect(asXlsx.warnings.map((w) => w.code)).toContain('FORMAT_DETECTED');
    const csvFile = await upload('tasks-ar.csv', CSV);
    expect((await errOf(api.imports.preview({ fileId: csvFile, format: 'xlsx' }))).code).toBe('IMPORT_FORMAT_MISMATCH');
    // A CSV that is really a ZIP fails the structure check at confirm.
    expect((await errOf(api.imports.upload(new Blob([fx('tasks.xlsx')]), CSV))).code).toBe('FILE_TYPE_NOT_ALLOWED');
    const mpp = await api.imports.upload(new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2])]), 'application/vnd.ms-project');
    const e501 = await errOf(api.imports.preview({ fileId: mpp.fileId, format: 'mpp' }));
    expect([e501.code, e501.status]).toEqual(['MPP_CONVERTER_NOT_CONFIGURED', 501]);
    const noTasks = await api.imports.upload(new Blob([new TextEncoder().encode('a,b\n1,2\n')]), CSV);
    expect((await errOf(api.imports.preview({ fileId: noTasks.fileId, format: 'csv' }))).code).toBe('IMPORT_NO_TASKS');

    const badUrl = await errOf(api.imports.jira({ siteUrl: 'https://evil.example.com', email: 'a@b.sa', apiToken: 'secret-token-1', projectKey: 'OPS' }));
    expect(badUrl.code).toBe('JIRA_URL_NOT_ALLOWED');
    const noKey = await errOf(api.imports.jira({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'secret-token-1' }));
    expect(noKey.code).toBe('VALIDATION_FAILED');
    const demo = await errOf(api.imports.jira({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'secret-token-1', projectKey: 'OPS' }));
    expect(isDemoJiraError(demo)).toBe(true);
    expect(JSON.stringify(await api.db.audit.toArray())).not.toContain('secret-token-1');

    await loginAs(SUP1);
    expect((await errOf(api.imports.preview({ fileId, format: 'xml' }))).code).toBe('FORBIDDEN');
    expect((await errOf(api.imports.upload(new Blob([fx('tasks-ar.csv')]), CSV))).code).toBe('FORBIDDEN');
  });
});

describe('exports — xml, csv, xlsx', () => {
  it('MS Project XML export of an imported HOUR project re-imports identically (rows, calendar, links)', async () => {
    await loginAs(ADMIN);
    const pv = await api.imports.preview({ fileId: await upload('mspdi-hours.xml', XML), format: 'xml' });
    const res = await api.imports.commit({ previewId: pv.previewId, assigneeMap: { علي: SUP1_ID } });
    const blob = await api.projects.export(res.projectId, 'xml');
    const xml = new TextDecoder().decode(await blobToArrayBuffer(blob));
    expect(xml.startsWith('<?xml')).toBe(true);
    const back = buildPreview(parseMspdi(xml), { format: 'xml', fileId: null });
    const strip = (rows: ReturnType<typeof previewTasksDto>) => rows.map(({ ref: _r, sourceId: _s, parentRef: _p, assigneeName: _a, ...t }) => t);
    expect(strip(previewTasksDto(back))).toEqual(strip(pv.tasks));
    expect(back.project.calendar.workingHours).toEqual(pv.project.calendar.workingHours);
    expect(back.project.calendar.weekendDays).toEqual(pv.project.calendar.weekendDays);
    expect(back.deps.map((d) => [d.type, d.lagMinutes]).sort()).toEqual(pv.dependencies.map((d) => [d.type, Math.round((d.lagHours ?? 0) * 60)]).sort());
    // And through the demo importer itself: export → upload → preview → commit.
    const again = await api.imports.preview({ fileId: (await api.imports.upload(blob, XML)).fileId, format: 'xml' });
    expect(again.stats).toEqual(pv.stats);
    const audit = await api.db.audit.toArray();
    expect(audit.find((a) => a.action === 'project.exported')?.after).toMatchObject({ format: 'xml', tasks: 5 });
  });

  it('CSV export: BOM, CRLF, Arabic headers, neutralised formulas; xlsx export: RTL, never frozen; both re-import', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'مشروع التصدير', startDate: '2026-11-01' });
    await api.tasks.create(p.id, { name: '=HYPERLINK("x")', startDate: '2026-11-01', durationDays: 2 });
    const csv = new Uint8Array(await blobToArrayBuffer(await api.projects.export(p.id, 'csv')));
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(csv.subarray(3));
    expect(text.split('\r\n')[0]).toContain('رقم WBS,المهمة,النوع');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    const pv = await api.imports.preview({ fileId: (await api.imports.upload(new Blob([csv]), CSV)).fileId, format: 'csv' });
    expect(pv.tasks.map((x) => x.name)).toEqual(["'=HYPERLINK(\"x\")"]);

    const xlsx = await api.projects.export(p.id, 'xlsx');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blobToArrayBuffer(xlsx));
    for (const ws of wb.worksheets) for (const v of ws.views) expect([v.rightToLeft, v.state === 'frozen']).toEqual([true, false]);
    const back = await api.imports.preview({ fileId: (await api.imports.upload(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).fileId, format: 'xlsx' });
    expect(back.tasks[0]).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-02', durationDays: 2 });
  });
});

describe('hours — create form and conversion', () => {
  it('workingDays + workingHours create a project calendar; the same days/hours as the default reuse it', async () => {
    await loginAs(ADMIN);
    const def = (await api.calendars.list()).find((c) => c.isDefault)!;
    const p = await api.projects.create({ name: 'ورشة الساعات', startDate: '2026-11-01', durationUnit: 'HOUR', workingDays: [0, 1, 2, 3, 4, 6], workingHours: [{ start: '07:00', end: '11:00' }, { start: '12:00', end: '16:00' }] });
    expect(p.durationUnit).toBe('HOUR');
    expect(p.calendarId).not.toBe(def.id);
    const cal = await api.calendars.get(p.calendarId);
    expect(cal).toMatchObject({ name: 'تقويم ورشة الساعات', weekendDays: [5], workingHours: [{ start: '07:00', end: '11:00' }, { start: '12:00', end: '16:00' }] });
    expect(cal.exceptions.length).toBe(def.exceptions.length);
    const t = await api.tasks.create(p.id, { name: 'تركيب', startDate: '2026-11-01', durationHours: 6 });
    expect(t).toMatchObject({ startDate: '2026-11-01T07:00', endDate: '2026-11-01T14:00' });
    const same = await api.projects.create({ name: 'افتراضي', startDate: '2026-11-01', workingDays: [0, 1, 2, 3, 4] });
    expect(same.calendarId).toBe(def.id);
    expect((await errOf(api.projects.create({ name: 'بلا أيام', startDate: '2026-11-01', workingDays: [] }))).code).toBe('VALIDATION_FAILED');
  });

  it('POST /projects/:id/convert: DAY → HOUR keeps the working days and turns lags into hours; back to DAY; audited', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'تحويل', startDate: '2026-11-01' });
    const a = await api.tasks.create(p.id, { name: 'أ', startDate: '2026-11-01', durationDays: 2 });
    const b = await api.tasks.create(p.id, { name: 'ب', startDate: '2026-11-01', durationDays: 1 });
    await api.dependencies.create(p.id, { predecessorId: a.id, successorId: b.id, lagDays: 1 });
    const hp = await api.projects.convert(p.id, 'HOUR');
    expect(hp.durationUnit).toBe('HOUR');
    let g = await api.projects.gantt(p.id);
    expect(g.tasks.find((x) => x.name === 'أ')).toMatchObject({ startDate: '2026-11-01T09:00', endDate: '2026-11-02T18:00', durationHours: 16 });
    expect(g.dependencies[0]!.lagHours).toBe(8);
    expect(g.tasks.find((x) => x.name === 'ب')!.startDate).toBe('2026-11-04T09:00');
    await api.projects.convert(p.id, 'DAY');
    g = await api.projects.gantt(p.id);
    expect(g.project.durationUnit).toBe('DAY');
    expect(g.tasks.find((x) => x.name === 'أ')).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-02', durationDays: 2 });
    expect(g.dependencies[0]).toMatchObject({ lagDays: 1 });
    expect(g.dependencies[0]!.lagHours).toBeUndefined();
    const conv = (await api.db.audit.toArray()).filter((x) => x.action === 'project.converted');
    expect(conv.map((x) => [(x.before as { durationUnit: string }).durationUnit, (x.after as { durationUnit: string }).durationUnit].join('→')).sort()).toEqual(['DAY→HOUR', 'HOUR→DAY']);
  });
});
