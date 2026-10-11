import { buildTree } from './model';
import type { ScheduleTask } from './types';

/**
 * Computes WBS numbers (`1`, `1.2`, `1.2.3`) from `parentId` and `sortOrder`.
 * Siblings are ordered by `sortOrder`, then by `id` for ties. Tasks whose
 * parent is missing from the list are numbered as roots. Iterative, so any
 * depth works.
 *
 * @returns a map from task id to its WBS code.
 * @throws HierarchyError when `parentId` links form a loop.
 */
export function computeWbs(
  tasks: readonly Pick<ScheduleTask, 'id' | 'parentId' | 'sortOrder'>[],
): Map<string, string> {
  const tree = buildTree(tasks as readonly ScheduleTask[]);
  const codes = new Array<string>(tree.n);
  for (let r = 0; r < tree.roots.length; r++) codes[tree.roots[r]!] = String(r + 1);
  for (let k = 0; k < tree.order.length; k++) {
    const v = tree.order[k]!;
    const prefix = codes[v]! + '.';
    const from = tree.childStart[v]!;
    const to = tree.childStart[v + 1]!;
    for (let j = from; j < to; j++) codes[tree.childList[j]!] = prefix + String(j - from + 1);
  }
  const result = new Map<string, string>();
  for (let i = 0; i < tree.n; i++) result.set(tasks[i]!.id, codes[i]!);
  return result;
}
