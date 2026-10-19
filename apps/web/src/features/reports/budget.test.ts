import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetReportDto } from '@nuzli/shared';
import { formatMoney, setDisplayPrefs } from '../../i18n';
import { breakdownRows, formatPct, isOverBudget, meterValue, overBudgetRows, remainingOf, toneColor, usedPct, usedTone } from './budget';

afterEach(() => setDisplayPrefs({ digits: 'latn' }));

describe('money display', () => {
  it('formats SAR with «ر.س» and Western digits by default', () => {
    expect(formatMoney(520000, 'SAR')).toBe('520,000 ر.س');
    expect(formatMoney(2500.5, 'SAR')).toBe('2,500.5 ر.س');
    expect(formatMoney(null, 'SAR')).toBe('');
  });
  it('switches to Arabic-Indic digits with the user preference', () => {
    setDisplayPrefs({ digits: 'arab' });
    expect(formatMoney(1500, 'SAR')).toBe('١٬٥٠٠ ر.س');
  });
  it('shows other currencies by their code', () => {
    expect(formatMoney(10, 'USD')).toBe('10 USD');
  });
});

describe('% used and its colour', () => {
  it('is indigo up to 90 %, amber above 90 %, red above 100 %', () => {
    expect(usedTone(null)).toBe('none');
    expect(usedTone(0)).toBe('ok');
    expect(usedTone(90)).toBe('ok');
    expect(usedTone(90.01)).toBe('warn');
    expect(usedTone(100)).toBe('warn');
    expect(usedTone(100.01)).toBe('over');
    expect(toneColor('ok')).toBe('field');
    expect(toneColor('warn')).toBe('signal');
    expect(toneColor('over')).toBe('breach');
  });
  it('computes % used, remaining and the meter fill', () => {
    expect(usedPct(95950, 520000)).toBe(18.45);
    expect(usedPct(10, 0)).toBeNull();
    expect(usedPct(10, null)).toBeNull();
    expect(remainingOf(520000, 95950)).toBe(424050);
    expect(remainingOf(null, 5)).toBeNull();
    expect(meterValue(135)).toBe(100);
    expect(meterValue(-3)).toBe(0);
    expect(meterValue(null)).toBe(0);
    expect(formatPct(18.45)).toBe('18.5٪');
    expect(formatPct(null)).toBe('');
  });
});

const REPORT: Pick<BudgetReportDto, 'byGroup' | 'byAssignee' | 'byLabel' | 'budget' | 'overBudgetTasks'> = {
  budget: 1000,
  byGroup: [
    { taskId: 'g1', wbs: '1', name: 'التجهيز', type: 'GROUP', plannedCost: 400, actualCost: 500, variance: -100 },
    { taskId: 'g2', wbs: '2', name: 'الزراعة', type: 'GROUP', plannedCost: 600, actualCost: 100, variance: 500 },
  ],
  byAssignee: [
    { assignee: null, taskCount: 1, loggedMinutes: 0, plannedCost: 100, actualCost: 0, variance: 100 },
    { assignee: { id: 'u1', fullName: 'فهد' }, taskCount: 3, loggedMinutes: 60, plannedCost: 900, actualCost: 600, variance: 300 },
  ],
  byLabel: [{ label: null, taskCount: 2, plannedCost: 50, actualCost: 70, variance: -20 }],
  overBudgetTasks: [
    { taskId: 'a', wbs: '1.1', name: 'أ', plannedCost: 100, actualCost: 110, overBy: 10 },
    { taskId: 'b', wbs: '1.2', name: 'ب', plannedCost: 200, actualCost: 300, overBy: 100 },
  ],
};
const NAMES = { unassigned: 'غير مسندة', noLabel: 'بلا وسم' };

describe('over-budget rows and breakdowns', () => {
  it('flags actual above planned as over budget', () => {
    expect(isOverBudget({ plannedCost: 100, actualCost: 100 })).toBe(false);
    expect(isOverBudget({ plannedCost: 100, actualCost: 100.01 })).toBe(true);
  });
  it('lists over-budget tasks largest overrun first with the overrun %', () => {
    const rows = overBudgetRows(REPORT);
    expect(rows.map((r) => r.taskId)).toEqual(['b', 'a']);
    expect(rows[0]!.overPct).toBe(50);
    expect(rows[1]!.overPct).toBe(10);
  });
  it('keeps groups in WBS order and names the null buckets', () => {
    const groups = breakdownRows(REPORT, 'group', NAMES);
    expect(groups.map((g) => g.name)).toEqual(['1 التجهيز', '2 الزراعة']);
    expect(groups[0]!.over).toBe(true);
    expect(groups[0]!.budgetShare).toBe(50);
    const people = breakdownRows(REPORT, 'assignee', NAMES);
    expect(people.map((p) => p.name)).toEqual(['فهد', 'غير مسندة']);
    expect(breakdownRows(REPORT, 'label', NAMES)[0]).toMatchObject({ name: 'بلا وسم', over: true, color: null });
  });
});
