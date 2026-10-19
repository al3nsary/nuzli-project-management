import type { OrgUnitDto } from '@nuzli/shared';

/**
 * Pure helpers of the organisational structure screen (owner request A9, ADR-102): the tree built
 * from the flat `GET /org` list, client-side move checks (the API refuses the same moves with
 * ORG_CYCLE), and the top-down chart layout. The chart is laid out in *logical* x (from the
 * inline start) and converted to physical x once, with the direction sign (skill
 * nuzli-arabic-rtl): in RTL the first child is drawn on the right.
 */

export interface OrgNode {
  unit: OrgUnitDto;
  children: OrgNode[];
  depth: number;
}

/** Roots and children in the API order (parents first, siblings by sort). Orphans become roots. */
export function buildForest(units: readonly OrgUnitDto[]): OrgNode[] {
  const byId = new Map<string, OrgNode>();
  for (const u of units) byId.set(u.id, { unit: u, children: [], depth: 0 });
  const roots: OrgNode[] = [];
  for (const u of units) {
    const node = byId.get(u.id)!;
    const parent = u.parentId ? byId.get(u.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: OrgNode[], depth: number) => {
    list.sort((a, b) => a.unit.sort - b.unit.sort || a.unit.name.localeCompare(b.unit.name, 'ar'));
    for (const n of list) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

/** Depth-first rows of the visible tree (collapsed nodes hide their subtree). */
export function visibleRows(forest: readonly OrgNode[], collapsed: ReadonlySet<string>): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (list: readonly OrgNode[]) => {
    for (const n of list) {
      out.push(n);
      if (!collapsed.has(n.unit.id)) walk(n.children);
    }
  };
  walk(forest);
  return out;
}

/** Ids of `id` and everything under it. */
export function subtreeIds(units: readonly OrgUnitDto[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const u of units) {
    if (!u.parentId) continue;
    children.set(u.parentId, [...(children.get(u.parentId) ?? []), u.id]);
  }
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

/** Same rule as the API (ORG_CYCLE): a unit may not go under itself or under a descendant. */
export function canMoveUnit(units: readonly OrgUnitDto[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return true;
  return !subtreeIds(units, id).has(newParentId);
}

/** A sort value that places a node after the last sibling under `parentId` (the API's nextSort). */
export function sortAfterLast(units: readonly OrgUnitDto[], parentId: string | null, exceptId?: string): number {
  const sorts = units.filter((u) => u.parentId === parentId && u.id !== exceptId).map((u) => u.sort);
  return sorts.length ? Math.floor(Math.max(...sorts)) + 1 : 1;
}

// ---------------------------------------------------------------- chart layout

export const CHART = {
  nodeWidth: 248,
  headerHeight: 64,
  lineHeight: 24,
  maxLines: 4,
  footerHeight: 26,
  gapX: 28,
  gapY: 56,
  margin: 32,
};

export interface ChartBox {
  id: string;
  unit: OrgUnitDto;
  /** Physical left edge. */
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
}

export interface ChartLayout {
  boxes: ChartBox[];
  edges: Array<{ from: string; to: string; path: string }>;
  width: number;
  height: number;
}

/** Box height: header, up to `maxLines` positions (+1 line «و N أخرى»), and a teams footer. */
export function boxHeight(unit: OrgUnitDto): number {
  const lines = Math.min(CHART.maxLines, unit.positions.length) + (unit.positions.length > CHART.maxLines ? 1 : 0);
  return CHART.headerHeight + lines * CHART.lineHeight + (unit.teams.length ? CHART.footerHeight : 0) + 12;
}

/**
 * Top-down tidy layout: each subtree is as wide as the sum of its children's subtrees (or one
 * box); parents are centred over their children; rows share one y per depth (the tallest box of
 * the row). `dir` = -1 mirrors the logical x for RTL.
 */
export function layoutChart(forest: readonly OrgNode[], dir: 1 | -1): ChartLayout {
  const widthOf = new Map<string, number>();
  const measure = (n: OrgNode): number => {
    const own = CHART.nodeWidth;
    const kids = n.children.reduce((sum, c, i) => sum + measure(c) + (i ? CHART.gapX : 0), 0);
    const w = Math.max(own, kids);
    widthOf.set(n.unit.id, w);
    return w;
  };
  const total = forest.reduce((sum, n, i) => sum + measure(n) + (i ? CHART.gapX : 0), 0);

  // Row heights per depth.
  const rowH = new Map<number, number>();
  const walkH = (n: OrgNode) => {
    rowH.set(n.depth, Math.max(rowH.get(n.depth) ?? 0, boxHeight(n.unit)));
    n.children.forEach(walkH);
  };
  forest.forEach(walkH);
  const rowY = new Map<number, number>();
  let y = CHART.margin;
  for (let d = 0; rowH.has(d); d++) {
    rowY.set(d, y);
    y += rowH.get(d)! + CHART.gapY;
  }
  const height = y - CHART.gapY + CHART.margin;
  const width = total + CHART.margin * 2;

  const logical: Array<{ n: OrgNode; lx: number; parentId: string | null }> = [];
  const place = (n: OrgNode, start: number, parentId: string | null) => {
    const w = widthOf.get(n.unit.id)!;
    logical.push({ n, lx: start + (w - CHART.nodeWidth) / 2, parentId });
    let cur = start + (w - n.children.reduce((s, c, i) => s + widthOf.get(c.unit.id)! + (i ? CHART.gapX : 0), 0)) / 2;
    for (const c of n.children) {
      place(c, cur, n.unit.id);
      cur += widthOf.get(c.unit.id)! + CHART.gapX;
    }
  };
  let start = CHART.margin;
  for (const r of forest) {
    place(r, start, null);
    start += widthOf.get(r.unit.id)! + CHART.gapX;
  }
  // Logical → physical once (RTL: the inline start is on the right).
  const boxes: ChartBox[] = logical.map(({ n, lx, parentId }) => ({
    id: n.unit.id,
    unit: n.unit,
    x: dir === 1 ? lx : width - lx - CHART.nodeWidth,
    y: rowY.get(n.depth)!,
    width: CHART.nodeWidth,
    height: boxHeight(n.unit),
    parentId,
  }));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const edges = boxes
    .filter((b) => b.parentId && byId.has(b.parentId))
    .map((b) => {
      const p = byId.get(b.parentId!)!;
      const x1 = p.x + p.width / 2;
      const y1 = p.y + p.height;
      const x2 = b.x + b.width / 2;
      const y2 = b.y;
      const mid = y1 + (y2 - y1) / 2;
      return { from: p.id, to: b.id, path: `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}` };
    });
  return { boxes, edges, width, height };
}

/** Zoom that fits the whole chart into a viewport (never above 1). */
export function fitScale(chart: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (!chart.width || !chart.height) return 1;
  return Math.max(0.2, Math.min(1, (viewport.width - 16) / chart.width, (viewport.height - 16) / chart.height));
}
