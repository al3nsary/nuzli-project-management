/**
 * A9 imports — Excel (.xlsx via exceljs) and CSV (papaparse): header mapping with Arabic and
 * English synonyms, outline from WBS codes, an outline-level column or indentation, tolerant
 * dates, durations and predecessors (docs/imports.md lists every accepted column name).
 */
import { Workbook, type CellValue, type Worksheet } from 'exceljs';
import Papa from 'papaparse';
import { AppError } from '../common/app-error';
import {
  cleanText,
  emptyDraft,
  headerKey,
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

function plainCellValue(v: CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return plainCellValue(o.result as CellValue);
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((r) => r.text).join('');
    if ('text' in o) return o.text;
    if ('error' in o) return null;
    return null;
  }
  return v;
}

export async function readXlsx(buf: Buffer, sheetName?: string): Promise<{ rows: TableRow[]; sheet: string }> {
  const wb = new Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new AppError('IMPORT_FILE_INVALID', { reason: 'xlsx' });
  }
  const sheets = wb.worksheets;
  if (!sheets.length) throw new AppError('IMPORT_NO_TASKS');
  let ws: Worksheet | undefined;
  if (sheetName) ws = wb.getWorksheet(sheetName);
  if (!ws) {
    // The first sheet with a task-name header in its first 15 rows.
    ws = sheets.find((s) => headerRowIndex(sheetRows(s, 15)) >= 0) ?? sheets[0];
  }
  return { rows: sheetRows(ws!, 100_000), sheet: ws!.name };
}

function sheetRows(ws: Worksheet, max: number): TableRow[] {
  const rows: TableRow[] = [];
  const last = Math.min(ws.rowCount, max);
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    const cells: TableRow = [];
    const count = Math.max(row.cellCount, 0);
    for (let c = 1; c <= count; c++) {
      const cell = row.getCell(c);
      const fmt = cell.numFmt ?? '';
      cells.push({ v: plainCellValue(cell.value), indent: cell.alignment?.indent ?? 0, percent: fmt.includes('%') });
    }
    rows.push(cells);
  }
  return rows;
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
  return parsed.data.slice(0, 100_000).map((r) =>
    r.map((raw) => {
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
