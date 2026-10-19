import { describe, expect, it } from 'vitest';
import { ERRORS, calendarDaysOverdue, isEditWindowOpen, perMemberRate, weekChangePct } from './index';

describe('calculations audit 2026-10 — shared rules', () => {
  it('L13: the edit window is closed at exactly editableUntil (now < until), as Date, string or number', () => {
    const until = new Date('2026-10-19T10:00:00.000Z');
    expect(isEditWindowOpen(new Date('2026-10-19T09:59:59.999Z'), until)).toBe(true);
    expect(isEditWindowOpen(new Date('2026-10-19T10:00:00.000Z'), until)).toBe(false);
    expect(isEditWindowOpen('2026-10-19T10:00:00.000Z', '2026-10-19T10:00:00.000Z')).toBe(false);
    expect(isEditWindowOpen(until.getTime() - 1, until.toISOString())).toBe(true);
  });

  it('week KPI: this week so far vs the same span of the previous week', () => {
    // Monday: 3 so far vs 3 by Monday last week = 0 %, not −70 % against a full week of 10.
    expect(weekChangePct(3, 3)).toBe(0);
    expect(weekChangePct(6, 4)).toBe(50);
    expect(weekChangePct(1, 3)).toBe(-66.7);
    expect(weekChangePct(5, 0)).toBeNull();
  });

  it('per-member rate is null without members (n/a), else 2 decimals', () => {
    expect(perMemberRate(4, 0)).toBeNull();
    expect(perMemberRate(10, 3)).toBe(3.33);
  });

  it('days overdue are calendar days (Thursday → Sunday = 3)', () => {
    expect(calendarDaysOverdue('2026-10-15', '2026-10-18')).toBe(3);
    expect(calendarDaysOverdue('2026-10-22T18:00', '2026-10-22')).toBe(0);
  });

  it('H1: the group-status error has an Arabic message', () => {
    expect(ERRORS.TASK_GROUP_STATUS_DERIVED).toMatch(/[؀-ۿ]/);
  });
});
