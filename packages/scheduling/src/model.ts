/**
 * Internal, array-based representation shared by `rollUp`, `computeWbs` and
 * `schedule`. Not exported from the package.
 *
 * @internal
 */
import { MINUTES_PER_DAY, fromDayNumber, toDayNumber } from './dates';
import { HierarchyError } from './errors';
import type { ScheduleResult, ScheduleTask } from './types';
import { minutesToHours, type Units } from './units';

export interface Tree {
  readonly n: number;
  readonly index: Map<string, number>;
  /** Parent index, or -1 for a root (null or unknown parentId). */
  readonly parent: Int32Array;
  /** Children of i are `childList[childStart[i] .. childStart[i + 1])`, sorted by sortOrder then id. */
  readonly childStart: Int32Array;
  readonly childList: Int32Array;
  /** Roots, sorted like siblings. */
  readonly roots: Int32Array;
  /** Breadth-first order from the roots: every parent precedes its children. */
  readonly order: Int32Array;
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Builds the parent/child structure iteratively (no recursion, any depth). */
export function buildTree(tasks: readonly ScheduleTask[]): Tree {
  const n = tasks.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = tasks[i]!.id;
    if (index.has(id)) throw new RangeError(`Duplicate task id "${id}"`);
    index.set(id, i);
  }
  const parent = new Int32Array(n);
  const counts = new Int32Array(n + 1);
  let rootCount = 0;
  for (let i = 0; i < n; i++) {
    const pid = tasks[i]!.parentId;
    const p = pid == null ? undefined : index.get(pid);
    if (p === undefined) {
      parent[i] = -1;
      rootCount++;
    } else {
      parent[i] = p;
      counts[p]!++;
    }
  }
  const childStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) childStart[i + 1] = childStart[i]! + counts[i]!;
  const fill = childStart.slice(0, n);
  const childList = new Int32Array(Math.max(0, n - rootCount));
  const roots = new Int32Array(rootCount);
  let r = 0;
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    if (p < 0) roots[r++] = i;
    else childList[fill[p]!++] = i;
  }
  const cmp = (a: number, b: number): number => {
    const ta = tasks[a]!;
    const tb = tasks[b]!;
    return ta.sortOrder - tb.sortOrder || cmpId(ta.id, tb.id);
  };
  roots.sort(cmp);
  for (let i = 0; i < n; i++) {
    const s = childStart[i]!;
    const e = childStart[i + 1]!;
    if (e - s > 1) childList.subarray(s, e).sort(cmp);
  }
  const order = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const root of roots) order[tail++] = root;
  while (head < tail) {
    const v = order[head++]!;
    for (let k = childStart[v]!; k < childStart[v + 1]!; k++) order[tail++] = childList[k]!;
  }
  if (tail < n) {
    const seen = new Uint8Array(n);
    for (let k = 0; k < tail; k++) seen[order[k]!] = 1;
    const loop: string[] = [];
    for (let i = 0; i < n; i++) if (!seen[i]) loop.push(tasks[i]!.id);
    throw new HierarchyError(loop);
  }
  return { n, index, parent, childStart, childList, roots, order };
}

export const KIND_TASK = 0;
export const KIND_GROUP = 1;
export const KIND_MILESTONE = 2;

/** Numeric working state of a task list. */
export interface Model {
  readonly tree: Tree;
  readonly kind: Uint8Array;
  /** 1 when the task has children (any type): its dates are rolled up. */
  readonly summary: Uint8Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly dur: Int32Array;
  readonly prog: Float64Array;
}

export function buildModel(
  tasks: readonly ScheduleTask[],
  tree: Tree = buildTree(tasks),
  units?: Units,
): Model {
  const n = tasks.length;
  const kind = new Uint8Array(n);
  const summary = new Uint8Array(n);
  const start = new Int32Array(n);
  const end = new Int32Array(n);
  const dur = new Int32Array(n);
  const prog = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = tasks[i]!;
    kind[i] = t.type === 'GROUP' ? KIND_GROUP : t.type === 'MILESTONE' ? KIND_MILESTONE : KIND_TASK;
    summary[i] = tree.childStart[i + 1]! > tree.childStart[i]! ? 1 : 0;
    if (units?.hour) {
      start[i] = units.parse(t.startDate);
      end[i] = units.parse(t.endDate);
      dur[i] = units.readDuration(t);
    } else {
      start[i] = toDayNumber(t.startDate);
      end[i] = toDayNumber(t.endDate);
      dur[i] = Math.max(0, Math.trunc(t.durationDays));
    }
    prog[i] = t.progress;
  }
  return { tree, kind, summary, start, end, dur, prog };
}

export function cloneModel(m: Model): Model {
  return {
    tree: m.tree,
    kind: m.kind,
    summary: m.summary,
    start: m.start.slice(),
    end: m.end.slice(),
    dur: m.dur.slice(),
    prog: m.prog.slice(),
  };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Rolls every summary task up from its children, bottom-up (reverse BFS order,
 * so it is iterative and safe at any depth).
 */
export function rollUpModel(m: Model, units: Units): void {
  const { order, childStart, childList } = m.tree;
  for (let k = order.length - 1; k >= 0; k--) {
    const g = order[k]!;
    if (!m.summary[g]) {
      // Calculations audit H2: a GROUP left without children has no work left — progress 0
      // (its dates and duration are kept; it weighs 0 in its parent, see below).
      if (m.kind[g] === KIND_GROUP) m.prog[g] = 0;
      continue;
    }
    let s = Infinity;
    let e = -Infinity;
    let weighted = 0;
    let weights = 0;
    let plain = 0;
    const from = childStart[g]!;
    const to = childStart[g + 1]!;
    for (let j = from; j < to; j++) {
      const c = childList[j]!;
      if (m.start[c]! < s) s = m.start[c]!;
      if (m.end[c]! > e) e = m.end[c]!;
      const w = (m.kind[c] === KIND_MILESTONE || m.kind[c] === KIND_GROUP) && !m.summary[c] ? 0 : m.dur[c]!;
      weighted += w * m.prog[c]!;
      weights += w;
      plain += m.prog[c]!;
    }
    if (e < s) e = s;
    m.start[g] = s;
    m.end[g] = e;
    m.dur[g] = units.span(s, e);
    m.prog[g] = round2(weights > 0 ? weighted / weights : plain / (to - from));
  }
}

/** Writes a model back into task objects; unchanged tasks keep their identity. */
export function emit<T extends ScheduleTask>(
  tasks: readonly T[],
  before: Model,
  after: Model,
  units?: Units,
): ScheduleResult<T> {
  if (units?.hour) return emitHours(tasks, before, after, units);
  const out: T[] = new Array<T>(tasks.length);
  const changedIds: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const startChanged = before.start[i] !== after.start[i];
    const endChanged = before.end[i] !== after.end[i];
    const durChanged = t.durationDays !== after.dur[i];
    const progChanged = t.progress !== after.prog[i];
    if (startChanged || endChanged || durChanged || progChanged) {
      out[i] = {
        ...t,
        startDate: startChanged ? fromDayNumber(after.start[i]!) : t.startDate,
        endDate: endChanged ? fromDayNumber(after.end[i]!) : t.endDate,
        durationDays: after.dur[i]!,
        progress: after.prog[i]!,
      };
      changedIds.push(t.id);
    } else {
      out[i] = t;
    }
  }
  return { tasks: out, changedIds };
}

/**
 * HOUR-mode {@link emit}: dates are minute numbers, `durationHours` comes from
 * working minutes, and `durationDays` is derived (working days the task touches).
 */
function emitHours<T extends ScheduleTask>(
  tasks: readonly T[],
  before: Model,
  after: Model,
  units: Units,
): ScheduleResult<T> {
  const cal = units.cal;
  const out: T[] = new Array<T>(tasks.length);
  const changedIds: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const s = after.start[i]!;
    const e = after.end[i]!;
    const mins = after.dur[i]!;
    const hours = minutesToHours(mins);
    const days =
      mins > 0 && e > s
        ? cal.workingDaysBetweenNum(
            Math.floor(cal.nextWorkingMinuteNum(s) / MINUTES_PER_DAY),
            Math.floor(cal.addWorkingMinutesNum(e, -1) / MINUTES_PER_DAY),
          )
        : 0;
    const startChanged = before.start[i] !== s;
    const endChanged = before.end[i] !== e;
    if (
      startChanged ||
      endChanged ||
      t.durationHours !== hours ||
      t.durationDays !== days ||
      t.progress !== after.prog[i]
    ) {
      out[i] = {
        ...t,
        startDate: startChanged ? units.format(s) : t.startDate,
        endDate: endChanged ? units.format(e) : t.endDate,
        durationDays: days,
        durationHours: hours,
        progress: after.prog[i]!,
      };
      changedIds.push(t.id);
    } else {
      out[i] = t;
    }
  }
  return { tasks: out, changedIds };
}
