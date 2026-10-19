/**
 * A9 imports (ADR-110..112): parsers against fixture files (test/fixtures/imports), the MSPDI
 * round trip, Jira CSV/REST mapping, the SSRF guard, the converter client, upload structure
 * checks, and preview → commit through ImportsService with the in-memory Prisma stand-in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectReportsService } from '../projects/project-reports.service';
import { ProjectStore, timeColumns } from '../projects/project-store';
import { ProjectsService } from '../projects/projects.service';
import { buildTasksCsv } from '../projects/tasks-export';
import { localOf } from '../projects/task-engine';
import { TemplatesService } from '../projects/templates.service';
import { TasksService } from '../projects/tasks.service';
import { verifyImportBytes } from '../storage/magic-bytes';
import { convertMpp, CONVERTER_TOKEN_HEADER } from './converter-client';
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
} from './import-model';
import { ImportsService } from './imports.service';
import { assertJiraSite, fetchJiraIssues, guardedLookup, isPrivateAddress, issuesToDraft, parseIPv6, parseJiraCsv, restIssue, type HttpGet } from './jira';
import { parseMspdi, writeMspdi } from './mspdi';
import { decodeText, readCsv, readXlsx, tableToDraft } from './tabular';

const fx = (n: string): Buffer => readFileSync(join(__dirname, '../../test/fixtures/imports', n));
const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };

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
    return e instanceof AppError ? e.code : String(e);
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
    draft.tasks = [{ key: 'a', sourceId: null, name: 'a', parentKey: null, start: null, end: null, durationMinutes: 960, progress: 0, status: null, assigneeName: null, plannedCost: 0, actualCost: 0, deadline: null, notes: null }];
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
    const r = rows(p);
    expect(r.map((t) => [t.wbs, t.name, t.type])).toEqual([
      ['1', 'الأعمال الإنشائية', 'GROUP'],
      ['1.1', 'الحفر', 'TASK'],
      ['1.2', 'صب الخرسانة', 'TASK'],
      ['2', 'التسليم', 'MILESTONE'],
      ['3', 'بدون رقم', 'TASK'],
      ['4', 'سطر بتاريخ غير مفهوم', 'TASK'],
    ]);
    expect(byName(p, 'الحفر')).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-13', durationDays: 3, progress: 40, status: 'IN_PROGRESS', assigneeName: 'مشرف ١', plannedCost: 1500, notes: 'حفر الأساسات' });
    // 1.1 ends Tue 13; + 1 working day of lag → Thu 15; 2 days over Fri/Sat → Sun 18.
    expect(byName(p, 'صب الخرسانة')).toMatchObject({ startDate: '2026-10-15', endDate: '2026-10-18', deadline: '2026-10-25', plannedCost: 2000 });
    expect(byName(p, 'التسليم')).toMatchObject({ startDate: '2026-10-19', durationDays: 0 });
    expect(byName(p, 'الأعمال الإنشائية')).toMatchObject({ plannedCost: 3500, status: 'IN_PROGRESS' });
    expect(byName(p, 'بدون رقم')).toMatchObject({ status: 'DONE', startDate: '2026-10-18', endDate: '2026-10-19' });
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
    expect(byName(p, 'Survey')).toMatchObject({ startDate: '2026-10-11', durationDays: 2, progress: 100, status: 'DONE' });
    expect(byName(p, 'Excavation').durationDays).toBe(5);
    expect(previewDepsDto(p).map((x) => [x.type, x.lagDays])).toEqual([
      ['FS', 0],
      ['FS', 2],
      ['SS', -1],
    ]);
    expect(p.warnings.map((w) => w.code).sort()).toEqual(['DEPENDENCY_TYPE_IGNORED', 'PREDECESSOR_MISSING']);
  });

  it('Excel: picks the sheet with a task-name header, indentation outline, date-time cells, percent cells, hours column → HOUR', async () => {
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
    expect(byName(p, 'فحص التكييف')).toMatchObject({ startDate: '2026-10-11T09:00', endDate: '2026-10-11T12:00', durationHours: 3, progress: 100, plannedCost: 750.5 });
    // FS after 12:00: 12:00–13:00 + lunch + 14:00–18:00 = 5 h.
    expect(byName(p, 'تغيير الفلاتر')).toMatchObject({ startDate: '2026-10-11T12:00', endDate: '2026-10-11T18:00', progress: 25 });
    // FS + 1 h after Sunday 18:00 → Monday 10:00, 8 h → Tuesday 10:00.
    expect(byName(p, 'صيانة المبنى ب')).toMatchObject({ startDate: '2026-10-12T10:00', endDate: '2026-10-13T10:00', durationHours: 8 });
  });

  it('decodes UTF-16 CSV (Excel "Unicode text") and refuses a file without a task-name column', async () => {
    const text = 'اسم المهمة\tالمدة\r\nأ\t2\r\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(decodeText(utf16)).toBe(text);
    expect(rows(preview(tableToDraft(readCsv(utf16), { dateOrder: 'DMY' })))[0]).toMatchObject({ name: 'أ', durationDays: 2 });
    expect(await codeOf(() => tableToDraft(readCsv(Buffer.from('a,b\n1,2\n')), { dateOrder: 'DMY' }))).toBe('IMPORT_NO_TASKS');
  });
});

describe('MS Project XML (MSPDI)', () => {
  it('hours file: summary, milestone, FS/SS lags, lunch-break calendar with a holiday, resources → assignee, costs in hundredths', () => {
    const draft = parseMspdi(fx('mspdi-hours.xml').toString('utf8'));
    const p = preview(draft);
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
    expect(byName(p, 'تجهيز الموقع & العزل')).toMatchObject({ durationHours: 4, progress: 100, status: 'DONE', plannedCost: 1500, actualCost: 1200.5 });
    expect(byName(p, 'التمديدات')).toMatchObject({ startDate: '2026-10-11T13:00', endDate: '2026-10-12T12:00', durationHours: 8, deadline: '2026-10-14', notes: 'تمديدات الكهرباء والسباكة' });
    // FS + 1 day (480 min): Mon 12:00 → 13–17 + Tue 08–12 → Tue 12:00 is lunch → 13:00.
    expect(byName(p, 'اعتماد')).toMatchObject({ startDate: '2026-10-13T13:00', durationHours: 0 });
    expect(previewDepsDto(p)).toEqual([
      { predecessorRef: 'u2', successorRef: 'u3', type: 'FS', lagDays: 0, lagHours: 0 },
      { predecessorRef: 'u3', successorRef: 'u4', type: 'SS', lagDays: 0, lagHours: 1 },
      { predecessorRef: 'u3', successorRef: 'u5', type: 'FS', lagDays: 1, lagHours: 8 },
    ]);
    expect(p.warnings.map((w) => w.code).sort()).toEqual(['ASSIGNEE_MULTIPLE', 'DEPENDENCY_TYPE_IGNORED', 'HOURS_DETECTED']);
  });

  it('days file: Sat/Sun weekend from WeekDays, null tasks skipped, whole-day durations stay DAY', () => {
    const p = preview(parseMspdi(fx('mspdi-days.xml').toString('utf8')));
    expect(p.project).toMatchObject({ name: 'Warehouse', durationUnit: 'DAY', calendar: { weekendDays: [0, 6] } });
    expect(rows(p).map((t) => [t.name, t.startDate, t.endDate, t.durationDays])).toEqual([
      ['Foundations', '2026-10-12', '2026-10-14', 3],
      ['Walls', '2026-10-16', '2026-10-19', 2],
    ]);
  });

  it('refuses DOCTYPEs and non-MSPDI XML', async () => {
    expect(await codeOf(() => parseMspdi('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Project/>'))).toBe('IMPORT_FILE_INVALID');
    expect(await codeOf(() => parseMspdi('<?xml version="1.0"?><svg/>'))).toBe('IMPORT_FORMAT_MISMATCH');
  });

  it('round trip: what writeMspdi exports, parseMspdi reads back (hierarchy, hours, calendar, lags, assignees, costs)', () => {
    const p1 = preview(parseMspdi(fx('mspdi-hours.xml').toString('utf8')));
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
    const strip = (p: PreviewPayload) => rows(p).map(({ ref: _r, sourceId: _s, parentRef: _p, ...t }) => t);
    expect(strip(p2)).toEqual(strip(p1));
    expect(p2.project.calendar).toEqual(p1.project.calendar);
    expect(previewDepsDto(p2).map(({ predecessorRef: _a, successorRef: _b, ...x }) => x)).toEqual(previewDepsDto(p1).map(({ predecessorRef: _a, successorRef: _b, ...x }) => x));
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
    // Original Estimate 57,600 s = 16 h = 2 working days from the custom Start date.
    expect(byName(p, 'مسح الأرض')).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-12', durationDays: 2, deadline: '2026-10-12' });
    expect(previewDepsDto(p).map((x) => `${x.predecessorRef}>${x.successorRef}`)).toEqual(['jOPS-2>jOPS-3', 'jOPS-2>jOPS-4', 'jOPS-3>jOPS-4']);
  });

  it('REST: paginates with nextPageToken, maps issues, sends Basic auth to the site only', async () => {
    const calls: URL[] = [];
    const page = (n: number, next?: string) =>
      JSON.stringify({
        issues: [
          { id: `${n}`, key: `OPS-${n}`, fields: { summary: `مهمة ${n}`, issuetype: { name: n === 1 ? 'Epic' : 'Task' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, assignee: { displayName: 'مشرف ١' }, created: '2026-10-05T09:15:00.000+0300', duedate: null, timeoriginalestimate: 28800, parent: n === 1 ? undefined : { key: 'OPS-1' }, issuelinks: n === 2 ? [{ type: { name: 'Blocks' }, outwardIssue: { key: 'OPS-3' } }] : [], description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'وصف' }] }] }, customfield_10015: '2026-10-11' } },
        ],
        ...(next ? { nextPageToken: next } : { isLast: true }),
      });
    const get: HttpGet = async (url, headers) => {
      calls.push(url);
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('a@b.sa:secret-token').toString('base64')}`);
      const token = url.searchParams.get('nextPageToken');
      return { status: 200, body: token === 't2' ? page(2, 't3') : token === 't3' ? page(3) : page(1, 't2') };
    };
    const res = await fetchJiraIssues({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'secret-token', projectKey: 'OPS' }, { get });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.origin).toBe('https://acme.atlassian.net');
    expect(calls[0]!.pathname).toBe('/rest/api/3/search/jql');
    expect(calls[0]!.searchParams.get('jql')).toBe('project = "OPS" ORDER BY created ASC');
    expect(res.issues.map((i) => i.key)).toEqual(['OPS-1', 'OPS-2', 'OPS-3']);
    const p = preview(issuesToDraft(res.issues, { projectName: 'OPS' }));
    expect(rows(p).map((t) => [t.wbs, t.sourceId, t.type, t.notes])).toEqual([
      ['1', 'OPS-1', 'GROUP', 'وصف'],
      ['1.1', 'OPS-2', 'TASK', 'وصف'],
      ['1.2', 'OPS-3', 'TASK', 'وصف'],
    ]);
    expect(previewDepsDto(p)).toEqual([{ predecessorRef: 'jOPS-2', successorRef: 'jOPS-3', type: 'FS', lagDays: 0 }]);
  });

  it('REST errors: 401 → JIRA_AUTH_FAILED, redirect → JIRA_URL_NOT_ALLOWED, 500 → JIRA_REQUEST_FAILED; the token never appears in the error', async () => {
    const input = { siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'super-secret-token', projectKey: 'OPS' };
    for (const [status, code] of [
      [401, 'JIRA_AUTH_FAILED'],
      [302, 'JIRA_URL_NOT_ALLOWED'],
      [500, 'JIRA_REQUEST_FAILED'],
    ] as const) {
      const err = await fetchJiraIssues(input, { get: async () => ({ status, body: '' }) }).catch((e: unknown) => e as AppError);
      expect((err as AppError).code).toBe(code);
      expect(JSON.stringify({ details: (err as AppError).details, message: (err as AppError).message })).not.toContain('super-secret-token');
    }
  });

  it('security review A9 L5: one overall deadline across every page, even when the server trickles or ignores the signal', async () => {
    const input = { siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 't', projectKey: 'OPS' };
    let calls = 0;
    const signals: Array<AbortSignal | undefined> = [];
    // Every page answers after 30 ms with a next page; the deadline (80 ms) ends the loop.
    const slow: HttpGet = (_u, _h, signal) => {
      calls++;
      signals.push(signal);
      return new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: JSON.stringify({ issues: [{ key: `OPS-${calls}`, fields: { summary: 'x' } }], nextPageToken: `p${calls}` }) }), 30));
    };
    const started = Date.now();
    const err = await fetchJiraIssues(input, { get: slow, deadlineMs: 80 }).catch((e: unknown) => e as AppError);
    expect(err).toMatchObject({ code: 'JIRA_REQUEST_FAILED', details: { reason: 'timeout' } });
    expect(calls).toBeLessThan(6);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signals[0]).toBeDefined();
    // A request that never answers is cut at the deadline too.
    const hang: HttpGet = () => new Promise(() => undefined);
    expect(await fetchJiraIssues(input, { get: hang, deadlineMs: 50 }).catch((e: unknown) => (e as AppError).details)).toEqual({ reason: 'timeout' });
  });

  it('SSRF guard: https *.atlassian.net or the allowlist only; no IPs, ports, credentials; private addresses refused at DNS', async () => {
    expect(assertJiraSite('https://acme.atlassian.net/jira/software').origin).toBe('https://acme.atlassian.net');
    for (const bad of ['http://acme.atlassian.net', 'https://169.254.169.254', 'https://acme.atlassian.net.evil.com', 'https://evil.com', 'https://acme.atlassian.net:8443', 'https://u:p@acme.atlassian.net', 'https://[::1]', 'ftp://acme.atlassian.net', 'not a url']) {
      expect(await codeOf(() => assertJiraSite(bad))).toBe('JIRA_URL_NOT_ALLOWED');
    }
    expect(assertJiraSite('https://jira.example.sa', ['jira.example.sa']).hostname).toBe('jira.example.sa');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['104.192.141.1', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
    // Security review A9 L5: the IPv6 gaps (site-local, 6to4, hex-mapped, IPv4-compatible, discard, Teredo, NAT64, junk).
    for (const ip of ['fec0::1', '2002:a00:1::1', '2002:c0a8:101::', '::ffff:7f00:1', '::ffff:a00:1', '::127.0.0.1', '::a.b.c.d', '100::1', '2001::1', '2001:db8::1', '64:ff9b::a00:1', '3fff::1', 'fe80::1%eth0', '::', '1::', 'zz::1']) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['2a00:1450:4001::200e', '::ffff:8.8.8.8', '2001:4860:4860::8888']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    expect(parseIPv6('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    const lookup = guardedLookup((_h, _o, cb) => cb(null, [{ address: '104.192.141.1', family: 4 }, { address: '10.0.0.5', family: 4 }]));
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('acme.atlassian.net', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EJIRAPRIVATE');
    const ok = await new Promise<string>((resolve) => guardedLookup((_h, _o, cb) => cb(null, [{ address: '104.192.141.1', family: 4 }]))('acme.atlassian.net', {}, (_e, a) => resolve(a as string)));
    expect(ok).toBe('104.192.141.1');
  });

  it('a REST issue without a key is ignored', () => {
    expect(restIssue({ fields: { summary: 'x' } })).toBeNull();
  });
});

describe('MS Project .mpp converter client', () => {
  it('without CONVERTER_URL → 501 MPP_CONVERTER_NOT_CONFIGURED (Arabic message points to «حفظ باسم ← XML»)', async () => {
    const err = await convertMpp(new Uint8Array([1]), { timeoutMs: 1000 }).catch((e: unknown) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('MPP_CONVERTER_NOT_CONFIGURED');
    expect((err as AppError).status).toBe(501);
    expect((err as AppError).messageAr).toContain('XML');
  });

  it('posts the bytes with the token and returns MSPDI; maps 422 and 5xx', async () => {
    const xml = fx('mspdi-days.xml');
    const seen: Array<{ url: string; headers: Record<string, string>; size: number }> = [];
    const fetchOk = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      seen.push({ url, headers: init.headers, size: init.body.length });
      return { ok: true, status: 200, arrayBuffer: async () => xml.buffer.slice(xml.byteOffset, xml.byteOffset + xml.byteLength) };
    };
    const out = await convertMpp(new Uint8Array([0xd0, 0xcf]), { url: 'http://converter:8080/', token: 't'.repeat(40), timeoutMs: 1000 }, fetchOk as never);
    expect(parseMspdi(out).projectName).toBe('Warehouse');
    expect(seen[0]).toMatchObject({ url: 'http://converter:8080/convert', size: 2 });
    expect(seen[0]!.headers[CONVERTER_TOKEN_HEADER]).toBe('t'.repeat(40));
    const status = (s: number) => async () => ({ ok: false, status: s, arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await codeOf(() => convertMpp(new Uint8Array([1]), { url: 'http://c', timeoutMs: 1000 }, status(422) as never))).toBe('IMPORT_FILE_INVALID');
    expect(await codeOf(() => convertMpp(new Uint8Array([1]), { url: 'http://c', timeoutMs: 1000 }, status(503) as never))).toBe('MPP_CONVERSION_FAILED');
    expect(await codeOf(() => convertMpp(new Uint8Array([1]), { url: 'http://c', timeoutMs: 1000 }, (async () => { throw new Error('ECONNREFUSED'); }) as never))).toBe('MPP_CONVERSION_FAILED');
  });

  it('the converter output is streamed under a size cap: the stream is cancelled once the cap is passed', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(ctrl) {
          pulled++;
          ctrl.enqueue(new TextEncoder().encode('<x>'.padEnd(1024, ' ')));
        },
        cancel() {
          cancelled = true;
        },
      });
    const fetchStream = async () => ({ ok: true, status: 200, body: endless(), arrayBuffer: async () => { throw new Error('must not buffer'); } });
    const err = await convertMpp(new Uint8Array([1]), { url: 'http://c', timeoutMs: 1000, maxBytes: 10 * 1024 }, fetchStream as never).catch((e: unknown) => e as AppError);
    expect(err).toMatchObject({ code: 'MPP_CONVERSION_FAILED', details: { reason: 'too large' } });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
    const small = async () => ({ ok: true, status: 200, body: new Blob(['<Project/>']).stream(), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await convertMpp(new Uint8Array([1]), { url: 'http://c', timeoutMs: 1000 }, small as never)).toBe('<Project/>');
  });
});

describe('import uploads — structure checks (magic bytes)', () => {
  it('xlsx = ZIP with xl/workbook.xml; mpp = OLE2; XML without DOCTYPE; CSV = text', async () => {
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
    expect(verifyImportBytes(fx('tasks.xlsx'), xlsx)).toBe(true);
    expect(verifyImportBytes(Buffer.from('PK\x03\x04 random zip', 'latin1'), xlsx)).toBe(false);
    expect(verifyImportBytes(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'application/vnd.ms-project')).toBe(true);
    expect(verifyImportBytes(fx('tasks.xlsx'), 'application/vnd.ms-project')).toBe(false);
    expect(verifyImportBytes(fx('mspdi-hours.xml'), 'application/xml')).toBe(true);
    expect(verifyImportBytes(Buffer.from('﻿  <Project/>'), 'text/xml')).toBe(true);
    expect(verifyImportBytes(Buffer.from('<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><p>&x;</p>'), 'application/xml')).toBe(false);
    expect(verifyImportBytes(fx('tasks-ar.csv'), 'text/csv')).toBe(true);
    expect(verifyImportBytes(Buffer.from('a,b\u0000c'), 'text/csv')).toBe(false);
    expect(verifyImportBytes(Buffer.from('<html><script>'), 'text/csv')).toBe(false);
    expect(verifyImportBytes(fx('tasks.xlsx'), 'text/csv')).toBe(false);
  });
});

// ─────────────────────────────────────────── service: preview → commit

const FILE = '11111111-0000-4000-8000-000000000001';
const SUP1 = 'aaaaaaaa-0000-4000-8000-000000000001';

function serviceSetup(fixture: string, mimeType: string, cfg: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: SUP1, fullName: 'علي', role: 'SUPERVISOR', status: 'ACTIVE' },
      { id: 'sup-off', fullName: 'أحمد', role: 'SUPERVISOR', status: 'SUSPENDED' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], isDefault: true, exceptions: [] }],
    files: [{ id: FILE, storageKey: `imports/2026/10/${FILE}.xml`, mimeType, status: 'READY', entityType: 'import', uploadedById: 'admin', deletedAt: null, sizeBytes: 10 }],
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const storage = { readAll: jest.fn(async () => new Uint8Array(fx(fixture))), delete: jest.fn(async () => undefined) };
  const service = new ImportsService(fake.db as never, storage as never, store, audit, { CONVERTER_TIMEOUT_MS: 1000, JIRA_ALLOWED_HOSTS: [], ...cfg } as never);
  return { fake, storage, service, store, audit };
}

describe('ImportsService — preview and commit', () => {
  it('MSPDI preview → commit: one transaction creates the calendar, HOUR project, hierarchy, links with lags and mapped assignees', async () => {
    const { fake, storage, service } = serviceSetup('mspdi-hours.xml', 'application/xml');
    const pv = await service.previewFile({ fileId: FILE, format: 'xml', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv.stats).toEqual({ taskCount: 5, groupCount: 1, milestoneCount: 1, dependencyCount: 3 });
    expect(pv.unmappedAssignees).toEqual([
      { name: 'أحمد', taskCount: 1, suggestedUserId: null },
      { name: 'علي', taskCount: 1, suggestedUserId: SUP1 },
    ]);
    expect(new Date(pv.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(fake.data.importPreviews).toHaveLength(1);

    const res = await service.commit({ previewId: pv.previewId, assigneeMap: { علي: SUP1, أحمد: null } }, ADMIN, ctx);
    expect(res).toMatchObject({ taskCount: 5, dependencyCount: 3, calendarCreated: true });
    const project = fake.data.projects.find((p) => p.id === res.projectId)!;
    expect(project).toMatchObject({ name: 'تشطيب البرج', durationUnit: 'HOUR', calendarId: res.calendarId });
    const cal = fake.data.calendars.find((c) => c.id === res.calendarId)!;
    expect(cal).toMatchObject({ weekendDays: [5, 6], workingHours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] });
    expect(cal.exceptions).toHaveLength(1);

    const tasks = fake.data.tasks.filter((t) => t.projectId === res.projectId);
    const t = (name: string) => tasks.find((x) => x.name === name)!;
    expect(t('التمديدات')).toMatchObject({ parentId: t('المرحلة الأولى').id, assigneeId: SUP1, durationMinutes: 480, type: 'TASK' });
    expect(localOf(t('التمديدات').startAt!)).toBe('2026-10-11T13:00');
    expect(t('تجهيز الموقع & العزل').assigneeId).toBeNull();
    expect(t('المرحلة الأولى')).toMatchObject({ type: 'GROUP', assigneeId: null });
    expect(localOf(t('اعتماد').startAt!)).toBe('2026-10-13T13:00');
    const deps = fake.data.deps.filter((x) => x.projectId === res.projectId);
    expect(deps.map((x) => [x.type, x.lagMinutes]).sort()).toEqual([
      ['FS', 0],
      ['FS', 480],
      ['SS', 60],
    ]);
    expect(fake.data.audit.find((a) => a.action === 'project.imported')).toMatchObject({ entityId: res.projectId, after: { format: 'xml', tasks: 5, dependencies: 3, durationUnit: 'HOUR', calendarCreated: true } });
    // The preview is consumed and the upload deleted.
    expect(fake.data.importPreviews).toHaveLength(0);
    expect(storage.delete).toHaveBeenCalledWith(`imports/2026/10/${FILE}.xml`);
    expect(fake.data.files[0]!.deletedAt).toBeInstanceOf(Date);
    expect(await codeOf(() => service.commit({ previewId: pv.previewId, assigneeMap: {} }, ADMIN, ctx))).toBe('IMPORT_PREVIEW_EXPIRED');
  });

  it('commit re-bases to a new start date, refuses non-supervisors, and expired previews', async () => {
    const { fake, service } = serviceSetup('tasks-ar.csv', 'text/csv');
    const pv = await service.previewFile({ fileId: FILE, format: 'csv', options: { dateOrder: 'DMY', projectName: 'مشروع الفيلا' } }, ADMIN, ctx);
    expect(await codeOf(() => service.commit({ previewId: pv.previewId, assigneeMap: { 'مشرف ١': 'sup-off' } }, ADMIN, ctx))).toBe('ASSIGNEE_NOT_SUPERVISOR');
    const res = await service.commit({ previewId: pv.previewId, assigneeMap: {}, startDate: '2026-11-01' }, ADMIN, ctx);
    const project = fake.data.projects.find((p) => p.id === res.projectId)!;
    expect(project).toMatchObject({ name: 'مشروع الفيلا', durationUnit: 'DAY', calendarId: 'cal' });
    expect(res.calendarCreated).toBe(false);
    const dig = fake.data.tasks.find((x) => x.projectId === res.projectId && x.name === 'الحفر')!;
    // 2026-11-01 is a Sunday; the first task keeps offset 0 and 3 working days.
    expect(dig.startDate.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(dig.endDate.toISOString().slice(0, 10)).toBe('2026-11-03');
    expect(dig).toMatchObject({ startAt: null, durationDays: 3, plannedCost: 1500, description: 'حفر الأساسات' });

    // The upload was deleted by the commit; a new one for the next preview.
    fake.data.files[0]!.deletedAt = null;
    const pv2 = await service.previewFile({ fileId: FILE, format: 'csv', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    fake.data.importPreviews[0]!.expiresAt = new Date(Date.now() - 1000);
    expect(await codeOf(() => service.commit({ previewId: pv2.previewId, assigneeMap: {} }, ADMIN, ctx))).toBe('IMPORT_PREVIEW_EXPIRED');
    expect(await service.cleanupExpired()).toBe(1);
    expect(fake.data.importPreviews).toHaveLength(0);
  });

  it('security review A9 L2: at most 5 previews per admin (the oldest go first); the cleanup loops over every batch', async () => {
    const { fake, service } = serviceSetup('tasks-ar.csv', 'text/csv');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await service.previewFile({ fileId: FILE, format: 'csv', options: { dateOrder: 'DMY' } }, ADMIN, ctx)).previewId);
      fake.data.importPreviews.at(-1)!.createdAt = new Date(Date.UTC(2026, 9, 19, 8, i));
    }
    expect(fake.data.importPreviews.map((p) => p.id).sort()).toEqual(ids.slice(2).sort());
    // The upload the newest preview reads is kept.
    expect(fake.data.files[0]!.deletedAt).toBeNull();
    // Another admin's previews are not touched.
    fake.data.importPreviews.push({ id: 'other', createdById: 'admin-2', format: 'csv', fileId: null, payload: {}, expiresAt: new Date(Date.now() - 1), createdAt: new Date() });
    for (let i = 0; i < 1_201; i++) {
      fake.data.importPreviews.push({ id: `old-${i}`, createdById: 'admin-3', format: 'csv', fileId: null, payload: {}, expiresAt: new Date(Date.now() - 1000), createdAt: new Date() });
    }
    expect(await service.cleanupExpired()).toBe(1_202);
    expect(fake.data.importPreviews).toHaveLength(5);
  });

  it('format must match the upload; someone else\'s upload is 404; .mpp without a converter is 501', async () => {
    const { service, fake } = serviceSetup('mspdi-hours.xml', 'application/xml');
    expect(await codeOf(() => service.previewFile({ fileId: FILE, format: 'xlsx', options: { dateOrder: 'DMY' } }, ADMIN, ctx))).toBe('IMPORT_FORMAT_MISMATCH');
    expect(await codeOf(() => service.previewFile({ fileId: FILE, format: 'xml', options: { dateOrder: 'DMY' } }, { ...ADMIN, id: 'other' }, ctx))).toBe('NOT_FOUND');
    fake.data.files[0]!.mimeType = 'application/vnd.ms-project';
    expect(await codeOf(() => service.previewFile({ fileId: FILE, format: 'mpp', options: { dateOrder: 'DMY' } }, ADMIN, ctx))).toBe('MPP_CONVERTER_NOT_CONFIGURED');
  });

  it('Jira CSV and Excel previews go through the same path; options force the unit', async () => {
    const jira = serviceSetup('jira-export.csv', 'text/csv');
    const pv = await jira.service.previewFile({ fileId: FILE, format: 'jira-csv', options: { dateOrder: 'DMY', durationUnit: 'HOUR' } }, ADMIN, ctx);
    expect(pv.format).toBe('jira-csv');
    expect(pv.project.durationUnit).toBe('HOUR');
    expect(pv.tasks.find((t) => t.sourceId === 'OPS-2')).toMatchObject({ durationHours: 16 });
    const xlsx = serviceSetup('tasks.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const pv2 = await xlsx.service.previewFile({ fileId: FILE, format: 'xlsx', options: { dateOrder: 'DMY' } }, ADMIN, ctx);
    expect(pv2.stats.taskCount).toBe(5);
  });
});

// ─────────────────────────────────────────── exports round trip

describe('project exports (xlsx, csv, MSPDI)', () => {
  const P = '00000000-0000-4000-8000-0000000000e1';
  const A = 'a0000000-0000-4000-8000-00000000000a';
  const B = 'b0000000-0000-4000-8000-00000000000b';
  const G = 'c0000000-0000-4000-8000-00000000000c';

  function exportSetup(unit: 'DAY' | 'HOUR') {
    const hour = unit === 'HOUR';
    const at = (start: string, end: string, minutes: number) => (hour ? timeColumns({ startDate: start, endDate: end, durationHours: minutes / 60 }) : {});
    const fake = createFakeDb({
      users: [
        { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
        { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
      ],
      calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], isDefault: true, exceptions: [{ id: 'h', date: d('2026-10-20'), isWorking: false, name: 'عطلة' }] }],
      projects: [{ id: P, name: 'مشروع =التصدير', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11'), durationUnit: unit, budget: 9000 }],
      tasks: [
        task({ id: G, projectId: P, type: 'GROUP', name: 'المرحلة', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-14'), durationDays: 4, plannedCost: 700, ...at('2026-10-11T09:00', '2026-10-12T13:00', 720) }),
        task({ id: A, projectId: P, parentId: G, name: 'الحفر', sortOrder: 1, wbsCache: '1.1', assigneeId: 'sup1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, plannedCost: 500, actualCost: 100, deadline: d('2026-10-15'), description: 'ملاحظة', ...at('2026-10-11T09:00', '2026-10-11T15:00', 300) }),
        task({ id: B, projectId: P, parentId: G, name: 'الصب', sortOrder: 2, wbsCache: '1.2', startDate: d('2026-10-14'), endDate: d('2026-10-14'), durationDays: 1, plannedCost: 200, ...at('2026-10-12T09:00', '2026-10-12T13:00', 240) }),
      ],
      deps: [{ id: 'd1', projectId: P, predecessorId: A, successorId: B, type: 'FS', lagDays: hour ? 0 : 1, lagMinutes: hour ? 120 : 0 }],
      labels: [{ id: 'l1', projectId: P, name: 'عاجل', color: '#ff0000' }],
      taskLabels: [{ taskId: A, labelId: 'l1' }],
      customFields: [{ id: 'f1', projectId: P, name: 'المقاول', type: 'TEXT', options: [], sort: 0 }],
      customValues: [{ taskId: A, fieldId: 'f1', value: 'شركة البناء' }],
    });
    const audit = new AuditService(fake.db as never);
    const store = new ProjectStore(fake.db as never, audit);
    const tasks = new TasksService(fake.db as never, store, audit, fake.notifications as never);
    const reports = new ProjectReportsService(fake.db as never, store);
    const projects = new ProjectsService(fake.db as never, store, audit, new TemplatesService(fake.db as never, store, audit, tasks, reports));
    return { fake, projects };
  }

  it('xlsx: RTL, no frozen panes, cost/deadline/labels/custom-field columns; the importer reads it back', async () => {
    const { projects, fake } = exportSetup('DAY');
    const out = await projects.exportProject(P, 'xlsx', ADMIN, ctx);
    expect(out.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const wb = new Workbook();
    await wb.xlsx.load(out.buffer as unknown as ArrayBuffer);
    for (const ws of wb.worksheets) for (const v of ws.views) expect([v.rightToLeft, v.state]).toEqual([true, undefined === v.state ? undefined : 'normal']);
    const ws = wb.getWorksheet('المهام')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(['رقم WBS', 'المهمة', 'النوع', 'البداية', 'النهاية', 'المدة (أيام عمل)', 'نسبة الإنجاز', 'الحالة', 'الأولوية', 'المسند إليه', 'الفريق', 'الوصف', 'التكلفة المخططة', 'التكلفة الفعلية', 'الموعد النهائي', 'الوسوم', 'المقاول']);
    const dig = (ws.getRow(3).values as unknown[]).slice(1);
    expect(dig.slice(12)).toEqual([500, 100, new Date('2026-10-15T00:00:00Z'), 'عاجل', 'شركة البناء']);
    expect(fake.data.audit.find((a) => a.action === 'project.exported')).toMatchObject({ after: { format: 'xlsx', tasks: 3 } });
    const back = preview(tableToDraft((await readXlsx(out.buffer)).rows, { dateOrder: 'DMY' }));
    expect(rows(back).map((t) => [t.wbs, t.name, t.type, t.startDate, t.endDate, t.plannedCost])).toEqual([
      ['1', 'المرحلة', 'GROUP', '2026-10-11', '2026-10-14', 700],
      ['1.1', 'الحفر', 'TASK', '2026-10-11', '2026-10-12', 500],
      ['1.2', 'الصب', 'TASK', '2026-10-14', '2026-10-14', 200],
    ]);
  });

  it('csv: UTF-8 BOM, CRLF, the same columns, formula injection neutralised', async () => {
    const { projects } = exportSetup('DAY');
    const out = await projects.exportProject(P, 'csv', ADMIN, ctx);
    expect(out.contentType).toBe('text/csv; charset=utf-8');
    expect([...out.buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = out.buffer.toString('utf8').slice(1);
    expect(text.split('\r\n')[0]).toBe('رقم WBS,المهمة,النوع,البداية,النهاية,المدة (أيام عمل),نسبة الإنجاز,الحالة,الأولوية,المسند إليه,الفريق,الوصف,التكلفة المخططة,التكلفة الفعلية,الموعد النهائي,الوسوم,المقاول');
    expect(text).toContain('1.1,الحفر,مهمة,2026-10-11,2026-10-12,2,0,لم تبدأ,متوسطة,مشرف ١,,ملاحظة,500,100,2026-10-15,عاجل,شركة البناء');
    expect(buildTasksCsv({}, [{ wbs: '1', name: '=HYPERLINK("x")', type: 'TASK', startDate: '2026-10-11', endDate: '2026-10-11', durationDays: 1, progress: 0, status: 'NOT_STARTED', priority: 'LOW', assigneeName: null, teamName: null, description: null }]).toString('utf8')).toContain(`"'=HYPERLINK(""x"")"`);
    // The importer reads the CSV export back.
    const back = preview(tableToDraft(readCsv(out.buffer), { dateOrder: 'DMY' }));
    expect(rows(back).map((t) => t.name)).toEqual(['المرحلة', 'الحفر', 'الصب']);
  });

  it('xml (MSPDI) of an HOUR project: calendar, hours, summary, lag in hours, resources; re-imports identically', async () => {
    const { projects } = exportSetup('HOUR');
    const out = await projects.exportProject(P, 'xml', ADMIN, ctx);
    expect(out.contentType).toBe('application/xml; charset=utf-8');
    const xml = out.buffer.toString('utf8');
    expect(xml).toContain('<Title>مشروع =التصدير</Title>');
    expect(xml).toContain('<LinkLag>1200</LinkLag><LagFormat>5</LagFormat>');
    expect(xml).toContain('<Resource><UID>1</UID><ID>1</ID><Name>مشرف ١</Name>');
    const back = preview(parseMspdi(xml));
    expect(back.project).toMatchObject({ name: 'مشروع =التصدير', durationUnit: 'HOUR', calendar: { weekendDays: [5, 6], exceptions: [{ date: '2026-10-20', isWorking: false }] } });
    expect(rows(back).map((t) => [t.wbs, t.name, t.type, t.startDate, t.endDate, t.durationHours, t.assigneeName, t.plannedCost, t.actualCost, t.deadline, t.notes])).toEqual([
      ['1', 'المرحلة', 'GROUP', '2026-10-11T09:00', '2026-10-12T13:00', 12, null, 700, 100, null, null],
      ['1.1', 'الحفر', 'TASK', '2026-10-11T09:00', '2026-10-11T15:00', 5, 'مشرف ١', 500, 100, '2026-10-15', 'ملاحظة'],
      ['1.2', 'الصب', 'TASK', '2026-10-12T09:00', '2026-10-12T13:00', 4, null, 200, 0, null, null],
    ]);
    expect(previewDepsDto(back)).toEqual([expect.objectContaining({ type: 'FS', lagHours: 2 })]);
  });

  it('xml of a DAY project spans the working hours of each day and re-imports as DAY', async () => {
    const { projects } = exportSetup('DAY');
    const out = await projects.exportProject(P, 'xml', ADMIN, ctx);
    const xml = out.buffer.toString('utf8');
    expect(xml).toContain('<Start>2026-10-11T09:00:00</Start><Finish>2026-10-12T18:00:00</Finish><Duration>PT16H0M0S</Duration>');
    const back = preview(parseMspdi(xml));
    expect(back.project.durationUnit).toBe('DAY');
    expect(rows(back).map((t) => [t.name, t.startDate, t.endDate, t.durationDays])).toEqual([
      ['المرحلة', '2026-10-11', '2026-10-14', 4],
      ['الحفر', '2026-10-11', '2026-10-12', 2],
      ['الصب', '2026-10-14', '2026-10-14', 1],
    ]);
    expect(previewDepsDto(back)).toEqual([expect.objectContaining({ type: 'FS', lagDays: 1 })]);
  });
});
