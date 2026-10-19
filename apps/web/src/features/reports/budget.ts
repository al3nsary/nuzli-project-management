/**
 * Budget display rules (A9 «الميزانية»), pure and shared by the project dashboard, the people
 * tab, the reports page and the portfolios page.
 * - % used = actual / budget × 100 (the API sends `budgetUsedPct`, null without a budget).
 * - The meter is indigo up to 90 %, amber above 90 % and red above 100 %.
 * - A task is over budget when its actual cost exceeds its planned cost.
 */
import type { BudgetReportDto } from '@nuzli/shared';
import { formatNumber } from '../../i18n/format';

export type UsedTone = 'none' | 'ok' | 'warn' | 'over';

export function usedTone(pct: number | null | undefined): UsedTone {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'none';
  if (pct > 100) return 'over';
  if (pct > 90) return 'warn';
  return 'ok';
}

/** Mantine colour name of a tone (theme ramps: field = indigo, signal = amber, breach = red). */
export const toneColor = (tone: UsedTone): string => (tone === 'over' ? 'breach' : tone === 'warn' ? 'signal' : 'field');
/** CSS token of a tone, for text and chart marks. */
export const toneVar = (tone: UsedTone): string => (tone === 'over' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--primary)');

/** The meter fill: 0..100 (an overrun fills the meter; the number says by how much). */
export const meterValue = (pct: number | null | undefined) => (pct === null || pct === undefined || !Number.isFinite(pct) ? 0 : Math.max(0, Math.min(100, pct)));

/** actual / budget × 100 with two decimals; null without (or with a zero) budget. */
export function usedPct(actual: number, budget: number | null | undefined): number | null {
  if (budget === null || budget === undefined || budget <= 0) return null;
  return Math.round((actual / budget) * 10000) / 100;
}

/** budget − actual; null without a budget. */
export const remainingOf = (budget: number | null | undefined, actual: number): number | null =>
  budget === null || budget === undefined ? null : Math.round((budget - actual) * 100) / 100;

/** «١٨٫٥٪» — one decimal at most, the Arabic percent sign. */
export function formatPct(pct: number | null | undefined, decimals = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  const f = 10 ** decimals;
  return `${formatNumber(Math.round(pct * f) / f)}٪`;
}

export const isOverBudget = (row: { plannedCost: number; actualCost: number }) => row.actualCost > row.plannedCost;

export type BreakdownBy = 'group' | 'assignee' | 'label';

export interface BreakdownRow {
  key: string;
  name: string;
  planned: number;
  actual: number;
  variance: number;
  over: boolean;
  color: string | null;
  /** actual as a share of the project budget, % (null without a budget). */
  budgetShare: number | null;
}

/**
 * Rows of the «by group / by assignee / by label» chart, largest planned cost first.
 * `names.unassigned` / `names.noLabel` label the null buckets.
 */
export function breakdownRows(
  report: Pick<BudgetReportDto, 'byGroup' | 'byAssignee' | 'byLabel' | 'budget'>,
  by: BreakdownBy,
  names: { unassigned: string; noLabel: string },
): BreakdownRow[] {
  const share = (actual: number) => usedPct(actual, report.budget);
  const rows: BreakdownRow[] =
    by === 'group'
      ? report.byGroup.map((g) => ({
          key: g.taskId,
          name: g.wbs ? `${g.wbs} ${g.name}` : g.name,
          planned: g.plannedCost,
          actual: g.actualCost,
          variance: g.variance,
          over: isOverBudget(g),
          color: null,
          budgetShare: share(g.actualCost),
        }))
      : by === 'assignee'
        ? report.byAssignee.map((a) => ({
            key: a.assignee?.id ?? 'none',
            name: a.assignee?.fullName ?? names.unassigned,
            planned: a.plannedCost,
            actual: a.actualCost,
            variance: a.variance,
            over: isOverBudget(a),
            color: null,
            budgetShare: share(a.actualCost),
          }))
        : report.byLabel.map((l) => ({
            key: l.label?.id ?? 'none',
            name: l.label?.name ?? names.noLabel,
            planned: l.plannedCost,
            actual: l.actualCost,
            variance: l.variance,
            over: isOverBudget(l),
            color: l.label?.color ?? null,
            budgetShare: share(l.actualCost),
          }));
  return by === 'group' ? rows : [...rows].sort((a, b) => b.planned - a.planned || b.actual - a.actual);
}

/** Over-budget tasks, largest overrun first, with the overrun as % of the plan. */
export function overBudgetRows(report: Pick<BudgetReportDto, 'overBudgetTasks'>) {
  return [...report.overBudgetTasks]
    .sort((a, b) => b.overBy - a.overBy)
    .map((r) => ({ ...r, overPct: r.plannedCost > 0 ? Math.round((r.overBy / r.plannedCost) * 1000) / 10 : null }));
}
