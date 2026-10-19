/**
 * A9 imports (ADR-110): the format-neutral draft every parser produces, the tolerant value
 * parsers they share (dates, durations, predecessors, statuses, Arabic-Indic digits), and
 * `buildPreview`, which turns a draft into an engine-checked project preview.
 * Pure functions only — no Prisma, no I/O — so every rule is unit-tested directly.
 */
import { WorkCalendar, computeWbs, detectCycle, type WorkingHours } from '@nuzli/scheduling';
import {
  toWesternDigits,
  type DependencyType,
  type ImportCalendarDto,
  type ImportPreviewDependencyDto,
  type ImportPreviewTaskDto,
  type ImportWarningDto,
  type TaskStatus,
  type TaskType,
} from '@nuzli/shared';
import { AppError } from '../common/app-error';
import {
  DEFAULT_WORKING_HOURS,
  isLocalDateTime,
  minutesToHours,
  normalizeLeaf,
  recompute,
  riyadhToday,
  type StoredTask,
  type Unit,
} from '../projects/task-engine';

/** Hard cap of an import (also the batch size of the write path). */
export const MAX_IMPORT_TASKS = 5000;
/** Jira REST imports stop here (owner brief: max 2,000 issues). */
export const MAX_JIRA_ISSUES = 2000;

export interface DraftTask {
  /** Unique within the draft. */
  key: string;
  sourceId: string | null;
  name: string;
  parentKey: string | null;
  /** True when the source marked it as a summary/epic (it becomes a GROUP when it has children). */
  summary?: boolean;
  milestone?: boolean;
  /** `YYYY-MM-DD` or a local `YYYY-MM-DDTHH:MM`. */
  start: string | null;
  end: string | null;
  /** Working minutes, when the source gave a time-based duration. */
  durationMinutes?: number | null;
  /** Working days, when the source gave a day-based duration. */
  durationDays?: number | null;
  progress: number;
  status: TaskStatus | null;
  assigneeName: string | null;
  plannedCost: number;
  actualCost: number;
  deadline: string | null;
  notes: string | null;
}

export interface DraftDependency {
  predKey: string;
  succKey: string;
  type: DependencyType;
  /** Working minutes (time-based lag) or working days. */
  lagMinutes?: number;
  lagDays?: number;
}

export interface DraftCalendar {
  name?: string;
  weekendDays?: number[];
  workingHours?: WorkingHours[];
  exceptions?: Array<{ date: string; isWorking: boolean; name: string; workingHours?: WorkingHours[] | null }>;
}

export interface ImportDraft {
  projectName: string | null;
  startDate: string | null;
  /** The unit the source states (MSPDI hours); null = detect. */
  unit: Unit | null;
  /** The source said durations are in hours (a "Duration (hours)" column, hour units). */
  hoursHint?: boolean;
  calendar: DraftCalendar | null;
  tasks: DraftTask[];
  deps: DraftDependency[];
  warnings: ImportWarningDto[];
}

export function emptyDraft(): ImportDraft {
  return { projectName: null, startDate: null, unit: null, calendar: null, tasks: [], deps: [], warnings: [] };
}

export function warn(draft: { warnings: ImportWarningDto[] }, code: string, message_ar: string, at?: { row?: number; sourceId?: string }): void {
  if (draft.warnings.length >= 500) return;
  draft.warnings.push({ code, message_ar, ...(at?.row !== undefined ? { row: at.row } : {}), ...(at?.sourceId ? { sourceId: at.sourceId } : {}) });
}

// ─────────────────────────────────────────── text helpers

/** Arabic-Indic and Persian digits → ASCII, Arabic decimal/thousands separators → `.`/nothing. */
export function westernize(s: string): string {
  return toWesternDigits(s).replace(/٫/g, '.').replace(/٬/g, '').replace(/،/g, ',');
}

/** A header cell as a comparison key: lower case, no diacritics/tatweel/punctuation, single spaces. */
export function headerKey(s: string): string {
  return westernize(String(s))
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[()[\]{}:%#*_.\-/\\|"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = westernize(v).replace(/[^\d.,\-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseMoney(v: unknown): number {
  const n = parseNumber(v);
  if (n === null || n < 0) return 0;
  return Math.min(999_999_999_999.99, Math.round(n * 100) / 100);
}

/** 0–100. A spreadsheet fraction (0.5 from a percent cell) is passed with `fraction = true`. */
export function parseProgress(v: unknown, fraction = false): number {
  if (v === null || v === undefined || v === '') return 0;
  let n: number | null;
  if (typeof v === 'number') n = fraction && v <= 1 ? v * 100 : v;
  else {
    const s = westernize(String(v));
    n = parseNumber(s);
    if (n !== null && !s.includes('%') && n > 0 && n <= 1 && s.includes('.')) n *= 100;
  }
  if (n === null || !Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
}

const STATUS_WORDS: Array<[TaskStatus, string[]]> = [
  ['DONE', ['done', 'complete', 'completed', 'closed', 'resolved', 'finished', 'مكتمل', 'مكتمله', 'منجز', 'منجزه', 'منتهي', 'منتهيه', 'تمت', 'تم', 'مغلق', 'مغلقه']],
  ['IN_PROGRESS', ['in progress', 'inprogress', 'started', 'ongoing', 'in review', 'review', 'قيد التنفيذ', 'جاري', 'جاريه', 'قيد العمل', 'بدات', 'قيد المراجعه']],
  ['ON_HOLD', ['on hold', 'hold', 'blocked', 'paused', 'suspended', 'معلق', 'معلقه', 'متوقف', 'متوقفه', 'موقوف']],
  ['NOT_STARTED', ['not started', 'to do', 'todo', 'open', 'new', 'backlog', 'planned', 'لم تبدا', 'لم يبدا', 'جديد', 'جديده', 'مفتوح', 'مفتوحه']],
];

export function parseStatus(v: unknown): TaskStatus | null {
  const k = headerKey(String(v ?? ''));
  if (!k) return null;
  for (const [status, words] of STATUS_WORDS) if (words.includes(k)) return status;
  return null;
}

/** Status from the source or, when absent, from progress. */
export function statusOf(status: TaskStatus | null, progress: number): TaskStatus {
  if (status) return status;
  if (progress >= 100) return 'DONE';
  if (progress > 0) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

// ─────────────────────────────────────────── dates

const pad = (n: number): string => String(n).padStart(2, '0');

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function withTime(date: string | null, h?: string, mi?: string, ampm?: string): string | null {
  if (!date) return null;
  if (h === undefined) return date;
  let hh = Number(h);
  const mm = Number(mi ?? 0);
  if (ampm) {
    const pm = /p/i.test(ampm) || /م/.test(ampm);
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  if (hh > 24 || mm > 59) return date;
  if (hh === 24) hh = 23;
  if (hh === 0 && mm === 0) return date;
  return `${date}T${pad(hh)}:${pad(mm)}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, أبريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, أغسطس: 8, سبتمبر: 9, اكتوبر: 10, أكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
};

/** Excel serial date (1900 system) → local date or date-time. */
export function fromExcelSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 120000) return null;
  const ms = Math.round((n - 25569) * 86_400_000);
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const mins = Math.round((n % 1) * 1440);
  if (!mins || mins >= 1440) return date;
  return `${date}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

/**
 * Tolerant date parser → `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (local wall time), or null.
 * Accepts JS Dates (spreadsheet cells, read as UTC wall time), Excel serials, ISO, `YYYY/MM/DD`,
 * `DD/MM/YYYY` (or month first with `order = 'MDY'`), dots/dashes, 2-digit years, English and
 * Arabic month names, Jira's `19/Oct/26 10:30 AM`, MS Project's `Sun 19/10/26 08:00`, AM/PM
 * (also ص/م), and Arabic-Indic digits.
 */
export function parseDateValue(v: unknown, order: 'DMY' | 'MDY' = 'DMY'): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    return time === '00:00' ? date : `${date}T${time}`;
  }
  if (typeof v === 'number') return fromExcelSerial(v);
  let s = westernize(String(v)).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 20000 && n < 120000 ? fromExcelSerial(n) : null;
  }
  // Weekday prefixes (MS Project text exports) and commas.
  s = s.replace(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+/i, '').replace(/^(الاحد|الأحد|الاثنين|الإثنين|الثلاثاء|الاربعاء|الأربعاء|الخميس|الجمعة|السبت)\s+/, '');
  s = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const time = String.raw`(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm|AM|PM|ص|م)?)?(?:Z|[+-]\d{2}:?\d{2})?`;
  let m = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${time}$`).exec(s);
  if (m) return withTime(ymd(+m[1]!, +m[2]!, +m[3]!), m[4], m[5], m[6]);
  m = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})${time}$`).exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    let d = order === 'DMY' ? a : b;
    let mo = order === 'DMY' ? b : a;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return withTime(ymd(+m[3]!, mo, d), m[4], m[5], m[6]);
  }
  m = new RegExp(String.raw`^(\d{1,2})[-/ ]([A-Za-z؀-ۿ]+)\.?[-/ ](\d{2,4})${time}$`).exec(s);
  if (m && monthOf(m[2]!)) return withTime(ymd(+m[3]!, monthOf(m[2]!)!, +m[1]!), m[4], m[5], m[6]);
  m = new RegExp(String.raw`^([A-Za-z]+)\.? (\d{1,2}) (\d{4})${time}$`).exec(s);
  if (m && monthOf(m[1]!)) return withTime(ymd(+m[3]!, monthOf(m[1]!)!, +m[2]!), m[4], m[5], m[6]);
  return null;
}

function monthOf(word: string): number | null {
  return MONTHS[word] ?? MONTHS[word.toLowerCase().slice(0, 3)] ?? MONTHS[word.toLowerCase()] ?? null;
}

// ─────────────────────────────────────────── durations and lags

export interface ParsedDuration {
  minutes?: number;
  days?: number;
}

const UNIT_RE = String.raw`(mo|mon|mons|month|months|w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|e?d|اسبوع|أسبوع|اسابيع|أسابيع|يوم|ايام|أيام|ي|ساعه|ساعة|ساعات|س|دقيقه|دقيقة|دقائق|د|شهر|اشهر|أشهر)?`;

/**
 * `5`, `5d`, `5 days`, `٣ أيام`, `1.5w`, `4h`, `4 ساعات`, `30m`, `2 mons`, ISO `PT16H0M0S`.
 * Bare numbers are days unless `defaultUnit = 'h'`. Weeks = 5 days, months = 20 days.
 */
export function parseDuration(v: unknown, minutesPerDay = 480, defaultUnit: 'd' | 'h' = 'd'): ParsedDuration | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return defaultUnit === 'h' ? { minutes: Math.round(v * 60) } : { days: v };
  const s = westernize(String(v)).trim().toLowerCase().replace(/\?$/, '');
  const iso = parseIsoDuration(s);
  if (iso !== null) return { minutes: iso };
  const m = new RegExp(String.raw`^(\d+(?:\.\d+)?)\s*${UNIT_RE}$`).exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] ?? '').replace(/^e/, '');
  if (!u) return defaultUnit === 'h' ? { minutes: Math.round(n * 60) } : { days: n };
  if (/^(mo|mon|mons|month|months|شهر|اشهر|أشهر)$/.test(u)) return { days: n * 20 };
  if (/^(w|wk|wks|week|weeks|اسبوع|أسبوع|اسابيع|أسابيع)$/.test(u)) return { days: n * 5 };
  if (/^(d|day|days|يوم|ايام|أيام|ي)$/.test(u)) return { days: n };
  if (/^(h|hr|hrs|hour|hours|ساعه|ساعة|ساعات|س)$/.test(u)) return { minutes: Math.round(n * 60) };
  if (/^(m|min|mins|minute|minutes|دقيقه|دقيقة|دقائق|د)$/.test(u)) return { minutes: Math.round(n) };
  void minutesPerDay;
  return null;
}

/** ISO 8601 duration `PT16H30M0S` / `P2DT4H` → minutes (days of 24 h are not working days: P1D = 1440). */
export function parseIsoDuration(s: string): number | null {
  const m = /^-?p(?:(\d+(?:\.\d+)?)y)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/i.exec(s.trim());
  if (!m || s.trim().toLowerCase() === 'p' || s.trim().toLowerCase() === 'pt') return null;
  const [, , , d, h, mi, sec] = m;
  return Math.round(Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(mi ?? 0) + Number(sec ?? 0) / 60);
}

export interface ParsedPredecessor {
  ref: string;
  type: DependencyType;
  lagMinutes?: number;
  lagDays?: number;
}

/**
 * MS Project / spreadsheet predecessors: `5`, `3FS+2d`, `4SS-1 day`, `7FF+3h`, `2;5;9`, `3,4`,
 * `1.2.3FS` (WBS codes). Unknown pieces are returned in `bad`.
 */
export function parsePredecessors(v: unknown): { items: ParsedPredecessor[]; bad: string[] } {
  const items: ParsedPredecessor[] = [];
  const bad: string[] = [];
  if (v === null || v === undefined) return { items, bad };
  const s = westernize(String(v)).trim();
  if (!s) return { items, bad };
  for (const raw of s.split(/[;,،\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = new RegExp(String.raw`^([0-9][0-9.]*|[A-Za-z][A-Za-z0-9_]*-\d+)\s*(FS|SS|FF|SF|ف ب|ب ب|ن ن|ب ن)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*${UNIT_RE})?$`, 'i').exec(part);
    if (!m) {
      bad.push(part);
      continue;
    }
    const ref = m[1]!.replace(/\.$/, '');
    const t = (m[2] ?? 'FS').toUpperCase();
    const type = (['FS', 'SS', 'FF', 'SF'].includes(t) ? t : 'FS') as DependencyType;
    const item: ParsedPredecessor = { ref, type };
    if (m[3] && m[4]) {
      const d = parseDuration(`${m[4]}${m[5] ?? 'd'}`);
      const sign = m[3] === '-' ? -1 : 1;
      if (d?.minutes !== undefined) item.lagMinutes = sign * d.minutes;
      else if (d?.days !== undefined) item.lagDays = sign * d.days;
    }
    items.push(item);
  }
  return { items, bad };
}

// ─────────────────────────────────────────── outline

/**
 * Parents from outline levels (1 = root) in row order: each task's parent is the nearest
 * earlier task one level up. A jump of more than one level attaches to the deepest open one.
 */
export function parentsFromLevels(levels: ReadonlyArray<number>): Array<number | null> {
  const stack: Array<{ level: number; index: number }> = [];
  return levels.map((lvl, i) => {
    const level = Math.max(1, Math.trunc(lvl) || 1);
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1]!.index : null;
    stack.push({ level, index: i });
    return parent;
  });
}

/** Parents from WBS codes `1`, `1.2`, `1.2.3` (a code whose prefix is unknown falls back to levels). */
export function parentsFromWbs(codes: ReadonlyArray<string | null>): Array<number | null> {
  const byCode = new Map<string, number>();
  codes.forEach((c, i) => {
    if (c) byCode.set(normalizeWbs(c), i);
  });
  const levels = codes.map((c) => (c ? normalizeWbs(c).split('.').length : 1));
  const fallback = parentsFromLevels(levels);
  return codes.map((c, i) => {
    if (!c) return fallback[i]!;
    const parts = normalizeWbs(c).split('.');
    if (parts.length < 2) return null;
    const parent = byCode.get(parts.slice(0, -1).join('.'));
    return parent !== undefined && parent !== i ? parent : fallback[i]!;
  });
}

export const normalizeWbs = (c: string): string =>
  westernize(c)
    .trim()
    .replace(/\.+$/, '')
    .split('.')
    .map((p) => String(Number(p) || p))
    .join('.');

// ─────────────────────────────────────────── preview

export interface PreviewTask extends StoredTask {
  sourceId: string | null;
  assigneeName: string | null;
}

export interface PreviewPayload {
  version: 1;
  format: string;
  fileId: string | null;
  project: { name: string; startDate: string; durationUnit: Unit; calendar: ImportCalendarDto };
  tasks: PreviewTask[];
  deps: Array<{ predecessorId: string; successorId: string; type: DependencyType; lagDays: number; lagMinutes: number }>;
  warnings: ImportWarningDto[];
}

const workingFloor = (cal: WorkCalendar, d: string): string => cal.addWorkingDays(d.slice(0, 10), 0);

/** HOUR when forced or stated; else when any time of day, any time-based duration that is not whole days, or an hours hint. */
export function detectUnit(draft: ImportDraft, minutesPerDay: number, forced?: Unit): { unit: Unit; reason: string | null } {
  if (forced) return { unit: forced, reason: null };
  if (draft.unit) return { unit: draft.unit, reason: draft.unit === 'HOUR' ? 'المصدر يحدّد المدد بالساعات' : null };
  if (draft.hoursHint) return { unit: 'HOUR', reason: 'عمود المدة بالساعات' };
  for (const t of draft.tasks) {
    if (t.durationMinutes != null && t.durationMinutes > 0 && t.durationMinutes % minutesPerDay !== 0) {
      return { unit: 'HOUR', reason: `مدة «${t.name.slice(0, 40)}» ليست أيامًا كاملة` };
    }
  }
  return { unit: 'DAY', reason: null };
}

export function calendarOfDraft(draft: ImportDraft): { cal: WorkCalendar; dto: ImportCalendarDto; defaulted: boolean } {
  const c = draft.calendar;
  const weekendDays = c?.weekendDays && c.weekendDays.length < 7 ? [...new Set(c.weekendDays)].sort((a, b) => a - b) : [5, 6];
  let workingHours = c?.workingHours?.length ? c.workingHours : DEFAULT_WORKING_HOURS;
  const exceptions = (c?.exceptions ?? []).slice(0, 1000);
  let cal: WorkCalendar;
  try {
    cal = new WorkCalendar({ weekendDays, workingHours, exceptions: exceptions.map((e) => ({ ...e, workingHours: e.workingHours ?? undefined })) });
  } catch {
    workingHours = DEFAULT_WORKING_HOURS;
    cal = new WorkCalendar({ weekendDays, workingHours });
    return {
      cal,
      dto: { name: c?.name ?? 'تقويم مستورد', weekendDays, workingHours: [...workingHours], exceptions: [] },
      defaulted: true,
    };
  }
  return {
    cal,
    dto: { name: c?.name ?? 'تقويم مستورد', weekendDays, workingHours: [...workingHours], exceptions },
    defaulted: !c,
  };
}

/**
 * Turns a draft into an engine-checked preview: picks the unit, normalises every leaf
 * (start, duration, end on the imported calendar), promotes summaries with children to groups,
 * drops dependencies that are missing, duplicated or would form a cycle (with warnings), then
 * runs the scheduling engine (auto-schedule on) so the preview shows the dates the project will
 * really have. Throws IMPORT_NO_TASKS / IMPORT_TOO_MANY_TASKS.
 */
export function buildPreview(draft: ImportDraft, opts: { format: string; fileId: string | null; forcedUnit?: Unit; projectName?: string; fallbackName?: string; today?: string }): PreviewPayload {
  const tasksIn = draft.tasks.filter((t) => t.name);
  if (!tasksIn.length) throw new AppError('IMPORT_NO_TASKS');
  if (tasksIn.length > MAX_IMPORT_TASKS) throw new AppError('IMPORT_TOO_MANY_TASKS', { count: tasksIn.length, max: MAX_IMPORT_TASKS });
  const warnings = [...draft.warnings];
  const { cal, dto: calendar, defaulted } = calendarOfDraft(draft);
  if (defaulted && draft.calendar) warn({ warnings }, 'CALENDAR_DEFAULTED', 'تقويم الملف غير صالح، فاستُعمل التقويم الافتراضي (الجمعة والسبت عطلة، 09–13 و14–18).');
  const std = cal.standardMinutesPerDay;
  const { unit, reason } = detectUnit({ ...draft, tasks: tasksIn }, std, opts.forcedUnit);
  if (unit === 'HOUR' && reason && !opts.forcedUnit) warn({ warnings }, 'HOURS_DETECTED', `سيُنشأ المشروع بوحدة الساعات: ${reason}.`);

  const keys = new Set(tasksIn.map((t) => t.key));
  const byKey = new Map(tasksIn.map((t) => [t.key, t]));
  // Parents must exist and must not loop.
  for (const t of tasksIn) {
    if (t.parentKey && !keys.has(t.parentKey)) {
      warn({ warnings }, 'PARENT_MISSING', `المهمة الأم لـ«${t.name.slice(0, 60)}» غير موجودة، فأصبحت في المستوى الأعلى.`, { sourceId: t.sourceId ?? undefined });
      t.parentKey = null;
    }
  }
  for (const t of tasksIn) {
    const seen = new Set<string>([t.key]);
    let p = t.parentKey;
    while (p) {
      if (seen.has(p)) {
        t.parentKey = null;
        break;
      }
      seen.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
  }
  const parents = new Set(tasksIn.map((t) => t.parentKey).filter((p): p is string => !!p));

  // Project start: the stated one, else the earliest task start, else today (Riyadh).
  const starts = tasksIn.map((t) => t.start).filter((s): s is string => !!s).map((s) => s.slice(0, 10)).sort();
  const projectStart = workingFloor(cal, (draft.startDate ?? starts[0] ?? opts.today ?? riyadhToday()).slice(0, 10));

  const order = new Map<string | null, number>();
  const stored: PreviewTask[] = tasksIn.map((t) => {
    const parentKey = t.parentKey;
    const sortOrder = (order.get(parentKey) ?? 0) + 1;
    order.set(parentKey, sortOrder);
    const hasKids = parents.has(t.key);
    const milestone = !hasKids && (t.milestone || (t.durationMinutes === 0 && t.durationDays == null) || t.durationDays === 0);
    if (t.milestone && hasKids) warn({ warnings }, 'MILESTONE_DURATION', `«${t.name.slice(0, 60)}» معلَمٌ له مهامّ فرعية، فصار مجموعة.`);
    const type: TaskType = hasKids ? 'GROUP' : milestone ? 'MILESTONE' : 'TASK';
    const progress = Math.round(Math.min(100, Math.max(0, t.progress)) * 100) / 100;
    const base: PreviewTask = {
      id: t.key,
      projectId: 'preview',
      parentId: parentKey,
      sortOrder,
      wbsCache: '',
      name: t.name.slice(0, 300),
      type,
      startDate: projectStart,
      endDate: projectStart,
      durationDays: 1,
      progress,
      status: statusOf(t.status, progress),
      priority: 'MEDIUM',
      assigneeId: null,
      description: t.notes ? t.notes.slice(0, 8000) : null,
      version: 0,
      plannedCost: t.plannedCost,
      actualCost: t.actualCost,
      deadline: t.deadline ? t.deadline.slice(0, 10) : null,
      barColor: null,
      labelIds: [],
      sourceId: t.sourceId,
      assigneeName: t.assigneeName,
    };
    return leafSchedule(base, t, unit, cal, projectStart);
  });

  // Dependencies: known tasks, no duplicates, no self/ancestor links, no FS cycles.
  const ancestors = (key: string): Set<string> => {
    const out = new Set<string>();
    let p = byKey.get(key)?.parentKey ?? null;
    while (p && !out.has(p)) {
      out.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
    return out;
  };
  const deps: PreviewPayload['deps'] = [];
  const pairs = new Set<string>();
  let ignoredTypes = 0;
  for (const d of draft.deps) {
    const label = `${byKey.get(d.predKey)?.name ?? d.predKey} ← ${byKey.get(d.succKey)?.name ?? d.succKey}`.slice(0, 120);
    if (!keys.has(d.predKey) || !keys.has(d.succKey)) {
      warn({ warnings }, 'PREDECESSOR_MISSING', `ربطٌ بمهمة غير موجودة تُرك: ${label}.`);
      continue;
    }
    if (d.predKey === d.succKey || ancestors(d.succKey).has(d.predKey) || ancestors(d.predKey).has(d.succKey)) {
      warn({ warnings }, 'DEPENDENCY_CYCLE_DROPPED', `ربطٌ بين مهمة ومجموعتها تُرك: ${label}.`);
      continue;
    }
    const pair = `${d.predKey}>${d.succKey}`;
    if (pairs.has(pair)) {
      warn({ warnings }, 'DEPENDENCY_DUPLICATE', `ربطٌ مكرّر تُرك: ${label}.`);
      continue;
    }
    const lagMinutes = d.lagMinutes !== undefined ? Math.round(d.lagMinutes) : Math.round((d.lagDays ?? 0) * std);
    const lagDays = d.lagDays !== undefined ? Math.round(d.lagDays) : Math.round(lagMinutes / std);
    const candidate = { predecessorId: d.predKey, successorId: d.succKey, type: d.type, lagDays, lagMinutes };
    if (d.type === 'FS') {
      const fs = deps.filter((x) => x.type === 'FS');
      if (detectCycle(fs, { predecessorId: d.predKey, successorId: d.succKey })) {
        warn({ warnings }, 'DEPENDENCY_CYCLE_DROPPED', `ربطٌ يصنع حلقة تُرك: ${label}.`);
        continue;
      }
    } else ignoredTypes++;
    pairs.add(pair);
    deps.push(candidate);
  }
  if (ignoredTypes) {
    warn({ warnings }, 'DEPENDENCY_TYPE_IGNORED', `${ignoredTypes} ربطًا من نوع غير «انتهاء ← بداية» حُفظت كما هي لكنها لا تُحرّك المواعيد (المحرّك يجدول FS فقط).`);
  }

  let finals: PreviewTask[];
  try {
    finals = recompute({
      tasks: stored,
      dependencies: deps.map((d) => ({ ...d, ...(unit === 'HOUR' ? { lagHours: minutesToHours(d.lagMinutes) } : {}) })),
      calendar: cal,
      autoSchedule: true,
      durationUnit: unit,
    });
  } catch (err) {
    if (err instanceof AppError) throw new AppError('IMPORT_FILE_INVALID', { reason: err.code, details: err.details });
    throw err;
  }
  // A group without a stated status follows its rolled-up progress.
  const stated = new Set(tasksIn.filter((t) => t.status).map((t) => t.key));
  finals = finals.map((t) => (t.type === 'GROUP' && !stated.has(t.id) ? { ...t, status: statusOf(null, t.progress) } : t));
  const name = (opts.projectName ?? draft.projectName ?? opts.fallbackName ?? 'مشروع مستورد').slice(0, 160);
  return {
    version: 1,
    format: opts.format,
    fileId: opts.fileId,
    project: { name: name.length >= 2 ? name : 'مشروع مستورد', startDate: projectStart, durationUnit: unit, calendar },
    tasks: finals,
    deps,
    warnings,
  };
}

/** Start, duration and end of one task in the chosen unit (groups get a placeholder the engine rolls up). */
function leafSchedule(base: PreviewTask, t: DraftTask, unit: Unit, cal: WorkCalendar, projectStart: string): PreviewTask {
  const std = cal.standardMinutesPerDay;
  const start = t.start;
  const hasDuration = (t.durationDays != null && t.durationDays > 0) || (t.durationMinutes != null && t.durationMinutes > 0);
  if (unit === 'DAY') {
    let days: number;
    if (base.type === 'MILESTONE') days = 0;
    else if (t.durationDays != null && t.durationDays > 0) days = Math.max(1, Math.ceil(t.durationDays - 1e-9));
    else if (t.durationMinutes != null && t.durationMinutes > 0) days = Math.max(1, Math.ceil(t.durationMinutes / std - 1e-9));
    else if (start && t.end) days = Math.max(1, cal.workingDaysBetween(workingFloor(cal, start), t.end.slice(0, 10)));
    else days = 1;
    // Only an end (and a duration): count back from the end.
    const s =
      !start && t.end
        ? cal.addWorkingDays(cal.addWorkingDays(t.end.slice(0, 10), 0), -Math.max(0, days - 1))
        : workingFloor(cal, (start ?? projectStart).slice(0, 10));
    return normalizeLeaf({ ...base, startDate: s, endDate: s, durationDays: days }, cal, false, 'DAY');
  }
  const endLocal = t.end ? (isLocalDateTime(t.end) ? t.end : `${t.end}T23:59`) : null;
  let minutes: number;
  let s: string;
  if (start) s = cal.nextWorkingMinute(isLocalDateTime(start) ? start : `${start}T00:00`);
  else s = cal.nextWorkingMinute(`${projectStart}T00:00`);
  if (base.type === 'MILESTONE') minutes = 0;
  else if (t.durationMinutes != null && t.durationMinutes > 0) minutes = t.durationMinutes;
  else if (t.durationDays != null && t.durationDays > 0) minutes = Math.round(t.durationDays * std);
  else if (start && endLocal) minutes = Math.max(cal.workingMinutesBetween(s, endLocal), 0) || std;
  else minutes = std;
  if (!start && endLocal && (hasDuration || base.type === 'MILESTONE')) {
    s = cal.nextWorkingMinute(cal.addWorkingMinutes(cal.prevWorkingEnd(endLocal), -minutes));
  }
  return normalizeLeaf({ ...base, startDate: s, endDate: s, durationHours: minutesToHours(minutes), durationDays: 0 }, cal, false, 'HOUR');
}

/** Public preview rows (WBS from the engine's tree). */
export function previewTasksDto(p: PreviewPayload): ImportPreviewTaskDto[] {
  const wbs = computeWbs(p.tasks);
  const out = p.tasks.map((t) => ({
    ref: t.id,
    sourceId: t.sourceId,
    wbs: wbs.get(t.id) ?? '',
    parentRef: t.parentId,
    name: t.name,
    type: t.type,
    startDate: t.startDate,
    endDate: t.endDate,
    durationDays: t.durationDays,
    ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
    progress: t.progress,
    status: t.status,
    assigneeName: t.assigneeName,
    plannedCost: t.plannedCost,
    actualCost: t.actualCost,
    deadline: t.deadline,
    notes: t.description,
  }));
  return out.sort((a, b) => cmpWbs(a.wbs, b.wbs));
}

export function previewDepsDto(p: PreviewPayload): ImportPreviewDependencyDto[] {
  return p.deps.map((d) => ({
    predecessorRef: d.predecessorId,
    successorRef: d.successorId,
    type: d.type,
    lagDays: d.lagDays,
    ...(p.project.durationUnit === 'HOUR' ? { lagHours: minutesToHours(d.lagMinutes) } : {}),
  }));
}

function cmpWbs(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
