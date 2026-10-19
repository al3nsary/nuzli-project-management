/**
 * A9 — MS Project XML (MSPDI, the schema MS Project writes with «حفظ باسم ← XML» and MPXJ
 * produces from .mpp). `parseMspdi` reads tasks (outline, dates, durations, milestones,
 * summaries, % complete, costs, deadlines, notes), links (type 0..3, lag in tenths of minutes),
 * resources + assignments (assignee names) and the project calendar. `writeMspdi` produces a
 * file the importer reads back (round trip, tested) and MS Project opens.
 */
import { XMLParser } from 'fast-xml-parser';
import { WorkCalendar, type WorkingHours } from '@nuzli/scheduling';
import type { DependencyType } from '@nuzli/shared';
import { AppError } from '../common/app-error';
import {
  cleanText,
  emptyDraft,
  parentsFromLevels,
  parseIsoDuration,
  warn,
  type DraftCalendar,
  type DraftTask,
  type ImportDraft,
} from './import-model';
import { isLocalDateTime, type Unit } from '../projects/task-engine';

/** PredecessorLink/Type: 0 = FF, 1 = FS, 2 = SF, 3 = SS. */
export const LINK_TYPES: Record<string, DependencyType> = { '0': 'FF', '1': 'FS', '2': 'SF', '3': 'SS' };
const LINK_CODES: Record<DependencyType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
/** DurationFormat / LagFormat codes that mean hours or minutes (elapsed and estimated variants included). */
const TIME_FORMATS = new Set([3, 4, 5, 6, 35, 36, 37, 38]);
const PERCENT_FORMATS = new Set([19, 20, 51, 52]);
/** Elapsed lag formats (em, eh, ed, ew, emo and their estimated forms): calendar time, not working time. */
const ELAPSED_FORMATS = new Set([4, 6, 8, 10, 12, 36, 38, 40, 42, 44]);

const ARRAYS = new Set([
  'Project.Tasks.Task',
  'Project.Tasks.Task.PredecessorLink',
  'Project.Resources.Resource',
  'Project.Assignments.Assignment',
  'Project.Calendars.Calendar',
  'Project.Calendars.Calendar.WeekDays.WeekDay',
  'Project.Calendars.Calendar.WeekDays.WeekDay.WorkingTimes.WorkingTime',
  'Project.Calendars.Calendar.Exceptions.Exception',
  'Project.Calendars.Calendar.Exceptions.Exception.WorkingTimes.WorkingTime',
]);

type X = Record<string, unknown>;
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: unknown): number | null => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => str(v) === '1' || str(v)?.toLowerCase() === 'true';
const list = (v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : v && typeof v === 'object' ? [v as X] : []);

/** `2026-10-11T08:00:00` (local, no zone in MSPDI) → `YYYY-MM-DDTHH:MM`, midnight → the date. */
function localOfXml(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  if (!m[2] || (m[2] === '00' && m[3] === '00')) return m[1]!;
  return `${m[1]}T${m[2]}:${m[3]}`;
}

const hm = (v: unknown): string | null => {
  const s = str(v);
  const m = s ? /^(\d{2}):(\d{2})/.exec(s) : null;
  return m ? `${m[1]}:${m[2]}` : null;
};

function workingTimes(node: X | undefined): WorkingHours[] {
  const out: WorkingHours[] = [];
  for (const wt of list((node?.WorkingTimes as X | undefined)?.WorkingTime)) {
    const start = hm(wt.FromTime);
    let end = hm(wt.ToTime);
    if (!start || !end) continue;
    if (end === '00:00') end = '24:00';
    if (end > start) out.push({ start, end });
  }
  return out;
}

function calendarOf(cal: X, warnings: ImportDraft): DraftCalendar {
  const weekend: number[] = [];
  const hoursCount = new Map<string, { hours: WorkingHours[]; n: number }>();
  const exceptions: NonNullable<DraftCalendar['exceptions']> = [];
  for (const wd of list((cal.WeekDays as X | undefined)?.WeekDay)) {
    const type = num(wd.DayType);
    if (type === null) continue;
    if (type >= 1 && type <= 7) {
      const day = type - 1; // 1 = Sunday
      if (!bool(wd.DayWorking)) weekend.push(day);
      else {
        const hours = workingTimes(wd);
        if (hours.length) {
          const k = hours.map((h) => `${h.start}-${h.end}`).join(',');
          const e = hoursCount.get(k) ?? { hours, n: 0 };
          e.n++;
          hoursCount.set(k, e);
        }
      }
    } else if (type === 0) {
      // Older MSPDI: exceptions as WeekDay 0 with a TimePeriod.
      const tp = wd.TimePeriod as X | undefined;
      pushRange(exceptions, localOfXml(tp?.FromDate), localOfXml(tp?.ToDate), bool(wd.DayWorking), 'استثناء', workingTimes(wd));
    }
  }
  for (const ex of list((cal.Exceptions as X | undefined)?.Exception)) {
    const tp = ex.TimePeriod as X | undefined;
    pushRange(exceptions, localOfXml(tp?.FromDate), localOfXml(tp?.ToDate), bool(ex.DayWorking), cleanText(ex.Name, 120) ?? 'استثناء', workingTimes(ex));
  }
  const best = [...hoursCount.values()].sort((a, b) => b.n - a.n)[0];
  if (hoursCount.size > 1) warn(warnings, 'CALENDAR_DEFAULTED', 'أيام العمل في تقويم الملف بساعات مختلفة، فاستُعملت ساعات أكثر الأيام تكرارًا لكل الأيام.');
  return {
    name: cleanText(cal.Name, 80) ?? 'تقويم مستورد',
    weekendDays: weekend.length < 7 ? weekend : [5, 6],
    ...(best ? { workingHours: best.hours } : {}),
    exceptions,
  };
}

function pushRange(
  out: NonNullable<DraftCalendar['exceptions']>,
  from: string | null,
  to: string | null,
  working: boolean,
  name: string,
  hours: WorkingHours[],
): void {
  if (!from) return;
  const a = from.slice(0, 10);
  const b = (to ?? from).slice(0, 10);
  let d = a;
  for (let i = 0; d <= b && i < 366; i++) {
    out.push({ date: d, isWorking: working, name, ...(working && hours.length ? { workingHours: hours } : {}) });
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
}

/** Parses MSPDI XML into a draft. DOCTYPEs are refused (no entity declarations are processed). */
export function parseMspdi(xml: string): ImportDraft {
  if (/<!DOCTYPE/i.test(xml)) throw new AppError('IMPORT_FILE_INVALID', { reason: 'doctype' });
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: false,
    removeNSPrefix: true,
    isArray: (_name, jpath) => ARRAYS.has(String(jpath)),
  });
  let doc: X;
  try {
    doc = parser.parse(xml) as X;
  } catch {
    throw new AppError('IMPORT_FILE_INVALID', { reason: 'xml' });
  }
  const project = doc.Project as X | undefined;
  if (!project || typeof project !== 'object') throw new AppError('IMPORT_FORMAT_MISMATCH', { expected: 'MSPDI <Project>' });
  const draft = emptyDraft();
  const minutesPerDay = num(project.MinutesPerDay) ?? 480;
  draft.projectName = cleanText(project.Title, 160) ?? cleanText(project.Name, 160)?.replace(/\.(xml|mpp)$/i, '') ?? null;
  const ps = localOfXml(project.StartDate);
  draft.startDate = ps ? ps.slice(0, 10) : null;
  const projectFormat = num(project.DurationFormat);
  let anyHours = projectFormat !== null && TIME_FORMATS.has(projectFormat);

  // Calendar: the project's, else the first base calendar.
  const calendars = list((project.Calendars as X | undefined)?.Calendar);
  const calUid = str(project.CalendarUID);
  const cal = calendars.find((c) => str(c.UID) === calUid) ?? calendars.find((c) => bool(c.IsBaseCalendar)) ?? calendars[0];
  if (cal) draft.calendar = calendarOf(cal, draft);

  // Resources and assignments → one assignee name per task (the largest share).
  const resources = new Map<string, string>();
  for (const r of list((project.Resources as X | undefined)?.Resource)) {
    const uid = str(r.UID);
    const name = cleanText(r.Name, 200);
    // Type 1 = work resource (0 = material, 2 = cost); a missing type is a work resource.
    const type = str(r.Type);
    if (uid && name && (type === null || type === '1')) resources.set(uid, name);
  }
  const assigned = new Map<string, Array<{ name: string; units: number }>>();
  for (const a of list((project.Assignments as X | undefined)?.Assignment)) {
    const task = str(a.TaskUID);
    const name = resources.get(str(a.ResourceUID) ?? '');
    if (!task || !name) continue;
    const arr = assigned.get(task) ?? [];
    arr.push({ name, units: num(a.Units) ?? 1 });
    assigned.set(task, arr);
  }

  const all = list((project.Tasks as X | undefined)?.Task)
    .filter((t) => !bool(t.IsNull) && str(t.UID) !== null)
    .sort((a, b) => (num(a.ID) ?? 0) - (num(b.ID) ?? 0));
  // A10: MS Project 2010+ «inactive» tasks (<Active>0</Active>) are not scheduled there either.
  const rows = all.filter((t) => str(t.Active) !== '0');
  if (rows.length < all.length) {
    warn(draft, 'INACTIVE_SKIPPED', `${all.length - rows.length} مهمة معطّلة (Inactive) في MS Project لم تُستورد.`);
  }
  const real = rows.filter((t) => (num(t.OutlineLevel) ?? 1) >= 1 && str(t.UID) !== '0');
  const summaryRow = rows.find((t) => str(t.UID) === '0' || num(t.OutlineLevel) === 0);
  if (!draft.projectName && summaryRow) draft.projectName = cleanText(summaryRow.Name, 160);

  const tasks: DraftTask[] = [];
  const uidToKey = new Map<string, string>();
  for (const t of real) {
    const uid = str(t.UID)!;
    const name = cleanText(t.Name, 300);
    if (!name) {
      warn(draft, 'ROW_SKIPPED', `مهمة بلا اسم (UID ${uid}) تُركت.`, { sourceId: uid });
      continue;
    }
    const key = `u${uid}`;
    uidToKey.set(uid, key);
    const durMinutes = parseIsoDuration(str(t.Duration) ?? '');
    const fmt = num(t.DurationFormat);
    if (fmt !== null && TIME_FORMATS.has(fmt)) anyHours = true;
    const start = localOfXml(t.Start);
    const finish = localOfXml(t.Finish);
    // Sub-day precision on a work task (summaries roll up whatever their children are).
    if (!bool(t.Summary) && durMinutes !== null && durMinutes > 0 && durMinutes % minutesPerDay !== 0) {
      anyHours = true;
    }
    const a = (assigned.get(uid) ?? []).sort((x, y) => y.units - x.units);
    if (a.length > 1) warn(draft, 'ASSIGNEE_MULTIPLE', `«${name.slice(0, 60)}» مسندة إلى أكثر من مورد؛ استُعمل «${a[0]!.name}» (تُسند المهمة لمشرف واحد).`, { sourceId: uid });
    tasks.push({
      key,
      sourceId: str(t.ID) ?? uid,
      name,
      parentKey: null,
      summary: bool(t.Summary),
      milestone: bool(t.Milestone),
      start,
      end: finish,
      durationMinutes: durMinutes,
      durationDays: null,
      progress: Math.min(100, Math.max(0, num(t.PercentComplete) ?? 0)),
      status: null,
      assigneeName: a[0]?.name ?? null,
      // MSPDI money is in hundredths of the currency unit.
      plannedCost: Math.max(0, Math.round(num(t.Cost) ?? 0) / 100),
      actualCost: Math.max(0, Math.round(num(t.ActualCost) ?? 0) / 100),
      deadline: localOfXml(t.Deadline)?.slice(0, 10) ?? null,
      notes: cleanText(t.Notes, 8000),
    });
  }
  const levels = real.filter((t) => uidToKey.has(str(t.UID)!)).map((t) => num(t.OutlineLevel) ?? 1);
  const parents = parentsFromLevels(levels);
  tasks.forEach((t, i) => {
    const p = parents[i];
    t.parentKey = p === null || p === undefined ? null : tasks[p]!.key;
  });

  for (const t of real) {
    const succ = uidToKey.get(str(t.UID)!);
    if (!succ) continue;
    for (const link of list(t.PredecessorLink)) {
      if (bool(link.CrossProject)) {
        warn(draft, 'PREDECESSOR_MISSING', `ربطٌ بمشروع آخر تُرك (UID ${str(t.UID)}).`, { sourceId: str(t.UID) ?? undefined });
        continue;
      }
      const pred = uidToKey.get(str(link.PredecessorUID) ?? '');
      if (!pred) {
        warn(draft, 'PREDECESSOR_MISSING', `سابقة غير موجودة (UID ${str(link.PredecessorUID)}) تُركت.`, { sourceId: str(t.UID) ?? undefined });
        continue;
      }
      const type = LINK_TYPES[str(link.Type) ?? '1'] ?? 'FS';
      const lagFormat = num(link.LagFormat) ?? 7;
      const rawLag = num(link.LinkLag) ?? 0;
      let lagMinutes = 0;
      if (PERCENT_FORMATS.has(lagFormat)) {
        if (rawLag) warn(draft, 'DURATION_UNPARSED', `تأخيرٌ بالنسبة المئوية لا يُدعم فاعتُبر صفرًا (UID ${str(t.UID)}).`, { sourceId: str(t.UID) ?? undefined });
      } else lagMinutes = Math.round(rawLag / 10);
      if (ELAPSED_FORMATS.has(lagFormat)) {
        // Calculations audit L8: LinkLag of an elapsed format is calendar minutes (×10); it is
        // converted to working time on the project calendar in buildPreview.
        draft.deps.push({ predKey: pred, succKey: succ, type, lagElapsedMinutes: lagMinutes });
        continue;
      }
      if (TIME_FORMATS.has(lagFormat) && lagMinutes % minutesPerDay !== 0) anyHours = true;
      draft.deps.push({ predKey: pred, succKey: succ, type, lagMinutes });
    }
  }
  draft.tasks = tasks;
  draft.unit = anyHours ? 'HOUR' : null;
  return draft;
}

// ─────────────────────────────────────────── writer

export interface MspdiTask {
  wbs: string;
  name: string;
  type: 'TASK' | 'GROUP' | 'MILESTONE';
  /** `YYYY-MM-DD` (DAY) or local `YYYY-MM-DDTHH:MM` (HOUR). */
  startDate: string;
  endDate: string;
  durationDays: number;
  durationHours?: number;
  progress: number;
  plannedCost: number;
  actualCost: number;
  deadline: string | null;
  notes: string | null;
  assigneeName: string | null;
  id: string;
  parentId: string | null;
}

export interface MspdiProject {
  name: string;
  startDate: string;
  unit: Unit;
  calendar: { name: string; weekendDays: number[]; workingHours: WorkingHours[]; exceptions: Array<{ date: string; isWorking: boolean; name: string; workingHours?: WorkingHours[] | null }> };
  tasks: MspdiTask[];
  deps: Array<{ predecessorId: string; successorId: string; type: DependencyType; lagDays: number; lagMinutes: number }>;
  currencyCode?: string;
  createdAt?: Date;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const tag = (name: string, value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : `<${name}>${typeof value === 'number' ? value : esc(value)}</${name}>`;

const isoDuration = (minutes: number): string => {
  const m = Math.max(0, Math.round(minutes));
  return `PT${Math.floor(m / 60)}H${m % 60}M0S`;
};

const xmlDateTime = (local: string): string => `${local.length === 10 ? `${local}T00:00` : local.slice(0, 16)}:00`;

/** MSPDI XML of one project (UTF-8). DAY tasks span the working hours of their days. */
export function writeMspdi(p: MspdiProject): string {
  const cal = new WorkCalendar({
    weekendDays: p.calendar.weekendDays,
    workingHours: p.calendar.workingHours,
    exceptions: p.calendar.exceptions.map((e) => ({ date: e.date, isWorking: e.isWorking, ...(e.workingHours ? { workingHours: e.workingHours } : {}) })),
  });
  const mpd = cal.standardMinutesPerDay;
  const hours = p.unit === 'HOUR';
  const span = (t: MspdiTask): { start: string; finish: string; minutes: number } => {
    if (hours || isLocalDateTime(t.startDate)) {
      const minutes = t.type === 'MILESTONE' ? 0 : t.durationHours !== undefined ? Math.round(t.durationHours * 60) : cal.workingMinutesBetween(t.startDate, t.endDate);
      return { start: t.startDate, finish: t.endDate, minutes };
    }
    const start = cal.nextWorkingMinute(`${t.startDate}T00:00`);
    if (t.type === 'MILESTONE' || t.durationDays <= 0) return { start, finish: start, minutes: 0 };
    const nextDay = new Date(Date.parse(`${t.endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const finish = cal.prevWorkingEnd(`${nextDay}T00:00`);
    return { start, finish, minutes: cal.workingMinutesBetween(start, finish) };
  };
  const uid = new Map(p.tasks.map((t, i) => [t.id, i + 1]));
  const resources = [...new Set(p.tasks.map((t) => t.assigneeName).filter((n): n is string => !!n))];
  const resUid = new Map(resources.map((n, i) => [n, i + 1]));
  const first = p.calendar.workingHours[0]?.start ?? '09:00';
  const last = p.calendar.workingHours[p.calendar.workingHours.length - 1]?.end ?? '18:00';
  const working = 7 - p.calendar.weekendDays.length;
  const spans = p.tasks.map(span);
  const finishAll = spans.reduce<string | null>((m, s) => (m === null || s.finish > m ? s.finish : m), null) ?? `${p.startDate}T${first}`;

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<Project xmlns="http://schemas.microsoft.com/project">');
  out.push(tag('SaveVersion', 14), tag('Name', `${p.name}.xml`), tag('Title', p.name));
  if (p.createdAt) out.push(tag('CreationDate', p.createdAt.toISOString().slice(0, 19)));
  out.push(tag('ScheduleFromStart', 1), tag('StartDate', xmlDateTime(cal.nextWorkingMinute(`${p.startDate}T00:00`))), tag('FinishDate', xmlDateTime(finishAll)));
  out.push(tag('CalendarUID', 1), tag('DefaultStartTime', `${first}:00`), tag('DefaultFinishTime', `${last === '24:00' ? '23:59' : last}:00`));
  out.push(tag('MinutesPerDay', mpd), tag('MinutesPerWeek', mpd * Math.max(1, working)), tag('DaysPerMonth', 20));
  out.push(tag('DurationFormat', hours ? 5 : 7), tag('WorkFormat', 2), tag('CurrencyCode', p.currencyCode ?? 'SAR'), tag('WeekStartDay', 0));

  // Calendar.
  out.push('<Calendars><Calendar>', tag('UID', 1), tag('Name', p.calendar.name), tag('IsBaseCalendar', 1), '<WeekDays>');
  for (let d = 0; d < 7; d++) {
    const off = p.calendar.weekendDays.includes(d);
    out.push('<WeekDay>', tag('DayType', d + 1), tag('DayWorking', off ? 0 : 1));
    if (!off) out.push(workingTimesXml(p.calendar.workingHours));
    out.push('</WeekDay>');
  }
  out.push('</WeekDays>');
  if (p.calendar.exceptions.length) {
    out.push('<Exceptions>');
    for (const e of p.calendar.exceptions) {
      out.push(
        '<Exception>',
        tag('EnteredByOccurrences', 0),
        `<TimePeriod>${tag('FromDate', `${e.date}T00:00:00`)}${tag('ToDate', `${e.date}T23:59:00`)}</TimePeriod>`,
        tag('Occurrences', 1),
        tag('Name', e.name),
        tag('Type', 1),
        tag('DayWorking', e.isWorking ? 1 : 0),
      );
      if (e.isWorking) out.push(workingTimesXml(e.workingHours ?? p.calendar.workingHours));
      out.push('</Exception>');
    }
    out.push('</Exceptions>');
  }
  out.push('</Calendar></Calendars>');

  // Tasks (UID 0 = the project summary task, as MS Project writes it).
  out.push('<Tasks>');
  out.push('<Task>', tag('UID', 0), tag('ID', 0), tag('Name', p.name), tag('OutlineNumber', '0'), tag('OutlineLevel', 0), tag('Summary', 1), '</Task>');
  p.tasks.forEach((t, i) => {
    const s = spans[i]!;
    out.push(
      '<Task>',
      tag('UID', i + 1),
      tag('ID', i + 1),
      tag('Name', t.name),
      tag('Type', 1),
      tag('WBS', t.wbs),
      tag('OutlineNumber', t.wbs),
      tag('OutlineLevel', t.wbs ? t.wbs.split('.').length : 1),
      tag('Start', xmlDateTime(s.start)),
      tag('Finish', xmlDateTime(s.finish)),
      tag('Duration', isoDuration(s.minutes)),
      tag('DurationFormat', hours ? 5 : 7),
      tag('Milestone', t.type === 'MILESTONE' ? 1 : 0),
      tag('Summary', t.type === 'GROUP' ? 1 : 0),
      tag('PercentComplete', Math.round(t.progress)),
      tag('Cost', Math.round(t.plannedCost * 100)),
      tag('ActualCost', Math.round(t.actualCost * 100)),
      t.deadline ? tag('Deadline', `${t.deadline}T${last === '24:00' ? '23:59' : last}:00`) : '',
      t.notes ? tag('Notes', t.notes) : '',
    );
    for (const d of p.deps) {
      if (d.successorId !== t.id) continue;
      const pred = uid.get(d.predecessorId);
      if (!pred) continue;
      const lagMinutes = hours ? d.lagMinutes : d.lagDays * mpd;
      out.push(
        '<PredecessorLink>',
        tag('PredecessorUID', pred),
        tag('Type', LINK_CODES[d.type]),
        tag('CrossProject', 0),
        tag('LinkLag', Math.round(lagMinutes * 10)),
        tag('LagFormat', hours ? 5 : 7),
        '</PredecessorLink>',
      );
    }
    out.push('</Task>');
  });
  out.push('</Tasks>');

  out.push('<Resources>');
  for (const name of resources) out.push('<Resource>', tag('UID', resUid.get(name)!), tag('ID', resUid.get(name)!), tag('Name', name), tag('Type', 1), '</Resource>');
  out.push('</Resources>');
  out.push('<Assignments>');
  let a = 1;
  p.tasks.forEach((t, i) => {
    if (!t.assigneeName || t.type === 'GROUP') return;
    out.push('<Assignment>', tag('UID', a++), tag('TaskUID', i + 1), tag('ResourceUID', resUid.get(t.assigneeName)!), tag('Units', 1), '</Assignment>');
  });
  out.push('</Assignments>');
  out.push('</Project>');
  return out.join('');
}

function workingTimesXml(hours: readonly WorkingHours[]): string {
  return `<WorkingTimes>${hours
    .map((h) => `<WorkingTime>${tag('FromTime', `${h.start}:00`)}${tag('ToTime', `${h.end === '24:00' ? '00:00' : h.end}:00`)}</WorkingTime>`)
    .join('')}</WorkingTimes>`;
}
