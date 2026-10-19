/**
 * Status ↔ progress rules and the group roll-up of status (calculations audit 2026-10, H1/H2).
 * Pure functions shared by the API (`task-engine.recompute`, the update paths) and the web demo,
 * so both apply exactly the same rules.
 *
 * Canonical rules:
 * - Leaf invariant (`normalizeStatusProgress`): DONE ⇒ progress 100; progress ≥ 100 ⇒ DONE;
 *   NOT_STARTED with progress > 0 ⇒ IN_PROGRESS. ON_HOLD keeps any progress below 100.
 * - Leaf edit (`syncStatusProgress`): see its doc — the field the user changed decides.
 * - Group (`deriveGroupStatus`): never edited by users; derived bottom-up from its children.
 * - Empty group (a GROUP with no live child): progress 0, costs 0, status NOT_STARTED, dates and
 *   duration kept as they were; it weighs 0 in every progress roll-up (`progressWeight`).
 */

export type WorkStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'ON_HOLD';

export interface StatusProgress {
  status: WorkStatus;
  progress: number;
}

const clampProgress = (p: number): number => (Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0);

/**
 * The leaf invariant, applied after every write: DONE ⇒ 100; ≥ 100 ⇒ DONE; NOT_STARTED with
 * progress > 0 ⇒ IN_PROGRESS. Anything else is kept.
 */
export function normalizeStatusProgress(status: WorkStatus, progress: number): StatusProgress {
  const p = clampProgress(progress);
  if (status === 'DONE') return { status, progress: 100 };
  if (p >= 100) return { status: 'DONE', progress: 100 };
  if (status === 'NOT_STARTED' && p > 0) return { status: 'IN_PROGRESS', progress: p };
  return { status, progress: p };
}

/**
 * Applies a user's status/progress edit to a leaf:
 * - progress only: 100 ⇒ DONE; below 100 on a DONE task ⇒ IN_PROGRESS; > 0 on NOT_STARTED ⇒ IN_PROGRESS.
 * - status only: DONE ⇒ progress 100; NOT_STARTED ⇒ progress 0; leaving DONE (to IN_PROGRESS or
 *   ON_HOLD) while progress is 100 ⇒ progress 0 (the task is reopened; there is no better number).
 * - both: taken as sent, then the invariant (DONE ⇒ 100; 100 ⇒ DONE; NOT_STARTED + progress ⇒ IN_PROGRESS).
 * Unchanged values (`edit.x === cur.x`) count as "not sent".
 */
export function syncStatusProgress(
  cur: StatusProgress,
  edit: { status?: WorkStatus | undefined; progress?: number | undefined },
): StatusProgress {
  const statusSent = edit.status !== undefined && edit.status !== cur.status;
  const progressSent = edit.progress !== undefined && edit.progress !== cur.progress;
  if (statusSent && progressSent) return normalizeStatusProgress(edit.status!, edit.progress!);
  if (progressSent) {
    const p = clampProgress(edit.progress!);
    if (p >= 100) return { status: 'DONE', progress: 100 };
    if (cur.status === 'DONE') return { status: 'IN_PROGRESS', progress: p };
    return normalizeStatusProgress(cur.status, p);
  }
  if (statusSent) {
    const s = edit.status!;
    if (s === 'DONE') return { status: 'DONE', progress: 100 };
    if (s === 'NOT_STARTED') return { status: 'NOT_STARTED', progress: 0 };
    return { status: s, progress: cur.progress >= 100 ? 0 : clampProgress(cur.progress) };
  }
  return normalizeStatusProgress(cur.status, cur.progress);
}

/**
 * A group's status from its children (statuses already derived for child groups) and its own
 * rolled-up progress, in the owner's order (ADR-133):
 * 1. no children → NOT_STARTED (an empty group);
 * 2. every child DONE → DONE;
 * 3. any child IN_PROGRESS or DONE, or rolled progress > 0 → IN_PROGRESS
 *    (so DONE + ON_HOLD children → IN_PROGRESS: part of the work is done);
 * 4. every child that is not DONE is ON_HOLD → ON_HOLD (after rule 3 this means: every child
 *    ON_HOLD and nothing done yet);
 * 5. otherwise NOT_STARTED.
 */
export function deriveGroupStatus(children: ReadonlyArray<{ status: WorkStatus }>, rolledProgress: number): WorkStatus {
  if (!children.length) return 'NOT_STARTED';
  let done = 0;
  let hold = 0;
  let active = false;
  for (const c of children) {
    if (c.status === 'DONE') {
      done++;
      active = true;
    } else if (c.status === 'ON_HOLD') hold++;
    else if (c.status === 'IN_PROGRESS') active = true;
  }
  if (done === children.length) return 'DONE';
  if (active || rolledProgress > 0) return 'IN_PROGRESS';
  if (hold > 0 && done + hold === children.length) return 'ON_HOLD';
  return 'NOT_STARTED';
}

/** The fields {@link rollUpStatus} reads and may write. */
export interface StatusNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: 'TASK' | 'GROUP' | 'MILESTONE';
  readonly status: WorkStatus;
  readonly progress: number;
  readonly plannedCost?: number;
  readonly actualCost?: number;
}

/**
 * Runs after the date/progress roll-up (`schedule`/`rollUp`) and the cost roll-up:
 * - every leaf (no children) that is not a GROUP gets the leaf invariant;
 * - an empty GROUP gets progress 0, status NOT_STARTED and — when it carries costs — 0 / 0;
 * - every task with children gets {@link deriveGroupStatus}, bottom-up (children before parents).
 * Tasks whose values do not change keep their object identity. Iterative; safe at any depth.
 */
export function rollUpStatus<T extends StatusNode>(tasks: readonly T[]): T[] {
  const ids = new Map<string, number>();
  tasks.forEach((t, i) => ids.set(t.id, i));
  const children = new Map<number, number[]>();
  for (let i = 0; i < tasks.length; i++) {
    const p = tasks[i]!.parentId;
    const pi = p == null ? undefined : ids.get(p);
    if (pi === undefined) continue;
    const list = children.get(pi);
    if (list) list.push(i);
    else children.set(pi, [i]);
  }
  // Post-order (children before parents) without recursion.
  const order: number[] = [];
  const seen = new Uint8Array(tasks.length);
  for (let r = 0; r < tasks.length; r++) {
    if (seen[r]) continue;
    const stack: Array<[number, boolean]> = [[r, false]];
    while (stack.length) {
      const [i, expanded] = stack.pop()!;
      if (expanded) {
        order.push(i);
        continue;
      }
      if (seen[i]) continue;
      seen[i] = 1;
      stack.push([i, true]);
      for (const c of children.get(i) ?? []) if (!seen[c]) stack.push([c, false]);
    }
  }
  const out: T[] = tasks.slice();
  for (const i of order) {
    const t = out[i]!;
    const kids = children.get(i);
    let next: T = t;
    if (kids?.length) {
      const status = deriveGroupStatus(
        kids.map((k) => out[k]!),
        t.progress,
      );
      if (status !== t.status) next = { ...t, status };
    } else if (t.type === 'GROUP') {
      const zeroCost = (t.plannedCost !== undefined && t.plannedCost !== 0) || (t.actualCost !== undefined && t.actualCost !== 0);
      if (t.progress !== 0 || t.status !== 'NOT_STARTED' || zeroCost) {
        next = {
          ...t,
          progress: 0,
          status: 'NOT_STARTED',
          ...(t.plannedCost !== undefined ? { plannedCost: 0 } : {}),
          ...(t.actualCost !== undefined ? { actualCost: 0 } : {}),
        };
      }
    } else {
      const n = normalizeStatusProgress(t.status, t.progress);
      if (n.status !== t.status || n.progress !== t.progress) next = { ...t, ...n };
    }
    out[i] = next;
  }
  return out;
}
