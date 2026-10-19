import { describe, expect, it } from 'vitest';
import type { TimeEntryDto } from '@nuzli/shared';
import { buildWeekGrid, splitMinutes, toMinutes, validMinutes } from './timelog';
import { weekDays } from '../calendar/calendarMath';

const task = (id: string, name: string, projectName = 'مشروع الحديقة') => ({ id, name, projectId: `p-${projectName}`, projectName });
let n = 0;
const entry = (taskRef: ReturnType<typeof task>, date: string, minutes: number, note: string | null = null): TimeEntryDto => ({
  id: `e${++n}`,
  task: taskRef,
  user: { id: 'u', fullName: 'مشرف' },
  date,
  minutes,
  note,
  createdAt: `2026-10-19T0${n % 10}:00:00.000Z`,
});

describe('time log week grid', () => {
  const days = weekDays('2026-10-19'); // Sunday 18 → Saturday 24
  const a = task('a', 'ري الأشجار');
  const b = task('b', 'قص العشب');

  it('totals per day, per task and for the week', () => {
    const grid = buildWeekGrid(
      [entry(a, '2026-10-18', 60), entry(a, '2026-10-18', 30), entry(a, '2026-10-20', 45), entry(b, '2026-10-20', 120), entry(b, '2026-10-24', 15)],
      days,
    );
    expect(grid.days[0]).toBe('2026-10-18');
    const ra = grid.rows.find((r) => r.task.id === 'a')!;
    const rb = grid.rows.find((r) => r.task.id === 'b')!;
    expect(ra.byDay).toEqual([90, 0, 45, 0, 0, 0, 0]);
    expect(ra.total).toBe(135);
    expect(ra.entries[0]).toHaveLength(2);
    expect(rb.byDay).toEqual([0, 0, 120, 0, 0, 0, 15]);
    expect(rb.total).toBe(135);
    expect(grid.dayTotals).toEqual([90, 0, 165, 0, 0, 0, 15]);
    expect(grid.total).toBe(270);
    expect(grid.dayTotals.reduce((s, m) => s + m, 0)).toBe(grid.total);
  });

  it('ignores entries outside the week', () => {
    const grid = buildWeekGrid([entry(a, '2026-10-17', 60), entry(a, '2026-10-25', 60), entry(a, '2026-10-19', 20)], days);
    expect(grid.total).toBe(20);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]!.byDay[1]).toBe(20);
  });

  it('adds my assigned tasks as empty rows, without duplicating logged ones, sorted by project then task', () => {
    const c = task('c', 'تنظيف الممرات', 'مشروع النظافة');
    const grid = buildWeekGrid([entry(b, '2026-10-21', 30)], days, [b, a, c]);
    expect(grid.rows.map((r) => r.task.id)).toEqual(['a', 'b', 'c']);
    expect(grid.rows.find((r) => r.task.id === 'b')!.total).toBe(30);
    expect(grid.rows.find((r) => r.task.id === 'c')!.total).toBe(0);
  });

  it('converts and validates durations (1..1440 minutes)', () => {
    expect(toMinutes(1, 30)).toBe(90);
    expect(toMinutes('2', '')).toBe(120);
    expect(toMinutes(null, 45)).toBe(45);
    expect(splitMinutes(135)).toEqual({ hours: 2, minutes: 15 });
    expect(validMinutes(0)).toBe(false);
    expect(validMinutes(1)).toBe(true);
    expect(validMinutes(1440)).toBe(true);
    expect(validMinutes(1441)).toBe(false);
  });
});
