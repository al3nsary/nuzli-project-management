/**
 * «التصفية والتجميع» of the project views (owner request A9): filter by assignee, status,
 * priority, label, team, a custom field value and a name search; group by assignee, status,
 * priority, label, team or a custom field. Pure functions shared by the Gantt, list, board and
 * calendar so one filter drives every tab; saved views store `{ filter, groupBy, zoom, columns }`
 * in `/me/view-prefs` (`gantt.views`).
 */
import type { CustomFieldDto, LabelDto, Priority, TaskDto, TaskStatus } from '@nuzli/shared';
import type { RowGroup } from '../gantt/geometry';

export const NONE = '__none__';

export interface TaskFilter {
  assignees: string[];
  statuses: TaskStatus[];
  priorities: Priority[];
  labels: string[];
  teams: string[];
  field: { id: string; value: string } | null;
  q: string;
}

export type GroupBy = 'none' | 'assignee' | 'status' | 'priority' | 'label' | 'team' | `field:${string}`;

export const EMPTY_FILTER: TaskFilter = { assignees: [], statuses: [], priorities: [], labels: [], teams: [], field: null, q: '' };

export function activeCount(f: TaskFilter): number {
  return (
    (f.assignees.length ? 1 : 0) +
    (f.statuses.length ? 1 : 0) +
    (f.priorities.length ? 1 : 0) +
    (f.labels.length ? 1 : 0) +
    (f.teams.length ? 1 : 0) +
    (f.field ? 1 : 0) +
    (f.q.trim() ? 1 : 0)
  );
}

/** A stored filter made safe (saved views may predate fields that were deleted). */
export function normalizeFilter(raw: unknown): TaskFilter {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<TaskFilter>;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as T[]) : []);
  const field = o.field && typeof o.field === 'object' && typeof o.field.id === 'string' ? { id: o.field.id, value: String(o.field.value ?? '') } : null;
  return {
    assignees: arr(o.assignees),
    statuses: arr(o.statuses),
    priorities: arr(o.priorities),
    labels: arr(o.labels),
    teams: arr(o.teams),
    field,
    q: typeof o.q === 'string' ? o.q : '',
  };
}

function fieldMatches(field: CustomFieldDto | undefined, value: unknown, wanted: string): boolean {
  if (!field) return true;
  if (wanted === NONE) return value === null || value === undefined || value === '';
  switch (field.type) {
    case 'CHECKBOX':
      return (value === true) === (wanted === 'true');
    case 'NUMBER':
      return value !== null && value !== undefined && String(value) === wanted;
    case 'TEXT':
      return typeof value === 'string' && value.toLowerCase().includes(wanted.toLowerCase());
    default:
      return value === wanted;
  }
}

/** Does the task match every active criterion? (Within one criterion, any value matches.) */
export function matchTask(t: TaskDto, f: TaskFilter, fields?: ReadonlyMap<string, CustomFieldDto>): boolean {
  if (f.q.trim() && !t.name.toLowerCase().includes(f.q.trim().toLowerCase()) && !t.wbs.startsWith(f.q.trim())) return false;
  if (f.assignees.length && !f.assignees.includes(t.assignee?.id ?? NONE)) return false;
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
  if (f.teams.length && !f.teams.includes(t.assignee?.teamName ?? NONE)) return false;
  if (f.labels.length) {
    const ids = t.labelIds ?? [];
    const ok = f.labels.some((l) => (l === NONE ? ids.length === 0 : ids.includes(l)));
    if (!ok) return false;
  }
  if (f.field) {
    const field = fields?.get(f.field.id);
    if (!fieldMatches(field, t.customValues?.[f.field.id], f.field.value)) return false;
  }
  return true;
}

export interface GroupContext {
  labels: ReadonlyMap<string, LabelDto>;
  fields: ReadonlyMap<string, CustomFieldDto>;
  statusLabel(s: TaskStatus): string;
  priorityLabel(p: Priority): string;
  /** Arabic words for the "none" buckets. */
  words: { unassigned: string; noLabel: string; noTeam: string; noValue: string; yes: string; no: string };
}

const STATUS_ORDER: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'DONE'];
const PRIORITY_ORDER: Priority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const STATUS_COLOR: Record<TaskStatus, string> = {
  NOT_STARTED: 'var(--dim2)',
  IN_PROGRESS: 'var(--primary)',
  ON_HOLD: 'var(--amber)',
  DONE: 'var(--live)',
};

/** The grouping function for the Gantt rows, or null for the WBS hierarchy. */
export function groupFn(groupBy: GroupBy, ctx: GroupContext): ((t: TaskDto) => RowGroup[]) | null {
  if (groupBy === 'none') return null;
  if (groupBy === 'assignee') {
    return (t) => [
      t.assignee
        ? { key: `a:${t.assignee.id}`, label: t.assignee.fullName, color: t.assignee.teamColor, order: 0 }
        : { key: 'a:none', label: ctx.words.unassigned, order: 1 },
    ];
  }
  if (groupBy === 'team') {
    return (t) => [
      t.assignee?.teamName
        ? { key: `t:${t.assignee.teamName}`, label: t.assignee.teamName, color: t.assignee.teamColor, order: 0 }
        : { key: 't:none', label: ctx.words.noTeam, order: 1 },
    ];
  }
  if (groupBy === 'status') {
    return (t) => [{ key: `s:${t.status}`, label: ctx.statusLabel(t.status), color: STATUS_COLOR[t.status], order: STATUS_ORDER.indexOf(t.status) }];
  }
  if (groupBy === 'priority') {
    return (t) => [{ key: `p:${t.priority}`, label: ctx.priorityLabel(t.priority), order: PRIORITY_ORDER.indexOf(t.priority) }];
  }
  if (groupBy === 'label') {
    return (t) => {
      const ids = (t.labelIds ?? []).filter((id) => ctx.labels.has(id));
      if (!ids.length) return [{ key: 'l:none', label: ctx.words.noLabel, order: 1 }];
      return ids.map((id) => {
        const l = ctx.labels.get(id)!;
        return { key: `l:${id}`, label: l.name, color: l.color, order: 0 };
      });
    };
  }
  const fieldId = groupBy.slice(6);
  const field = ctx.fields.get(fieldId);
  if (!field) return null;
  return (t) => {
    const v = t.customValues?.[fieldId];
    if (v === null || v === undefined || v === '') return [{ key: 'f:none', label: ctx.words.noValue, order: 9999 }];
    const label = field.type === 'CHECKBOX' ? (v === true ? ctx.words.yes : ctx.words.no) : String(v);
    const order = field.type === 'DROPDOWN' ? field.options.indexOf(String(v)) : 0;
    return [{ key: `f:${String(v)}`, label, order }];
  };
}

/** Tasks to show in list-like views: the matches and their ancestors, in the original order. */
export function filterWithAncestors(tasks: readonly TaskDto[], visible: (t: TaskDto) => boolean): TaskDto[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const keep = new Set<string>();
  for (const t of tasks) {
    if (!visible(t)) continue;
    for (let cur: TaskDto | undefined = t, guard = 0; cur && !keep.has(cur.id) && guard < 500; guard++) {
      keep.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return tasks.filter((t) => keep.has(t.id));
}

/**
 * «ترتيب متسلسل» (cascade sorting): inside every parent, children ordered by start date (then WBS);
 * answers the batch changes `{ id, version, sortOrder }` for the tasks whose order changes.
 */
export function cascadeChanges(tasks: readonly TaskDto[]): Array<{ id: string; version: number; sortOrder: number }> {
  const byParent = new Map<string | null, TaskDto[]>();
  for (const t of tasks) {
    const list = byParent.get(t.parentId) ?? [];
    list.push(t);
    byParent.set(t.parentId, list);
  }
  const out: Array<{ id: string; version: number; sortOrder: number }> = [];
  for (const list of byParent.values()) {
    const current = [...list].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
    const wanted = [...list].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.sortOrder - b.sortOrder);
    if (wanted.every((t, i) => t.id === current[i]!.id)) continue;
    wanted.forEach((t, i) => {
      if (t.sortOrder !== i + 1) out.push({ id: t.id, version: t.version, sortOrder: i + 1 });
    });
  }
  return out;
}
