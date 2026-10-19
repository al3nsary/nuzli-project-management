/**
 * The optimistic side of the status ↔ progress rule (calculations audit H1, ADR-133): a leaf edit
 * goes through the shared `syncStatusProgress`, so the grid, the board and the drawer show at once
 * what the server (and the demo) will store — «منجزة» ⇒ 100 %, 100 % ⇒ «منجزة», back to
 * «لم تبدأ» ⇒ 0 %. Groups are never edited here: their status is derived from their tasks.
 */
import { syncStatusProgress } from '@nuzli/scheduling';
import type { GanttDto, TaskStatus } from '@nuzli/shared';
import { mergeTasks } from '../gantt/batch';

/** True when the task has children in the chart or is a GROUP (its status/progress are derived). */
export function isDerivedTask(tasks: GanttDto['tasks'], id: string): boolean {
  const task = tasks.find((x) => x.id === id);
  return !task || task.type === 'GROUP' || tasks.some((x) => x.parentId === id);
}

/**
 * The chart with the leaf `id` showing the synced status and progress of `patch`, or null when the
 * patch touches neither field, the task is a group, or nothing changes.
 */
export function withStatusSync(g: GanttDto, id: string, patch: { status?: TaskStatus | undefined; progress?: number | undefined }): GanttDto | null {
  if (patch.status === undefined && patch.progress === undefined) return null;
  if (isDerivedTask(g.tasks, id)) return null;
  const cur = g.tasks.find((x) => x.id === id)!;
  const next = syncStatusProgress({ status: cur.status, progress: cur.progress }, { status: patch.status, progress: patch.progress });
  if (next.status === cur.status && next.progress === cur.progress) return null;
  return mergeTasks(g, [{ ...cur, ...next }]);
}
