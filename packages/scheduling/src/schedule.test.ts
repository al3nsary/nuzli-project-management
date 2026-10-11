import { describe, expect, it } from 'vitest';
import { WorkCalendar, type Calendar } from './calendar';
import { CycleError, TaskEditError } from './errors';
import { moveTask, resizeTask, schedule } from './schedule';
import { byId, fs, group, task } from './test-helpers';
import type { ScheduleDependency } from './types';

// October 2026: Thu 01, Fri 02, Sat 03, Sun 04 … Thu 08, Fri 09, Sat 10, Sun 11, Mon 12, Tue 13.
const FRI_SAT: Calendar = { weekendDays: [5, 6], exceptions: [] };
const WITH_HOLIDAY: Calendar = {
  weekendDays: [5, 6],
  exceptions: [{ date: '2026-10-12', isWorking: false }],
};

describe('schedule — FS propagation', () => {
  it('acceptance: delaying a task shifts FS successors over Fri/Sat and a holiday', () => {
    const c = WITH_HOLIDAY;
    const tasks = [
      task('A', '2026-10-04', 4, { calendar: c }), // Sun 4 – Wed 7
      task('B', '2026-10-08', 2, { calendar: c }), // Thu 8 – Sun 11
      task('C', '2026-10-13', 1, { calendar: c }), // Tue 13
    ];
    const dependencies = [fs('A', 'B'), fs('B', 'C')];
    // Consistent to start with: nothing moves.
    expect(schedule({ tasks, dependencies, calendar: c, autoSchedule: true }).changedIds).toEqual(
      [],
    );

    const r = moveTask({ tasks, dependencies, calendar: c, autoSchedule: true }, 'A', '2026-10-05');
    const out = byId(r.tasks);
    expect(out.A).toMatchObject({
      startDate: '2026-10-05',
      endDate: '2026-10-08',
      durationDays: 4,
    });
    // Next working day after Thu 8 is Sun 11; 2 working days skip the Mon 12 holiday.
    expect(out.B).toMatchObject({
      startDate: '2026-10-11',
      endDate: '2026-10-13',
      durationDays: 2,
    });
    expect(out.C).toMatchObject({
      startDate: '2026-10-14',
      endDate: '2026-10-14',
      durationDays: 1,
    });
    expect(r.changedIds).toEqual(['A', 'B', 'C']);
    expect(r.changes.map((t) => t.id)).toEqual(['A', 'B', 'C']);
  });

  it('applies a positive lag in working days', () => {
    const tasks = [task('A', '2026-10-05', 4), task('B', '2026-10-01', 1)]; // A: Mon 5 – Thu 8
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'B', 2)],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    // Thu 8 → Sun 11 (+1) → Mon 12, Tue 13 (lag 2)
    expect(byId(r.tasks).B).toMatchObject({ startDate: '2026-10-13', endDate: '2026-10-13' });
  });

  it('applies a lead (negative lag)', () => {
    const tasks = [
      task('A', '2026-10-05', 4),
      task('B', '2026-10-01', 2),
      task('C', '2026-10-01', 1),
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'B', -1), fs('A', 'C', -2)],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    const out = byId(r.tasks);
    expect(out.B).toMatchObject({ startDate: '2026-10-08', endDate: '2026-10-11' }); // overlaps A's last day
    expect(out.C).toMatchObject({ startDate: '2026-10-07', endDate: '2026-10-07' });
  });

  it('shifts forward only: a successor that is already later stays put', () => {
    const tasks = [task('A', '2026-10-05', 4), task('B', '2026-10-20', 2)];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'B')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    expect(r.changedIds).toEqual([]);
    expect(r.tasks[1]).toBe(tasks[1]);
  });

  it('takes the latest of several predecessors', () => {
    const tasks = [
      task('A', '2026-10-04', 1),
      task('B', '2026-10-04', 5),
      task('C', '2026-10-01', 1),
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'C'), fs('B', 'C')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    expect(byId(r.tasks).C!.startDate).toBe('2026-10-11'); // B ends Thu 8
  });

  it('keeps milestones at duration 0, as successor and as predecessor', () => {
    const tasks = [
      task('A', '2026-10-05', 4),
      task('M', '2026-10-01', 0),
      task('B', '2026-10-01', 2),
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'M'), fs('M', 'B')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    const out = byId(r.tasks);
    expect(out.M).toMatchObject({
      type: 'MILESTONE',
      startDate: '2026-10-11',
      endDate: '2026-10-11',
      durationDays: 0,
    });
    expect(out.B).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-13' });
  });

  it('honours a working-Saturday exception while shifting', () => {
    const cal: Calendar = {
      weekendDays: [5, 6],
      exceptions: [{ date: '2026-10-10', isWorking: true }],
    };
    const tasks = [
      task('A', '2026-10-05', 4, { calendar: cal }),
      task('B', '2026-10-01', 2, { calendar: cal }),
    ];
    const r = schedule({ tasks, dependencies: [fs('A', 'B')], calendar: cal, autoSchedule: true });
    expect(byId(r.tasks).B).toMatchObject({ startDate: '2026-10-10', endDate: '2026-10-11' });
  });

  it('ignores SS/FF/SF and unknown ids without crashing', () => {
    const tasks = [task('A', '2026-10-05', 4), task('B', '2026-10-01', 1)];
    const deps: ScheduleDependency[] = [
      { predecessorId: 'A', successorId: 'B', type: 'SS', lagDays: 0 },
      { predecessorId: 'A', successorId: 'B', type: 'FF', lagDays: 3 },
      { predecessorId: 'B', successorId: 'A', type: 'SF', lagDays: 0 },
      fs('ghost', 'B'),
      fs('A', 'ghost'),
    ];
    expect(
      schedule({ tasks, dependencies: deps, calendar: FRI_SAT, autoSchedule: true }).changedIds,
    ).toEqual([]);
  });

  it('preserves extra fields and identity of untouched tasks', () => {
    const tasks = [
      { ...task('A', '2026-10-05', 4), name: 'حفر', version: 3 },
      { ...task('B', '2026-10-01', 1), name: 'صب', version: 7 },
      { ...task('Z', '2026-10-01', 1), name: 'آخر', version: 1 },
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'B')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    expect(r.tasks[1]).toMatchObject({ name: 'صب', version: 7, startDate: '2026-10-11' });
    expect(r.tasks[0]).toBe(tasks[0]);
    expect(r.tasks[2]).toBe(tasks[2]);
  });

  it('accepts a prebuilt WorkCalendar and defaults to Fri/Sat when none is given', () => {
    const tasks = [task('A', '2026-10-05', 4), task('B', '2026-10-01', 1)];
    const a = schedule({ tasks, dependencies: [fs('A', 'B')], calendar: new WorkCalendar() });
    const b = schedule({ tasks, dependencies: [fs('A', 'B')] });
    expect(byId(a.tasks).B!.startDate).toBe('2026-10-11');
    expect(byId(b.tasks).B!.startDate).toBe('2026-10-11');
  });

  it('with `changed`, leaves unrelated pre-existing violations alone', () => {
    const tasks = [
      task('A', '2026-10-05', 4),
      task('B', '2026-10-01', 1), // violates A -> B
      task('X', '2026-10-04', 1),
      task('Y', '2026-10-01', 1), // violates X -> Y
    ];
    const deps = [fs('A', 'B'), fs('X', 'Y')];
    const r = schedule({
      tasks,
      dependencies: deps,
      calendar: FRI_SAT,
      autoSchedule: true,
      changed: ['X'],
    });
    expect(r.changedIds).toEqual(['Y']);
  });
});

describe('schedule — autoSchedule off', () => {
  it('only rolls up', () => {
    const tasks = [
      group('g'),
      task('A', '2026-10-05', 4, { parentId: 'g', progress: 50 }),
      task('B', '2026-10-01', 1, { parentId: 'g' }),
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'B')],
      calendar: FRI_SAT,
      autoSchedule: false,
    });
    expect(r.changedIds).toEqual(['g']);
    const out = byId(r.tasks);
    expect(out.B!.startDate).toBe('2026-10-01'); // violation kept
    expect(out.g).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-08', progress: 40 });
  });
});

describe('schedule — groups', () => {
  it('a group predecessor uses its rolled-up end', () => {
    const tasks = [
      group('G'),
      task('a', '2026-10-04', 2, { parentId: 'G' }), // Sun 4 – Mon 5
      task('b', '2026-10-04', 4, { parentId: 'G' }), // Sun 4 – Wed 7
      task('X', '2026-10-01', 1),
    ];
    const state = { tasks, dependencies: [fs('G', 'X')], calendar: FRI_SAT, autoSchedule: true };
    const r = schedule(state);
    expect(byId(r.tasks).X!.startDate).toBe('2026-10-08');
    expect(r.changedIds).toEqual(['G', 'X']);

    // Stretching a child stretches the group and pushes X.
    const settled = { ...state, tasks: r.tasks };
    const r2 = resizeTask(settled, 'b', '2026-10-11');
    const out = byId(r2.tasks);
    expect(out.b).toMatchObject({ endDate: '2026-10-11', durationDays: 6 });
    expect(out.G).toMatchObject({ endDate: '2026-10-11', durationDays: 6 });
    expect(out.X!.startDate).toBe('2026-10-12');
    expect(r2.changedIds).toEqual(['G', 'b', 'X']);
  });

  it('a group successor shifts every leaf by the same working-day delta', () => {
    const tasks = [
      task('P', '2026-10-05', 4), // Mon 5 – Thu 8
      group('G'),
      task('c', '2026-10-05', 1, { parentId: 'G' }), // Mon 5
      task('d', '2026-10-07', 2, { parentId: 'G' }), // Wed 7 – Thu 8
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('P', 'G')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    const out = byId(r.tasks);
    // G must start Sun 11: Mon 5 → Sun 11 is 4 working days, applied to every leaf.
    expect(out.c).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-11' });
    expect(out.d).toMatchObject({ startDate: '2026-10-13', endDate: '2026-10-14' });
    expect(out.G).toMatchObject({
      startDate: '2026-10-11',
      endDate: '2026-10-14',
      durationDays: 4,
    });
  });

  it('nested group shifts combine with the leaves own dependencies', () => {
    const tasks = [
      task('P', '2026-10-05', 4), // ends Thu 8
      group('G'),
      group('H', { parentId: 'G' }),
      task('h1', '2026-10-05', 1, { parentId: 'H' }),
      task('Q', '2026-10-11', 5), // Sun 11 – Thu 15
      task('h2', '2026-10-06', 1, { parentId: 'H' }),
    ];
    const r = schedule({
      tasks,
      dependencies: [fs('P', 'G'), fs('Q', 'h2')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    const out = byId(r.tasks);
    expect(out.h1!.startDate).toBe('2026-10-11'); // shifted with G by 4 working days
    expect(out.h2!.startDate).toBe('2026-10-18'); // its own predecessor Q wins
    expect(out.G).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-18' });
    expect(out.H).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-18' });
  });

  it('a chain through a deep (60-level) tree', () => {
    const tasks = [task('A', '2026-10-05', 4)];
    for (let k = 0; k < 60; k++) tasks.push(group(`g${k}`, { parentId: k ? `g${k - 1}` : null }));
    tasks.push(task('leaf', '2026-10-01', 2, { parentId: 'g59' }));
    tasks.push(task('Z', '2026-10-01', 1));
    const r = schedule({
      tasks,
      dependencies: [fs('A', 'g0'), fs('g0', 'Z')],
      calendar: FRI_SAT,
      autoSchedule: true,
    });
    const out = byId(r.tasks);
    expect(out.leaf).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-12' });
    expect(out.g0).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-12' });
    expect(out.g59).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-12' });
    expect(out.Z!.startDate).toBe('2026-10-13');
  });
});

describe('schedule — cycles', () => {
  it('throws CycleError with the path', () => {
    const tasks = [
      task('a', '2026-10-04', 1),
      task('b', '2026-10-04', 1),
      task('c', '2026-10-04', 1),
    ];
    const deps = [fs('a', 'b'), fs('b', 'c'), fs('c', 'a')];
    let err: unknown;
    try {
      schedule({ tasks, dependencies: deps, calendar: FRI_SAT, autoSchedule: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CycleError);
    const path = (err as CycleError).path;
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set(['a', 'b', 'c']));
    expect((err as CycleError).code).toBe('DEPENDENCY_CYCLE');
  });

  it('rejects a self-dependency and a dependency on an own ancestor', () => {
    const tasks = [group('g'), task('a', '2026-10-04', 1, { parentId: 'g' })];
    const run = (deps: ScheduleDependency[]) => () =>
      schedule({ tasks, dependencies: deps, calendar: FRI_SAT, autoSchedule: true });
    expect(run([fs('a', 'a')])).toThrow(CycleError);
    expect(run([fs('a', 'g')])).toThrow(CycleError);
    expect(run([fs('g', 'a')])).toThrow(CycleError);
  });

  it('does not throw for cycles only through non-FS types, nor when autoSchedule is off', () => {
    const tasks = [task('a', '2026-10-04', 1), task('b', '2026-10-04', 1)];
    const ss: ScheduleDependency = { predecessorId: 'b', successorId: 'a', type: 'SS', lagDays: 0 };
    expect(() =>
      schedule({ tasks, dependencies: [fs('a', 'b'), ss], calendar: FRI_SAT }),
    ).not.toThrow();
    expect(() =>
      schedule({
        tasks,
        dependencies: [fs('a', 'b'), fs('b', 'a')],
        calendar: FRI_SAT,
        autoSchedule: false,
      }),
    ).not.toThrow();
  });
});

describe('moveTask / resizeTask', () => {
  const base = () => ({
    tasks: [
      task('A', '2026-10-04', 2),
      task('B', '2026-10-06', 3),
      group('G'),
      task('g1', '2026-10-11', 2, { parentId: 'G' }),
    ],
    dependencies: [fs('A', 'B'), fs('B', 'G')],
    calendar: FRI_SAT,
    autoSchedule: true,
  });

  it('snaps a move onto a weekend forward to the next working day', () => {
    const state = { ...base(), tasks: schedule(base()).tasks };
    const r = moveTask(state, 'B', '2026-10-09'); // Friday
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-11',
      endDate: '2026-10-13',
      durationDays: 3,
    });
    expect(byId(r.tasks).g1).toMatchObject({ startDate: '2026-10-14', endDate: '2026-10-15' });
    expect(r.changedIds).toEqual(['B', 'G', 'g1']);
  });

  it('a move earlier than a predecessor allows is pushed back to the constraint', () => {
    const state = { ...base(), tasks: schedule(base()).tasks };
    const r = moveTask(state, 'B', '2026-10-01');
    expect(byId(r.tasks).B!.startDate).toBe('2026-10-06');
    expect(r.changedIds).toEqual([]);
  });

  it('moving a group shifts its leaves (both directions)', () => {
    const state = {
      ...base(),
      dependencies: [],
      tasks: schedule({ ...base(), dependencies: [] }).tasks,
    };
    const fwd = moveTask(state, 'G', '2026-10-13'); // Sun 11 → Tue 13 = +2 working days
    expect(byId(fwd.tasks).g1).toMatchObject({ startDate: '2026-10-13', endDate: '2026-10-14' });
    expect(byId(fwd.tasks).G).toMatchObject({ startDate: '2026-10-13', endDate: '2026-10-14' });
    const back = moveTask(state, 'G', '2026-10-07'); // Sun 11 → Wed 7 = -2 working days
    expect(byId(back.tasks).g1).toMatchObject({ startDate: '2026-10-07', endDate: '2026-10-08' });
  });

  it('moving a milestone keeps duration 0', () => {
    const state = {
      tasks: [task('M', '2026-10-04', 0)],
      dependencies: [],
      calendar: FRI_SAT,
      autoSchedule: true,
    };
    const r = moveTask(state, 'M', '2026-10-10');
    expect(r.changes).toEqual([
      expect.objectContaining({ startDate: '2026-10-11', endDate: '2026-10-11', durationDays: 0 }),
    ]);
  });

  it('resize snaps a weekend end back and never goes below 1 day', () => {
    const state = { ...base(), tasks: schedule(base()).tasks };
    const r = resizeTask(state, 'A', '2026-10-10'); // Sat → Thu 8
    expect(byId(r.tasks).A).toMatchObject({ endDate: '2026-10-08', durationDays: 5 });
    expect(byId(r.tasks).B).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-13' });
    const tiny = resizeTask(state, 'A', '2026-09-01');
    expect(byId(tiny.tasks).A).toMatchObject({
      startDate: '2026-10-04',
      endDate: '2026-10-04',
      durationDays: 1,
    });
  });

  it('rejects unknown ids, groups and milestones', () => {
    const state = base();
    expect(() => moveTask(state, 'nope', '2026-10-11')).toThrow(TaskEditError);
    expect(() => resizeTask(state, 'G', '2026-10-20')).toThrow(TaskEditError);
    expect(() =>
      resizeTask({ ...state, tasks: [task('M', '2026-10-04', 0)] }, 'M', '2026-10-20'),
    ).toThrow(TaskEditError);
  });
});
