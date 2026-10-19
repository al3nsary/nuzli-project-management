/**
 * Calculations audit L11: under «الوسم», when a task with several labels is counted under each,
 * the chart explains why its bars add up to more than the total.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { BudgetReportDto } from '@nuzli/shared';
import { BudgetSection } from './BudgetSection';

vi.mock('echarts-for-react/lib/core', () => ({ default: () => <div data-testid="echart" /> }));

const line = (p: number, a: number) => ({ plannedCost: p, actualCost: a, variance: p - a });
const report = (overlapping: boolean): BudgetReportDto => ({
  projectId: 'p',
  currency: 'SAR',
  budget: 1000,
  ...line(100, 50),
  budgetVariance: 950,
  budgetUsedPct: 5,
  loggedMinutes: 0,
  byGroup: [{ taskId: 't', wbs: '1', name: 'أ', type: 'TASK', ...line(100, 50) }],
  byAssignee: [],
  byLabel: [
    { label: { id: 'l1', projectId: 'p', name: 'كهرباء', color: '#123456' }, taskCount: 1, ...line(100, 50) },
    { label: { id: 'l2', projectId: 'p', name: 'سباكة', color: '#654321' }, taskCount: 1, ...line(100, 50) },
  ],
  byLabelOverlapping: overlapping,
  byLabelNote: overlapping ? 'المهمة ذات أكثر من وسم تُحسب تحت كلٍّ منها، لذا قد يزيد مجموع الأعمدة على الإجمالي.' : null,
  overBudgetTasks: [],
} as unknown as BudgetReportDto);

function show(r: BudgetReportDto) {
  render(
    <MantineProvider>
      <BudgetSection report={r} loading={false} error={null} onOpenTask={() => undefined} />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByText('الوسم'));
}

describe('L11 — the label chart note', () => {
  it('shows byLabelNote under «الوسم» when tasks are counted under several labels', () => {
    show(report(true));
    expect(screen.getByTestId('by-label-note')).toHaveTextContent('المهمة ذات أكثر من وسم');
  });
  it('shows nothing when no task has two labels', () => {
    show(report(false));
    expect(screen.queryByTestId('by-label-note')).toBeNull();
  });
});
