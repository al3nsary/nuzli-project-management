// Ported verbatim from apps/api/src/org/org-tree.ts (ADR-102) — keep both in step.
/**
 * Pure helpers of the organisational structure (A9, ADR-102), unit-tested on their own.
 * Units form a tree through `parent_id`; positions form a reporting forest through
 * `reports_to_position_id`. Both must stay acyclic: a node may never be placed under itself or
 * under one of its descendants.
 */

/**
 * True when linking `nodeId` under `newParentId` would close a loop: walking up from the new
 * parent reaches the node. `parentOf` maps every node to its current parent (null = root).
 * A pre-existing loop elsewhere (should never happen) stops the walk instead of hanging.
 */
export function wouldCreateCycle(
  parentOf: ReadonlyMap<string, string | null>,
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === nodeId) return true;
  const seen = new Set<string>();
  let cur: string | null = newParentId;
  while (cur !== null) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** Every descendant id of `rootId` (not including it). */
export function descendantsOf(parentOf: ReadonlyMap<string, string | null>, rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, parent] of parentOf) {
    if (parent === null) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || id === rootId) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * Depth-first order: parents before children, siblings by `sort` then name. Nodes whose parent
 * is missing from the list (an archived parent filtered out) are treated as roots.
 */
export function orderTree<T extends { id: string; parentId: string | null; sort: number; name: string }>(nodes: readonly T[]): T[] {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string | null, T[]>();
  for (const n of nodes) {
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ar'));
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const n of byParent.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      walk(n.id);
    }
  };
  walk(null);
  return out;
}

/** The sort value that places a new node after its last sibling. */
export function nextSort(siblingSorts: readonly number[]): number {
  return siblingSorts.length ? Math.floor(Math.max(...siblingSorts)) + 1 : 1;
}
