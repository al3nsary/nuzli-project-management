import { describe, expect, it } from 'vitest';
import { detectCycle, wouldCreateCycle } from './cycles';
import { HierarchyError } from './errors';
import { rollUp } from './rollup';
import { byId, fs, group, task } from './test-helpers';
import { computeWbs } from './wbs';

describe('computeWbs', () => {
  it('numbers roots and children by sortOrder', () => {
    const tasks = [
      group('g1', { sortOrder: 1 }),
      group('g2', { sortOrder: 2 }),
      task('a', '2026-10-11', 1, { parentId: 'g1', sortOrder: 2 }),
      task('b', '2026-10-11', 1, { parentId: 'g1', sortOrder: 1 }),
      task('c', '2026-10-11', 1, { parentId: 'g2', sortOrder: 5 }),
      task('d', '2026-10-11', 1, { parentId: 'b', sortOrder: 0 }),
    ];
    expect(Object.fromEntries(computeWbs(tasks))).toEqual({
      g1: '1',
      g2: '2',
      b: '1.1',
      a: '1.2',
      d: '1.1.1',
      c: '2.1',
    });
  });

  it('renumbers after reordering and breaks ties by id', () => {
    const tasks = [
      group('g1', { sortOrder: 1 }),
      group('g2', { sortOrder: 2 }),
      task('x', '2026-10-11', 1, { parentId: 'g1', sortOrder: 1 }),
      task('y', '2026-10-11', 1, { parentId: 'g1', sortOrder: 2 }),
    ];
    const reordered = tasks.map((t) =>
      t.id === 'g1' ? { ...t, sortOrder: 3 } : t.id === 'y' ? { ...t, sortOrder: 0 } : t,
    );
    expect(Object.fromEntries(computeWbs(reordered))).toEqual({
      g2: '1',
      g1: '2',
      y: '2.1',
      x: '2.2',
    });
    const ties = [task('b', '2026-10-11', 1), task('a', '2026-10-11', 1)];
    expect(computeWbs(ties).get('a')).toBe('1');
    expect(computeWbs(ties).get('b')).toBe('2');
  });

  it('treats a missing parent as a root and rejects parent loops', () => {
    expect(computeWbs([task('a', '2026-10-11', 1, { parentId: 'ghost' })]).get('a')).toBe('1');
    const loop = [
      task('a', '2026-10-11', 1, { parentId: 'b' }),
      task('b', '2026-10-11', 1, { parentId: 'a' }),
      task('c', '2026-10-11', 1),
    ];
    expect(() => computeWbs(loop)).toThrow(HierarchyError);
    expect(() => computeWbs([task('a', '2026-10-11', 1), task('a', '2026-10-11', 1)])).toThrow(
      RangeError,
    );
  });

  it('handles a 60-level deep tree', () => {
    const tasks = Array.from({ length: 60 }, (_, k) =>
      group(`g${k}`, { parentId: k ? `g${k - 1}` : null }),
    );
    tasks.push(task('leaf', '2026-10-11', 1, { parentId: 'g59' }));
    expect(computeWbs(tasks).get('leaf')).toBe(Array(61).fill('1').join('.'));
  });
});

describe('rollUp', () => {
  it('rolls dates, working-day duration and duration-weighted progress', () => {
    const tasks = [
      group('g'),
      task('a', '2026-10-04', 2, { parentId: 'g', progress: 100 }), // Sun 4 – Mon 5
      task('b', '2026-10-06', 6, { parentId: 'g', progress: 0 }), // Tue 6 – Tue 13
      task('m', '2026-10-15', 0, { parentId: 'g', progress: 0 }), // milestone weighs 0
    ];
    const { tasks: out, changedIds } = rollUp(tasks);
    const g = byId(out).g!;
    expect(g.startDate).toBe('2026-10-04');
    expect(g.endDate).toBe('2026-10-15');
    expect(g.durationDays).toBe(10);
    expect(g.progress).toBe(25); // (2·100 + 6·0) / 8
    expect(changedIds).toEqual(['g']);
    expect(out[1]).toBe(tasks[1]); // leaves untouched, same identity
  });

  it('uses the plain average when every child weighs 0', () => {
    const tasks = [
      group('g'),
      task('m1', '2026-10-11', 0, { parentId: 'g', progress: 100 }),
      task('m2', '2026-10-13', 0, { parentId: 'g', progress: 0 }),
    ];
    const g = byId(rollUp(tasks).tasks).g!;
    expect(g.progress).toBe(50);
    expect(g.startDate).toBe('2026-10-11');
    expect(g.endDate).toBe('2026-10-13');
  });

  it('is recursive: nested groups weigh by their rolled-up duration', () => {
    const tasks = [
      group('top'),
      group('sub', { parentId: 'top' }),
      task('a', '2026-10-11', 3, { parentId: 'sub', progress: 100 }),
      task('b', '2026-10-11', 1, { parentId: 'sub', progress: 0 }),
      task('c', '2026-10-18', 3, { parentId: 'top', progress: 0 }),
    ];
    const r = byId(rollUp(tasks).tasks);
    expect(r.sub!.durationDays).toBe(3);
    expect(r.sub!.progress).toBe(75); // (3·100 + 1·0) / 4
    expect(r.top!.startDate).toBe('2026-10-11');
    expect(r.top!.endDate).toBe('2026-10-20');
    expect(r.top!.progress).toBe(37.5); // (3·75 + 3·0) / 6
  });

  it('handles depth 60 (and 5,000) without recursion problems', () => {
    for (const depth of [60, 5000]) {
      const tasks = Array.from({ length: depth }, (_, k) =>
        group(`g${k}`, { parentId: k ? `g${k - 1}` : null }),
      );
      tasks.push(task('leaf', '2026-10-11', 4, { parentId: `g${depth - 1}`, progress: 40 }));
      const out = byId(rollUp(tasks).tasks);
      expect(out.g0!.startDate).toBe('2026-10-11');
      expect(out.g0!.endDate).toBe('2026-10-14');
      expect(out.g0!.durationDays).toBe(4);
      expect(out.g0!.progress).toBe(40);
    }
  });

  it('reports nothing when groups are already consistent', () => {
    const first = rollUp([
      group('g'),
      task('a', '2026-10-11', 2, { parentId: 'g', progress: 10 }),
    ]).tasks;
    expect(rollUp(first).changedIds).toEqual([]);
  });
});

describe('cycle detection', () => {
  const chain = [fs('a', 'b'), fs('b', 'c')];

  it('returns null for an acyclic graph', () => {
    expect(detectCycle(chain)).toBeNull();
    expect(detectCycle([])).toBeNull();
  });

  it('finds a direct cycle', () => {
    expect(detectCycle([fs('a', 'b'), fs('b', 'a')])).toEqual(['a', 'b', 'a']);
  });

  it('finds an indirect cycle with its path', () => {
    expect(detectCycle([...chain, fs('c', 'a')])).toEqual(['a', 'b', 'c', 'a']);
    expect(detectCycle([fs('x', 'y'), ...chain], fs('c', 'a'))).toEqual(['c', 'a', 'b', 'c']);
  });

  it('finds a self-dependency', () => {
    expect(detectCycle([fs('a', 'a')])).toEqual(['a', 'a']);
    expect(detectCycle(chain, fs('b', 'b'))).toEqual(['b', 'b']);
  });

  it('counts all dependency types', () => {
    expect(
      detectCycle([fs('a', 'b'), { predecessorId: 'b', successorId: 'a', type: 'SS', lagDays: 0 }]),
    ).not.toBeNull();
  });

  it('wouldCreateCycle', () => {
    expect(wouldCreateCycle(chain, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(chain, 'b', 'a')).toBe(true);
    expect(wouldCreateCycle(chain, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(chain, 'a', 'c')).toBe(false);
    expect(wouldCreateCycle(chain, 'c', 'd')).toBe(false);
  });

  it('handles a 10,000-long chain iteratively', () => {
    const deps = Array.from({ length: 10_000 }, (_, k) => fs(`t${k}`, `t${k + 1}`));
    expect(detectCycle(deps)).toBeNull();
    expect(wouldCreateCycle(deps, 't10000', 't0')).toBe(true);
    expect(detectCycle(deps, fs('t10000', 't0'))?.length).toBe(10_002);
  });
});
