import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayKind,
  deadlinesByDay,
  diffDays,
  dragDeltaColumns,
  dragDeltaDays,
  initialAnchor,
  itemsOnDay,
  layoutWeek,
  monthGrid,
  nearestOutside,
  startOfWeek,
  stepAnchor,
  taskDays,
  weekDays,
  weekdayOf,
} from './calendarMath';
import { previewCalendarMove } from './drag';
import { batchPayload, engineState } from '../gantt/batch';
import { makeGantt } from '../gantt/testData';

describe('calendar date math', () => {
  it('month grid starts on Sunday and covers whole weeks', () => {
    const oct = monthGrid('2026-10-19');
    expect(oct).toHaveLength(5);
    expect(oct[0]![0]).toBe('2026-09-27');
    expect(oct[4]![6]).toBe('2026-10-31');
    for (const w of oct) {
      expect(w).toHaveLength(7);
      expect(weekdayOf(w[0]!)).toBe(0);
      expect(weekdayOf(w[6]!)).toBe(6);
    }
    // contiguous days
    const flat = oct.flat();
    for (let i = 1; i < flat.length; i++) expect(diffDays(flat[i - 1]!, flat[i]!)).toBe(1);
    // February 2026 begins on a Sunday and ends on a Saturday: exactly four rows.
    const feb = monthGrid('2026-02-10');
    expect(feb).toHaveLength(4);
    expect(feb[0]![0]).toBe('2026-02-01');
    expect(feb[3]![6]).toBe('2026-02-28');
  });

  it('week ranges are Sunday → Saturday', () => {
    expect(startOfWeek('2026-10-19')).toBe('2026-10-18');
    expect(startOfWeek('2026-10-18')).toBe('2026-10-18');
    expect(startOfWeek('2026-10-24')).toBe('2026-10-18');
    expect(weekDays('2026-10-21')).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  });

  it('navigation steps by month and week (across years)', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-01');
    expect(stepAnchor('month', '2026-10-19', 1)).toBe('2026-11-01');
    expect(stepAnchor('week', '2026-10-21', -1)).toBe('2026-10-11');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('RTL: a physical drag to the left moves to later days; LTR the opposite', () => {
    const cell = 100;
    expect(dragDeltaColumns(-210, cell, -1)).toBe(2); // RTL, dragged left two cells
    expect(dragDeltaColumns(210, cell, -1)).toBe(-2); // RTL, dragged right
    expect(dragDeltaColumns(210, cell, 1)).toBe(2); // LTR, dragged right
    expect(dragDeltaColumns(40, cell, -1)).toBe(0);
    expect(Object.is(dragDeltaColumns(-10, cell, 1), -0)).toBe(false);
    // crossing a week row adds seven days
    expect(dragDeltaDays(-1, 1)).toBe(6);
    expect(dragDeltaDays(2, -1)).toBe(-5);
  });

  it('column order is logical: Sunday is column 0 (the inline start, the right in RTL)', () => {
    const week = weekDays('2026-10-18');
    const lay = layoutWeek(week, [{ id: 'a', start: '2026-10-18', end: '2026-10-18' }, { id: 'b', start: '2026-10-24', end: '2026-10-24' }]);
    expect(lay.segments.find((s) => s.id === 'a')!.colStart).toBe(0);
    expect(lay.segments.find((s) => s.id === 'b')!.colStart).toBe(6);
  });
});

describe('lane packing', () => {
  const week = weekDays('2026-10-18');

  it('never overlaps bars and reuses free lanes', () => {
    const lay = layoutWeek(week, [
      { id: 'long', start: '2026-10-18', end: '2026-10-22' },
      { id: 'early', start: '2026-10-18', end: '2026-10-19' },
      { id: 'late', start: '2026-10-20', end: '2026-10-21' },
      { id: 'end', start: '2026-10-23', end: '2026-10-24' },
    ]);
    const lane = (id: string) => lay.segments.find((s) => s.id === id)!.lane;
    expect(lane('long')).toBe(0);
    expect(lane('end')).toBe(0); // starts after «long» ends
    expect(lane('early')).toBe(1);
    expect(lane('late')).toBe(1); // reuses lane 1 after «early»
    expect(lay.lanes).toBe(2);
    for (const a of lay.segments)
      for (const b of lay.segments)
        if (a !== b && a.lane === b.lane) expect(a.colEnd < b.colStart || b.colEnd < a.colStart).toBe(true);
  });

  it('clips multi-week items and marks the cut edges', () => {
    const lay = layoutWeek(week, [{ id: 'x', start: '2026-10-10', end: '2026-10-30' }, { id: 'y', start: '2026-10-01', end: '2026-10-05' }]);
    expect(lay.segments).toHaveLength(1);
    expect(lay.segments[0]).toMatchObject({ colStart: 0, colEnd: 6, continuesBefore: true, continuesAfter: true });
  });

  it('reports «+N» overflow per day beyond the lane limit', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, start: '2026-10-20', end: '2026-10-21' }));
    const lay = layoutWeek(week, items, 3);
    expect(lay.lanes).toBe(5);
    expect(lay.hidden[2]).toEqual(['d', 'e']);
    expect(lay.hidden[3]).toEqual(['d', 'e']);
    expect(lay.hidden[0]).toEqual([]);
    expect(itemsOnDay(items, '2026-10-21')).toHaveLength(5);
  });
});

describe('task days', () => {
  it('DAY projects: inclusive end', () => {
    expect(taskDays({ startDate: '2026-10-18', endDate: '2026-10-20' }, 'DAY')).toEqual({ start: '2026-10-18', end: '2026-10-20' });
  });
  it('HOUR projects: exclusive end — ending at 00:00 ends the previous day', () => {
    expect(taskDays({ startDate: '2026-10-18T09:00', endDate: '2026-10-20T00:00' }, 'HOUR')).toEqual({ start: '2026-10-18', end: '2026-10-19' });
    expect(taskDays({ startDate: '2026-10-18T09:00', endDate: '2026-10-18T13:00' }, 'HOUR')).toEqual({ start: '2026-10-18', end: '2026-10-18' });
    expect(taskDays({ startDate: '2026-10-18T14:00', endDate: '2026-10-19T11:00' }, 'HOUR')).toEqual({ start: '2026-10-18', end: '2026-10-19' });
    // a zero-length bar at midnight stays on its day
    expect(taskDays({ startDate: '2026-10-18T00:00', endDate: '2026-10-18T00:00' }, 'HOUR')).toEqual({ start: '2026-10-18', end: '2026-10-18' });
  });
  it('milestones sit on their start day', () => {
    expect(taskDays({ startDate: '2026-10-18', endDate: '2026-10-22', type: 'MILESTONE' }, 'DAY')).toEqual({ start: '2026-10-18', end: '2026-10-18' });
  });
});

describe('deadlines, weekend and holidays', () => {
  it('flags deadlines per day, red when passed (API flag first, rule as fallback)', () => {
    const m = deadlinesByDay(
      [
        { id: 'a', deadline: '2026-10-10', status: 'IN_PROGRESS' },
        { id: 'b', deadline: '2026-10-10', status: 'DONE' },
        { id: 'c', deadline: '2026-10-25', status: 'NOT_STARTED' },
        { id: 'd', deadline: '2026-10-25', status: 'NOT_STARTED', deadlinePassed: true },
        { id: 'e', deadline: null, status: 'NOT_STARTED' },
      ],
      '2026-10-19',
    );
    expect(m.get('2026-10-10')).toEqual([
      { id: 'a', passed: true },
      { id: 'b', passed: false },
    ]);
    expect(m.get('2026-10-25')).toEqual([
      { id: 'c', passed: false },
      { id: 'd', passed: true },
    ]);
    expect(m.size).toBe(2);
  });

  it('shades Friday/Saturday and named holidays; a working exception clears the weekend', () => {
    const cal = {
      weekendDays: [5, 6],
      exceptions: [
        { date: '2026-10-21', isWorking: false, name: 'إجازة' },
        { date: '2026-10-23', isWorking: true, name: 'يوم عمل' },
      ],
    };
    expect(dayKind('2026-10-24', cal)).toMatchObject({ weekend: true, holiday: null });
    expect(dayKind('2026-10-23', cal)).toMatchObject({ weekend: false, workingException: true });
    expect(dayKind('2026-10-21', cal)).toMatchObject({ weekend: false, holiday: 'إجازة' });
    expect(dayKind('2026-10-19', cal)).toMatchObject({ weekend: false, holiday: null });
  });

  it('opens on today inside the project, otherwise on its nearest edge; finds the nearest task outside a range', () => {
    const spans = [
      { id: 'a', start: '2026-11-03', end: '2026-11-10' },
      { id: 'b', start: '2026-12-01', end: '2026-12-05' },
    ];
    expect(initialAnchor(spans, '2026-11-05')).toBe('2026-11-05');
    expect(initialAnchor(spans, '2026-10-19')).toBe('2026-11-03');
    expect(initialAnchor(spans, '2027-01-19')).toBe('2026-12-05');
    expect(initialAnchor([], '2026-10-19')).toBe('2026-10-19');
    expect(nearestOutside(spans, '2026-10-01', '2026-10-31')).toBe('2026-11-03');
    expect(nearestOutside(spans, '2026-11-15', '2026-11-20')).toBe('2026-11-10');
    expect(nearestOutside(spans, '2026-11-20', '2026-11-28')).toBe('2026-12-01');
  });
});

describe('drag → batch', () => {
  it('a moved bar produces the engine changes (one batch with read versions)', () => {
    const g = makeGantt(1, 3);
    const state = engineState(g);
    const t1 = g.tasks.find((t) => t.id === 't1')!;
    const p = previewCalendarMove(g, state, t1, 2);
    const moved = p.byId.get('t1')!;
    expect(moved.startDate > t1.startDate).toBe(true);
    // FS successors shift with it (auto-schedule), and the group rolls up.
    expect(p.byId.has('t2')).toBe(true);
    const body = batchPayload(p.changes, new Map(g.tasks.map((t) => [t.id, t])));
    expect(body.changes.find((c) => c.id === 't1')).toMatchObject({ version: 1, startDate: moved.startDate, endDate: moved.endDate });
    expect(body.changes.length).toBe(p.changes.length);
  });

  it('moving a group moves its children', () => {
    const g = makeGantt(2, 2);
    const state = engineState(g);
    const g1 = g.tasks.find((t) => t.id === 'g1')!;
    const kids = g.tasks.filter((t) => t.parentId === 'g1');
    const p = previewCalendarMove(g, state, g1, 7);
    for (const k of kids) {
      const after = p.byId.get(k.id);
      expect(after, k.id).toBeDefined();
      expect(diffDays(k.startDate, after!.startDate)).toBeGreaterThanOrEqual(7);
    }
  });

  it('no movement → no batch', () => {
    const g = makeGantt(1, 2);
    expect(previewCalendarMove(g, engineState(g), g.tasks[1]!, 0).changes).toEqual([]);
  });

  it('HOUR projects move by whole days of wall-clock minutes', () => {
    const base = makeGantt(1, 1);
    const leaf = base.tasks.find((t) => t.type === 'TASK')!;
    const g = {
      ...base,
      project: { ...base.project, durationUnit: 'HOUR' as const, autoSchedule: false },
      tasks: base.tasks.map((t) =>
        t.id === leaf.id
          ? { ...t, startDate: '2026-11-02T09:00', endDate: '2026-11-02T13:00', durationHours: 4 }
          : { ...t, startDate: '2026-11-02T09:00', endDate: '2026-11-02T13:00' },
      ),
    };
    const p = previewCalendarMove(g, engineState(g), g.tasks.find((t) => t.id === leaf.id)!, 1);
    const moved = p.byId.get(leaf.id);
    expect(moved?.startDate.slice(0, 16)).toBe('2026-11-03T09:00');
  });
});
