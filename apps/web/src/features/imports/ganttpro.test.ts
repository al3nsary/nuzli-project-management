/**
 * A10 (ADR-124, ADR-130): the API's GanttPRO spec (apps/api/src/imports/ganttpro.spec.ts) against
 * the browser port — the same synthetic export (copied byte for byte into __fixtures__), the same
 * expectations for the layout, values, calendar inference, predecessors, content sniffing and the
 * MS Project 2016–2021 file — plus the GanttPRO-layout writer: layout, RTL without frozen panes,
 * and a round trip through the importer for DAY and HOUR projects.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workbook } from 'exceljs';
import { draftOf, sniffFormat } from './files';
import {
  argbToHex,
  deadlineOf,
  detectGanttpro,
  ganttproToDraft,
  GANTTPRO_COLUMNS,
  inferCalendar,
  NOZOLY_CALENDAR_SHEET,
  NOZOLY_FOOTER,
  sheetNameOf,
  utcCellToLocal,
  writeGanttpro,
  type GanttproExport,
} from './ganttpro';
import { buildPreview, previewDepsDto, previewTasksDto, type PreviewPayload } from './model';
import { parseMspdi } from './mspdi';
import { readXlsx, type TableRow } from './tabular';

const fx = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(join(process.cwd(), 'src/features/imports/__fixtures__', n)));

async function sample(): Promise<{
  preview: PreviewPayload;
  draft: ReturnType<typeof ganttproToDraft>;
}> {
  const { rows, sheet, calendarRows } = await readXlsx(fx('ganttpro-sample.xlsx'));
  const layout = detectGanttpro(rows);
  expect(layout).not.toBeNull();
  const draft = ganttproToDraft(rows, layout!, { sheetName: sheet, calendarRows });
  return {
    draft,
    preview: buildPreview(draft, { format: 'ganttpro', fileId: null, today: '2025-11-01' }),
  };
}

describe('GanttPRO import — the synthetic export (browser port)', () => {
  it('layout: header on row 5, the name in C..G, footer and blank row skipped, exact counts per type, depth 5', async () => {
    const { rows } = await readXlsx(fx('ganttpro-sample.xlsx'));
    const layout = detectGanttpro(rows)!;
    expect(layout.headerRow).toBe(4);
    expect(layout.nameCols).toEqual([2, 3, 4, 5, 6]);
    expect(layout.cols).toMatchObject({ color: 0, wbs: 1, name: 6, assigned: 7, start: 8, end: 9, type: 23, project: 24, level: 25 });

    const { draft, preview } = await sample();
    expect(draft.tasks).toHaveLength(13);
    expect(draft.tasks.some((t) => /ganttpro/i.test(t.name))).toBe(false);
    expect(draft.sourceStats).toEqual({ sourceTypes: { project: 2, 'tasks group': 3, task: 7, milestone: 1 }, estimatedHours: 12, timeLogMinutes: 540 });
    const t = previewTasksDto(preview);
    expect(t.filter((x) => x.type === 'GROUP')).toHaveLength(5);
    expect(t.filter((x) => x.type === 'TASK')).toHaveLength(7);
    expect(t.filter((x) => x.type === 'MILESTONE')).toHaveLength(1);
    expect(Math.max(...t.map((x) => x.wbs.split('.').length))).toBe(5);
    expect(preview.project.name).toBe('فيلا تجريبية');
    const by = (n: string) => t.find((x) => x.name === n)!;
    expect(by('حفر القواعد').wbs).toBe('1.1.3.1.1');
    expect(by('حفر القواعد').parentRef).toBe(by('الحفر').ref);
    expect(by('Handover').parentRef).toBeNull();
    expect(by('أعمال الموقع').type).toBe('GROUP');
  });

  it('dates UTC → Riyadh (07:00Z → 10:00), hours → an HOUR project, the calendar inferred from the task times', async () => {
    const { preview } = await sample();
    expect(preview.project.durationUnit).toBe('HOUR');
    expect(preview.project.calendar).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '10:00', end: '14:00' }, { start: '15:00', end: '19:00' }] });
    expect(preview.warnings.find((w) => w.code === 'CALENDAR_DEFAULTED')!.message_ar).toContain('استُنتج');
    const t = previewTasksDto(preview);
    const by = (n: string) => t.find((x) => x.name === n)!;
    expect(by('تسوير الموقع')).toMatchObject({ startDate: '2025-11-02T10:00', endDate: '2025-11-02T19:00', durationHours: 8 });
    expect(by('حفر القواعد')).toMatchObject({ startDate: '2025-11-04T10:00', endDate: '2025-11-05T14:00', durationHours: 12, deadline: '2025-11-06' });
    expect(by('صب النظافة')).toMatchObject({ startDate: '2025-11-05T15:00', endDate: '2025-11-05T19:00' });
    // FS + 1 working hour after «Painting» (ends 11-10 19:00) → 11-11 11:00.
    expect(by('Cleaning')).toMatchObject({ startDate: '2025-11-11T11:00', endDate: '2025-11-11T13:00', durationHours: 2 });
    expect(by('اعتماد التصميم').type).toBe('MILESTONE');
    expect(preview.project.startDate).toBe('2025-11-02');
  });

  it('colours from the column-A fill (exceljs in the browser exposes the fill), statuses and priorities, costs, progress, description with links', async () => {
    const { rows } = await readXlsx(fx('ganttpro-sample.xlsx'));
    expect(rows[5]![0]!.fill).toMatch(/^FF[0-9A-F]{6}$/i);
    const { preview } = await sample();
    const t = previewTasksDto(preview);
    const by = (n: string) => t.find((x) => x.name === n)!;
    expect(by('حفر القواعد').barColor).toBe('#FF6363');
    expect(by('الأساسات').barColor).toBe('#81C784');
    expect(by('Site survey').barColor).toBe('#217EE9');
    expect(new Set(t.map((x) => x.barColor)).size).toBe(7);
    expect(by('تسوير الموقع')).toMatchObject({ status: 'DONE', priority: 'HIGH', plannedCost: 1200, actualCost: 1000, progress: 100 });
    expect(by('Site survey')).toMatchObject({ status: 'IN_PROGRESS', priority: 'MEDIUM', progress: 50 });
    expect(by('حفر القواعد')).toMatchObject({ status: 'NOT_STARTED', priority: 'LOW' });
    expect(by('Painting')).toMatchObject({ status: 'ON_HOLD', priority: 'URGENT', actualCost: 50 });
    expect(by('Cleaning')).toMatchObject({ status: 'NOT_STARTED', priority: 'LOW', notes: 'See https://example.com/spec\nSecond line' });
    expect(by('Handover').status).toBe('DONE');
    const codes = preview.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['STATUS_UNKNOWN', 'ASSIGNEE_MULTIPLE', 'ESTIMATES_NOT_IMPORTED', 'CALENDAR_DEFAULTED']));
    expect(by('حفر القواعد').assigneeName).toBe('Unknown Person');
  });

  it('predecessors by WBS: plain, with type + lag, and several separated by ; — all resolved', async () => {
    const { preview } = await sample();
    const t = previewTasksDto(preview);
    const name = new Map(t.map((x) => [x.ref, x.name]));
    const deps = previewDepsDto(preview).map((x) => `${name.get(x.predecessorRef)}>${name.get(x.successorRef)}:${x.type}:${x.lagHours ?? 0}`);
    expect(deps.sort()).toEqual(
      [
        'تسوير الموقع>Site survey:FS:0',
        'Site survey>حفر القواعد:FS:0',
        'حفر القواعد>صب النظافة:FS:0',
        'صب النظافة>اعتماد التصميم:FS:0',
        'Painting>Cleaning:FS:1',
        'Cleaning>Handover:FS:0',
        'اعتماد التصميم>Handover:FS:0',
      ].sort(),
    );
    expect(preview.warnings.some((w) => w.code === 'PREDECESSOR_MISSING')).toBe(false);
  });

  it('draftOf: a GanttPRO workbook chosen as «xlsx» or «ganttpro» is read as GanttPRO; a plain workbook stays Excel', async () => {
    expect((await draftOf('xlsx', fx('ganttpro-sample.xlsx'))).detectedFormat).toBe('ganttpro');
    expect((await draftOf('ganttpro', fx('ganttpro-sample.xlsx'))).detectedFormat).toBe('ganttpro');
    const plain = await draftOf('ganttpro', fx('tasks.xlsx'));
    expect(plain.detectedFormat).toBe('xlsx');
    expect(plain.tasks).toHaveLength(5);
  });
});

// ─────────────────────────────────────────── layouts in memory

const cellsOf = (vals: unknown[]): TableRow => vals.map((v) => ({ v }));
function gpRows(header: string[], data: unknown[][], banner = 'Create professional Gantt charts in GanttPRO in a few clicks', project = 'Tower'): TableRow[] {
  return [cellsOf([]), cellsOf(['', '', '', '', '', '', '', '', '', '', '', banner]), cellsOf([]), cellsOf([project]), cellsOf(header), ...data.map(cellsOf)];
}
const EN = GANTTPRO_COLUMNS.map(([, h]) => h);
const at = (local: string) => new Date(Date.parse(`${local}:00Z`) - 3 * 3600_000);
function gpRow(o: { wbs: string; level: number; type: string; name: string; start?: string; end?: string; hours?: number; pred?: string }): unknown[] {
  const r: unknown[] = new Array(26).fill('');
  r[1] = o.wbs;
  for (let c = 1 + o.level; c <= 6; c++) r[c] = o.name;
  r[8] = o.start ? at(o.start) : '';
  r[9] = o.end ? at(o.end) : '';
  r[12] = o.hours ?? 0;
  r[18] = o.pred ?? '';
  r[23] = o.type;
  r[25] = o.level;
  return r;
}

describe('GanttPRO layouts and rules (browser port)', () => {
  it('a single level-1 «project» row named like the project becomes the project and is not imported', () => {
    const rows = gpRows(EN, [
      gpRow({ wbs: '1', level: 1, type: 'project', name: 'Tower', start: '2025-11-02T09:00', end: '2025-11-02T13:00', hours: 4 }),
      gpRow({ wbs: '1.1', level: 2, type: 'task', name: 'A', start: '2025-11-02T09:00', end: '2025-11-02T11:00', hours: 2 }),
      gpRow({ wbs: '1.2', level: 2, type: 'task', name: 'B', start: '2025-11-02T11:00', end: '2025-11-02T13:00', hours: 2, pred: '1.1' }),
    ]);
    const draft = ganttproToDraft(rows, detectGanttpro(rows)!, { sheetName: 'Tower' });
    expect(draft.projectName).toBe('Tower');
    expect(draft.tasks.map((t) => [t.name, t.parentKey])).toEqual([
      ['A', null],
      ['B', null],
    ]);
    expect(draft.deps).toHaveLength(1);
    expect(draft.warnings.map((w) => w.code)).toContain('PROJECT_ROOT_USED');
  });

  it('Level is cross-checked against the WBS number (LEVEL_MISMATCH), one-minute tasks are rounded up (DURATION_ROUNDED)', () => {
    const rows = gpRows(EN, [
      gpRow({ wbs: '1', level: 1, type: 'tasks group', name: 'G', start: '2025-11-02T09:00', end: '2025-11-02T13:00', hours: 4 }),
      gpRow({ wbs: '1.1', level: 3, type: 'task', name: 'A', start: '2025-11-02T09:00', end: '2025-11-02T09:01', hours: 1 / 60 }),
    ]);
    const draft = ganttproToDraft(rows, detectGanttpro(rows)!);
    const codes = draft.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['LEVEL_MISMATCH', 'DURATION_ROUNDED']));
    expect(draft.tasks[1]!.parentKey).toBe(draft.tasks[0]!.key);
    const p = buildPreview(draft, { format: 'ganttpro', fileId: null, today: '2025-11-01' });
    expect(previewTasksDto(p).find((t) => t.name === 'A')!.durationHours).toBe(0.25);
  });

  it('Arabic and Russian GanttPRO headers are recognised; unknown headers fall back to GanttPRO positions', () => {
    const ar = ['اللون', 'رقم WBS', '', '', '', '', 'اسم المهمة / العنوان', 'مسند إلى', 'تاريخ البدء المخطط', 'تاريخ الانتهاء المخطط', 'الموعد النهائي', 'التقدم (%)', 'المدة (ساعات)', 'الساعات المقدرة', 'سجل الوقت (دقائق)', 'الحالة', 'الأولوية', 'وصف المهمة', 'السابقة', 'الميزانية', 'التكلفة الفعلية', 'تاريخ الإنشاء', 'المنشئ', 'النوع', 'المشروع', 'المستوى'];
    const ru = ['Цвет', 'Номер WBS', '', '', '', '', 'Название задачи / Заголовок', 'Назначено', 'Плановая дата начала', 'Плановая дата окончания', 'Дедлайн', 'Прогресс (%)', 'Длительность (часы)', 'Оценка (часы)', 'Учет времени (минуты)', 'Статус', 'Приоритет', 'Описание задачи', 'Предшественник', 'Бюджет', 'Фактическая стоимость', 'Создано', 'Создатель', 'Тип', 'Проект', 'Уровень'];
    for (const header of [ar, ru]) {
      const layout = detectGanttpro(gpRows(header, [gpRow({ wbs: '1', level: 1, type: 'задача', name: 'X' })]))!;
      expect(layout).toMatchObject({ headerRow: 4, cols: { wbs: 1, name: 6, start: 8, end: 9, duration: 12, status: 15, type: 23, level: 25 } });
    }
    const xx = EN.map((h, i) => (h ? `Kolumn${i}` : ''));
    const layout = detectGanttpro(gpRows(xx, [gpRow({ wbs: '1', level: 1, type: 'task', name: 'X', start: '2025-11-02T09:00', end: '2025-11-02T10:00', hours: 1 })]))!;
    expect(layout.cols).toMatchObject({ wbs: 1, name: 6, start: 8, duration: 12, type: 23, level: 25 });
    const draft = ganttproToDraft(gpRows(xx, [gpRow({ wbs: '1', level: 1, type: 'task', name: 'X', start: '2025-11-02T09:00', end: '2025-11-02T10:00', hours: 1 })]), layout);
    expect(draft.tasks[0]).toMatchObject({ name: 'X', start: '2025-11-02T09:00', durationMinutes: 60 });
    expect(detectGanttpro([cellsOf(['WBS', 'Task name', 'Start', 'Finish'])])).toBeNull();
  });

  it('values: UTC cells → Riyadh, deadlines keep the UTC day, ARGB → #RRGGBB, sheet names', () => {
    expect(utcCellToLocal(new Date('2025-11-05T07:00:00Z'))).toBe('2025-11-05T10:00');
    expect(utcCellToLocal(new Date('2025-11-05T22:30:00Z'))).toBe('2025-11-06T01:30');
    expect(deadlineOf(new Date('2025-11-16T23:58:00Z'))).toBe('2025-11-16');
    expect(argbToHex('FF50C7D6')).toBe('#50C7D6');
    expect(argbToHex('#50c7d6')).toBe('#50C7D6');
    expect(argbToHex('theme')).toBeNull();
    const sheet = sheetNameOf('مشروع: [البرج]/المرحلة ١ والمرحلة الثانية الطويلة');
    expect(sheet.length).toBeLessThanOrEqual(31);
    expect(sheet).not.toMatch(/[[\]:*?/\\]/);
    expect(sheet.startsWith('مشروع البرج المرحلة')).toBe(true);
    expect(sheetNameOf('Nozoly calendar')).toBe('Project');
  });

  it('calendar inference: a lunch break where it explains the durations, weekend from unused weekdays; too little data → default', () => {
    const samples = [
      { start: '2025-11-02T08:00', end: '2025-11-02T17:00', minutes: 480 },
      { start: '2025-11-03T08:00', end: '2025-11-03T12:00', minutes: 240 },
      { start: '2025-11-03T13:00', end: '2025-11-03T17:00', minutes: 240 },
      { start: '2025-11-04T08:00', end: '2025-11-05T17:00', minutes: 960 },
      { start: '2025-11-06T08:00', end: '2025-11-06T17:00', minutes: 480 },
      { start: '2025-11-08T08:00', end: '2025-11-08T17:00', minutes: 480 },
    ];
    expect(inferCalendar(samples)).toMatchObject({ inferred: true, weekendDays: [5], workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], matched: 6, total: 6 });
    expect(inferCalendar(samples.slice(0, 2))).toMatchObject({ inferred: false, weekendDays: [5, 6], workingHours: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] });
  });

  it('sniffFormat: ZIP → xlsx, OLE2 → mpp, MSPDI with or without the namespace → xml, anything else → null', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffFormat(fx('ganttpro-sample.xlsx'))).toBe('xlsx');
    expect(sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('mpp');
    expect(sniffFormat(fx('mspdi-2019.xml'))).toBe('xml');
    expect(sniffFormat(enc('﻿<?xml version="1.0"?><Project><Tasks><Task/></Tasks></Project>'))).toBe('xml');
    expect(sniffFormat(enc('<?xml version="1.0"?><Other/>'))).toBeNull();
    expect(sniffFormat(fx('tasks-ar.csv'))).toBeNull();
  });
});

describe('MS Project 2016–2021 XML (browser port)', () => {
  it('namespace, Arabic names, the project calendar by CalendarUID with an exception, summary, milestone, inactive task skipped, work resources only, costs', () => {
    const draft = parseMspdi(new TextDecoder().decode(fx('mspdi-2019.xml')));
    expect(draft.projectName).toBe('مجمع تجريبي');
    expect(draft.tasks.map((t) => t.name)).toEqual(['الهيكل الإنشائي', 'Excavation & shoring', 'صب الخرسانة', 'تسليم الهيكل']);
    expect(draft.warnings.map((w) => w.code)).toContain('INACTIVE_SKIPPED');
    expect(draft.calendar).toMatchObject({ name: 'تقويم المشروع', weekendDays: [5, 6], workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] });
    expect(draft.calendar!.exceptions).toEqual([{ date: '2025-11-04', isWorking: false, name: 'إجازة تجريبية' }]);
    const p = buildPreview(draft, { format: 'xml', fileId: null, today: '2025-11-01' });
    expect(p.project.durationUnit).toBe('DAY');
    const t = previewTasksDto(p);
    const by = (n: string) => t.find((x) => x.name === n)!;
    expect(by('الهيكل الإنشائي').type).toBe('GROUP');
    expect(by('Excavation & shoring')).toMatchObject({ parentRef: by('الهيكل الإنشائي').ref, assigneeName: 'مشرف تجريبي', plannedCost: 2500, actualCost: 1000, durationDays: 2, startDate: '2025-11-02', endDate: '2025-11-03', notes: 'ملاحظة تجريبية' });
    expect(by('صب الخرسانة')).toMatchObject({ startDate: '2025-11-05', endDate: '2025-11-06', deadline: '2025-11-09', assigneeName: null });
    expect(by('تسليم الهيكل').type).toBe('MILESTONE');
  });
});

// ─────────────────────────────────────────── writer + round trip (pure)

function exportOf(unit: 'DAY' | 'HOUR'): GanttproExport {
  const hour = unit === 'HOUR';
  const span = (d: string, s: string, e: string, h: number) => (hour ? { startDate: `${d}T${s}`, endDate: `${d.slice(0, 8)}${e}`, durationHours: h } : { startDate: d, endDate: d.slice(0, 8) + e.slice(0, 2) });
  return {
    name: 'مشروع البرج',
    unit,
    generatedAt: new Date('2026-10-19T08:00:00Z'),
    calendar: { name: 'افتراضي', weekendDays: [5, 6], workingHours: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }], exceptions: [{ date: '2026-10-20', isWorking: false, name: 'عطلة' }] },
    tasks: [
      { id: 'g', parentId: null, wbs: '1', name: 'المرحلة', type: 'GROUP', ...span('2026-10-11', '09:00', hour ? '12T13:00' : '12', 12), durationDays: 2, progress: 20, status: 'IN_PROGRESS', priority: 'MEDIUM', assigneeName: null, description: null, plannedCost: 700, actualCost: 100, deadline: null, barColor: '#4DB6AC' },
      { id: 'a', parentId: 'g', wbs: '1.1', name: 'الحفر', type: 'TASK', ...span('2026-10-11', '09:00', hour ? '11T15:00' : '11', 5), durationDays: 1, progress: 40, status: 'IN_PROGRESS', priority: 'URGENT', assigneeName: 'مشرف ١', description: '=رابط https://example.com', plannedCost: 500, actualCost: 100, deadline: '2026-10-15', barColor: '#FF6363' },
      { id: 'b', parentId: 'g', wbs: '1.2', name: 'الصب', type: 'TASK', ...span('2026-10-12', '09:00', hour ? '12T13:00' : '12', 4), durationDays: 1, progress: 0, status: 'ON_HOLD', priority: 'LOW', assigneeName: null, description: null, plannedCost: 200, actualCost: 0, deadline: null, barColor: null },
      { id: 'm', parentId: null, wbs: '2', name: 'التسليم', type: 'MILESTONE', ...span('2026-10-13', '09:00', hour ? '13T09:00' : '13', 0), durationDays: 0, progress: 0, status: 'NOT_STARTED', priority: 'MEDIUM', assigneeName: null, description: null, plannedCost: 0, actualCost: 0, deadline: null, barColor: null },
    ],
    deps: [
      { predecessorId: 'a', successorId: 'b', type: 'FS', lagDays: 0, lagMinutes: hour ? 120 : 0 },
      { predecessorId: 'b', successorId: 'm', type: 'FS', lagDays: 0, lagMinutes: 0 },
    ],
  };
}

describe('writeGanttpro (the DemoApi export ?format=ganttpro)', () => {
  it("GanttPRO's layout: banner, English header on row 5, fills, merged names, UTC dates, vocabulary, footer, hidden calendar sheet; RTL, no frozen panes", async () => {
    const bytes = await writeGanttpro(exportOf('HOUR'));
    const ExcelJS = (await import('exceljs')).default;
    const wb: Workbook = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('مشروع البرج');
    expect(ws.views[0]).toMatchObject({ rightToLeft: true });
    expect(ws.views.some((v) => (v as { state?: string }).state === 'frozen')).toBe(false);
    expect(ws.getRow(5).values).toEqual([undefined, ...EN]);
    expect(ws.getCell('A4').value).toBe('مشروع البرج');
    const row = (wbs: string) => [6, 7, 8, 9].map((r) => ws.getRow(r)).find((r) => r.getCell(2).value === wbs)!;
    expect((row('1.1').getCell(1).fill as { fgColor: { argb: string } }).fgColor.argb).toBe('FFFF6363');
    expect(row('1').getCell(3).value).toBe('المرحلة');
    expect(row('1.1').getCell(4).value).toBe('الحفر');
    expect(row('1.1').getCell(7).value).toBe('الحفر'); // merged D:G
    expect(row('1.1').getCell(9).value).toEqual(new Date('2026-10-11T06:00:00Z')); // 09:00 Riyadh
    expect(row('1.1').getCell(13).value).toBe(5);
    expect([row('1.1').getCell(16).value, row('1.1').getCell(17).value]).toEqual(['In progress', 'Highest']);
    expect([row('1.2').getCell(16).value, row('1.2').getCell(17).value, row('1.2').getCell(19).value]).toEqual(['On hold', 'Low', '1.1FS+2h']);
    expect(row('1').getCell(24).value).toBe('project');
    expect(row('2').getCell(24).value).toBe('milestone');
    expect(row('1.2').getCell(25).value).toBe('مشروع البرج / المرحلة');
    expect(row('1.1').getCell(18).value).toBe('=رابط https://example.com');
    expect(ws.getCell(11, 1).value).toBe(NOZOLY_FOOTER);
    const cal = wb.getWorksheet(NOZOLY_CALENDAR_SHEET)!;
    expect(cal.state).toBe('hidden');
    expect(cal.views[0]).toMatchObject({ rightToLeft: true });
  });

  it.each(['HOUR', 'DAY'] as const)('round trip (%s): the importer reads the export back as GanttPRO with the same calendar, unit, tasks and links', async (unit) => {
    const src = exportOf(unit);
    const bytes = await writeGanttpro(src);
    const draft = await draftOf('xlsx', bytes);
    expect(draft.detectedFormat).toBe('ganttpro');
    const p = buildPreview(draft, { format: 'xlsx', fileId: null, today: '2026-10-01' });
    expect(p.warnings.map((w) => w.code).filter((c) => c !== 'HOURS_DETECTED')).toEqual([]);
    expect(p.project).toMatchObject({ name: 'مشروع البرج', durationUnit: unit, startDate: '2026-10-11' });
    expect(p.project.calendar).toMatchObject({ weekendDays: [5, 6], workingHours: src.calendar.workingHours, exceptions: [{ date: '2026-10-20', isWorking: false, name: 'عطلة' }] });
    const t = previewTasksDto(p);
    const by = (n: string) => t.find((x) => x.name === n)!;
    for (const s of src.tasks) {
      const x = by(s.name);
      expect({ wbs: x.wbs, type: x.type, start: x.startDate, end: x.endDate, status: x.status, priority: x.priority, planned: x.plannedCost, actual: x.actualCost, deadline: x.deadline, color: x.barColor }).toEqual({
        wbs: s.wbs,
        type: s.type,
        start: s.startDate,
        end: s.endDate,
        status: s.status,
        priority: s.priority,
        planned: s.plannedCost,
        actual: s.actualCost,
        deadline: s.deadline,
        color: s.barColor,
      });
      if (unit === 'HOUR' && s.type !== 'GROUP') expect(x.durationHours).toBe(s.durationHours);
    }
    expect(by('الحفر')).toMatchObject({ assigneeName: 'مشرف ١', notes: '=رابط https://example.com', progress: 40 });
    const name = new Map(t.map((x) => [x.ref, x.name]));
    expect(previewDepsDto(p).map((d) => [name.get(d.predecessorRef), name.get(d.successorRef), d.type, d.lagHours ?? d.lagDays])).toEqual([
      ['الحفر', 'الصب', 'FS', unit === 'HOUR' ? 2 : 0],
      ['الصب', 'التسليم', 'FS', 0],
    ]);
  });
});
