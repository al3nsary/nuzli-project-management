/**
 * A9 imports — Excel (.xlsx via exceljs) and CSV (papaparse): header mapping with Arabic and
 * English synonyms, outline from WBS codes, an outline-level column or indentation, tolerant
 * dates, durations and predecessors (docs/imports.md lists every accepted column name).
 */
import { Worker } from 'node:worker_threads';
import Papa from 'papaparse';
import { AppError } from '../common/app-error';
import { inspectZip } from '../storage/zip-guard';
import {
  cleanText,
  emptyDraft,
  headerKey,
  MAX_IMPORT_TASKS,
  normalizeWbs,
  parentsFromLevels,
  parentsFromWbs,
  parseDateValue,
  parseDuration,
  parseMoney,
  parseNumber,
  parsePredecessors,
  parseProgress,
  parseStatus,
  warn,
  type DraftTask,
  type ImportDraft,
} from './import-model';

export type Field =
  | 'name'
  | 'id'
  | 'wbs'
  | 'level'
  | 'start'
  | 'finish'
  | 'duration'
  | 'assignee'
  | 'status'
  | 'progress'
  | 'predecessors'
  | 'cost'
  | 'actualCost'
  | 'deadline'
  | 'notes'
  | 'type';

/** Accepted header names per field (compared after `headerKey` normalisation). */
export const HEADER_SYNONYMS: Record<Field, string[]> = {
  name: ['اسم المهمة', 'المهمة', 'مهمة', 'اسم النشاط', 'النشاط', 'البند', 'العنوان', 'task name', 'task', 'name', 'title', 'activity', 'activity name', 'summary', 'item'],
  id: ['id', 'المعرف', 'الرقم', 'رقم', 'رقم المهمة', 'م', 'task id', 'unique id', '#', 'no'],
  wbs: ['wbs', 'رقم wbs', 'الترقيم', 'رمز wbs', 'outline number', 'wbs code'],
  level: ['المستوى', 'مستوى', 'مستوى المخطط', 'مستوى المخطط التفصيلي', 'outline level', 'level', 'indent'],
  start: ['البداية', 'تاريخ البداية', 'بداية', 'يبدا', 'تبدا', 'البدء', 'تاريخ البدء', 'start', 'start date', 'begin', 'begin date', 'starts'],
  finish: ['النهاية', 'تاريخ النهاية', 'نهاية', 'ينتهي', 'تنتهي', 'الانتهاء', 'تاريخ الانتهاء', 'finish', 'finish date', 'end', 'end date', 'ends'],
  duration: ['المدة', 'مدة', 'المدة بالايام', 'المدة ايام', 'المدة بالساعات', 'المدة ساعات', 'duration', 'duration days', 'duration hours', 'days', 'hours'],
  assignee: ['المسؤول', 'المسوول', 'المسند اليه', 'المكلف', 'المنفذ', 'الموارد', 'اسماء الموارد', 'assigned', 'assigned to', 'assignee', 'owner', 'resource names', 'resources', 'resource', 'responsible'],
  status: ['الحالة', 'حالة', 'status', 'state'],
  progress: ['التقدم', 'نسبة الانجاز', 'الانجاز', 'نسبة الاكتمال', 'progress', 'complete', 'percent complete', 'complete percent', '% complete', 'done'],
  predecessors: ['السابقة', 'السابقات', 'المهام السابقة', 'المهام السابقه', 'الاعتماديات', 'تعتمد على', 'predecessors', 'predecessor', 'depends on', 'dependencies', 'dependency'],
  cost: ['التكلفة', 'التكلفة المخططة', 'الميزانية', 'الكلفة', 'cost', 'planned cost', 'budget', 'budgeted cost'],
  actualCost: ['التكلفة الفعلية', 'الكلفة الفعلية', 'actual cost'],
  deadline: ['الموعد النهائي', 'موعد نهائي', 'الموعد', 'deadline', 'due', 'due date'],
  notes: ['ملاحظات', 'الملاحظات', 'الوصف', 'وصف', 'notes', 'note', 'description', 'comments'],
  type: ['النوع', 'نوع', 'معلم', 'type', 'milestone', 'kind'],
};

const SYNONYM_INDEX: Map<string, Field> = (() => {
  const m = new Map<string, Field>();
  for (const [field, words] of Object.entries(HEADER_SYNONYMS) as Array<[Field, string[]]>) {
    for (const w of words) if (!m.has(headerKey(w))) m.set(headerKey(w), field);
  }
  return m;
})();

/** The field a header names, or null. Exact synonym first, then a few safe prefixes. */
export function fieldOfHeader(h: string): Field | null {
  const k = headerKey(h);
  if (!k) return null;
  const exact = SYNONYM_INDEX.get(k);
  if (exact) return exact;
  // Keys are normalised (ة → ه): «المدة (أيام عمل)» → «المده ايام عمل».
  if (/^(المده|مده|duration)/.test(k)) return 'duration';
  if (/^(تاريخ البدا|البدا|start)/.test(k)) return 'start';
  if (/^(تاريخ النهاي|النهاي|finish|end )/.test(k)) return 'finish';
  if (/^(اسم المهم|task name)/.test(k)) return 'name';
  return null;
}

/** One cell as the parsers need it. */
export interface TableCell {
  v: unknown;
  /** Indentation level of the cell (xlsx alignment indent, CSV leading spaces). */
  indent?: number;
  /** The cell shows a percentage (xlsx number format with %). */
  percent?: boolean;
}

export type TableRow = TableCell[];

// ─────────────────────────────────────────── readers

/** Columns read per row (security review A9 M3): anything further right is ignored. */
export const MAX_IMPORT_COLUMNS = 200;
/** Spreadsheet rows considered at all (row numbers above this are ignored, as before). */
export const MAX_IMPORT_ROW_NUMBER = 100_000;
/** Non-empty rows read: the task limit plus room for a title block and the header row. */
export const MAX_IMPORT_ROWS = MAX_IMPORT_TASKS + 16;

export interface XlsxReadOptions {
  /** Hard deadline for the parse (the worker is terminated). */
  timeoutMs?: number;
  /** V8 old-generation heap of the parsing worker. */
  maxOldGenerationSizeMb?: number;
  maxRows?: number;
}

/**
 * The parsing worker (plain JavaScript run with `eval`, so it behaves the same from `dist` and
 * under ts-jest). It loads the workbook with exceljs, iterates only real cells
 * (`eachRow` / `eachCell` without empties, security review M3), caps columns and rows, and posts
 * plain rows back. When no sheet is named it first posts the first 15 rows of every sheet and
 * waits for the main thread to pick one (the header detection lives in TypeScript).
 */
const XLSX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { Workbook } = require(workerData.exceljsPath);
function plain(v) {
  if (v === null || v === undefined) return null;
  // Dates cross the thread boundary as epoch milliseconds (revived in denseRows).
  if (v instanceof Date) return { $date: v.getTime() };
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    return null;
  }
  return v;
}
function rowsOf(ws, maxRows) {
  const rows = [];
  let truncated = false;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (truncated || r > workerData.maxRowNumber) return;
    if (rows.length >= maxRows) { truncated = true; return; }
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (c > workerData.maxCols) return;
      while (cells.length < c - 1) cells.push({ v: null, indent: 0, percent: false });
      const fmt = cell.numFmt || '';
      cells.push({ v: plain(cell.value), indent: (cell.alignment && cell.alignment.indent) || 0, percent: fmt.includes('%') });
    });
    rows.push({ r, cells });
  });
  return { rows, truncated };
}
(async () => {
  const wb = new Workbook();
  try {
    await wb.xlsx.load(workerData.bytes);
  } catch (e) {
    parentPort.postMessage({ type: 'invalid' });
    return;
  }
  const sheets = wb.worksheets;
  if (!sheets.length) { parentPort.postMessage({ type: 'empty' }); return; }
  let idx = workerData.sheetName ? sheets.findIndex((s) => s.name === workerData.sheetName) : -1;
  if (idx < 0) {
    parentPort.postMessage({ type: 'heads', heads: sheets.map((s) => rowsOf(s, 15).rows) });
    idx = await new Promise((res) => parentPort.once('message', (m) => res(m.pick)));
  }
  const ws = sheets[idx] || sheets[0];
  const out = rowsOf(ws, workerData.maxRows);
  parentPort.postMessage({ type: 'rows', sheet: ws.name, rows: out.rows, truncated: out.truncated });
})();
`;

type SparseRow = { r: number; cells: TableRow };
type WorkerMsg =
  | { type: 'invalid' }
  | { type: 'empty' }
  | { type: 'heads'; heads: SparseRow[][] }
  | { type: 'rows'; sheet: string; rows: SparseRow[]; truncated: boolean };

/** Sparse worker rows → the dense table the mapper expects (index i = spreadsheet row i + 1). */
export function denseRows(rows: SparseRow[]): TableRow[] {
  const last = rows.reduce((m, x) => Math.max(m, x.r), 0);
  const out: TableRow[] = Array.from({ length: last }, () => []);
  for (const x of rows) {
    out[x.r - 1] = x.cells.map((c) => {
      const v = c.v as { $date?: unknown } | null;
      return v && typeof v === 'object' && typeof v.$date === 'number' ? { ...c, v: new Date(v.$date) } : c;
    });
  }
  return out;
}

/**
 * .xlsx → rows. Security review A9 M2/M3 (ADR-119): the ZIP is checked first (`inspectZip`:
 * at most 100 MB uncompressed and 2,000 entries, ratio at most 100, declared sizes verified), then
 * exceljs runs in a `worker_threads` worker with a heap limit and a deadline, so a hostile file
 * kills the worker, never the API process.
 */
export async function readXlsx(buf: Buffer, sheetName?: string, opts: XlsxReadOptions = {}): Promise<{ rows: TableRow[]; sheet: string }> {
  const verdict = inspectZip(buf);
  if (!verdict.ok) throw new AppError('IMPORT_FILE_INVALID', { reason: 'xlsx-limits', detail: verdict.reason });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const worker = new Worker(XLSX_WORKER_SOURCE, {
    eval: true,
    workerData: {
      exceljsPath: require.resolve('exceljs'),
      bytes,
      sheetName: sheetName ?? null,
      maxRows: opts.maxRows ?? MAX_IMPORT_ROWS,
      maxCols: MAX_IMPORT_COLUMNS,
      maxRowNumber: MAX_IMPORT_ROW_NUMBER,
    },
    transferList: [bytes.buffer],
    resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
  });
  const invalid = (reason: string) => new AppError('IMPORT_FILE_INVALID', { reason });
  try {
    const result = await new Promise<{ sheet: string; rows: SparseRow[]; truncated: boolean }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(() => reject(invalid('xlsx-timeout'))), timeoutMs);
      function finish(fn: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      }
      worker.on('message', (m: WorkerMsg) => {
        if (m.type === 'invalid') finish(() => reject(invalid('xlsx')));
        else if (m.type === 'empty') finish(() => reject(new AppError('IMPORT_NO_TASKS')));
        else if (m.type === 'heads') {
          // The first sheet with a task-name header in its first 15 rows.
          const pick = m.heads.findIndex((h) => headerRowIndex(denseRows(h)) >= 0);
          worker.postMessage({ pick: pick < 0 ? 0 : pick });
        } else finish(() => resolve(m));
      });
      // ERR_WORKER_OUT_OF_MEMORY, a stack overflow or any other crash of the parser.
      worker.on('error', () => finish(() => reject(invalid('xlsx-limits'))));
      worker.on('exit', (code) => finish(() => reject(invalid(code === 0 ? 'xlsx' : 'xlsx-limits'))));
    });
    if (result.truncated) throw new AppError('IMPORT_TOO_MANY_TASKS', { max: MAX_IMPORT_TASKS });
    return { rows: denseRows(result.rows), sheet: result.sheet };
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

/** CSV text (UTF-8 with or without BOM, or UTF-16 with a BOM); delimiter detected (`,` `;` tab). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return text.replace(/^﻿/, '');
}

export function readCsv(buf: Buffer): TableRow[] {
  const text = decodeText(buf);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
  if (parsed.errors.some((e) => e.type === 'Delimiter') && !parsed.data.length) throw new AppError('IMPORT_FILE_INVALID', { reason: 'csv' });
  // Security review A9 M3: rows capped at the task limit, columns at MAX_IMPORT_COLUMNS.
  if (parsed.data.length > MAX_IMPORT_ROWS) throw new AppError('IMPORT_TOO_MANY_TASKS', { max: MAX_IMPORT_TASKS });
  return parsed.data.map((r) =>
    r.slice(0, MAX_IMPORT_COLUMNS).map((raw) => {
      const lead = /^[ \t ]*/.exec(raw)?.[0] ?? '';
      const indent = lead.includes('\t') ? lead.split('\t').length - 1 : Math.floor(lead.length / 2);
      return { v: raw, indent };
    }),
  );
}

// ─────────────────────────────────────────── mapping

export function headerRowIndex(rows: TableRow[]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (rows[i]!.some((c) => typeof c.v === 'string' && fieldOfHeader(c.v) === 'name')) return i;
  }
  return -1;
}

export interface ColumnMap {
  fields: Partial<Record<Field, number>>;
  hoursHint: boolean;
}

export function mapColumns(header: TableRow): ColumnMap {
  const fields: Partial<Record<Field, number>> = {};
  let hoursHint = false;
  header.forEach((c, i) => {
    if (typeof c.v !== 'string' && typeof c.v !== 'number') return;
    const f = fieldOfHeader(String(c.v));
    if (!f || fields[f] !== undefined) return;
    fields[f] = i;
    if (f === 'duration' && /ساع|hour|hrs/.test(headerKey(String(c.v)))) hoursHint = true;
  });
  return { fields, hoursHint };
}

/**
 * Rows → draft. The header row is the first of the first 15 rows with a task-name column.
 * Parents: WBS codes, else an outline-level column, else indentation of the name cell.
 * Predecessors refer to the ID column when there is one, else to WBS codes or row numbers.
 */
export function tableToDraft(rows: TableRow[], opts: { dateOrder: 'DMY' | 'MDY'; minutesPerDay?: number }): ImportDraft {
  const draft = emptyDraft();
  const h = headerRowIndex(rows);
  if (h < 0) throw new AppError('IMPORT_NO_TASKS', { reason: 'no task-name column' });
  const { fields: col, hoursHint } = mapColumns(rows[h]!);
  draft.hoursHint = hoursHint;
  const cell = (r: TableRow, f: Field): TableCell | undefined => (col[f] === undefined ? undefined : r[col[f]!]);
  const value = (r: TableRow, f: Field): unknown => cell(r, f)?.v ?? null;
  const mpd = opts.minutesPerDay ?? 480;

  const tasks: DraftTask[] = [];
  const meta: Array<{ id: string | null; wbs: string | null; level: number | null; indent: number; preds: unknown; row: number }> = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const rowNo = i + 1;
    const nameCell = cell(r, 'name');
    const name = cleanText(nameCell?.v, 300);
    if (!name) {
      if (r.some((c) => c.v !== null && c.v !== undefined && String(c.v).trim() !== '')) {
        warn(draft, 'ROW_SKIPPED', `الصف ${rowNo} بلا اسم مهمة فتُرك.`, { row: rowNo });
      }
      continue;
    }
    if (String(nameCell?.v ?? '').trim().length > 300) warn(draft, 'NAME_TRUNCATED', `اسم المهمة في الصف ${rowNo} أطول من ٣٠٠ حرف فقُصّ.`, { row: rowNo });
    const start = parseDateValue(value(r, 'start'), opts.dateOrder);
    const end = parseDateValue(value(r, 'finish'), opts.dateOrder);
    if (value(r, 'start') && !start) warn(draft, 'DATE_UNPARSED', `تاريخ البداية في الصف ${rowNo} غير مفهوم.`, { row: rowNo });
    if (value(r, 'finish') && !end) warn(draft, 'DATE_UNPARSED', `تاريخ النهاية في الصف ${rowNo} غير مفهوم.`, { row: rowNo });
    const rawDuration = value(r, 'duration');
    const dur = parseDuration(rawDuration, mpd, hoursHint ? 'h' : 'd');
    if (rawDuration !== null && rawDuration !== '' && !dur) warn(draft, 'DURATION_UNPARSED', `المدة في الصف ${rowNo} غير مفهومة.`, { row: rowNo });
    const typeWord = headerKey(String(value(r, 'type') ?? ''));
    const milestone = ['معلم', 'milestone', 'yes', 'نعم', 'true', '1'].includes(typeWord) && col.type !== undefined;
    const summary = ['مجموعه', 'مجموعة', 'summary', 'group', 'epic', 'ملخص'].includes(typeWord);
    const deadline = parseDateValue(value(r, 'deadline'), opts.dateOrder);
    const progressCell = cell(r, 'progress');
    const progress = parseProgress(progressCell?.v ?? null, !!progressCell?.percent);
    tasks.push({
      key: `r${rowNo}`,
      sourceId: cleanText(value(r, 'id'), 60) ?? cleanText(value(r, 'wbs'), 60) ?? String(rowNo),
      name,
      parentKey: null,
      summary,
      milestone,
      start,
      end,
      durationMinutes: dur?.minutes ?? null,
      durationDays: dur?.days ?? null,
      progress,
      status: parseStatus(value(r, 'status')),
      assigneeName: cleanText(firstName(value(r, 'assignee')), 200),
      plannedCost: parseMoney(value(r, 'cost')),
      actualCost: parseMoney(value(r, 'actualCost')),
      deadline: deadline ? deadline.slice(0, 10) : null,
      notes: cleanText(value(r, 'notes'), 8000),
    });
    const lvl = parseNumber(value(r, 'level'));
    meta.push({
      id: cleanText(value(r, 'id'), 60),
      wbs: cleanText(value(r, 'wbs'), 60),
      level: lvl !== null && lvl >= 0 ? lvl : null,
      indent: nameCell?.indent ?? 0,
      preds: value(r, 'predecessors'),
      row: rowNo,
    });
  }

  // Outline.
  let parents: Array<number | null>;
  if (meta.some((m) => m.wbs && normalizeWbs(m.wbs).includes('.'))) parents = parentsFromWbs(meta.map((m) => m.wbs));
  else if (meta.some((m) => m.level !== null && m.level > 1)) {
    // Outline level 0 (MS Project's project summary row) is treated like level 1.
    parents = parentsFromLevels(meta.map((m) => m.level ?? 1));
  } else if (meta.some((m) => m.indent > 0)) parents = parentsFromLevels(meta.map((m) => m.indent + 1));
  else parents = meta.map(() => null);
  tasks.forEach((t, i) => {
    const p = parents[i];
    t.parentKey = p === null || p === undefined ? null : tasks[p]!.key;
  });

  // Predecessor references.
  const byId = new Map<string, string>();
  const byWbs = new Map<string, string>();
  meta.forEach((m, i) => {
    if (m.id) byId.set(m.id.replace(/\.0+$/, ''), tasks[i]!.key);
    if (m.wbs) byWbs.set(normalizeWbs(m.wbs), tasks[i]!.key);
  });
  const hasIds = byId.size > 0;
  meta.forEach((m, i) => {
    const { items, bad } = parsePredecessors(m.preds);
    for (const b of bad) warn(draft, 'PREDECESSOR_MISSING', `السابقة «${b.slice(0, 40)}» في الصف ${m.row} غير مفهومة.`, { row: m.row });
    for (const it of items) {
      const ref = it.ref;
      let key: string | undefined;
      if (hasIds) key = byId.get(ref);
      if (!key && ref.includes('.')) key = byWbs.get(normalizeWbs(ref));
      if (!key && !hasIds && /^\d+$/.test(ref)) key = tasks[Number(ref) - 1]?.key;
      if (!key) key = byWbs.get(normalizeWbs(ref));
      if (!key) {
        warn(draft, 'PREDECESSOR_MISSING', `السابقة «${ref}» في الصف ${m.row} لا تطابق أي مهمة.`, { row: m.row });
        continue;
      }
      draft.deps.push({ predKey: key, succKey: tasks[i]!.key, type: it.type, ...(it.lagMinutes !== undefined ? { lagMinutes: it.lagMinutes } : {}), ...(it.lagDays !== undefined ? { lagDays: it.lagDays } : {}) });
    }
  });
  draft.tasks = tasks;
  return draft;
}

/** "أحمد; سعد" or "Ahmad[50%]" → the first name. */
function firstName(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return v.split(/[;,،]/)[0]!.replace(/\[[^\]]*\]/g, '').trim();
}
