import { describe, expect, it } from 'vitest';
import { WorkCalendar, moveTask, resizeTask, toDayNumber } from '@nuzli/scheduling';
import type { GanttDto, TaskBatchInput, TaskDto } from '@nuzli/shared';
import { ApiError } from '../../api/errors';
import {
  barFor,
  barGeometry,
  buildRows,
  dayEndX,
  dayStartX,
  dayWindow,
  dragDeltaDays,
  makeScale,
  rowWindow,
  xToDay,
  ROW_HEIGHT,
} from './geometry';
import {
  batchPayload,
  checkNewLink,
  engineState,
  previewMove,
  previewResize,
  previewShiftWorkingDays,
  runOptimisticBatch,
} from './batch';
import { makeGantt } from './testData';

describe('RTL geometry (ADR-016)', () => {
  const s = makeScale(toDayNumber('2026-11-01'), toDayNumber('2026-11-30'), 'day');

  it('a later date has a smaller x; the chart starts at the right edge', () => {
    expect(dayStartX(s, s.startDay)).toBe(s.width);
    expect(dayStartX(s, toDayNumber('2026-11-10'))).toBeLessThan(dayStartX(s, toDayNumber('2026-11-09')));
    expect(dayEndX(s, toDayNumber('2026-11-09'))).toBe(dayStartX(s, toDayNumber('2026-11-10')));
    expect(xToDay(s, dayStartX(s, toDayNumber('2026-11-15')) - 1)).toBe(toDayNumber('2026-11-15'));
  });

  it('a bar spans from its end (left) to its start (right)', () => {
    const g = makeGantt(1, 2);
    const rows = buildRows(g.tasks, new Set());
    const leaf = rows[1]!;
    const bar = barFor(leaf, leaf.task, s);
    expect(bar.startX).toBeGreaterThan(bar.endX);
    expect(bar.x).toBe(bar.endX);
    expect(bar.w).toBeCloseTo((leaf.task.durationDays + 0) * s.dayWidth, 0);
    expect(bar.y).toBeGreaterThan(ROW_HEIGHT);
  });

  it('dragging LEFT means later in RTL', () => {
    expect(dragDeltaDays(-3 * s.dayWidth, s.dayWidth)).toBe(3);
    expect(dragDeltaDays(2 * s.dayWidth, s.dayWidth)).toBe(-2);
    expect(dragDeltaDays(-3 * s.dayWidth, s.dayWidth, 1)).toBe(-3); // LTR would be earlier
    expect(dragDeltaDays(4, s.dayWidth)).toBe(0);
  });

  it('collapsing a group hides its descendants', () => {
    const g = makeGantt(3, 4);
    expect(buildRows(g.tasks, new Set())).toHaveLength(15);
    const rows = buildRows(g.tasks, new Set(['g1']));
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.index)).toEqual([...Array(11).keys()]);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[1]!.depth).toBe(1);
  });

  it('the row window is bounded by the viewport', () => {
    expect(rowWindow(0, 720, 2000)).toEqual({ first: 0, last: 28 });
    const w = rowWindow(36 * 1000, 720, 2000);
    expect(w.last - w.first).toBeLessThanOrEqual(40);
    const days = dayWindow(0, 800, s);
    expect(days.toDay).toBe(s.endDay); // the physical left edge is the latest day
  });
});

describe('render model performance (2,000 tasks)', () => {
  it('row + bar geometry for 2,000 tasks takes < 16 ms', () => {
    const g = makeGantt(200, 9);
    expect(g.tasks).toHaveLength(2000);
    const s = makeScale(toDayNumber('2026-10-01'), toDayNumber('2027-06-30'), 'week');
    // warm-up (JIT)
    for (let i = 0; i < 3; i++) barGeometry(buildRows(g.tasks, new Set()), s);
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      const rows = buildRows(g.tasks, new Set());
      barGeometry(rows, s);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[4]!;
    console.info(`gantt render model, 2,000 tasks: median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(16);
  });
});

describe('drag preview = engine output (brief §6.4)', () => {
  const g = makeGantt(2, 4);
  const state = engineState(g);
  const first = g.tasks.find((t) => t.id === 't1')!;

  it('move preview equals moveTask from @nuzli/scheduling', () => {
    const p = previewMove(state, first, 3);
    const engine = moveTask({ ...state }, first.id, '2026-11-04');
    expect(p.changes).toEqual(engine.changes);
    // The chain t1 → t2 → t3 → t4 shifts, skipping Friday/Saturday.
    expect(p.byId.get('t2')!.startDate > first.endDate).toBe(true);
    for (const t of p.changes) {
      const day = new Date(`${t.startDate}T00:00:00Z`).getUTCDay();
      expect([5, 6]).not.toContain(day);
    }
  });

  it('resize preview equals resizeTask; keyboard shift moves by working days', () => {
    const p = previewResize(state, first, 2);
    expect(p.changes).toEqual(resizeTask({ ...state }, first.id, '2026-11-03').changes);
    const k = previewShiftWorkingDays(state, first, 1);
    expect(k.byId.get('t1')!.startDate).toBe(new WorkCalendar({ weekendDays: [5, 6] }).addWorkingDays(first.startDate, 1));
  });

  it('the batch payload holds exactly the changed tasks with their read versions', () => {
    const p = previewMove(state, first, 3);
    const original = new Map(g.tasks.map((t) => [t.id, { ...t, version: t.id === 't2' ? 7 : t.version }]));
    const body = batchPayload(p.changes, original);
    expect(body.changes.map((c) => c.id)).toEqual(p.changes.map((t) => t.id));
    expect(body.changes.find((c) => c.id === 't2')!.version).toBe(7);
    // Untouched tasks are not sent.
    expect(body.changes.some((c) => c.id === 't5')).toBe(false);
    for (const c of body.changes) expect(Object.keys(c).sort()).toEqual(['durationDays', 'endDate', 'id', 'startDate', 'version']);
  });
});

describe('optimistic batch with rollback (ADR-017)', () => {
  const setup = () => {
    let cache: GanttDto | undefined = makeGantt(1, 3);
    const states: GanttDto[] = [];
    return {
      get: () => cache,
      set: (x: GanttDto) => {
        cache = x;
        states.push(x);
      },
      states,
    };
  };

  it('409 restores the snapshot and reports a conflict', async () => {
    const c = setup();
    const before = c.get()!;
    const p = previewMove(engineState(before), before.tasks.find((t) => t.id === 't1')!, 2);
    const sent: TaskBatchInput[] = [];
    const out = await runOptimisticBatch({
      ...c,
      changes: p.changes,
      send: async (body) => {
        sent.push(body);
        // The optimistic state is visible while the request is in flight.
        expect(c.get()!.tasks.find((t) => t.id === 't1')!.startDate).toBe(p.byId.get('t1')!.startDate);
        throw ApiError.of('CONFLICT_VERSION', 409, { refresh: 'tasks', conflicts: [{ id: 't1', currentVersion: 2 }] });
      },
    });
    expect(sent).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, conflict: true });
    expect(c.get()).toBe(before);
  });

  it('success applies the server answer (new versions)', async () => {
    const c = setup();
    const before = c.get()!;
    const p = previewMove(engineState(before), before.tasks.find((t) => t.id === 't1')!, 2);
    const out = await runOptimisticBatch({
      ...c,
      changes: p.changes,
      send: async (body) => ({ tasks: body.changes.map((x) => ({ ...p.byId.get(x.id)!, version: x.version + 1 }) as TaskDto) }),
    });
    expect(out.ok).toBe(true);
    expect(c.get()!.tasks.find((t) => t.id === 't1')!.version).toBe(2);
  });
});

describe('dependency validation', () => {
  it('rejects self, existing and cyclic links with the path', () => {
    const g = makeGantt(1, 3);
    const state = engineState(g);
    expect(checkNewLink(state, 't1', 't1')).toMatchObject({ ok: false, reason: 'self' });
    expect(checkNewLink(state, 't1', 't2')).toMatchObject({ ok: false, reason: 'exists' });
    const cyc = checkNewLink(state, 't3', 't1');
    expect(cyc).toMatchObject({ ok: false, reason: 'cycle' });
    expect((cyc as { path: string[] }).path).toEqual(['t3', 't1', 't2', 't3']);
    // A link to one's own group is a cycle in the engine.
    expect(checkNewLink(state, 't1', 'g0')).toMatchObject({ ok: false, reason: 'cycle' });
    expect(checkNewLink(state, 't1', 't3')).toEqual({ ok: true });
  });
});
