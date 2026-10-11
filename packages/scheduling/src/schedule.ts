import { WorkCalendar } from './calendar';
import { fromDayNumber, toDayNumber, type IsoDate } from './dates';
import { CycleError, TaskEditError } from './errors';
import { KIND_MILESTONE, buildModel, cloneModel, emit, rollUpModel, type Model } from './model';
import type { ScheduleInput, ScheduleResult, ScheduleTask, TaskEditResult } from './types';

/**
 * Reschedules a project.
 *
 * 1. Summary tasks are rolled up from their children.
 * 2. When `autoSchedule` is on (the default), a forward pass runs in
 *    topological order (Kahn's algorithm) over the FS dependencies and the
 *    hierarchy. For `P -FS(lag)-> S`, S may start no earlier than
 *    `addWorkingDays(P.end, 1 + lag)`: the next working day after P ends,
 *    moved `lag` working days (a negative lag is a lead). A task is shifted
 *    **forward only**, and only when that constraint is violated; it keeps its
 *    duration in working days and its end is recomputed. Milestones keep
 *    duration 0 (end = start).
 * 3. Summary tasks are rolled up again.
 *
 * Groups are never scheduled directly:
 * - a dependency whose **predecessor** is a group uses the group's rolled-up end
 *   (after its children were scheduled);
 * - a dependency whose **successor** is a group shifts every leaf descendant by
 *   the same number of working days, just enough for the group's start to meet
 *   the constraint.
 *
 * `SS`, `FF` and `SF` dependencies are accepted and ignored (modelled for later).
 * Dependencies that reference unknown task ids are ignored.
 *
 * @throws CycleError when FS dependencies (or a dependency between a task and
 * one of its ancestors) form a cycle.
 */
export function schedule<T extends ScheduleTask>(input: ScheduleInput<T>): ScheduleResult<T> {
  const cal = WorkCalendar.from(input.calendar);
  const before = buildModel(input.tasks);
  const after = cloneModel(before);
  rollUpModel(after, cal);
  if (input.autoSchedule !== false) {
    forwardPass(input, after, cal);
    rollUpModel(after, cal);
  }
  return emit(input.tasks, before, after);
}

/**
 * Graph layout: node `i` is task i's start (and its end, for a leaf); node
 * `n + i` is the end of summary task i. Edges: FS `end(P) -> start(S)`;
 * hierarchy `start(g) -> start(child)` and `end(child) -> end(g)`.
 */
function forwardPass<T extends ScheduleTask>(
  input: ScheduleInput<T>,
  m: Model,
  cal: WorkCalendar,
): void {
  const { tree, summary } = m;
  const n = tree.n;
  const N = 2 * n;
  const endNode = (i: number): number => (summary[i] ? n + i : i);
  const taskOf = (v: number): number => (v >= n ? v - n : v);

  // Collect FS constraints that point at known tasks.
  const deps = input.dependencies;
  const fsPred: number[] = [];
  const fsSucc: number[] = [];
  const fsLag: number[] = [];
  for (const d of deps) {
    if (d.type !== 'FS') continue;
    const p = tree.index.get(d.predecessorId);
    const s = tree.index.get(d.successorId);
    if (p === undefined || s === undefined) continue;
    if (p === s) throw new CycleError([d.predecessorId, d.predecessorId]);
    fsPred.push(p);
    fsSucc.push(s);
    fsLag.push(Math.trunc(d.lagDays) || 0);
  }
  const F = fsPred.length;

  // Out-edges (CSR) and in-degrees.
  const outCount = new Int32Array(N + 1);
  const indeg = new Int32Array(N);
  const addCount = (from: number, to: number): void => {
    outCount[from]!++;
    indeg[to]!++;
  };
  for (let k = 0; k < F; k++) addCount(endNode(fsPred[k]!), fsSucc[k]!);
  for (let i = 0; i < n; i++) {
    const p = tree.parent[i]!;
    if (p >= 0) {
      addCount(p, i);
      addCount(endNode(i), n + p);
    }
  }
  const outStart = new Int32Array(N + 1);
  for (let v = 0; v < N; v++) outStart[v + 1] = outStart[v]! + outCount[v]!;
  const fill = outStart.slice(0, N);
  const outList = new Int32Array(outStart[N]!);
  const put = (from: number, to: number): void => {
    outList[fill[from]!++] = to;
  };
  for (let k = 0; k < F; k++) put(endNode(fsPred[k]!), fsSucc[k]!);
  for (let i = 0; i < n; i++) {
    const p = tree.parent[i]!;
    if (p >= 0) {
      put(p, i);
      put(endNode(i), n + p);
    }
  }

  // Incoming FS constraints per successor task (CSR).
  const inStart = new Int32Array(n + 1);
  for (let k = 0; k < F; k++) inStart[fsSucc[k]! + 1]!++;
  for (let i = 0; i < n; i++) inStart[i + 1]! += inStart[i]!;
  const inFill = inStart.slice(0, n);
  const inPred = new Int32Array(F);
  const inLag = new Int32Array(F);
  for (let k = 0; k < F; k++) {
    const slot = inFill[fsSucc[k]!]!++;
    inPred[slot] = fsPred[k]!;
    inLag[slot] = fsLag[k]!;
  }

  // Optional restriction to what is downstream of the edited tasks.
  let active: Uint8Array | null = null;
  if (input.changed) {
    active = new Uint8Array(N);
    const queue: number[] = [];
    const mark = (v: number): void => {
      if (!active![v]) {
        active![v] = 1;
        queue.push(v);
      }
    };
    for (const id of input.changed) {
      const i = tree.index.get(id);
      if (i === undefined) continue;
      mark(i);
      mark(endNode(i));
    }
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h]!;
      for (let e = outStart[v]!; e < outStart[v + 1]!; e++) mark(outList[e]!);
    }
  }

  // Kahn's algorithm over the live nodes (end nodes exist only for summaries).
  const isLive = (v: number): boolean => v < n || summary[v - n] === 1;
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  let live = 0;
  for (let v = 0; v < N; v++) {
    if (!isLive(v)) continue;
    live++;
    if (indeg[v] === 0) queue[tail++] = v;
  }
  /** Working days every leaf under summary g is pushed by (inherited + own). */
  const shift = new Int32Array(n);
  const { start, end, dur, kind } = m;
  const parent = tree.parent;

  while (head < tail) {
    const v = queue[head++]!;
    if (!active || active[v]) {
      if (v >= n) {
        // End of summary g: latest end of its (already processed) children.
        const g = v - n;
        let e = -Infinity;
        for (let j = tree.childStart[g]!; j < tree.childStart[g + 1]!; j++) {
          const c = tree.childList[j]!;
          if (end[c]! > e) e = end[c]!;
        }
        end[g] = e;
      } else {
        const p = parent[v]!;
        const inherited = p >= 0 ? shift[p]! : 0;
        let earliest = -Infinity;
        for (let k = inStart[v]!; k < inStart[v + 1]!; k++) {
          const e = cal.addWorkingDaysNum(end[inPred[k]!]!, 1 + inLag[k]!);
          if (e > earliest) earliest = e;
        }
        const base = inherited > 0 ? cal.addWorkingDaysNum(start[v]!, inherited) : start[v]!;
        if (summary[v]) {
          // Start of summary g: children are shifted by the same working-day delta.
          const own = earliest > base ? cal.workingDaysBetweenNum(base + 1, earliest) : 0;
          shift[v] = inherited + own;
        } else {
          const s = earliest > base ? earliest : base;
          if (s !== start[v]) {
            start[v] = s;
            end[v] = kind[v] === KIND_MILESTONE ? s : cal.endFromDurationNum(s, dur[v]!);
            if (kind[v] === KIND_MILESTONE) dur[v] = 0;
          }
        }
      }
    }
    for (let e = outStart[v]!; e < outStart[v + 1]!; e++) {
      const w = outList[e]!;
      if (--indeg[w]! === 0) queue[tail++] = w;
    }
  }

  if (tail < live) {
    throw new CycleError(
      findCyclePath(N, indeg, outStart, outList)
        .map((v) => input.tasks[taskOf(v)]!.id)
        .filter((id, k, arr) => k === 0 || id !== arr[k - 1]),
    );
  }
}

/** Finds one cycle among the nodes Kahn's algorithm could not release. */
function findCyclePath(
  N: number,
  indeg: Int32Array,
  outStart: Int32Array,
  outList: Int32Array,
): number[] {
  const color = new Uint8Array(N);
  for (let root = 0; root < N; root++) {
    if (indeg[root] === 0 || color[root]) continue;
    const nodes = [root];
    const pos = [outStart[root]!];
    color[root] = 1;
    while (nodes.length > 0) {
      const top = nodes.length - 1;
      const v = nodes[top]!;
      if (pos[top]! < outStart[v + 1]!) {
        const w = outList[pos[top]!++]!;
        if (indeg[w] === 0) continue;
        if (color[w] === 1) return [...nodes.slice(nodes.indexOf(w)), w];
        if (color[w] === 0) {
          color[w] = 1;
          nodes.push(w);
          pos.push(outStart[w]!);
        }
      } else {
        color[v] = 2;
        nodes.pop();
        pos.pop();
      }
    }
  }
  return [];
}

function locate<T extends ScheduleTask>(tasks: readonly T[], id: string): number {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new TaskEditError('TASK_NOT_FOUND', `Unknown task "${id}"`);
  return i;
}

function finishEdit<T extends ScheduleTask>(
  state: ScheduleInput<T>,
  edited: T[],
  touched: string[],
): TaskEditResult<T> {
  const result = schedule({ ...state, tasks: edited, changed: touched });
  const changedIds: string[] = [];
  const changes: T[] = [];
  for (let i = 0; i < state.tasks.length; i++) {
    const before = state.tasks[i]!;
    const after = result.tasks[i]!;
    if (
      before.startDate !== after.startDate ||
      before.endDate !== after.endDate ||
      before.durationDays !== after.durationDays ||
      before.progress !== after.progress
    ) {
      changedIds.push(after.id);
      changes.push(after);
    }
  }
  return { tasks: result.tasks, changedIds, changes };
}

/**
 * Moves a task so it starts on `newStart` (snapped forward to a working day),
 * keeping its duration in working days, then reschedules its successors.
 * Moving a group shifts all of its leaf descendants by the same number of
 * working days (forwards or backwards).
 *
 * @returns the full updated list plus the batch of changed tasks for one request.
 */
export function moveTask<T extends ScheduleTask>(
  state: ScheduleInput<T>,
  id: string,
  newStart: IsoDate,
): TaskEditResult<T> {
  const cal = WorkCalendar.from(state.calendar);
  const ctx: ScheduleInput<T> = { ...state, calendar: cal };
  const tasks = state.tasks.slice();
  const i = locate(tasks, id);
  const target = cal.addWorkingDaysNum(toDayNumber(newStart), 0);
  const m = buildModel(tasks);
  const touched: string[] = [];
  const shiftLeaf = (k: number, s: number): void => {
    const t = tasks[k]!;
    const milestone = m.kind[k] === KIND_MILESTONE;
    const d = milestone ? 0 : Math.max(0, Math.trunc(t.durationDays));
    tasks[k] = {
      ...t,
      startDate: fromDayNumber(s),
      endDate: fromDayNumber(cal.endFromDurationNum(s, d)),
      durationDays: d,
    };
    touched.push(t.id);
  };
  if (!m.summary[i]) {
    shiftLeaf(i, target);
  } else {
    // Signed working-day delta between the group's rolled-up start and the target.
    rollUpModel(m, cal);
    const from = m.start[i]!;
    const delta =
      target >= from
        ? cal.workingDaysBetweenNum(from + 1, target)
        : -cal.workingDaysBetweenNum(target, from - 1);
    const stack = [i];
    while (stack.length > 0) {
      const v = stack.pop()!;
      for (let j = m.tree.childStart[v]!; j < m.tree.childStart[v + 1]!; j++) {
        const c = m.tree.childList[j]!;
        if (m.summary[c]) stack.push(c);
        else if (delta !== 0) shiftLeaf(c, cal.addWorkingDaysNum(m.start[c]!, delta));
      }
    }
    touched.push(id);
  }
  return finishEdit(ctx, tasks, touched);
}

/**
 * Changes a task's end to `newEnd` (snapped back to a working day, never before
 * its start), recomputes its duration in working days, then reschedules its
 * successors. Groups (rolled up) and milestones (duration 0) cannot be resized.
 */
export function resizeTask<T extends ScheduleTask>(
  state: ScheduleInput<T>,
  id: string,
  newEnd: IsoDate,
): TaskEditResult<T> {
  const cal = WorkCalendar.from(state.calendar);
  const ctx: ScheduleInput<T> = { ...state, calendar: cal };
  const tasks = state.tasks.slice();
  const i = locate(tasks, id);
  const t = tasks[i]!;
  const hasChildren = tasks.some((x) => x.parentId === id);
  if (hasChildren || t.type === 'GROUP' || t.type === 'MILESTONE') {
    throw new TaskEditError('NOT_RESIZABLE', `Task "${id}" cannot be resized`);
  }
  const s = cal.addWorkingDaysNum(toDayNumber(t.startDate), 0);
  let e = toDayNumber(newEnd);
  if (!cal.isWorkingDayNum(e)) e = cal.addWorkingDaysNum(e, -1);
  const d = Math.max(1, cal.workingDaysBetweenNum(s, e));
  tasks[i] = {
    ...t,
    startDate: fromDayNumber(s),
    endDate: fromDayNumber(cal.endFromDurationNum(s, d)),
    durationDays: d,
  };
  return finishEdit(ctx, tasks, [id]);
}
