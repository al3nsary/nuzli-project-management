/**
 * DemoApi A10 GanttPRO parity (docs/API.md «A10», ADR-124, ADR-125, ADR-130): a GanttPRO export
 * chosen as «Excel» is recognised by its content (detectedFormat, FORMAT_DETECTED, the richer
 * stats), the commit keeps colours, priorities, hours, the inferred calendar and the lagged link;
 * `export?format=ganttpro` writes GanttPRO's layout and re-imports identically — also after an
 * edit, and through MS Project XML; supervisor suggestions match the e-mail local part.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { suggestFor, suggestionIndex } from './imports';
import { blobToArrayBuffer } from '../../lib/bytes';
import type { ImportContentType } from '../../features/imports/files';
import { NOZOLY_CALENDAR_SHEET } from '../../features/imports/ganttpro';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-ganttpro-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const XLSX: ImportContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XML: ImportContentType = 'application/xml';
const fx = (name: string) =>
  new Uint8Array(readFileSync(join(process.cwd(), 'src/features/imports/__fixtures__', name)));

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
}

type Row = {
  wbs: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  durationHours?: number;
  progress: number;
  status: string;
  priority?: string;
  plannedCost?: number;
  actualCost?: number;
  deadline?: string | null;
  barColor?: string | null;
};
const pick = (t: Row) => ({
  wbs: t.wbs,
  name: t.name,
  type: t.type,
  startDate: t.startDate,
  endDate: t.endDate,
  durationDays: t.durationDays,
  durationHours: t.durationHours,
  progress: t.progress,
  status: t.status,
  priority: t.priority,
  plannedCost: t.plannedCost,
  actualCost: t.actualCost,
  deadline: t.deadline ?? null,
  barColor: t.barColor ?? null,
});

async function importSample() {
  const fileId = (await api.imports.upload(new Blob([fx('ganttpro-sample.xlsx')]), XLSX)).fileId;
  const pv = await api.imports.preview({ fileId, format: 'xlsx' });
  const res = await api.imports.commit({ previewId: pv.previewId, assigneeMap: { 'Sami Rahman': SUP1_ID } });
  return { pv, res };
}

describe('GanttPRO in the demo', () => {
  it('a GanttPRO workbook chosen as «Excel» is read as GanttPRO; the commit keeps colours, priorities, hours, calendar and links', async () => {
    await loginAs(ADMIN);
    const { pv, res } = await importSample();
    expect(pv.format).toBe('xlsx');
    expect(pv.detectedFormat).toBe('ganttpro');
    expect(pv.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['FORMAT_DETECTED', 'CALENDAR_DEFAULTED', 'ESTIMATES_NOT_IMPORTED']));
    expect(pv.stats).toMatchObject({ taskCount: 13, groupCount: 5, milestoneCount: 1, dependencyCount: 7, maxLevel: 5, colorCount: 7, coloredCount: 13, deadlineCount: 1, estimatedHours: 12, timeLogMinutes: 540 });
    expect(pv.stats.sourceTypes).toEqual({ project: 2, 'tasks group': 3, task: 7, milestone: 1 });
    expect(pv.unmappedAssignees.map((a) => [a.name, a.taskCount])).toEqual([
      ['Sami Rahman', 2],
      ['Unknown Person', 1],
      ['noura.k', 2],
    ]);
    const audit = await api.db.audit.toArray();
    expect(audit.find((a) => a.action === 'project.import_previewed')?.after).toMatchObject({ format: 'xlsx', detectedFormat: 'ganttpro', tasks: 13 });

    expect(res).toMatchObject({ taskCount: 13, dependencyCount: 7, calendarCreated: true });
    const g = await api.projects.gantt(res.projectId);
    expect(g.project).toMatchObject({ name: 'فيلا تجريبية', durationUnit: 'HOUR' });
    expect(g.calendar).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '10:00', end: '14:00' }, { start: '15:00', end: '19:00' }] });
    const t = (name: string) => g.tasks.find((x) => x.name === name)!;
    expect(t('حفر القواعد')).toMatchObject({ barColor: '#FF6363', priority: 'LOW', durationHours: 12, startDate: '2025-11-04T10:00' });
    expect(t('Painting')).toMatchObject({ priority: 'URGENT', status: 'ON_HOLD' });
    expect(t('Painting').assignee?.id).toBe(SUP1_ID);
    expect(new Set(g.tasks.map((x) => x.barColor)).size).toBe(7);
    expect(g.dependencies.map((d) => d.lagHours ?? 0).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it('format «ganttpro» on a plain workbook falls back to the Excel reader and says so', async () => {
    await loginAs(ADMIN);
    const fileId = (await api.imports.upload(new Blob([fx('tasks.xlsx')]), XLSX)).fileId;
    const pv = await api.imports.preview({ fileId, format: 'ganttpro' });
    expect(pv.detectedFormat).toBe('xlsx');
    expect(pv.warnings.map((w) => w.code)).toContain('FORMAT_DETECTED');
    expect(pv.stats.taskCount).toBe(5);
  });

  it('export ?format=ganttpro: GanttPRO layout, RTL without frozen panes, hidden calendar sheet — re-imports identically, also after an edit; MS Project XML re-imports with the same counts', async () => {
    await loginAs(ADMIN);
    const { res } = await importSample();
    // An edit first (as a drag/resize would): 3 more working hours on one task.
    const before = await api.projects.gantt(res.projectId);
    const edited = before.tasks.find((x) => x.name === 'تسوير الموقع')!;
    await api.tasks.update(edited.id, { version: edited.version, durationHours: 11 });
    const g = await api.projects.gantt(res.projectId);
    expect(g.tasks.find((x) => x.id === edited.id)!.durationHours).toBe(11);

    const blob = await api.projects.export(res.projectId, 'ganttpro');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blobToArrayBuffer(blob));
    for (const ws of wb.worksheets) for (const v of ws.views) expect([v.rightToLeft, v.state === 'frozen']).toEqual([true, false]);
    expect(wb.worksheets[0]!.getRow(5).getCell(2).value).toBe('WBS Number');
    expect(wb.getWorksheet(NOZOLY_CALENDAR_SHEET)!.state).toBe('hidden');

    const back = await api.imports.preview({ fileId: (await api.imports.upload(blob, XLSX)).fileId, format: 'ganttpro' });
    expect(back.detectedFormat).toBe('ganttpro');
    expect(back.warnings.map((w) => w.code).filter((c) => c !== 'HOURS_DETECTED')).toEqual([]);
    expect(back.project).toMatchObject({ name: 'فيلا تجريبية', durationUnit: 'HOUR' });
    expect(back.project.calendar).toMatchObject({ weekendDays: g.calendar.weekendDays, workingHours: g.calendar.workingHours });
    expect(back.tasks.map(pick)).toEqual(g.tasks.map(pick));
    const name = new Map(back.tasks.map((x) => [x.ref, x.name]));
    const gname = new Map(g.tasks.map((x) => [x.id, x.name]));
    expect(back.dependencies.map((d) => `${name.get(d.predecessorRef)}>${name.get(d.successorRef)}:${d.type}:${d.lagHours ?? 0}`).sort()).toEqual(
      g.dependencies.map((d) => `${gname.get(d.predecessorId)}>${gname.get(d.successorId)}:${d.type}:${d.lagHours ?? 0}`).sort(),
    );
    const audit = await api.db.audit.toArray();
    expect(audit.find((a) => a.action === 'project.exported')?.after).toMatchObject({ format: 'ganttpro', tasks: 13 });

    // MS Project XML of the same (edited) project.
    const xml = await api.projects.export(res.projectId, 'xml');
    const viaXml = await api.imports.preview({ fileId: (await api.imports.upload(xml, XML)).fileId, format: 'xml' });
    expect(viaXml.stats).toMatchObject({ taskCount: back.stats.taskCount, groupCount: back.stats.groupCount, milestoneCount: back.stats.milestoneCount, dependencyCount: back.stats.dependencyCount });
    expect(viaXml.tasks.map((x) => [x.wbs, x.startDate, x.endDate])).toEqual(g.tasks.map((x) => [x.wbs, x.startDate, x.endDate]));
  });

  it('supervisor suggestions: full name in any case/spacing, e-mail, or e-mail local part; two people with one key → none', () => {
    const idx = suggestionIndex([
      { id: 'a', fullName: 'SAMI  RAHMAN', email: 'sami@example.com' },
      { id: 'b', fullName: 'نورة', email: 'noura.k@example.com' },
      { id: 'c', fullName: 'خالد', email: 'k@example.com' },
      { id: 'd', fullName: 'خالد', email: 'k2@example.com' },
    ]);
    expect(suggestFor(idx, 'Sami Rahman')).toBe('a');
    expect(suggestFor(idx, 'noura.k')).toBe('b');
    expect(suggestFor(idx, 'Noura.K@other.org')).toBe('b');
    expect(suggestFor(idx, 'خالد')).toBeNull();
    expect(suggestFor(idx, 'Unknown Person')).toBeNull();
  });
});
