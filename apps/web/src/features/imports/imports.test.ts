/**
 * The API's import fixture tests (apps/api/src/imports/imports.spec.ts) run against the browser
 * port (ADR-117): the same fixture files (copied byte for byte into __fixtures__), the same
 * expectations — value parsers, Excel/CSV, MSPDI (and its round trip), Jira CSV and REST mapping,
 * the Jira site rule, upload structure checks — plus the export round trips of the demo builders
 * (xlsx RTL without frozen panes, CSV with BOM and formula guard, MSPDI).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { buildTasksCsv, buildTasksWorkbook, type TaskExportRow } from '../projects/excel';
import { checkImportFile, draftOf, formatOfName, verifyImportBytes } from './files';
import { assertJiraSite, issuesToDraft, parseJiraCsv, restIssue } from './jira';
import {
  buildPreview,
  detectUnit,
  emptyDraft,
  parseDateValue,
  parseDuration,
  parsePredecessors,
  parseProgress,
  previewDepsDto,
  previewTasksDto,
  type ImportDraft,
  type PreviewPayload,
} from './model';
import { parseMspdi, writeMspdi } from './mspdi';
import { decodeText, readCsv, readXlsx, tableToDraft, xlsxSheetNames } from './tabular';

const fx = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(join(process.cwd(), 'src/features/imports/__fixtures__', n)));
const text = (n: string) => new TextDecoder().decode(fx(n));

function preview(draft: ImportDraft, format = 'test'): PreviewPayload {
  return buildPreview(draft, { format, fileId: null, today: '2026-10-11' });
}
const rows = (p: PreviewPayload) => previewTasksDto(p);
const byName = (p: PreviewPayload, name: string) => rows(p).find((t) => t.name === name)!;

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
}

describe('import value parsers', () => {
  it('dates: Excel serials, ISO, DD/MM/YYYY, MM/DD with the option, Arabic-Indic digits, month names, Jira and MS Project text', () => {
    expect(parseDateValue(46306)).toBe('2026-10-11');
    expect(parseDateValue(46306.375)).toBe('2026-10-11T09:00');
    expect(parseDateValue('2026-10-11')).toBe('2026-10-11');
    expect(parseDateValue('2026-10-11T14:30:00')).toBe('2026-10-11T14:30');
    expect(parseDateValue('11/10/2026')).toBe('2026-10-11');
    expect(parseDateValue('10/11/2026', 'MDY')).toBe('2026-10-11');
    expect(parseDateValue('25/10/2026', 'MDY')).toBe('2026-10-25');
    expect(parseDateValue('١١/١٠/٢٠٢٦')).toBe('2026-10-11');
    expect(parseDateValue('١١-١٠-٢٠٢٦ ٢:٣٠ م')).toBe('2026-10-11T14:30');
    expect(parseDateValue('19/Oct/26 10:30 AM')).toBe('2026-10-19T10:30');
    expect(parseDateValue('Sun 10/11/26 08:00', 'MDY')).toBe('2026-10-11T08:00');
    expect(parseDateValue('October 11, 2026')).toBe('2026-10-11');
    expect(parseDateValue('11 أكتوبر 2026')).toBe('2026-10-11');
    expect(parseDateValue(new Date(Date.UTC(2026, 9, 11, 9, 0)))).toBe('2026-10-11T09:00');
    expect(parseDateValue('31/02/2026')).toBeNull();
    expect(parseDateValue('غدًا')).toBeNull();
  });

  it('durations in days, weeks, hours, minutes (Arabic and English) and ISO', () => {
    expect(parseDuration('5')).toEqual({ days: 5 });
    expect(parseDuration('٣ أيام')).toEqual({ days: 3 });
    expect(parseDuration('1 wk')).toEqual({ days: 5 });
    expect(parseDuration('4h')).toEqual({ minutes: 240 });
    expect(parseDuration('2.5 ساعات')).toEqual({ minutes: 150 });
    expect(parseDuration('30 min')).toEqual({ minutes: 30 });
    expect(parseDuration('PT16H0M0S')).toEqual({ minutes: 960 });
    expect(parseDuration(3, 480, 'h')).toEqual({ minutes: 180 });
    expect(parseDuration('lots')).toBeNull();
  });

  it('predecessors with types and lags; progress forms', () => {
    expect(parsePredecessors('3FS+2d; 5, 7SS-1 day, 1.2FF+4h, foo bar').items).toEqual([
      { ref: '3', type: 'FS', lagDays: 2 },
      { ref: '5', type: 'FS' },
      { ref: '7', type: 'SS', lagDays: -1 },
      { ref: '1.2', type: 'FF', lagMinutes: 240 },
    ]);
    expect(parsePredecessors('foo bar').bad).toEqual(['foo bar']);
    expect(parseProgress('40%')).toBe(40);
    expect(parseProgress(0.25, true)).toBe(25);
    expect(parseProgress('0.5')).toBe(50);
    expect(parseProgress('١٠٠')).toBe(100);
  });

  it('HOUR detection: forced, stated by the source, an hours column, or a duration that is not whole days', () => {
    const draft = emptyDraft();
    draft.tasks = [
      {
        key: 'a',
        sourceId: null,
        name: 'a',
        parentKey: null,
        start: null,
        end: null,
        durationMinutes: 960,
        progress: 0,
        status: null,
        assigneeName: null,
        plannedCost: 0,
        actualCost: 0,
        deadline: null,
        notes: null,
      },
    ];
    expect(detectUnit(draft, 480).unit).toBe('DAY');
    draft.tasks[0]!.durationMinutes = 300;
    expect(detectUnit(draft, 480).unit).toBe('HOUR');
    expect(detectUnit(draft, 480, 'DAY').unit).toBe('DAY');
    expect(detectUnit({ ...emptyDraft(), hoursHint: true }, 480).unit).toBe('HOUR');
  });
});

describe('Excel and CSV imports', () => {
  it('Arabic CSV: WBS outline, DD/MM dates, Arabic digits, predecessors with lag, statuses, costs, deadline, warnings', () => {
    const p = preview(tableToDraft(readCsv(fx('tasks-ar.csv')), { dateOrder: 'DMY' }));
    expect(p.project.durationUnit).toBe('DAY');
    expect(rows(p).map((t) => [t.wbs, t.name, t.type])).toEqual([
      ['1', 'الأعمال الإنشائية', 'GROUP'],
      ['1.1', 'الحفر', 'TASK'],
      ['1.2', 'صب الخرسانة', 'TASK'],
      ['2', 'التسليم', 'MILESTONE'],
      ['3', 'بدون رقم', 'TASK'],
      ['4', 'سطر بتاريخ غير مفهوم', 'TASK'],
    ]);
    expect(byName(p, 'الحفر')).toMatchObject({
      startDate: '2026-10-11',
      endDate: '2026-10-13',
      durationDays: 3,
      progress: 40,
      status: 'IN_PROGRESS',
      assigneeName: 'مشرف ١',
      plannedCost: 1500,
      notes: 'حفر الأساسات',
    });
    expect(byName(p, 'صب الخرسانة')).toMatchObject({
      startDate: '2026-10-15',
      endDate: '2026-10-18',
      deadline: '2026-10-25',
      plannedCost: 2000,
    });
    expect(byName(p, 'التسليم')).toMatchObject({ startDate: '2026-10-19', durationDays: 0 });
    expect(byName(p, 'الأعمال الإنشائية')).toMatchObject({
      plannedCost: 3500,
      status: 'IN_PROGRESS',
    });
    expect(byName(p, 'بدون رقم')).toMatchObject({
      status: 'DONE',
      startDate: '2026-10-18',
      endDate: '2026-10-19',
    });
    expect(previewDepsDto(p)).toEqual([
      { predecessorRef: 'r3', successorRef: 'r4', type: 'FS', lagDays: 1 },
      { predecessorRef: 'r4', successorRef: 'r5', type: 'FS', lagDays: 0 },
    ]);
    expect(p.warnings.map((w) => w.code)).toEqual(['DATE_UNPARSED']);
  });

  it('MS Project-style CSV: outline-level column, IDs in predecessors, SS kept with a warning, unknown predecessor warned', () => {
    const p = preview(tableToDraft(readCsv(fx('tasks-en.csv')), { dateOrder: 'MDY' }));
    expect(rows(p).map((t) => [t.wbs, t.name, t.type, t.assigneeName])).toEqual([
      ['1', 'Site preparation', 'GROUP', null],
      ['1.1', 'Survey', 'TASK', 'Ahmad'],
      ['1.2', 'Fencing', 'TASK', 'Saad'],
      ['2', 'Excavation', 'TASK', 'Ahmad'],
      ['3', 'Inspection', 'MILESTONE', null],
    ]);
    expect(byName(p, 'Survey')).toMatchObject({
      startDate: '2026-10-11',
      durationDays: 2,
      progress: 100,
      status: 'DONE',
    });
    expect(byName(p, 'Excavation').durationDays).toBe(5);
    expect(previewDepsDto(p).map((x) => [x.type, x.lagDays])).toEqual([
      ['FS', 0],
      ['FS', 2],
      ['SS', -1],
    ]);
    expect(p.warnings.map((w) => w.code).sort()).toEqual([
      'DEPENDENCY_TYPE_IGNORED',
      'PREDECESSOR_MISSING',
    ]);
  });

  it('Excel: picks the sheet with a task-name header, indentation outline, date-time cells, percent cells, hours column → HOUR', async () => {
    expect(await xlsxSheetNames(fx('tasks.xlsx'))).toContain('الخطة');
    const { rows: table, sheet } = await readXlsx(fx('tasks.xlsx'));
    expect(sheet).toBe('الخطة');
    const p = preview(tableToDraft(table, { dateOrder: 'DMY' }));
    expect(p.project.durationUnit).toBe('HOUR');
    expect(p.warnings.map((w) => w.code)).toContain('HOURS_DETECTED');
    expect(rows(p).map((t) => [t.wbs, t.name, t.type])).toEqual([
      ['1', 'صيانة المبنى أ', 'GROUP'],
      ['1.1', 'فحص التكييف', 'TASK'],
      ['1.2', 'تغيير الفلاتر', 'TASK'],
      ['2', 'تقرير الصيانة', 'MILESTONE'],
      ['3', 'صيانة المبنى ب', 'TASK'],
    ]);
    expect(byName(p, 'فحص التكييف')).toMatchObject({
      startDate: '2026-10-11T09:00',
      endDate: '2026-10-11T12:00',
      durationHours: 3,
      progress: 100,
      plannedCost: 750.5,
    });
    expect(byName(p, 'تغيير الفلاتر')).toMatchObject({
      startDate: '2026-10-11T12:00',
      endDate: '2026-10-11T18:00',
      progress: 25,
    });
    expect(byName(p, 'صيانة المبنى ب')).toMatchObject({
      startDate: '2026-10-12T10:00',
      endDate: '2026-10-13T10:00',
      durationHours: 8,
    });
  });

  it('decodes UTF-16 CSV (Excel "Unicode text") and refuses a file without a task-name column', async () => {
    const t = 'اسم المهمة\tالمدة\r\nأ\t2\r\n';
    const body = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) {
      body[i * 2] = t.charCodeAt(i) & 0xff;
      body[i * 2 + 1] = t.charCodeAt(i) >> 8;
    }
    const utf16 = new Uint8Array([0xff, 0xfe, ...body]);
    expect(decodeText(utf16)).toBe(t);
    expect(rows(preview(tableToDraft(readCsv(utf16), { dateOrder: 'DMY' })))[0]).toMatchObject({
      name: 'أ',
      durationDays: 2,
    });
    expect(
      await codeOf(() =>
        tableToDraft(readCsv(new TextEncoder().encode('a,b\n1,2\n')), { dateOrder: 'DMY' }),
      ),
    ).toBe('IMPORT_NO_TASKS');
  });
});

describe('MS Project XML (MSPDI)', () => {
  it('hours file: summary, milestone, FS/SS lags, lunch-break calendar with a holiday, resources → assignee, costs in hundredths', () => {
    const p = preview(parseMspdi(text('mspdi-hours.xml')));
    expect(p.project).toMatchObject({
      name: 'تشطيب البرج',
      startDate: '2026-10-11',
      durationUnit: 'HOUR',
      calendar: {
        name: 'Saudi Standard',
        weekendDays: [5, 6],
        workingHours: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
        exceptions: [{ date: '2026-10-20', isWorking: false, name: 'إجازة' }],
      },
    });
    expect(rows(p).map((t) => [t.wbs, t.name, t.type, t.assigneeName])).toEqual([
      ['1', 'المرحلة الأولى', 'GROUP', null],
      ['1.1', 'تجهيز الموقع & العزل', 'TASK', 'أحمد'],
      ['1.2', 'التمديدات', 'TASK', 'علي'],
      ['2', 'فحص', 'TASK', null],
      ['3', 'اعتماد', 'MILESTONE', null],
    ]);
    expect(byName(p, 'تجهيز الموقع & العزل')).toMatchObject({
      durationHours: 4,
      progress: 100,
      status: 'DONE',
      plannedCost: 1500,
      actualCost: 1200.5,
    });
    expect(byName(p, 'التمديدات')).toMatchObject({
      startDate: '2026-10-11T13:00',
      endDate: '2026-10-12T12:00',
      durationHours: 8,
      deadline: '2026-10-14',
      notes: 'تمديدات الكهرباء والسباكة',
    });
    expect(byName(p, 'اعتماد')).toMatchObject({ startDate: '2026-10-13T13:00', durationHours: 0 });
    expect(previewDepsDto(p)).toEqual([
      { predecessorRef: 'u2', successorRef: 'u3', type: 'FS', lagDays: 0, lagHours: 0 },
      { predecessorRef: 'u3', successorRef: 'u4', type: 'SS', lagDays: 0, lagHours: 1 },
      { predecessorRef: 'u3', successorRef: 'u5', type: 'FS', lagDays: 1, lagHours: 8 },
    ]);
    expect(p.warnings.map((w) => w.code).sort()).toEqual([
      'ASSIGNEE_MULTIPLE',
      'DEPENDENCY_TYPE_IGNORED',
      'HOURS_DETECTED',
    ]);
  });

  it('days file: Sat/Sun weekend from WeekDays, null tasks skipped, whole-day durations stay DAY', () => {
    const p = preview(parseMspdi(text('mspdi-days.xml')));
    expect(p.project).toMatchObject({
      name: 'Warehouse',
      durationUnit: 'DAY',
      calendar: { weekendDays: [0, 6] },
    });
    expect(rows(p).map((t) => [t.name, t.startDate, t.endDate, t.durationDays])).toEqual([
      ['Foundations', '2026-10-12', '2026-10-14', 3],
      ['Walls', '2026-10-16', '2026-10-19', 2],
    ]);
  });

  it('refuses DOCTYPEs and non-MSPDI XML', async () => {
    expect(
      await codeOf(() =>
        parseMspdi('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Project/>'),
      ),
    ).toBe('IMPORT_FILE_INVALID');
    expect(await codeOf(() => parseMspdi('<?xml version="1.0"?><svg/>'))).toBe(
      'IMPORT_FORMAT_MISMATCH',
    );
  });

  it('round trip: what writeMspdi exports, parseMspdi reads back (hierarchy, hours, calendar, lags, assignees, costs)', () => {
    const p1 = preview(parseMspdi(text('mspdi-hours.xml')));
    const xml = writeMspdi({
      name: p1.project.name,
      startDate: p1.project.startDate,
      unit: p1.project.durationUnit,
      calendar: p1.project.calendar,
      tasks: rows(p1).map((t) => ({ ...t, id: t.ref, parentId: t.parentRef, notes: t.notes })),
      deps: p1.deps,
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    const p2 = preview(parseMspdi(xml));
    const strip = (p: PreviewPayload) =>
      rows(p).map(({ ref: _r, sourceId: _s, parentRef: _p, ...t }) => t);
    expect(strip(p2)).toEqual(strip(p1));
    expect(p2.project.calendar).toEqual(p1.project.calendar);
    expect(previewDepsDto(p2).map(({ predecessorRef: _a, successorRef: _b, ...x }) => x)).toEqual(
      previewDepsDto(p1).map(({ predecessorRef: _a, successorRef: _b, ...x }) => x),
    );
  });
});

describe('Jira', () => {
  it('CSV export: Epic → group, Epic Link and Parent (issue id) → hierarchy, blocks → FS, estimates → days, statuses', () => {
    const p = preview(parseJiraCsv(fx('jira-export.csv')));
    expect(p.project.durationUnit).toBe('DAY');
    expect(rows(p).map((t) => [t.wbs, t.sourceId, t.type, t.status, t.assigneeName])).toEqual([
      ['1', 'OPS-1', 'GROUP', 'IN_PROGRESS', null],
      ['1.1', 'OPS-2', 'TASK', 'DONE', 'مشرف ١'],
      ['1.2', 'OPS-3', 'TASK', 'NOT_STARTED', 'مشرف ٢'],
      ['2', 'OPS-4', 'GROUP', 'ON_HOLD', null],
      ['2.1', 'OPS-5', 'TASK', 'NOT_STARTED', 'مشرف ٢'],
    ]);
    expect(byName(p, 'مسح الأرض')).toMatchObject({
      startDate: '2026-10-11',
      endDate: '2026-10-12',
      durationDays: 2,
      deadline: '2026-10-12',
    });
    expect(previewDepsDto(p).map((x) => `${x.predecessorRef}>${x.successorRef}`)).toEqual([
      'jOPS-2>jOPS-3',
      'jOPS-2>jOPS-4',
      'jOPS-3>jOPS-4',
    ]);
  });

  it('REST issues map like the server (Epic, parent, blocks, ADF description)', () => {
    const issue = (n: number) => ({
      id: `${n}`,
      key: `OPS-${n}`,
      fields: {
        summary: `مهمة ${n}`,
        issuetype: { name: n === 1 ? 'Epic' : 'Task' },
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        assignee: { displayName: 'مشرف ١' },
        created: '2026-10-05T09:15:00.000+0300',
        duedate: null,
        timeoriginalestimate: 28800,
        parent: n === 1 ? undefined : { key: 'OPS-1' },
        issuelinks: n === 2 ? [{ type: { name: 'Blocks' }, outwardIssue: { key: 'OPS-3' } }] : [],
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'وصف' }] }],
        },
        customfield_10015: '2026-10-11',
      },
    });
    const issues = [1, 2, 3].map((n) => restIssue(issue(n))!);
    const p = preview(issuesToDraft(issues, { projectName: 'OPS' }));
    expect(rows(p).map((t) => [t.wbs, t.sourceId, t.type, t.notes])).toEqual([
      ['1', 'OPS-1', 'GROUP', 'وصف'],
      ['1.1', 'OPS-2', 'TASK', 'وصف'],
      ['1.2', 'OPS-3', 'TASK', 'وصف'],
    ]);
    expect(previewDepsDto(p)).toEqual([
      { predecessorRef: 'jOPS-2', successorRef: 'jOPS-3', type: 'FS', lagDays: 0 },
    ]);
    expect(restIssue({ fields: { summary: 'x' } })).toBeNull();
  });

  it('site URL rule: https *.atlassian.net or the allowlist only; no IPs, ports, credentials', async () => {
    expect(assertJiraSite('https://acme.atlassian.net/jira/software').origin).toBe(
      'https://acme.atlassian.net',
    );
    for (const bad of [
      'http://acme.atlassian.net',
      'https://169.254.169.254',
      'https://acme.atlassian.net.evil.com',
      'https://evil.com',
      'https://acme.atlassian.net:8443',
      'https://u:p@acme.atlassian.net',
      'https://[::1]',
      'ftp://acme.atlassian.net',
      'not a url',
    ]) {
      expect(await codeOf(() => assertJiraSite(bad))).toBe('JIRA_URL_NOT_ALLOWED');
    }
    expect(assertJiraSite('https://jira.example.sa', ['jira.example.sa']).hostname).toBe(
      'jira.example.sa',
    );
  });
});

describe('import uploads — client checks and structure checks', () => {
  it('xlsx = ZIP with xl/workbook.xml; mpp = OLE2; XML without DOCTYPE; CSV = text', () => {
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
    expect(verifyImportBytes(fx('tasks.xlsx'), xlsx)).toBe(true);
    expect(verifyImportBytes(enc('PK\x03\x04 random zip'), xlsx)).toBe(false);
    expect(
      verifyImportBytes(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
        'application/vnd.ms-project',
      ),
    ).toBe(true);
    expect(verifyImportBytes(fx('tasks.xlsx'), 'application/vnd.ms-project')).toBe(false);
    expect(verifyImportBytes(fx('mspdi-hours.xml'), 'application/xml')).toBe(true);
    expect(verifyImportBytes(new TextEncoder().encode('﻿  <Project/>'), 'text/xml')).toBe(true);
    expect(
      verifyImportBytes(
        new TextEncoder().encode(
          '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><p>&x;</p>',
        ),
        'application/xml',
      ),
    ).toBe(false);
    expect(verifyImportBytes(fx('tasks-ar.csv'), 'text/csv')).toBe(true);
    expect(verifyImportBytes(new TextEncoder().encode('a,b\u0000c'), 'text/csv')).toBe(false);
    expect(verifyImportBytes(new TextEncoder().encode('<html><script>'), 'text/csv')).toBe(false);
    expect(verifyImportBytes(fx('tasks.xlsx'), 'text/csv')).toBe(false);
  });

  it('type by extension, 20 MB, empty; format guessed from the name; .mpp needs the converter (501)', async () => {
    expect(checkImportFile({ name: 'plan.XLSX', size: 10 }, 'xlsx')).toBeNull();
    expect(checkImportFile({ name: 'plan.xls', size: 10 }, 'xlsx')).toBe('type');
    expect(checkImportFile({ name: 'plan.csv', size: 21 * 1024 * 1024 }, 'csv')).toBe('size');
    expect(checkImportFile({ name: 'plan.xml', size: 0 }, 'xml')).toBe('empty');
    expect(formatOfName('a.mpp')).toBe('mpp');
    const err = (await draftOf('mpp', new Uint8Array([0xd0])).catch((e: unknown) => e)) as ApiError;
    expect([err.code, err.status]).toEqual(['MPP_CONVERTER_NOT_CONFIGURED', 501]);
    expect(err.message_ar).toContain('XML');
  });
});

// ─────────────────────────────────────────── exports round trip (the demo builders)

const EXPORT_ROWS: TaskExportRow[] = [
  {
    wbs: '1',
    name: 'المرحلة',
    type: 'GROUP',
    startDate: '2026-10-11',
    endDate: '2026-10-14',
    durationDays: 4,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeName: null,
    teamName: null,
    description: null,
    plannedCost: 700,
    actualCost: 100,
  },
  {
    wbs: '1.1',
    name: 'الحفر',
    type: 'TASK',
    startDate: '2026-10-11',
    endDate: '2026-10-12',
    durationDays: 2,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeName: 'مشرف ١',
    teamName: null,
    description: 'ملاحظة',
    plannedCost: 500,
    actualCost: 100,
    deadline: '2026-10-15',
    labels: ['عاجل'],
    customValues: { f1: 'شركة البناء' },
  },
  {
    wbs: '1.2',
    name: 'الصب',
    type: 'TASK',
    startDate: '2026-10-14',
    endDate: '2026-10-14',
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeName: null,
    teamName: null,
    description: null,
    plannedCost: 200,
    actualCost: 0,
  },
];
const META = {
  name: 'مشروع =التصدير',
  status: 'ACTIVE' as const,
  startDate: '2026-10-11',
  endDate: '2026-10-14',
  progress: 0,
  calendarName: 'افتراضي',
  autoSchedule: true,
  generatedAt: new Date('2026-10-19T08:00:00Z'),
  customFields: [{ id: 'f1', name: 'المقاول', type: 'TEXT' as const }],
};

describe('project exports (xlsx, csv) — the demo builders', () => {
  it('xlsx: every sheet RTL, never frozen; A9 columns; the importer reads it back', async () => {
    const wb = await buildTasksWorkbook(META, EXPORT_ROWS);
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const ExcelJS = (await import('exceljs')).default;
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf.buffer);
    expect(back.worksheets.map((w) => w.name)).toEqual(['المهام', 'المشروع']);
    for (const ws of back.worksheets) {
      expect(ws.views.length).toBeGreaterThan(0);
      for (const v of ws.views) {
        expect(v.rightToLeft).toBe(true);
        expect(v.state).not.toBe('frozen');
        expect((v as { xSplit?: number }).xSplit ?? 0).toBe(0);
        expect((v as { ySplit?: number }).ySplit ?? 0).toBe(0);
      }
    }
    const header = (back.getWorksheet('المهام')!.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([
      'رقم WBS',
      'المهمة',
      'النوع',
      'البداية',
      'النهاية',
      'المدة (أيام عمل)',
      'نسبة الإنجاز',
      'الحالة',
      'الأولوية',
      'المسند إليه',
      'الفريق',
      'الوصف',
      'التكلفة المخططة',
      'التكلفة الفعلية',
      'الموعد النهائي',
      'الوسوم',
      'المقاول',
    ]);
    const p = preview(tableToDraft((await readXlsx(buf)).rows, { dateOrder: 'DMY' }));
    expect(
      rows(p).map((t) => [t.wbs, t.name, t.type, t.startDate, t.endDate, t.plannedCost]),
    ).toEqual([
      ['1', 'المرحلة', 'GROUP', '2026-10-11', '2026-10-14', 700],
      ['1.1', 'الحفر', 'TASK', '2026-10-11', '2026-10-12', 500],
      ['1.2', 'الصب', 'TASK', '2026-10-14', '2026-10-14', 200],
    ]);
  });

  it('csv: UTF-8 BOM, CRLF, the same columns, formula injection neutralised; the importer reads it back', () => {
    const out = buildTasksCsv({ customFields: META.customFields }, EXPORT_ROWS);
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(out.subarray(3));
    expect(body.split('\r\n')[0]).toBe(
      'رقم WBS,المهمة,النوع,البداية,النهاية,المدة (أيام عمل),نسبة الإنجاز,الحالة,الأولوية,المسند إليه,الفريق,الوصف,التكلفة المخططة,التكلفة الفعلية,الموعد النهائي,الوسوم,المقاول',
    );
    expect(body).toContain(
      '1.1,الحفر,مهمة,2026-10-11,2026-10-12,2,0,لم تبدأ,متوسطة,مشرف ١,,ملاحظة,500,100,2026-10-15,عاجل,شركة البناء',
    );
    const evil = buildTasksCsv({}, [
      {
        ...EXPORT_ROWS[1]!,
        name: '=HYPERLINK("x")',
        description: '@SUM(A1)',
        assigneeName: '+1',
        teamName: '-2+3',
      },
    ]);
    const evilText = new TextDecoder().decode(evil);
    expect(evilText).toContain(`"'=HYPERLINK(""x"")"`);
    expect(evilText).toContain(`'@SUM(A1)`);
    expect(evilText).toContain(`,'-2+3,`);
    expect(evilText).toContain(',+1,'.replace('+1', "'+1"));
    const back = preview(tableToDraft(readCsv(out), { dateOrder: 'DMY' }));
    expect(rows(back).map((t) => t.name)).toEqual(['المرحلة', 'الحفر', 'الصب']);
  });
});

// ─────────────────────────────────────────── the wizard's sample files (public/samples)

describe('sample files («جرّب بملف نموذجي») import cleanly', () => {
  const sample = (n: string) =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public/samples', n)));
  const run = async (n: string, format: 'csv' | 'xlsx' | 'xml' | 'jira-csv') =>
    buildPreview(await draftOf(format, sample(n)), { format, fileId: null });

  it('Arabic CSV: DAY, two groups, a milestone, FS links with lag and lead, no warnings', async () => {
    const p = await run('nuzli-sample-ar.csv', 'csv');
    expect(p.project.durationUnit).toBe('DAY');
    expect(rows(p).map((t) => [t.wbs, t.type])).toEqual([
      ['1', 'GROUP'],
      ['1.1', 'TASK'],
      ['1.2', 'TASK'],
      ['1.3', 'TASK'],
      ['2', 'GROUP'],
      ['2.1', 'TASK'],
      ['2.2', 'TASK'],
      ['2.3', 'TASK'],
      ['3', 'MILESTONE'],
    ]);
    expect(
      previewDepsDto(p)
        .map((d) => d.lagDays)
        .sort(),
    ).toEqual([-2, 0, 0, 0, 0, 0, 0, 1]);
    expect(p.warnings).toEqual([]);
  });

  it('Excel: the «الخطة» sheet is found after «تعليمات», outline from indentation, costs and percent cells', async () => {
    expect(await xlsxSheetNames(sample('nuzli-sample.xlsx'))).toEqual(['تعليمات', 'الخطة']);
    const p = await run('nuzli-sample.xlsx', 'xlsx');
    expect(rows(p).map((t) => [t.wbs, t.type])).toEqual([
      ['1', 'GROUP'],
      ['1.1', 'TASK'],
      ['1.2', 'TASK'],
      ['1.3', 'TASK'],
      ['2', 'GROUP'],
      ['2.1', 'TASK'],
      ['2.2', 'TASK'],
      ['3', 'MILESTONE'],
    ]);
    expect(byName(p, 'ترتيب المقاعد')).toMatchObject({ progress: 50, plannedCost: 1500 });
    expect(p.warnings).toEqual([]);
  });

  it('MS Project XML: HOUR with the 08–12 / 13–17 lunch-break calendar, a holiday and the weekend crossed', async () => {
    const p = await run('nuzli-sample-msproject-hours.xml', 'xml');
    expect(p.project).toMatchObject({
      name: 'تشطيب الطابق الثالث (تجريبي)',
      durationUnit: 'HOUR',
      calendar: {
        workingHours: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
        weekendDays: [5, 6],
      },
    });
    // 8 h from Wed 11:00: 1 h + 4 h after lunch, Thu holiday, Fri/Sat weekend, 3 h on Sunday.
    expect(byName(p, 'الدهان')).toMatchObject({
      startDate: '2026-11-04T11:00',
      endDate: '2026-11-08T11:00',
      durationHours: 8,
    });
    expect(byName(p, 'تسليم الطابق').type).toBe('MILESTONE');
    expect(p.warnings.map((w) => w.code).sort()).toEqual([
      'DEPENDENCY_TYPE_IGNORED',
      'HOURS_DETECTED',
    ]);
  });

  it('Jira CSV: two epics, a sub-task under its parent, blocks → FS, no warnings', async () => {
    const p = await run('nuzli-sample-jira.csv', 'jira-csv');
    expect(rows(p).map((t) => [t.wbs, t.sourceId, t.type])).toEqual([
      ['1', 'EVT-1', 'GROUP'],
      ['1.1', 'EVT-2', 'TASK'],
      ['1.2', 'EVT-3', 'TASK'],
      ['1.3', 'EVT-4', 'GROUP'],
      ['1.3.1', 'EVT-5', 'TASK'],
      ['2', 'EVT-6', 'GROUP'],
      ['2.1', 'EVT-7', 'TASK'],
    ]);
    expect(p.deps).toHaveLength(4);
    expect(p.warnings).toEqual([]);
  });
});

describe('previewGantt (the read-only Gantt of the preview)', () => {
  it('rows, links with hours, the calendar and the mapped assignee names', async () => {
    const { previewGantt } = await import('./previewGantt');
    const p = preview(parseMspdi(text('mspdi-hours.xml')));
    const dto = {
      previewId: 'x',
      expiresAt: new Date().toISOString(),
      format: 'xml' as const,
      project: p.project,
      tasks: previewTasksDto(p),
      dependencies: previewDepsDto(p),
      warnings: p.warnings,
      unmappedAssignees: [],
      stats: { taskCount: 5, groupCount: 1, milestoneCount: 1, dependencyCount: 3 },
    };
    const g = previewGantt(
      dto,
      new Map([
        ['علي', { id: 'u1', fullName: 'فهد' }],
        ['أحمد', null],
      ]),
    );
    expect(g.project).toMatchObject({
      durationUnit: 'HOUR',
      taskCount: 5,
      endDate: '2026-10-13T13:00',
    });
    expect(g.calendar.workingHours).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ]);
    expect(g.tasks.find((t) => t.name === 'التمديدات')!.assignee).toMatchObject({
      id: 'u1',
      fullName: 'فهد',
    });
    expect(g.tasks.find((t) => t.name === 'تجهيز الموقع & العزل')!.assignee).toBeNull();
    expect(g.tasks.find((t) => t.name === 'التمديدات')!.parentId).toBe(
      g.tasks.find((t) => t.name === 'المرحلة الأولى')!.id,
    );
    expect(g.dependencies.map((d) => [d.type, d.lagHours])).toEqual([
      ['FS', 0],
      ['SS', 1],
      ['FS', 8],
    ]);
  });
});
