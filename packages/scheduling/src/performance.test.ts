import { describe, expect, it } from 'vitest';
import { WorkCalendar } from './calendar';
import { moveTask, schedule } from './schedule';
import { computeWbs } from './wbs';
import type { ScheduleDependency, ScheduleTask } from './types';

// `performance` and `process` exist in Node and browsers but are not in the ES2022 lib typings.
const g = globalThis as unknown as {
  performance: { now(): number };
  process?: { env: Record<string, string | undefined> };
};
const env = g.process?.env ?? {};
/** 50 ms is the target; CI machines are slower and noisier, so `CI=1` (or SCHEDULING_PERF_BUDGET_MS) relaxes it. */
const BUDGET_MS = Number(env.SCHEDULING_PERF_BUDGET_MS ?? (env.CI ? 150 : 50));

function bigProject(): {
  tasks: ScheduleTask[];
  dependencies: ScheduleDependency[];
  calendar: WorkCalendar;
} {
  const calendar = new WorkCalendar({
    weekendDays: [5, 6],
    exceptions: [
      { date: '2027-02-22', isWorking: false },
      { date: '2027-09-23', isWorking: false },
      { date: '2027-03-30', isWorking: false },
      { date: '2027-03-31', isWorking: false },
    ],
  });
  const tasks: ScheduleTask[] = [];
  const dependencies: ScheduleDependency[] = [];
  let leaves = 0;
  let prev: string | null = null;
  for (let gi = 0; gi < 200; gi++) {
    const gid = `g${gi}`;
    tasks.push({
      id: gid,
      parentId: null,
      sortOrder: gi,
      type: 'GROUP',
      startDate: '2027-01-03',
      endDate: '2027-01-03',
      durationDays: 1,
      progress: 0,
    });
    for (let k = 0; k < 9; k++) {
      const id = `t${leaves++}`;
      const type = k === 8 ? 'MILESTONE' : 'TASK';
      const dur = type === 'MILESTONE' ? 0 : 1 + (leaves % 4);
      const start = '2027-01-03';
      tasks.push({
        id,
        parentId: gid,
        sortOrder: k,
        type,
        startDate: start,
        endDate: calendar.endFromDuration(start, dur),
        durationDays: dur,
        progress: (leaves * 7) % 101,
      });
      if (prev)
        dependencies.push({
          predecessorId: prev,
          successorId: id,
          type: 'FS',
          lagDays: leaves % 5 === 0 ? 1 : 0,
        });
      prev = id;
    }
  }
  return { tasks, dependencies, calendar };
}

describe('performance', () => {
  it('2,000 tasks / 200 groups / ~1,800 FS dependencies reschedule within budget', () => {
    const p = bigProject();
    expect(p.tasks.length).toBe(2000);
    expect(p.dependencies.length).toBe(1799);

    // First pass lays the whole chain out (every task moves).
    const t0 = g.performance.now();
    const settled = schedule({ ...p, autoSchedule: true });
    const cold = g.performance.now() - t0;
    expect(settled.changedIds.length).toBeGreaterThan(1900);

    // Delaying the very first task pushes all ~1,800 successors: the worst case for a drag.
    const state = { ...p, tasks: settled.tasks, autoSchedule: true };
    const runs: number[] = [];
    let changed = 0;
    for (let k = 0; k < 7; k++) {
      const s = g.performance.now();
      const r = moveTask(state, 't0', '2027-01-10');
      runs.push(g.performance.now() - s);
      changed = r.changes.length;
    }
    runs.sort((a, b) => a - b);
    const median = runs[3]!;

    const w0 = g.performance.now();
    computeWbs(settled.tasks);
    const wbs = g.performance.now() - w0;

    console.info(
      `[scheduling perf] cold schedule ${cold.toFixed(1)} ms; moveTask median ${median.toFixed(1)} ms ` +
        `(min ${runs[0]!.toFixed(1)}, max ${runs[6]!.toFixed(1)}); ${changed} tasks changed; WBS ${wbs.toFixed(1)} ms; budget ${BUDGET_MS} ms`,
    );
    expect(changed).toBeGreaterThan(1900);
    expect(median).toBeLessThan(BUDGET_MS);
    expect(cold).toBeLessThan(BUDGET_MS * 3);
  });
});

/** The same shape in an HOUR project: quarter-hour durations, hour lags, holidays and a short day. */
function bigHourProject(): {
  tasks: ScheduleTask[];
  dependencies: ScheduleDependency[];
  calendar: WorkCalendar;
} {
  const calendar = new WorkCalendar({
    weekendDays: [5, 6],
    exceptions: [
      { date: '2027-02-22', isWorking: false },
      { date: '2027-03-30', isWorking: false },
      { date: '2027-03-11', isWorking: true, workingHours: [{ start: '10:00', end: '15:00' }] },
      { date: '2027-04-03', isWorking: true, workingHours: [{ start: '08:00', end: '12:00' }] },
    ],
  });
  const tasks: ScheduleTask[] = [];
  const dependencies: ScheduleDependency[] = [];
  let leaves = 0;
  let prev: string | null = null;
  for (let gi = 0; gi < 200; gi++) {
    const gid = `g${gi}`;
    tasks.push({
      id: gid,
      parentId: null,
      sortOrder: gi,
      type: 'GROUP',
      startDate: '2027-01-03T09:00',
      endDate: '2027-01-03T09:00',
      durationDays: 1,
      progress: 0,
    });
    for (let k = 0; k < 9; k++) {
      const id = `t${leaves++}`;
      const type = k === 8 ? 'MILESTONE' : 'TASK';
      const hours = type === 'MILESTONE' ? 0 : 0.25 * (1 + (leaves % 24)); // 15 min … 6 h
      const start = '2027-01-03T09:00';
      tasks.push({
        id,
        parentId: gid,
        sortOrder: k,
        type,
        startDate: start,
        endDate: calendar.endFromDurationMinutes(start, Math.round(hours * 60)),
        durationDays: 1,
        durationHours: hours,
        progress: (leaves * 7) % 101,
      });
      if (prev)
        dependencies.push({
          predecessorId: prev,
          successorId: id,
          type: 'FS',
          lagDays: 0,
          lagHours: leaves % 5 === 0 ? 1.5 : leaves % 7 === 0 ? -0.5 : 0,
        });
      prev = id;
    }
  }
  return { tasks, dependencies, calendar };
}

describe('performance — HOUR projects', () => {
  it('2,000 tasks in working minutes reschedule within budget', () => {
    const p = bigHourProject();
    expect(p.tasks.length).toBe(2000);
    const base = { ...p, autoSchedule: true, durationUnit: 'HOUR' as const };

    const t0 = g.performance.now();
    const settled = schedule(base);
    const cold = g.performance.now() - t0;
    expect(settled.changedIds.length).toBeGreaterThan(1900);
    // The chain spans months, across weekends, holidays and special-hours days.
    const last = settled.tasks[settled.tasks.length - 1]!;
    expect(last.startDate > '2027-03-01').toBe(true);

    const state = { ...base, tasks: settled.tasks };
    const runs: number[] = [];
    let changed = 0;
    for (let k = 0; k < 7; k++) {
      const s = g.performance.now();
      const r = moveTask(state, 't0', '2027-01-04T11:30');
      runs.push(g.performance.now() - s);
      changed = r.changes.length;
    }
    runs.sort((a, b) => a - b);
    const median = runs[3]!;
    console.info(
      `[scheduling perf HOUR] cold schedule ${cold.toFixed(1)} ms; moveTask median ${median.toFixed(1)} ms ` +
        `(min ${runs[0]!.toFixed(1)}, max ${runs[6]!.toFixed(1)}); ${changed} tasks changed; budget ${BUDGET_MS} ms`,
    );
    expect(changed).toBeGreaterThan(1900);
    expect(median).toBeLessThan(BUDGET_MS);
    expect(cold).toBeLessThan(BUDGET_MS * 3);
  });
});
