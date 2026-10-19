/**
 * Grid columns of the Gantt and the list view (owner request A9, GanttPRO): «اسم المهمة» ·
 * «المسؤول» · «الحالة» by default, a «+» header button to add more (dates, duration, deadline,
 * priority, progress, costs, labels, WBS and every custom field), hide, drag-reorder and resize.
 * The layout is stored per user per project in `/me/view-prefs` (`gantt.columns`, `list.columns`,
 * ADR-097). Pure functions: the screens keep the array, these keep it valid.
 */
import type { CustomFieldDto } from '@nuzli/shared';
import type { MessageKey } from '../../i18n';

export type BaseColumnId =
  | 'name'
  | 'assignee'
  | 'status'
  | 'start'
  | 'end'
  | 'duration'
  | 'deadline'
  | 'priority'
  | 'progress'
  | 'plannedCost'
  | 'actualCost'
  | 'labels'
  | 'wbs';

/** A base column or a custom field (`cf:<fieldId>`). */
export type ColumnId = BaseColumnId | `cf:${string}`;

export interface ColumnPref {
  id: ColumnId;
  width: number;
}

interface ColumnDef {
  label: MessageKey;
  width: number;
  min: number;
}

export const COLUMN_DEFS: Record<BaseColumnId, ColumnDef> = {
  name: { label: 'col.name', width: 280, min: 160 },
  assignee: { label: 'col.assignee', width: 150, min: 90 },
  status: { label: 'col.status', width: 128, min: 80 },
  start: { label: 'col.start', width: 96, min: 70 },
  end: { label: 'col.end', width: 96, min: 70 },
  duration: { label: 'col.duration', width: 84, min: 60 },
  deadline: { label: 'col.deadline', width: 104, min: 70 },
  priority: { label: 'col.priority', width: 96, min: 70 },
  progress: { label: 'col.progress', width: 104, min: 70 },
  plannedCost: { label: 'col.plannedCost', width: 124, min: 80 },
  actualCost: { label: 'col.actualCost', width: 124, min: 80 },
  labels: { label: 'col.labels', width: 150, min: 80 },
  wbs: { label: 'col.wbs', width: 64, min: 44 },
};

export const BASE_COLUMNS = Object.keys(COLUMN_DEFS) as BaseColumnId[];
export const DEFAULT_COLUMNS: ColumnPref[] = [
  { id: 'name', width: COLUMN_DEFS.name.width },
  { id: 'assignee', width: COLUMN_DEFS.assignee.width },
  { id: 'status', width: COLUMN_DEFS.status.width },
];
/** The list view starts wider (it has room). */
export const DEFAULT_LIST_COLUMNS: ColumnPref[] = [
  { id: 'wbs', width: 64 },
  { id: 'name', width: 300 },
  { id: 'assignee', width: 160 },
  { id: 'status', width: 128 },
  { id: 'start', width: 104 },
  { id: 'end', width: 104 },
  { id: 'progress', width: 110 },
];
export const MAX_COLUMN_WIDTH = 600;
export const CUSTOM_FIELD_WIDTH = 140;

export const isCustom = (id: ColumnId): id is `cf:${string}` => id.startsWith('cf:');
export const fieldIdOf = (id: ColumnId): string | null => (isCustom(id) ? id.slice(3) : null);

export function minWidthOf(id: ColumnId): number {
  return isCustom(id) ? 80 : COLUMN_DEFS[id as BaseColumnId].min;
}

export function defaultWidthOf(id: ColumnId): number {
  return isCustom(id) ? CUSTOM_FIELD_WIDTH : COLUMN_DEFS[id as BaseColumnId].width;
}

/**
 * A stored value made safe: unknown ids and deleted custom fields dropped, duplicates removed,
 * widths clamped, and «اسم المهمة» always present and first (the tree lives in it).
 */
export function normalizeColumns(raw: unknown, fields: readonly Pick<CustomFieldDto, 'id'>[], fallback: ColumnPref[] = DEFAULT_COLUMNS): ColumnPref[] {
  if (!Array.isArray(raw)) return fallback.map((c) => ({ ...c }));
  const fieldIds = new Set(fields.map((f) => f.id));
  const seen = new Set<string>();
  const out: ColumnPref[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    const known = (BASE_COLUMNS as string[]).includes(id) || (id.startsWith('cf:') && fieldIds.has(id.slice(3)));
    if (!known) continue;
    const w = Number((item as { width?: unknown }).width);
    const cid = id as ColumnId;
    out.push({ id: cid, width: clampWidth(cid, Number.isFinite(w) ? w : defaultWidthOf(cid)) });
    seen.add(id);
  }
  const name = out.findIndex((c) => c.id === 'name');
  if (name < 0) out.unshift({ id: 'name', width: COLUMN_DEFS.name.width });
  else if (name > 0) out.unshift(...out.splice(name, 1));
  return out;
}

export const clampWidth = (id: ColumnId, w: number): number => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(minWidthOf(id), w)));

/** Columns that can still be added from the «+» menu (base first, then custom fields by order). */
export function availableColumns(cols: readonly ColumnPref[], fields: readonly CustomFieldDto[]): ColumnId[] {
  const have = new Set(cols.map((c) => c.id));
  const base = BASE_COLUMNS.filter((id) => !have.has(id));
  const custom = [...fields].sort((a, b) => a.sort - b.sort).map((f) => `cf:${f.id}` as ColumnId).filter((id) => !have.has(id));
  return [...base, ...custom];
}

export function addColumn(cols: readonly ColumnPref[], id: ColumnId): ColumnPref[] {
  if (cols.some((c) => c.id === id)) return [...cols];
  return [...cols, { id, width: defaultWidthOf(id) }];
}

/** Hides a column («اسم المهمة» cannot be hidden). */
export function removeColumn(cols: readonly ColumnPref[], id: ColumnId): ColumnPref[] {
  if (id === 'name') return [...cols];
  return cols.filter((c) => c.id !== id);
}

/** Moves the column at `from` to `to` (indices in the array); «اسم المهمة» stays first. */
export function moveColumn(cols: readonly ColumnPref[], from: number, to: number): ColumnPref[] {
  if (from === to || from < 0 || to < 0 || from >= cols.length || to >= cols.length) return [...cols];
  if (cols[from]!.id === 'name' || to === 0) return [...cols];
  const next = [...cols];
  const [c] = next.splice(from, 1);
  next.splice(to, 0, c!);
  return next;
}

export function resizeColumn(cols: readonly ColumnPref[], id: ColumnId, width: number): ColumnPref[] {
  return cols.map((c) => (c.id === id ? { ...c, width: clampWidth(id, width) } : c));
}

export const columnsWidth = (cols: readonly ColumnPref[]): number => cols.reduce((s, c) => s + c.width, 0);

/**
 * Column index under a physical x inside the header (for drag-reorder). `rtl`: the first column is
 * on the right. Returns the index the dragged column should take.
 */
export function dropIndex(cols: readonly ColumnPref[], localX: number, totalWidth: number, rtl = true): number {
  const logical = rtl ? totalWidth - localX : localX;
  let acc = 0;
  for (let i = 0; i < cols.length; i++) {
    const w = cols[i]!.width;
    if (logical < acc + w / 2) return Math.max(1, i);
    acc += w;
  }
  return cols.length - 1;
}
