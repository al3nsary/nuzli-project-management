import type { ScheduleDependency } from './types';

/** Only the endpoints matter for cycle checks; the other dependency fields are optional. */
type Edge = Pick<ScheduleDependency, 'predecessorId' | 'successorId'> & Partial<ScheduleDependency>;

function adjacency(deps: readonly Edge[], extra?: Edge): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (d: Edge): void => {
    const list = adj.get(d.predecessorId);
    if (list) list.push(d.successorId);
    else adj.set(d.predecessorId, [d.successorId]);
  };
  for (const d of deps) add(d);
  if (extra) add(extra);
  return adj;
}

/**
 * Looks for a cycle in the dependency graph (all four types count).
 *
 * @param deps existing dependencies.
 * @param newDep optional dependency about to be added; it is checked together with `deps`.
 * @returns `null` when the graph is acyclic, otherwise the closed cycle path of
 * task ids, e.g. `['a', 'b', 'c', 'a']`; a self-dependency gives `['a', 'a']`.
 */
export function detectCycle(deps: readonly Edge[], newDep?: Edge): string[] | null {
  const adj = adjacency(deps, newDep);
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const stackNodes: string[] = [];
  const stackPos: number[] = [];
  const starts = newDep ? [newDep.predecessorId, ...adj.keys()] : adj.keys();
  for (const root of starts) {
    if (state.has(root)) continue;
    state.set(root, 1);
    stackNodes.push(root);
    stackPos.push(0);
    while (stackNodes.length > 0) {
      const top = stackNodes.length - 1;
      const v = stackNodes[top]!;
      const next = adj.get(v);
      const pos = stackPos[top]!;
      if (next && pos < next.length) {
        stackPos[top] = pos + 1;
        const w = next[pos]!;
        const s = state.get(w);
        if (s === 1) {
          const from = stackNodes.lastIndexOf(w);
          return [...stackNodes.slice(from), w];
        }
        if (s === undefined) {
          state.set(w, 1);
          stackNodes.push(w);
          stackPos.push(0);
        }
      } else {
        state.set(v, 2);
        stackNodes.pop();
        stackPos.pop();
      }
    }
  }
  return null;
}

/**
 * True when adding `predecessorId -> successorId` to `deps` would close a cycle
 * (including a task depending on itself). Use it to reject the change before saving.
 */
export function wouldCreateCycle(
  deps: readonly Edge[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true;
  const adj = adjacency(deps);
  const seen = new Set<string>([successorId]);
  const queue = [successorId];
  for (let head = 0; head < queue.length; head++) {
    for (const w of adj.get(queue[head]!) ?? []) {
      if (w === predecessorId) return true;
      if (!seen.has(w)) {
        seen.add(w);
        queue.push(w);
      }
    }
  }
  return false;
}
