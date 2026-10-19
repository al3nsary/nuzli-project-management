/**
 * A10 — GanttPRO (ADR-124, ADR-125). GanttPRO's «Export → Excel» writes one sheet named after the
 * project: rows 1–4 a banner (slogan, project name + export time), the header on row 5, one row
 * per task, a blank row and a footer line. Columns: Color (the bar colour is the cell FILL of
 * column A), WBS Number, the task name in C..G (merged from the column of its level to G),
 * Assigned to, Planned start/end (UTC), Deadline, Progress (%), Duration (hours), Estimated hours,
 * Time log (minutes), Status, Priority, Task description, Predecessor (WBS numbers), Budget,
 * Actual cost, Created, Creator, Type (project / tasks group / task / milestone), Project
 * (the path of ancestors) and Level.
 *
 * `detectGanttpro` recognises the layout (also in Arabic/Russian locales and our own export),
 * `ganttproToDraft` turns it into an ImportDraft, `inferCalendar` rebuilds the working hours
 * from the task times, and `writeGanttpro` exports a project in the same layout (plus a hidden
 * «Nozoly calendar» sheet so a round trip keeps the calendar exactly).
 */
import { Workbook } from 'exceljs';
import { WorkCalendar, type WorkingHours } from '@nuzli/scheduling';
import type { DependencyType, Priority, TaskStatus, TaskType } from '@nuzli/shared';
import { DEFAULT_WORKING_HOURS, MIN_TASK_MINUTES, RIYADH_OFFSET_MS, type Unit } from '../projects/task-engine';
import {
  cleanText,
  emptyDraft,
  headerKey,
  normalizeWbs,
  parentsFromLevels,
  parentsFromWbs,
  parseDateValue,
  parseMoney,
  parseNumber,
  parsePredecessors,
  parseProgress,
  parseStatus,
  warn,
  type DraftCalendar,
  type DraftTask,
  type ImportDraft,
} from './import-model';
import type { TableCell, TableRow } from './tabular';

export type GpField =
  | 'color'
  | 'wbs'
  | 'name'
  | 'assigned'
  | 'start'
  | 'end'
  | 'deadline'
  | 'progress'
  | 'duration'
  | 'estimated'
  | 'timelog'
  | 'status'
  | 'priority'
  | 'description'
  | 'predecessor'
  | 'budget'
  | 'actualCost'
  | 'created'
  | 'creator'
  | 'type'
  | 'project'
  | 'level';

/** The English headers GanttPRO writes, in column order (C–F are blank: the name spans C..G). */
export const GANTTPRO_COLUMNS: ReadonlyArray<[GpField | null, string]> = [
  ['color', 'Color'],
  ['wbs', 'WBS Number'],
  [null, ''],
  [null, ''],
  [null, ''],
  [null, ''],
  ['name', 'Task name / Title'],
  ['assigned', 'Assigned to'],
  ['start', 'Planned start date'],
  ['end', 'Planned end date'],
  ['deadline', 'Deadline'],
  ['progress', 'Progress (%)'],
  ['duration', 'Duration (hours)'],
  ['estimated', 'Estimated hours'],
  ['timelog', 'Time log (minutes)'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['description', 'Task description'],
  ['predecessor', 'Predecessor'],
  ['budget', 'Budget'],
  ['actualCost', 'Actual cost'],
  ['created', 'Created'],
  ['creator', 'Creator'],
  ['type', 'Type'],
  ['project', 'Project'],
  ['level', 'Level'],
];

/** 0-based column of each field in GanttPRO's layout (the fallback when a header is unknown). */
export const GP_POSITION: Record<GpField, number> = Object.fromEntries(
  GANTTPRO_COLUMNS.map(([f], i) => [f, i]).filter(([f]) => f !== null),
) as Record<GpField, number>;

/** Header synonyms: English (GanttPRO), Arabic, Russian, and a few other GanttPRO locales. */
const GP_SYNONYMS: Record<GpField, string[]> = {
  color: ['color', 'colour', 'اللون', 'لون', 'цвет', 'farbe', 'couleur'],
  wbs: ['wbs number', 'wbs', 'رقم wbs', 'ترقيم wbs', 'номер wbs', 'wbs номер', 'wbs-nummer', 'numéro wbs', 'número wbs'],
  name: ['task name / title', 'task name', 'title', 'اسم المهمة / العنوان', 'اسم المهمة', 'المهمة', 'название задачи / заголовок', 'название задачи', 'название', 'aufgabenname', 'nom de la tâche', 'nombre de la tarea'],
  assigned: ['assigned to', 'assignee', 'assignees', 'مسند إلى', 'المسند إليه', 'المكلف', 'назначено', 'исполнитель', 'исполнители', 'zugewiesen an', 'assigné à', 'asignado a'],
  start: ['planned start date', 'start date', 'تاريخ البدء المخطط', 'تاريخ البداية المخطط', 'تاريخ البدء', 'плановая дата начала', 'дата начала', 'geplantes startdatum', 'date de début prévue', 'fecha de inicio planificada'],
  end: ['planned end date', 'end date', 'تاريخ الانتهاء المخطط', 'تاريخ النهاية المخطط', 'تاريخ الانتهاء', 'плановая дата окончания', 'дата окончания', 'geplantes enddatum', 'date de fin prévue', 'fecha de finalización planificada'],
  deadline: ['deadline', 'الموعد النهائي', 'дедлайн', 'крайний срок', 'frist', 'échéance', 'fecha límite'],
  progress: ['progress (%)', 'progress', 'التقدم (%)', 'نسبة الإنجاز', 'التقدم', 'прогресс (%)', 'прогресс', 'fortschritt (%)', 'progression (%)', 'progreso (%)'],
  duration: ['duration (hours)', 'duration', 'المدة (ساعات)', 'المدة', 'длительность (часы)', 'длительность', 'dauer (stunden)', 'durée (heures)', 'duración (horas)'],
  estimated: ['estimated hours', 'estimation', 'الساعات المقدرة', 'التقدير', 'оценка (часы)', 'оценка', 'geschätzte stunden', 'heures estimées', 'horas estimadas'],
  timelog: ['time log (minutes)', 'time log', 'سجل الوقت (دقائق)', 'سجل الوقت', 'учет времени (минуты)', 'учет времени', 'zeiterfassung (minuten)', 'suivi du temps (minutes)', 'registro de tiempo (minutos)'],
  status: ['status', 'الحالة', 'статус', 'statut', 'estado'],
  priority: ['priority', 'الأولوية', 'приоритет', 'priorität', 'priorité', 'prioridad'],
  description: ['task description', 'description', 'وصف المهمة', 'الوصف', 'описание задачи', 'описание', 'aufgabenbeschreibung', 'description de la tâche', 'descripción de la tarea'],
  predecessor: ['predecessor', 'predecessors', 'السابقة', 'المهام السابقة', 'предшественник', 'предшественники', 'vorgänger', 'prédécesseur', 'predecesor'],
  budget: ['budget', 'الميزانية', 'бюджет', 'presupuesto'],
  actualCost: ['actual cost', 'التكلفة الفعلية', 'фактическая стоимость', 'tatsächliche kosten', 'coût réel', 'costo real'],
  created: ['created', 'تاريخ الإنشاء', 'أنشئت', 'создано', 'erstellt', 'créé', 'creado'],
  creator: ['creator', 'المنشئ', 'создатель', 'ersteller', 'créateur', 'creador'],
  type: ['type', 'النوع', 'тип', 'typ', 'tipo'],
  project: ['project', 'المشروع', 'проект', 'projekt', 'projet', 'proyecto'],
  level: ['level', 'المستوى', 'уровень', 'ebene', 'niveau', 'nivel'],
};

const GP_INDEX: Map<string, GpField> = (() => {
  const m = new Map<string, GpField>();
  for (const [f, words] of Object.entries(GP_SYNONYMS) as Array<[GpField, string[]]>) {
    for (const w of words) if (!m.has(headerKey(w))) m.set(headerKey(w), f);
  }
  return m;
})();

/** Row types: GanttPRO's words in its locales (compared after `headerKey`). */
const TYPE_WORDS: Array<['project' | 'group' | 'task' | 'milestone', string[]]> = [
  ['project', ['project', 'проект', 'مشروع', 'projekt', 'projet', 'proyecto', 'progetto', 'projeto']],
  ['group', ['tasks group', 'task group', 'group', 'группа задач', 'группа', 'مجموعة مهام', 'مجموعة', 'aufgabengruppe', 'groupe de tâches', 'grupo de tareas']],
  ['milestone', ['milestone', 'веха', 'معلم', 'meilenstein', 'jalon', 'hito']],
  ['task', ['task', 'задача', 'مهمة', 'aufgabe', 'tâche', 'tarea']],
];
const TYPE_INDEX = new Map(TYPE_WORDS.flatMap(([t, ws]) => ws.map((w) => [headerKey(w), t] as const)));

const STATUS_MAP = new Map<string, TaskStatus>(
  (
    [
      ['open', 'NOT_STARTED'],
      ['to do', 'NOT_STARTED'],
      ['открыт', 'NOT_STARTED'],
      ['открыта', 'NOT_STARTED'],
      ['مفتوح', 'NOT_STARTED'],
      ['مفتوحة', 'NOT_STARTED'],
      ['in progress', 'IN_PROGRESS'],
      ['в работе', 'IN_PROGRESS'],
      ['قيد التنفيذ', 'IN_PROGRESS'],
      ['done', 'DONE'],
      ['closed', 'DONE'],
      ['выполнено', 'DONE'],
      ['закрыт', 'DONE'],
      ['закрыта', 'DONE'],
      ['منجز', 'DONE'],
      ['مغلق', 'DONE'],
      ['on hold', 'ON_HOLD'],
      ['paused', 'ON_HOLD'],
      ['на паузе', 'ON_HOLD'],
      ['معلق', 'ON_HOLD'],
    ] as Array<[string, TaskStatus]>
  ).map(([w, s]) => [headerKey(w), s]),
);

const PRIORITY_MAP = new Map<string, Priority>(
  (
    [
      ['lowest', 'LOW'],
      ['low', 'LOW'],
      ['medium', 'MEDIUM'],
      ['normal', 'MEDIUM'],
      ['high', 'HIGH'],
      ['highest', 'URGENT'],
      ['самый низкий', 'LOW'],
      ['низкий', 'LOW'],
      ['средний', 'MEDIUM'],
      ['высокий', 'HIGH'],
      ['самый высокий', 'URGENT'],
      ['الأدنى', 'LOW'],
      ['منخفضة', 'LOW'],
      ['متوسطة', 'MEDIUM'],
      ['عالية', 'HIGH'],
      ['الأعلى', 'URGENT'],
      ['عاجلة', 'URGENT'],
    ] as Array<[string, Priority]>
  ).map(([w, p]) => [headerKey(w), p]),
);

/** Our export's vocabulary (status / priority back to GanttPRO's words). */
export const GP_STATUS_WORD: Record<TaskStatus, string> = { NOT_STARTED: 'Open', IN_PROGRESS: 'In progress', DONE: 'Done', ON_HOLD: 'On hold' };
export const GP_PRIORITY_WORD: Record<Priority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Highest' };

/** The hidden sheet our export adds (calendar and unit); GanttPRO reads the first sheet only. */
export const NOZOLY_CALENDAR_SHEET = 'Nozoly calendar';
export const NOZOLY_FOOTER = 'Exported from Nozoly';
export const NOZOLY_BANNER = 'Nozoly — نزلي لإدارة المشاريع';
const FOOTER_RE = /ganttpro\.com|created with the help of|exported from nozoly/i;

export interface GanttproLayout {
  /** 0-based index of the header row. */
  headerRow: number;
  cols: Partial<Record<GpField, number>>;
  /** The columns holding the name (C..G), left to right. */
  nameCols: number[];
}

const text = (c: TableCell | undefined): string => (c?.v === null || c?.v === undefined ? '' : c.v instanceof Date ? '' : String(c.v).trim());

function mapHeader(row: TableRow): Partial<Record<GpField, number>> {
  const cols: Partial<Record<GpField, number>> = {};
  row.forEach((c, i) => {
    const t = text(c);
    if (!t) return;
    const f = GP_INDEX.get(headerKey(t));
    if (f && cols[f] === undefined) cols[f] = i;
  });
  return cols;
}

/**
 * The GanttPRO layout, or null. A header row (in the first 15) must name the WBS and task-name
 * columns plus three of Type/Level/Project/start/end/duration — or the rows above it mention
 * GanttPRO/Nozoly. Fields whose header is not recognised fall back to GanttPRO's column positions.
 */
export function detectGanttpro(rows: TableRow[]): GanttproLayout | null {
  const limit = Math.min(rows.length, 15);
  const bannerMentions = (upTo: number) => rows.slice(0, upTo).some((r) => r.some((c) => /ganttpro|nozoly/i.test(text(c))));
  for (let i = 0; i < limit; i++) {
    const cols = mapHeader(rows[i]!);
    if (cols.wbs === undefined || cols.name === undefined) continue;
    const marks = (['type', 'level', 'project', 'start', 'end', 'duration'] as GpField[]).filter((f) => cols[f] !== undefined).length;
    if (marks >= 3 || bannerMentions(i)) return finish(rows, i, cols);
  }
  // Fully localised headers we do not know: GanttPRO's banner, then a row of at least 20 header
  // cells followed by a row whose column B is a WBS number.
  if (!bannerMentions(limit)) return null;
  for (let i = 1; i < limit; i++) {
    const filled = rows[i]!.filter((c) => text(c)).length;
    const next = rows[i + 1];
    if (filled >= 20 && next && /^\d+(\.\d+)*$/.test(text(next[GP_POSITION.wbs]))) return finish(rows, i, {});
  }
  return null;
}

function finish(rows: TableRow[], headerRow: number, found: Partial<Record<GpField, number>>): GanttproLayout {
  const cols = { ...found };
  const header = rows[headerRow]!;
  const used = new Set(Object.values(cols));
  for (const [f, pos] of Object.entries(GP_POSITION) as Array<[GpField, number]>) {
    if (cols[f] !== undefined || used.has(pos)) continue;
    // A position is borrowed only when its header cell is blank or unknown to the synonyms table.
    const h = text(header[pos]);
    if (h && GP_INDEX.has(headerKey(h))) continue;
    if (!h && f !== 'name' && pos >= header.length) continue;
    cols[f] = pos;
    used.add(pos);
  }
  const name = cols.name!;
  const wbs = cols.wbs;
  const first = wbs !== undefined && wbs < name && name - wbs <= 10 ? wbs + 1 : name;
  const nameCols: number[] = [];
  for (let c = first; c <= name; c++) nameCols.push(c);
  return { headerRow, cols, nameCols };
}

// ─────────────────────────────────────────── values

const pad = (n: number): string => String(n).padStart(2, '0');

/** A GanttPRO date cell (UTC) → Riyadh local `YYYY-MM-DDTHH:MM`. */
export function utcCellToLocal(v: unknown): string | null {
  let ms: number | null = null;
  if (v instanceof Date) ms = Number.isNaN(v.getTime()) ? null : v.getTime();
  else if (v !== null && v !== undefined && v !== '') {
    const p = parseDateValue(v, 'MDY'); // GanttPRO writes US dates when it writes text
    if (p) ms = Date.parse(p.length === 10 ? `${p}T00:00:00Z` : `${p}:00Z`);
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 16);
}

/** Deadlines are days: GanttPRO writes the end of the day in UTC (23:58Z), so the UTC date is kept. */
export function deadlineOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const p = parseDateValue(v, 'MDY');
  return p ? p.slice(0, 10) : null;
}

/** `FF50C7D6` (ARGB) or `#50c7d6` → `#50C7D6`. */
export function argbToHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^#/, '');
  if (/^[0-9A-Fa-f]{8}$/.test(s)) return `#${s.slice(2).toUpperCase()}`;
  if (/^[0-9A-Fa-f]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  return null;
}

/** Multi-line text with links kept as written (whitespace inside lines collapsed). */
function cleanMultiline(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v instanceof Date) return null;
  const s = String(v)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// ─────────────────────────────────────────── calendar

const toMin = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export interface CalendarSample {
  /** Local `YYYY-MM-DDTHH:MM`. */
  start: string;
  end: string;
  /** Working minutes the file states. */
  minutes: number;
}

export interface InferredCalendar {
  weekendDays: number[];
  workingHours: WorkingHours[];
  /** Samples whose working minutes on this calendar equal the stated duration (±1 minute). */
  matched: number;
  total: number;
  /** False when the samples did not support any calendar better than the default. */
  inferred: boolean;
}

/**
 * Working hours and weekend from the task times: the day starts at the earliest frequent start
 * time and ends at the latest frequent end time; whole-day tasks give the working minutes per day,
 * and the difference to the span is a break placed where it explains the most durations (nearest
 * 13:00 on a tie). Weekend = weekdays no task starts or ends on (1–3 of them), else Fri/Sat. The
 * default (Fri/Sat, 09–13 and 14–18) is kept unless a candidate explains at least half the tasks.
 */
export function inferCalendar(samples: ReadonlyArray<CalendarSample>, observedDays: ReadonlyArray<string> = []): InferredCalendar {
  const usable = samples.filter((s) => s.minutes > 0 && s.start.length >= 16 && s.end.length >= 16 && s.end > s.start).slice(0, 2000);
  const fallback = (matched = 0): InferredCalendar => ({ weekendDays: [5, 6], workingHours: [...DEFAULT_WORKING_HOURS], matched, total: usable.length, inferred: false });
  if (usable.length < 3) return fallback();
  const count = (vals: string[]) => {
    const m = new Map<string, number>();
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const threshold = Math.max(2, Math.ceil(usable.length * 0.05));
  const starts = count(usable.map((s) => s.start.slice(11, 16)));
  const ends = count(usable.map((s) => s.end.slice(11, 16)));
  const frequent = (m: Map<string, number>) => [...m].filter(([, n]) => n >= threshold).map(([k]) => k).sort();
  const mode = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  const dayStart = toMin(frequent(starts)[0] ?? mode(starts));
  const fe = frequent(ends);
  const dayEnd = toMin(fe[fe.length - 1] ?? mode(ends));
  if (dayEnd - dayStart < 60) return fallback();
  const span = dayEnd - dayStart;
  const whole = usable.filter((s) => s.start.slice(0, 10) === s.end.slice(0, 10) && toMin(s.start.slice(11, 16)) === dayStart && toMin(s.end.slice(11, 16)) === dayEnd);
  const perDay = whole.length ? Number(mode(count(whole.map((s) => String(s.minutes))))) : span;
  const breakLen = perDay > 0 && perDay < span ? span - perDay : 0;

  // Weekend candidates.
  const dows = new Set<number>();
  for (const d of [...usable.flatMap((s) => [s.start, s.end]), ...observedDays]) dows.add(new Date(`${d.slice(0, 10)}T00:00:00Z`).getUTCDay());
  const unseen = [0, 1, 2, 3, 4, 5, 6].filter((d) => !dows.has(d));
  const weekends: number[][] = [];
  if (unseen.length >= 1 && unseen.length <= 3) weekends.push(unseen);
  if (!weekends.some((w) => w.join() === '5,6')) weekends.push([5, 6]);
  if (unseen.length === 0) weekends.push([]);

  const hourSets: WorkingHours[][] = [];
  if (!breakLen) hourSets.push([{ start: toHm(dayStart), end: toHm(dayEnd) }]);
  else {
    const options: number[] = [];
    for (let b = dayStart + 30; b + breakLen <= dayEnd - 30; b += 15) options.push(b);
    options.sort((a, b) => Math.abs(a - 780) - Math.abs(b - 780) || a - b);
    for (const b of options) hourSets.push([{ start: toHm(dayStart), end: toHm(b) }, { start: toHm(b + breakLen), end: toHm(dayEnd) }]);
  }

  let best: InferredCalendar | null = null;
  for (const weekendDays of weekends) {
    for (const workingHours of hourSets) {
      let cal: WorkCalendar;
      try {
        cal = new WorkCalendar({ weekendDays, workingHours });
      } catch {
        continue;
      }
      let matched = 0;
      for (const s of usable) if (Math.abs(cal.workingMinutesBetween(s.start, s.end) - s.minutes) <= 1) matched++;
      if (!best || matched > best.matched) best = { weekendDays, workingHours, matched, total: usable.length, inferred: true };
    }
  }
  // The default calendar must be beaten, not tied.
  const def = new WorkCalendar({ weekendDays: [5, 6], workingHours: DEFAULT_WORKING_HOURS });
  const defMatched = usable.filter((s) => Math.abs(def.workingMinutesBetween(s.start, s.end) - s.minutes) <= 1).length;
  if (!best || best.matched <= defMatched || best.matched * 2 < usable.length) return fallback(defMatched);
  return best;
}

/** The hidden calendar sheet of our own export: weekend, working hours, exceptions, unit. */
export function readCalendarSheet(rows: TableRow[] | null | undefined): { calendar: DraftCalendar; unit: Unit | null } | null {
  if (!rows?.length) return null;
  const cal: DraftCalendar = { exceptions: [] };
  let unit: Unit | null = null;
  const hours = (s: string): WorkingHours[] | null => {
    const out: WorkingHours[] = [];
    for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
      const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(part);
      if (!m) return null;
      out.push({ start: m[1]!, end: m[2]! });
    }
    return out;
  };
  for (const r of rows) {
    const k = text(r[0]);
    const v = text(r[1]);
    if (k === 'name' && v) cal.name = v.slice(0, 80);
    else if (k === 'weekendDays') {
      const days = v ? v.split(',').map((d) => Number(d.trim())) : [];
      if (days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) cal.weekendDays = days;
    } else if (k === 'workingHours') {
      const h = hours(v);
      if (h?.length) cal.workingHours = h;
    } else if (k === 'durationUnit' && (v === 'DAY' || v === 'HOUR')) unit = v;
    else if (k === 'exception' && /^\d{4}-\d{2}-\d{2}$/.test(v) && cal.exceptions!.length < 1000) {
      const isWorking = text(r[2]) === '1';
      const h = hours(text(r[4]));
      cal.exceptions!.push({ date: v, isWorking, name: (text(r[3]) || 'استثناء').slice(0, 120), ...(isWorking && h?.length ? { workingHours: h } : {}) });
    }
  }
  if (!cal.workingHours || !cal.weekendDays) return null;
  try {
    new WorkCalendar({ weekendDays: cal.weekendDays, workingHours: cal.workingHours });
  } catch {
    return null;
  }
  return { calendar: cal, unit };
}

// ─────────────────────────────────────────── parser

interface GpRow {
  row: number;
  wbs: string | null;
  level: number | null;
  kind: 'project' | 'group' | 'task' | 'milestone';
  task: DraftTask;
  preds: unknown;
}

/**
 * GanttPRO rows → draft (HOUR unless our own export says DAY). Banner, blank rows and the footer
 * are skipped; the hierarchy comes from the WBS numbers (Level is cross-checked); dates are UTC
 * → Riyadh; the calendar comes from our calendar sheet, else is inferred from the task times.
 */
export function ganttproToDraft(
  rows: TableRow[],
  layout: GanttproLayout,
  opts: { sheetName?: string; calendarRows?: TableRow[] | null } = {},
): ImportDraft {
  const draft = emptyDraft();
  draft.detectedFormat = 'ganttpro';
  const { cols, nameCols } = layout;
  const cell = (r: TableRow, f: GpField): TableCell | undefined => (cols[f] === undefined ? undefined : r[cols[f]!]);
  const value = (r: TableRow, f: GpField): unknown => cell(r, f)?.v ?? null;

  // Project name: the banner line just above the header (GanttPRO row 4), else the sheet name.
  let bannerName: string | null = null;
  for (let i = layout.headerRow - 1; i >= 0 && !bannerName; i--) {
    const t = rows[i]!.map(text).find((s) => s && !/ganttpro|create professional|nozoly/i.test(s));
    if (t) bannerName = t;
  }
  draft.projectName = cleanText(bannerName ?? opts.sheetName, 160);

  const out: GpRow[] = [];
  const sourceTypes: Record<string, number> = {};
  let estimated = 0;
  let timeLog = 0;
  let unknownStatus = 0;
  let unknownPriority = 0;
  let unknownType = 0;
  for (let i = layout.headerRow + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const rowNo = i + 1;
    const wbs = cleanText(value(r, 'wbs'), 60);
    const name = nameCols.map((c) => cleanText(r[c]?.v instanceof Date ? null : r[c]?.v, 300)).find((n) => !!n) ?? null;
    const typeRaw = cleanText(value(r, 'type'), 60);
    if (r.some((c) => FOOTER_RE.test(text(c))) && !(wbs && /^\d/.test(wbs))) continue; // the footer line
    if (!wbs && !name && !typeRaw) continue; // blank row
    if (!name) {
      warn(draft, 'ROW_SKIPPED', `الصف ${rowNo} بلا اسم مهمة فتُرك.`, { row: rowNo });
      continue;
    }
    if (out.length >= 5000 + 1) break; // buildPreview reports IMPORT_TOO_MANY_TASKS
    const typeKey = typeRaw ? TYPE_INDEX.get(headerKey(typeRaw)) : undefined;
    if (typeRaw) sourceTypes[typeRaw] = (sourceTypes[typeRaw] ?? 0) + 1;
    if (typeRaw && !typeKey) unknownType++;
    const kind = typeKey ?? 'task';
    const statusRaw = cleanText(value(r, 'status'), 60);
    let status: TaskStatus | null = null;
    if (statusRaw) {
      status = STATUS_MAP.get(headerKey(statusRaw)) ?? parseStatus(statusRaw);
      if (!status && kind !== 'project' && kind !== 'group') {
        unknownStatus++;
        status = 'NOT_STARTED';
      }
    }
    const priorityRaw = cleanText(value(r, 'priority'), 60);
    let priority: Priority | null = null;
    if (priorityRaw) {
      priority = PRIORITY_MAP.get(headerKey(priorityRaw)) ?? null;
      if (!priority) unknownPriority++;
    }
    const hours = parseNumber(value(r, 'duration'));
    const est = parseNumber(value(r, 'estimated'));
    if (est && est > 0 && kind !== 'project' && kind !== 'group') estimated += est;
    const tl = parseNumber(value(r, 'timelog'));
    if (tl && tl > 0 && kind !== 'project' && kind !== 'group') timeLog += tl;
    const assigned = typeof value(r, 'assigned') === 'string' ? (value(r, 'assigned') as string) : null;
    const names = assigned ? assigned.split(/[,;،\n]/).map((s) => s.trim()).filter(Boolean) : [];
    if (names.length > 1) warn(draft, 'ASSIGNEE_MULTIPLE', `«${name.slice(0, 60)}» مسندة إلى أكثر من شخص؛ استُعمل «${names[0]!.slice(0, 60)}» (تُسند المهمة لمشرف واحد).`, { row: rowNo });
    const progressCell = cell(r, 'progress');
    const colorCell = cell(r, 'color');
    const lvl = parseNumber(value(r, 'level'));
    out.push({
      row: rowNo,
      wbs,
      level: lvl !== null && lvl >= 1 ? Math.trunc(lvl) : null,
      kind,
      preds: value(r, 'predecessor'),
      task: {
        key: `r${rowNo}`,
        sourceId: wbs ?? String(rowNo),
        name,
        parentKey: null,
        summary: kind === 'project' || kind === 'group',
        milestone: kind === 'milestone',
        start: utcCellToLocal(value(r, 'start')),
        end: utcCellToLocal(value(r, 'end')),
        durationMinutes: kind === 'milestone' ? 0 : hours !== null && hours >= 0 ? Math.round(hours * 60) : null,
        durationDays: null,
        progress: parseProgress(progressCell?.v ?? null, !!progressCell?.percent),
        status,
        assigneeName: cleanText(names[0] ?? null, 200),
        plannedCost: parseMoney(value(r, 'budget')),
        actualCost: parseMoney(value(r, 'actualCost')),
        deadline: deadlineOf(value(r, 'deadline')),
        notes: cleanMultiline(value(r, 'description'), 8000),
        priority,
        barColor: argbToHex(colorCell?.fill ?? (typeof colorCell?.v === 'string' ? colorCell.v : null)),
      },
    });
  }
  if (unknownType) warn(draft, 'TYPE_UNKNOWN', `${unknownType} صفًّا بنوع غير معروف عوملت كمهام.`);
  if (unknownStatus) warn(draft, 'STATUS_UNKNOWN', `${unknownStatus} مهمة بحالة غير معروفة صارت «لم تبدأ».`);
  if (unknownPriority) warn(draft, 'PRIORITY_UNKNOWN', `${unknownPriority} مهمة بأولوية غير معروفة صارت «متوسطة».`);
  const tiny = out.filter((x) => x.kind === 'task' && x.task.durationMinutes != null && x.task.durationMinutes > 0 && x.task.durationMinutes < MIN_TASK_MINUTES).length;
  if (tiny) warn(draft, 'DURATION_ROUNDED', `${tiny} مهمة أقصر من ${MIN_TASK_MINUTES} دقيقة صارت ${MIN_TASK_MINUTES} دقيقة (أقلّ مدة في المشروع).`);
  if (estimated > 0 || timeLog > 0) {
    warn(draft, 'ESTIMATES_NOT_IMPORTED', `«الساعات المقدّرة» (${Math.round(estimated * 100) / 100} ساعة) و«سجل الوقت» (${Math.round(timeLog)} دقيقة) لا تُستورد؛ سجّل الوقت في المشروع بعد الاستيراد.`);
  }
  draft.sourceStats = { sourceTypes, estimatedHours: Math.round(estimated * 100) / 100, timeLogMinutes: Math.round(timeLog) };

  // Hierarchy: WBS numbers (authoritative), Level when a row has no WBS; mismatches reported.
  const parents = out.some((x) => x.wbs)
    ? parentsFromWbs(out.map((x) => x.wbs))
    : parentsFromLevels(out.map((x) => x.level ?? 1));
  let mismatched = 0;
  out.forEach((x, i) => {
    const p = parents[i];
    x.task.parentKey = p === null || p === undefined ? null : out[p]!.task.key;
    if (x.wbs && x.level !== null && normalizeWbs(x.wbs).split('.').length !== x.level) mismatched++;
  });
  if (mismatched) warn(draft, 'LEVEL_MISMATCH', `${mismatched} صفًّا يختلف مستواه عن رقم WBS؛ اعتُمد رقم WBS.`);

  // A single level-1 «project» row named like the project is the project itself.
  const roots = out.filter((x) => x.task.parentKey === null);
  const projectRows = roots.filter((x) => x.kind === 'project');
  const sameName = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  let dropped: GpRow | null = null;
  if (roots.length === 1 && projectRows.length === 1 && (sameName(projectRows[0]!.task.name, opts.sheetName) || sameName(projectRows[0]!.task.name, bannerName))) {
    dropped = projectRows[0]!;
    draft.projectName = dropped.task.name.slice(0, 160);
    for (const x of out) if (x.task.parentKey === dropped.task.key) x.task.parentKey = null;
    warn(draft, 'PROJECT_ROOT_USED', `الصف «${dropped.task.name.slice(0, 60)}» هو المشروع نفسه فصار اسمَ المشروع ولم يُستورد كمهمة.`, { row: dropped.row });
  }
  const kept = out.filter((x) => x !== dropped);

  // Predecessors by WBS number.
  const byWbs = new Map<string, string>();
  for (const x of kept) if (x.wbs) byWbs.set(normalizeWbs(x.wbs), x.task.key);
  for (const x of kept) {
    const raw = x.preds === null || x.preds === undefined ? '' : String(x.preds).replace(/[()]/g, ' ');
    const { items, bad } = parsePredecessors(raw);
    for (const b of bad) warn(draft, 'PREDECESSOR_MISSING', `السابقة «${b.slice(0, 40)}» في الصف ${x.row} غير مفهومة.`, { row: x.row });
    for (const it of items) {
      const key = byWbs.get(normalizeWbs(it.ref));
      if (!key) {
        warn(draft, 'PREDECESSOR_MISSING', `السابقة «${it.ref}» في الصف ${x.row} لا تطابق أي مهمة.`, { row: x.row });
        continue;
      }
      draft.deps.push({ predKey: key, succKey: x.task.key, type: it.type as DependencyType, ...(it.lagMinutes !== undefined ? { lagMinutes: it.lagMinutes } : {}), ...(it.lagDays !== undefined ? { lagDays: it.lagDays } : {}) });
    }
  }
  draft.tasks = kept.map((x) => x.task);

  // Calendar and unit.
  const own = readCalendarSheet(opts.calendarRows);
  if (own) {
    draft.calendar = own.calendar;
    draft.unit = own.unit ?? 'HOUR';
  } else {
    draft.unit = 'HOUR';
    const leaves = kept.filter((x) => x.kind === 'task');
    const inferred = inferCalendar(
      leaves.filter((x) => x.task.start && x.task.end && x.task.durationMinutes).map((x) => ({ start: x.task.start!, end: x.task.end!, minutes: x.task.durationMinutes! })),
      kept.filter((x) => x.kind === 'milestone' && x.task.start).map((x) => x.task.start!),
    );
    draft.calendar = { name: 'تقويم GanttPRO', weekendDays: inferred.weekendDays, workingHours: inferred.workingHours, exceptions: [] };
    const hoursText = inferred.workingHours.map((h) => `${h.start}–${h.end}`).join(' و');
    warn(
      draft,
      'CALENDAR_DEFAULTED',
      inferred.inferred
        ? `ملف GanttPRO لا يحمل التقويم، فاستُنتج من أوقات المهام: ساعات العمل ${hoursText}، والعطلة ${weekendText(inferred.weekendDays)} (يطابق ${inferred.matched} من ${inferred.total} مهمة). راجعه بعد الاستيراد.`
        : `ملف GanttPRO لا يحمل التقويم ولم يمكن استنتاجه من أوقات المهام، فاستُعمل الافتراضي: ${hoursText}، والعطلة الجمعة والسبت.`,
    );
  }
  return draft;
}

const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const weekendText = (days: number[]): string => (days.length ? days.map((d) => DAY_NAMES[d]).join(' و') : 'لا عطلة');

// ─────────────────────────────────────────── writer

export interface GanttproExportTask {
  id: string;
  parentId: string | null;
  wbs: string;
  name: string;
  type: TaskType;
  /** `YYYY-MM-DD` (DAY) or local `YYYY-MM-DDTHH:MM` (HOUR). */
  startDate: string;
  endDate: string;
  durationDays: number;
  durationHours?: number;
  progress: number;
  status: TaskStatus;
  priority: Priority;
  assigneeName: string | null;
  description: string | null;
  plannedCost: number;
  actualCost: number;
  deadline: string | null;
  barColor: string | null;
}

export interface GanttproExport {
  name: string;
  unit: Unit;
  calendar: { name: string; weekendDays: number[]; workingHours: WorkingHours[]; exceptions: Array<{ date: string; isWorking: boolean; name: string; workingHours?: WorkingHours[] | null }> };
  tasks: GanttproExportTask[];
  deps: Array<{ predecessorId: string; successorId: string; type: DependencyType; lagDays: number; lagMinutes: number }>;
  generatedAt: Date;
}

const BANNER_FILL = 'FF00564C';
const HEADER_FILL = 'FFDAFFF0';
const COL_WIDTHS = [3, 11, 3, 3, 3, 3, 30, 16, 17, 17, 12, 11, 12, 12, 12, 12, 11, 30, 14, 11, 11, 12, 12, 12, 30, 8];
const DATETIME_FMT = 'yyyy-mm-dd hh:mm';

/** Riyadh local `YYYY-MM-DDTHH:MM` → the UTC instant GanttPRO writes. */
const utcOf = (local: string): Date => new Date(Date.parse(`${local.slice(0, 16)}:00Z`) - RIYADH_OFFSET_MS);

/** Excel sheet names: ≤ 31 characters, none of `[]:*?/\`. */
export function sheetNameOf(name: string): string {
  const s = name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
  return s && s !== NOZOLY_CALENDAR_SHEET ? s : 'Project';
}

/**
 * The project as GanttPRO lays out its Excel export: banner rows 1–4, English headers on row 5,
 * one row per task in WBS order (colour fill in A, the name merged from its level's column to G,
 * UTC dates, hours, GanttPRO statuses/priorities, predecessor WBS numbers with type and lag when
 * they are not plain FS), a blank row and the footer «Exported from Nozoly». Level-1 groups are
 * «project», deeper groups «tasks group». RTL sheet view and no frozen panes (CLAUDE.md rule 5).
 * A hidden «Nozoly calendar» sheet carries the calendar and unit for an exact round trip.
 */
export async function writeGanttpro(p: GanttproExport): Promise<Buffer> {
  const cal = new WorkCalendar({
    weekendDays: p.calendar.weekendDays,
    workingHours: p.calendar.workingHours,
    exceptions: p.calendar.exceptions.map((e) => ({ date: e.date, isWorking: e.isWorking, ...(e.workingHours ? { workingHours: e.workingHours } : {}) })),
  });
  const hours = p.unit === 'HOUR';
  const span = (t: GanttproExportTask): { start: string; end: string; minutes: number } => {
    if (hours || t.startDate.length > 10) {
      const minutes = t.type === 'MILESTONE' ? 0 : t.durationHours !== undefined ? Math.round(t.durationHours * 60) : cal.workingMinutesBetween(t.startDate, t.endDate);
      return { start: t.startDate.slice(0, 16), end: t.type === 'MILESTONE' ? t.startDate.slice(0, 16) : t.endDate.slice(0, 16), minutes };
    }
    const start = cal.nextWorkingMinute(`${t.startDate}T00:00`);
    if (t.type === 'MILESTONE' || t.durationDays <= 0) return { start, end: start, minutes: 0 };
    const nextDay = new Date(Date.parse(`${t.endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const end = cal.prevWorkingEnd(`${nextDay}T00:00`);
    return { start, end, minutes: cal.workingMinutesBetween(start, end) };
  };

  const wb = new Workbook();
  wb.creator = 'Nozoly';
  wb.created = p.generatedAt;
  const ws = wb.addWorksheet(sheetNameOf(p.name), { views: [{ rightToLeft: true }] });
  COL_WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const banner = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANNER_FILL } } as const;
  const white = { size: 11, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
  for (let r = 1; r <= 4; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 26; c++) {
      const cell = row.getCell(c);
      cell.value = '';
      cell.fill = banner;
      cell.font = white;
    }
  }
  ws.mergeCells('A1:K3');
  ws.mergeCells('L2:Z2');
  ws.getCell('L2').value = NOZOLY_BANNER;
  ws.getCell('L2').alignment = { horizontal: 'right', vertical: 'middle' };
  ws.mergeCells('A4:M4');
  ws.getCell('A4').value = p.name;
  ws.getCell('A4').font = { ...white, bold: true, size: 14 };
  ws.mergeCells('N4:Z4');
  ws.getCell('N4').value = p.generatedAt;
  ws.getCell('N4').numFmt = DATETIME_FMT;
  ws.getCell('N4').alignment = { horizontal: 'right', vertical: 'middle' };

  const header = ws.getRow(5);
  GANTTPRO_COLUMNS.forEach(([, h], i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9, color: { argb: 'FF222222' }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  });

  const sorted = [...p.tasks].sort((a, b) => cmpWbs(a.wbs, b.wbs));
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const pathOf = (t: GanttproExportTask): string[] => {
    const out: string[] = [];
    for (let cur = t.parentId ? byId.get(t.parentId) : undefined, guard = 0; cur && guard < 100; guard++) {
      out.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return [p.name, ...out];
  };
  const lagText = (minutes: number, days: number): string => {
    if (hours) {
      if (!minutes) return '';
      const h = Math.round((Math.abs(minutes) / 60) * 100) / 100;
      return `${minutes < 0 ? '-' : '+'}${h}h`;
    }
    return days ? `${days < 0 ? '-' : '+'}${Math.abs(days)}d` : '';
  };
  const predText = (t: GanttproExportTask): string =>
    p.deps
      .filter((d) => d.successorId === t.id && byId.has(d.predecessorId))
      .map((d) => {
        const lag = lagText(d.lagMinutes, d.lagDays);
        return `${byId.get(d.predecessorId)!.wbs}${d.type !== 'FS' || lag ? d.type : ''}${lag}`;
      })
      .join(', ');

  let r = 6;
  for (const t of sorted) {
    const row = ws.getRow(r);
    const level = t.wbs ? t.wbs.split('.').length : 1;
    const s = span(t);
    const leaf = t.type !== 'GROUP';
    const type = t.type === 'MILESTONE' ? 'milestone' : t.type === 'GROUP' ? (level === 1 ? 'project' : 'tasks group') : 'task';
    const values: unknown[] = [
      '',
      t.wbs,
      '',
      '',
      '',
      '',
      '',
      t.assigneeName ?? '',
      utcOf(s.start),
      utcOf(s.end),
      t.deadline ? new Date(`${t.deadline}T23:59:00Z`) : '',
      Math.round(t.progress * 100) / 100,
      Math.round((s.minutes / 60) * 100) / 100,
      leaf ? 0 : '',
      leaf ? 0 : '',
      leaf ? GP_STATUS_WORD[t.status] : '',
      leaf ? GP_PRIORITY_WORD[t.priority] : '',
      t.description ? t.description : '',
      predText(t),
      t.plannedCost || '',
      t.actualCost || '',
      '',
      '',
      type,
      pathOf(t).join(' / '),
      level,
    ];
    values.forEach((v, i) => (row.getCell(i + 1).value = v as never));
    // The name: from the column of its level (C = 1 … G = 5) merged to G; deeper levels indent in G.
    const col = Math.min(level, 5) + 2;
    row.getCell(col).value = t.name;
    row.getCell(col).font = { bold: !leaf, size: 11, name: 'Calibri' };
    if (level > 5) row.getCell(col).alignment = { indent: level - 5 };
    if (col < 7) ws.mergeCells(r, col, r, 7);
    const fill = t.barColor && /^#[0-9A-Fa-f]{6}$/.test(t.barColor) ? `FF${t.barColor.slice(1).toUpperCase()}` : null;
    if (fill) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    for (const c of [9, 10, 11]) row.getCell(c).numFmt = DATETIME_FMT;
    r++;
  }
  r++; // a blank row, like GanttPRO
  ws.mergeCells(r, 1, r, 26);
  ws.getCell(r, 1).value = NOZOLY_FOOTER;
  ws.getCell(r, 1).font = { size: 11, color: { argb: 'FF888888' }, name: 'Calibri' };

  const calWs = wb.addWorksheet(NOZOLY_CALENDAR_SHEET, { state: 'hidden', views: [{ rightToLeft: true }] });
  const hoursOf = (h: readonly WorkingHours[]) => h.map((x) => `${x.start}-${x.end}`).join(',');
  calWs.addRow(['name', p.calendar.name]);
  calWs.addRow(['durationUnit', p.unit]);
  calWs.addRow(['weekendDays', p.calendar.weekendDays.join(',')]);
  calWs.addRow(['workingHours', hoursOf(p.calendar.workingHours)]);
  for (const e of p.calendar.exceptions.slice(0, 1000)) calWs.addRow(['exception', e.date, e.isWorking ? '1' : '0', e.name, e.workingHours ? hoursOf(e.workingHours) : '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
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

