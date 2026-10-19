import { useMemo, useState } from 'react';
import { SegmentedControl, Skeleton, Text } from '@mantine/core';
import { IconCoin } from '@tabler/icons-react';
import type { BudgetReportDto } from '@nuzli/shared';
import { formatMoney, formatMinutes, t, type MessageKey } from '../../i18n';
import { ErrorBlock } from '../../components/ui';
import { breakdownRows, formatPct, overBudgetRows, type BreakdownBy } from './budget';
import { ChartLegend, HBars, useChartPalette } from './charts';
import { BudgetTotals, CardEmpty, ReportCard } from './parts';

const BY_KEY: Record<BreakdownBy, MessageKey> = { group: 'a9r.budget.byGroup', assignee: 'a9r.budget.byAssignee', label: 'a9r.budget.byLabel' };

/**
 * «الميزانية» of one project (GanttPRO budget): the totals with the % used meter, budget vs
 * planned vs actual, planned vs actual by group / assignee / label (a segmented switch), and the
 * over-budget tasks in red (a row opens the task).
 */
export function BudgetSection({
  report,
  loading,
  error,
  onOpenTask,
}: {
  report: BudgetReportDto | undefined;
  loading: boolean;
  error: unknown;
  onOpenTask(id: string): void;
}) {
  const [by, setBy] = useState<BreakdownBy>('group');
  const p = useChartPalette();
  const currency = report?.currency ?? 'SAR';
  const money = useMemo(() => (v: number) => formatMoney(v, currency), [currency]);
  const compact = useMemo(() => (v: number) => formatMoney(v, currency, { compact: true }), [currency]);

  const rows = useMemo(
    () => (report ? breakdownRows(report, by, { unassigned: t('a9r.unassigned'), noLabel: t('a9r.noLabel') }) : []),
    [report, by],
  );
  const over = useMemo(() => (report ? overBudgetRows(report) : []), [report]);

  const breakdownSeries = useMemo(
    () => [
      { name: t('a9r.budget.planned'), color: p.primary, data: rows.map((r) => r.planned) },
      { name: t('a9r.budget.actual'), color: p.live, data: rows.map((r) => r.actual), colors: rows.map((r) => (r.over ? p.red : null)) },
    ],
    [rows, p],
  );
  const extraTooltip = useMemo(
    () => (i: number) => {
      const r = rows[i];
      if (!r) return '';
      const parts: string[] = [];
      if (r.budgetShare !== null) parts.push(t('a9r.budget.shareOfBudget', { pct: formatPct(r.budgetShare) }));
      if (r.over) parts.push(`<b style="color:${p.red}">${t('a9r.budget.overPlanBy', { amount: money(r.actual - r.planned) })}</b>`);
      return parts.join('<br/>');
    },
    [rows, p, money],
  );

  const totalsCats = useMemo(() => [t('a9r.budget.budget'), t('a9r.budget.planned'), t('a9r.budget.actual')], []);
  const totalsSeries = useMemo(() => {
    if (!report) return [];
    const usedOver = report.budget !== null && report.actualCost > report.budget;
    const planOver = report.budget !== null && report.plannedCost > report.budget;
    return [
      {
        name: t('a9r.budget.amount'),
        color: p.primary,
        data: [report.budget, report.plannedCost, report.actualCost],
        colors: [p.dim2, planOver ? p.amber : p.primary, usedOver ? p.red : p.live],
      },
    ];
  }, [report, p]);

  return (
    <section className="rp-stack" aria-labelledby="rp-budget-title">
      <h2 className="rp-section-title" id="rp-budget-title">
        <IconCoin size={20} stroke={1.8} aria-hidden />
        {t('a9r.budget.title')}
      </h2>
      {error ? (
        <ErrorBlock error={error} />
      ) : loading || !report ? (
        <div className="rp-card">
          <Skeleton h={64} radius="md" />
          <Skeleton h={14} mt="md" radius="xl" />
        </div>
      ) : (
        <>
          <div className="rp-card">
            <BudgetTotals budget={report.budget} planned={report.plannedCost} actual={report.actualCost} currency={currency} pct={report.budgetUsedPct} />
            <Text size="xs" c="dimmed" mt="sm">
              {t('a9r.budget.loggedNote', { time: formatMinutes(report.loggedMinutes) })}
            </Text>
          </div>

          <div className="rp-grid">
            <ReportCard title={t('a9r.budget.compareTitle')} sub={t('a9r.budget.compareSub')}>
              <HBars
                categories={totalsCats}
                series={totalsSeries}
                format={money}
                axisFormat={compact}
                label={t('a9r.budget.compareTitle')}
                labelWidth={90}
              />
            </ReportCard>

            <ReportCard
              title={t('a9r.budget.breakdownTitle')}
              actions={
                <SegmentedControl
                  size="xs"
                  className="rp-seg"
                  value={by}
                  onChange={(v) => setBy(v as BreakdownBy)}
                  aria-label={t('a9r.budget.breakdownBy')}
                  data={[
                    { value: 'group', label: t('a9r.budget.byGroup') },
                    { value: 'assignee', label: t('a9r.budget.byAssignee') },
                    { value: 'label', label: t('a9r.budget.byLabel') },
                  ]}
                />
              }
            >
              {rows.length ? (
                <>
                  <ChartLegend
                    items={[
                      { label: t('a9r.budget.planned'), color: p.primary },
                      { label: t('a9r.budget.actual'), color: p.live },
                      { label: t('a9r.budget.actualOver'), color: p.red },
                    ]}
                  />
                  <HBars
                    categories={rows.map((r) => r.name)}
                    series={breakdownSeries}
                    format={money}
                    axisFormat={compact}
                    extraTooltip={extraTooltip}
                    label={t('a9r.budget.breakdownAria', { by: t(BY_KEY[by]) })}
                  />
                  {by === 'label' && report?.byLabelOverlapping ? (
                    // Calculations audit L11: a task with several labels counts under each one.
                    <Text size="xs" c="dimmed" mt={6} role="note" data-testid="by-label-note">
                      {report.byLabelNote || t('a9r.budget.byLabelNote')}
                    </Text>
                  ) : null}
                </>
              ) : (
                <CardEmpty>{t('a9r.budget.noCosts')}</CardEmpty>
              )}
            </ReportCard>
          </div>

          <ReportCard
            flush
            title={t('a9r.budget.overTitle')}
            sub={over.length ? t('a9r.budget.overSub', { n: over.length }) : undefined}
          >
            {over.length ? (
              <div className="rp-table-scroll">
                <table className="rp-table" aria-label={t('a9r.budget.overTitle')}>
                  <thead>
                    <tr>
                      <th>{t('a9r.col.task')}</th>
                      <th className="num">{t('a9r.budget.planned')}</th>
                      <th className="num">{t('a9r.budget.actual')}</th>
                      <th className="num">{t('a9r.budget.overColumn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {over.map((r) => (
                      <tr
                        key={r.taskId}
                        data-over=""
                        data-click=""
                        tabIndex={0}
                        onClick={() => onOpenTask(r.taskId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenTask(r.taskId);
                          }
                        }}
                        aria-label={t('a9r.openTask', { name: r.name })}
                      >
                        <td>
                          <span className="rp-wbs">{r.wbs}</span> <span style={{ fontWeight: 500 }}>{r.name}</span>
                        </td>
                        <td className="num">{money(r.plannedCost)}</td>
                        <td className="num rp-red">{money(r.actualCost)}</td>
                        <td className="num rp-red">
                          {money(r.overBy)}
                          {r.overPct !== null ? <span className="rp-dim"> ({formatPct(r.overPct)})</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <CardEmpty>{t('a9r.budget.noOver')}</CardEmpty>
            )}
          </ReportCard>
        </>
      )}
    </section>
  );
}
