/**
 * A10 (ADR-124, ADR-125): GanttPRO import against a synthetic export with the real layout
 * (test/fixtures/imports/ganttpro-sample.xlsx — invented tasks and people), content detection,
 * the calendar inference, MS Project 2016–2021 XML, and the GanttPRO-layout export round trip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectReportsService } from '../projects/project-reports.service';
import { ProjectStore, timeColumns } from '../projects/project-store';
import { ProjectsService } from '../projects/projects.service';
import { TemplatesService } from '../projects/templates.service';
import { TasksService } from '../projects/tasks.service';
import { localOf } from '../projects/task-engine';
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
} from './ganttpro';
import { buildPreview, previewDepsDto, previewTasksDto, type PreviewPayload } from './import-model';
import { ImportsService, sniffFormat } from './imports.service';
import { parseMspdi } from './mspdi';
import { readXlsx, type TableRow } from './tabular';

const fx = (n: string): Buffer => readFileSync(join(__dirname, '../../test/fixtures/imports', n));
const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const FILE = '0f0f0f0f-0000-4000-8000-000000000001';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SAMI = '5a000000-0000-4000-8000-000000000001';
const NOURA = '5a000000-0000-4000-8000-000000000002';

async function sample(): Promise<{ preview: PreviewPayload; draft: ReturnType<typeof ganttproToDraft> }> {
  const { rows, sheet, calendarRows } = await readXlsx(fx('ganttpro-sample.xlsx'));
  const layout = detectGanttpro(rows);
  expect(layout).not.toBeNull();
  const draft = ganttproToDraft(rows, layout!, { sheetName: sheet, calendarRows });
  return { draft, preview: buildPreview(draft, { format: 'ganttpro', fileId: null, today: '2025-11-01' }) };
}

describe('GanttPRO import — the synthetic export', () => {
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

  it('colours from the column-A fill, statuses and priorities in GanttPRO vocabulary, costs, progress, description with links', async () => {
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

describe('GanttPRO layouts and rules', () => {
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

  it('Arabic and Russian GanttPRO headers are recognised; unknown headers fall back to GanttPRO positions', () => {
    const ar = ['اللون', 'رقم WBS', '', '', '', '', 'اسم المهمة / العنوان', 'مسند إلى', 'تاريخ البدء المخطط', 'تاريخ الانتهاء المخطط', 'الموعد النهائي', 'التقدم (%)', 'المدة (ساعات)', 'الساعات المقدرة', 'سجل الوقت (دقائق)', 'الحالة', 'الأولوية', 'وصف المهمة', 'السابقة', 'الميزانية', 'التكلفة الفعلية', 'تاريخ الإنشاء', 'المنشئ', 'النوع', 'المشروع', 'المستوى'];
    const ru = ['Цвет', 'Номер WBS', '', '', '', '', 'Название задачи / Заголовок', 'Назначено', 'Плановая дата начала', 'Плановая дата окончания', 'Дедлайн', 'Прогресс (%)', 'Длительность (часы)', 'Оценка (часы)', 'Учет времени (минуты)', 'Статус', 'Приоритет', 'Описание задачи', 'Предшественник', 'Бюджет', 'Фактическая стоимость', 'Создано', 'Создатель', 'Тип', 'Проект', 'Уровень'];
    for (const header of [ar, ru]) {
      const layout = detectGanttpro(gpRows(header, [gpRow({ wbs: '1', level: 1, type: 'задача', name: 'X' })]))!;
      expect(layout).toMatchObject({ headerRow: 4, cols: { wbs: 1, name: 6, start: 8, end: 9, duration: 12, status: 15, type: 23, level: 25 } });
    }
    // Headers in a locale we do not know: the banner + GanttPRO's column positions.
    const xx = EN.map((h, i) => (h ? `Kolumn${i}` : ''));
    const layout = detectGanttpro(gpRows(xx, [gpRow({ wbs: '1', level: 1, type: 'task', name: 'X', start: '2025-11-02T09:00', end: '2025-11-02T10:00', hours: 1 })]))!;
    expect(layout.cols).toMatchObject({ wbs: 1, name: 6, start: 8, duration: 12, type: 23, level: 25 });
    const draft = ganttproToDraft(gpRows(xx, [gpRow({ wbs: '1', level: 1, type: 'task', name: 'X', start: '2025-11-02T09:00', end: '2025-11-02T10:00', hours: 1 })]), layout);
    expect(draft.tasks[0]).toMatchObject({ name: 'X', start: '2025-11-02T09:00', durationMinutes: 60 });
    // A plain task list is not GanttPRO.
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
    const cal = inferCalendar(samples);
    expect(cal).toMatchObject({ inferred: true, weekendDays: [5], workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], matched: 6, total: 6 });
    expect(inferCalendar(samples.slice(0, 2))).toMatchObject({ inferred: false, weekendDays: [5, 6], workingHours: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] });
  });
});

// ─────────────────────────────────────────── service: detection, suggestions, commit

function serviceSetup(bytes: Buffer, mimeType: string) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE', email: 'admin@example.com' },
      { id: SAMI, fullName: 'SAMI  RAHMAN', role: 'SUPERVISOR', status: 'ACTIVE', email: 'sami@example.com' },
      { id: NOURA, fullName: 'نورة', role: 'SUPERVISOR', status: 'ACTIVE', email: 'noura.k@example.com' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], isDefault: true, exceptions: [] }],
    files: [{ id: FILE, storageKey: `imports/2026/10/${FILE}`, mimeType, status: 'READY', entityType: 'import', uploadedById: 'admin', deletedAt: null, sizeBytes: 10 }],
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const storage = { readAll: jest.fn(async () => new Uint8Array(bytes)), delete: jest.fn(async () => undefined) };
  const service = new ImportsService(fake.db as never, storage as never, store, audit, { CONVERTER_TIMEOUT_MS: 1000, JIRA_ALLOWED_HOSTS: [] } as never);
  return { fake, service };
}

describe('ImportsService — GanttPRO and MS Project detection', () => {
  it('a GanttPRO workbook sent as «xlsx» is read as GanttPRO; suggestions by name (any case) or e-mail; commit keeps colours, priorities, links', async () => {
    const { fake, service } = serviceSetup(fx('ganttpro-sample.xlsx'), XLSX);
    const pv = await service.previewFile({ fileId: FILE, format: 'xlsx', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv.format).toBe('xlsx');
    expect(pv.detectedFormat).toBe('ganttpro');
    expect(pv.warnings.map((w) => w.code)).toContain('FORMAT_DETECTED');
    expect(pv.stats).toMatchObject({ taskCount: 13, groupCount: 5, milestoneCount: 1, dependencyCount: 7, maxLevel: 5, colorCount: 7, coloredCount: 13, deadlineCount: 1 });
    expect(pv.stats.sourceTypes).toEqual({ project: 2, 'tasks group': 3, task: 7, milestone: 1 });
    expect(pv.unmappedAssignees).toEqual([
      { name: 'Sami Rahman', taskCount: 2, suggestedUserId: SAMI },
      { name: 'Unknown Person', taskCount: 1, suggestedUserId: null },
      { name: 'noura.k', taskCount: 2, suggestedUserId: NOURA },
    ]);
    expect(fake.data.audit.find((a) => a.action === 'project.import_previewed')).toMatchObject({ after: { format: 'xlsx', detectedFormat: 'ganttpro', tasks: 13 } });

    const res = await service.commit({ previewId: pv.previewId, assigneeMap: { 'Sami Rahman': SAMI, 'noura.k': NOURA } }, ADMIN, ctx);
    expect(res).toMatchObject({ taskCount: 13, dependencyCount: 7, calendarCreated: true });
    expect(fake.data.projects.find((p) => p.id === res.projectId)).toMatchObject({ name: 'فيلا تجريبية', durationUnit: 'HOUR' });
    expect(fake.data.calendars.find((c) => c.id === res.calendarId)).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '10:00', end: '14:00' }, { start: '15:00', end: '19:00' }] });
    const tasks = fake.data.tasks.filter((t) => t.projectId === res.projectId);
    const t = (n: string) => tasks.find((x) => x.name === n)!;
    expect(t('حفر القواعد')).toMatchObject({ barColor: '#FF6363', priority: 'LOW', durationMinutes: 720 });
    expect(localOf(t('حفر القواعد').startAt!)).toBe('2025-11-04T10:00');
    expect(t('Painting')).toMatchObject({ priority: 'URGENT', status: 'ON_HOLD', assigneeId: SAMI });
    expect(t('Site survey').assigneeId).toBe(NOURA);
    const deps = fake.data.deps.filter((x) => x.projectId === res.projectId);
    expect(deps.map((x) => x.lagMinutes ?? 0).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 0, 60]);
  });

  it('format «ganttpro» on a plain workbook falls back to the Excel reader and says so', async () => {
    const { service } = serviceSetup(fx('tasks.xlsx'), XLSX);
    const pv = await service.previewFile({ fileId: FILE, format: 'ganttpro', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv.detectedFormat).toBe('xlsx');
    expect(pv.warnings.map((w) => w.code)).toContain('FORMAT_DETECTED');
    expect(pv.stats.taskCount).toBe(5);
  });

  it('MS Project XML is recognised whatever was chosen; a CSV sent as Excel is still refused', async () => {
    const { service } = serviceSetup(fx('mspdi-2019.xml'), 'application/xml');
    const pv = await service.previewFile({ fileId: FILE, format: 'mpp', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv.detectedFormat).toBe('xml');
    expect(pv.stats).toMatchObject({ taskCount: 4, groupCount: 1, milestoneCount: 1, dependencyCount: 2 });
    const csv = serviceSetup(fx('tasks-ar.csv'), 'text/csv');
    await expect(csv.service.previewFile({ fileId: FILE, format: 'xlsx', options: { dateOrder: 'DMY' } }, ADMIN, ctx)).rejects.toMatchObject({ code: 'IMPORT_FORMAT_MISMATCH' });
  });

  it('sniffFormat: ZIP → xlsx, OLE2 → mpp, MSPDI with or without the namespace → xml, anything else → null', () => {
    expect(sniffFormat(fx('ganttpro-sample.xlsx'))).toBe('xlsx');
    expect(sniffFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('mpp');
    expect(sniffFormat(fx('mspdi-2019.xml'))).toBe('xml');
    expect(sniffFormat(Buffer.from('﻿<?xml version="1.0"?><Project><Tasks><Task/></Tasks></Project>'))).toBe('xml');
    expect(sniffFormat(Buffer.from('<?xml version="1.0"?><Other/>'))).toBeNull();
    expect(sniffFormat(fx('tasks-ar.csv'))).toBeNull();
  });
});

describe('MS Project 2016–2021 XML', () => {
  it('namespace, Arabic names, the project calendar by CalendarUID with an exception, summary, milestone, inactive task skipped, work resources only, costs', () => {
    const draft = parseMspdi(fx('mspdi-2019.xml').toString('utf8'));
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
    // The holiday on 11-04 pushes the successor to 11-05.
    expect(by('صب الخرسانة')).toMatchObject({ startDate: '2025-11-05', endDate: '2025-11-06', deadline: '2025-11-09', assigneeName: null });
    expect(by('تسليم الهيكل').type).toBe('MILESTONE');
  });
});

// ─────────────────────────────────────────── export in GanttPRO layout + round trip

describe('export ?format=ganttpro', () => {
  const P = '00000000-0000-4000-8000-0000000000e1';
  const A = 'a0000000-0000-4000-8000-00000000000a';
  const B = 'b0000000-0000-4000-8000-00000000000b';
  const G = 'c0000000-0000-4000-8000-00000000000c';
  const M = 'd0000000-0000-4000-8000-00000000000d';

  function exportSetup(unit: 'DAY' | 'HOUR') {
    const hour = unit === 'HOUR';
    const tc = (start: string, end: string, minutes: number) => (hour ? timeColumns({ startDate: start, endDate: end, durationHours: minutes / 60 }) : {});
    const fake = createFakeDb({
      users: [
        { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
        { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
      ],
      calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], isDefault: true, exceptions: [{ id: 'h', date: d('2026-10-20'), isWorking: false, name: 'عطلة' }] }],
      projects: [{ id: P, name: 'مشروع البرج', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11'), durationUnit: unit }],
      tasks: [
        task({ id: G, projectId: P, type: 'GROUP', name: 'المرحلة', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, plannedCost: 700, actualCost: 100, progress: hour ? 22.22 : 20, status: 'IN_PROGRESS', barColor: '#4DB6AC', ...tc('2026-10-11T09:00', '2026-10-12T13:00', 720) }),
        task({ id: A, projectId: P, parentId: G, name: 'الحفر', sortOrder: 1, wbsCache: '1.1', assigneeId: 'sup1', startDate: d('2026-10-11'), endDate: d('2026-10-11'), durationDays: 1, progress: 40, status: 'IN_PROGRESS', priority: 'URGENT', plannedCost: 500, actualCost: 100, deadline: d('2026-10-15'), description: '=رابط https://example.com', barColor: '#FF6363', ...tc('2026-10-11T09:00', '2026-10-11T15:00', 300) }),
        task({ id: B, projectId: P, parentId: G, name: 'الصب', sortOrder: 2, wbsCache: '1.2', startDate: d('2026-10-12'), endDate: d('2026-10-12'), durationDays: 1, priority: 'LOW', status: 'ON_HOLD', plannedCost: 200, ...tc('2026-10-12T09:00', '2026-10-12T13:00', 240) }),
        task({ id: M, projectId: P, type: 'MILESTONE', name: 'التسليم', sortOrder: 2, wbsCache: '2', startDate: d('2026-10-13'), endDate: d('2026-10-13'), durationDays: 0, ...tc('2026-10-13T09:00', '2026-10-13T09:00', 0) }),
      ],
      deps: [
        { id: 'd1', projectId: P, predecessorId: A, successorId: B, type: 'FS', lagDays: hour ? 0 : 0, lagMinutes: hour ? 120 : 0 },
        { id: 'd2', projectId: P, predecessorId: B, successorId: M, type: 'FS', lagDays: 0, lagMinutes: 0 },
      ],
      files: [{ id: FILE, storageKey: `imports/2026/10/${FILE}`, mimeType: XLSX, status: 'READY', entityType: 'import', uploadedById: 'admin', deletedAt: null, sizeBytes: 10 }],
    });
    const audit = new AuditService(fake.db as never);
    const store = new ProjectStore(fake.db as never, audit);
    const tasks = new TasksService(fake.db as never, store, audit, fake.notifications as never);
    const reports = new ProjectReportsService(fake.db as never, store);
    const projects = new ProjectsService(fake.db as never, store, audit, new TemplatesService(fake.db as never, store, audit, tasks, reports));
    return { fake, projects, store, audit };
  }

  it('the file has GanttPRO\'s layout: banner, English header on row 5, fills, merged names, UTC dates, vocabulary, footer; RTL, no frozen panes; audited', async () => {
    const { projects, fake } = exportSetup('HOUR');
    const out = await projects.exportProject(P, 'ganttpro', ADMIN, ctx);
    expect(out.filename).toMatch(/-ganttpro\.xlsx$/);
    expect(out.contentType).toBe(XLSX);
    const wb = new Workbook();
    await wb.xlsx.load(out.buffer as never);
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
    expect(wb.getWorksheet(NOZOLY_CALENDAR_SHEET)!.state).toBe('hidden');
    expect(fake.data.audit.find((a) => a.action === 'project.exported')).toMatchObject({ after: { format: 'ganttpro', tasks: 4 } });
  });

  it.each(['HOUR', 'DAY'] as const)('round trip (%s): the GanttPRO importer reads the export back identically', async (unit) => {
    const { projects, fake } = exportSetup(unit);
    const g = await projects.gantt(P, ADMIN);
    const out = await projects.exportProject(P, 'ganttpro', ADMIN, ctx);
    const audit = new AuditService(fake.db as never);
    const store = new ProjectStore(fake.db as never, audit);
    const storage = { readAll: jest.fn(async () => new Uint8Array(out.buffer)), delete: jest.fn(async () => undefined) };
    const service = new ImportsService(fake.db as never, storage as never, store, audit, { CONVERTER_TIMEOUT_MS: 1000, JIRA_ALLOWED_HOSTS: [] } as never);
    const pv = await service.previewFile({ fileId: FILE, format: 'xlsx', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv.detectedFormat).toBe('ganttpro');
    expect(pv.warnings.map((w) => w.code).filter((c) => c !== 'FORMAT_DETECTED' && c !== 'HOURS_DETECTED')).toEqual([]);
    expect(pv.project).toMatchObject({ name: 'مشروع البرج', durationUnit: unit, startDate: '2026-10-11' });
    expect(pv.project.calendar).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }], exceptions: [{ date: '2026-10-20', isWorking: false, name: 'عطلة' }] });
    const pick = (t: { wbs: string; name: string; type: string; startDate: string; endDate: string; durationDays: number; durationHours?: number; progress: number; status: string; priority?: string; plannedCost?: number; actualCost?: number; deadline?: string | null; barColor?: string | null }) => ({
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
    expect(pv.tasks.map(pick)).toEqual(g.tasks.map(pick));
    expect(pv.tasks.find((t) => t.name === 'الحفر')!.assigneeName).toBe('مشرف ١');
    expect(pv.tasks.find((t) => t.name === 'الحفر')!.notes).toBe('=رابط https://example.com');
    const name = new Map(pv.tasks.map((t) => [t.ref, t.name]));
    expect(pv.dependencies.map((x) => [name.get(x.predecessorRef), name.get(x.successorRef), x.type, x.lagHours ?? x.lagDays])).toEqual(
      g.dependencies.map((x) => [g.tasks.find((t) => t.id === x.predecessorId)!.name, g.tasks.find((t) => t.id === x.successorId)!.name, x.type, x.lagHours ?? x.lagDays]),
    );
  });
});
