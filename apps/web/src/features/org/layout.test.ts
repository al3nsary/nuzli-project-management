import { describe, expect, it } from 'vitest';
import type { OrgUnitDto } from '@nuzli/shared';
import { CHART, buildForest, canMoveUnit, fitScale, layoutChart, sortAfterLast, subtreeIds, visibleRows } from './layout';
import { nextSort, orderTree, wouldCreateCycle } from './tree';

const unit = (id: string, parentId: string | null, sort: number, extra: Partial<OrgUnitDto> = {}): OrgUnitDto => ({
  id,
  parentId,
  name: id,
  kind: 'UNIT',
  code: null,
  sort,
  archivedAt: null,
  positions: [],
  teams: [],
  ...extra,
});

// إدارة › (قسم أ › وحدة 1، وحدة 2) ، (قسم ب)
const UNITS = [unit('dept', null, 1), unit('a', 'dept', 1), unit('b', 'dept', 2), unit('a1', 'a', 1), unit('a2', 'a', 2)];

describe('org tree helpers (ported from apps/api org-tree.ts)', () => {
  it('a node under itself or a descendant is a cycle; anywhere else is fine', () => {
    const parentOf = new Map(UNITS.map((u) => [u.id, u.parentId]));
    expect(wouldCreateCycle(parentOf, 'dept', 'a1')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'a1', 'b')).toBe(false);
    expect(wouldCreateCycle(parentOf, 'a', null)).toBe(false);
    expect(nextSort([1, 2.5])).toBe(3);
    expect(orderTree(UNITS.map((u) => ({ ...u })).reverse()).map((u) => u.id)).toEqual(['dept', 'a', 'a1', 'a2', 'b']);
  });

  it('client checks match the API: canMoveUnit refuses the subtree, subtreeIds, sortAfterLast', () => {
    expect([...subtreeIds(UNITS, 'a')].sort()).toEqual(['a', 'a1', 'a2']);
    expect(canMoveUnit(UNITS, 'a', 'a2')).toBe(false);
    expect(canMoveUnit(UNITS, 'a', 'b')).toBe(true);
    expect(canMoveUnit(UNITS, 'dept', null)).toBe(true);
    expect(sortAfterLast(UNITS, 'a')).toBe(3);
    expect(sortAfterLast(UNITS, 'b')).toBe(1);
  });
});

describe('forest, visible rows and the chart layout', () => {
  it('builds the forest with depths; collapsed nodes hide their subtree', () => {
    const forest = buildForest(UNITS);
    expect(forest.map((n) => n.unit.id)).toEqual(['dept']);
    expect(forest[0]!.children.map((n) => n.unit.id)).toEqual(['a', 'b']);
    expect(forest[0]!.children[0]!.children[1]!.depth).toBe(2);
    expect(visibleRows(forest, new Set()).map((n) => n.unit.id)).toEqual(['dept', 'a', 'a1', 'a2', 'b']);
    expect(visibleRows(forest, new Set(['a'])).map((n) => n.unit.id)).toEqual(['dept', 'a', 'b']);
  });

  it('lays out top-down; parents centred over children; RTL mirrors x (first child on the right)', () => {
    const forest = buildForest(UNITS);
    const ltr = layoutChart(forest, 1);
    const rtl = layoutChart(forest, -1);
    const box = (l: typeof ltr, id: string) => l.boxes.find((b) => b.id === id)!;
    expect(ltr.width).toBe(rtl.width);
    // Rows: depth 0 above depth 1 above depth 2.
    expect(box(ltr, 'dept').y).toBeLessThan(box(ltr, 'a').y);
    expect(box(ltr, 'a').y).toBeLessThan(box(ltr, 'a1').y);
    // LTR: «a» left of «b»; RTL: «a» right of «b» (mirrored once from logical x).
    expect(box(ltr, 'a').x).toBeLessThan(box(ltr, 'b').x);
    expect(box(rtl, 'a').x).toBeGreaterThan(box(rtl, 'b').x);
    for (const id of ['dept', 'a', 'b', 'a1', 'a2']) {
      expect(box(rtl, id).x).toBeCloseTo(rtl.width - box(ltr, id).x - CHART.nodeWidth, 6);
    }
    // A parent sits centred over its children.
    const centre = (b: { x: number }) => b.x + CHART.nodeWidth / 2;
    expect(centre(box(ltr, 'a'))).toBeCloseTo((centre(box(ltr, 'a1')) + centre(box(ltr, 'a2'))) / 2, 6);
    // One edge per child, from the parent's bottom to the child's top.
    expect(ltr.edges).toHaveLength(4);
    expect(fitScale(ltr, { width: ltr.width / 2, height: 10_000 })).toBeLessThan(1);
    expect(fitScale(ltr, { width: 10_000, height: 10_000 })).toBe(1);
  });
});
