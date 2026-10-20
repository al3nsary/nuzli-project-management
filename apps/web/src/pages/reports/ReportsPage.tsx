import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Select } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCoin, IconFileSpreadsheet, IconFolders, IconListCheck } from '@tabler/icons-react';
import { can, type ProjectReportRow, type ProjectStatus } from '@nuzli/shared';
import { useAuthStore } from '../../stores/auth';
import { useProjectsReport } from '../../api/a9Queries';
import { errorMessage } from '../../api/errors';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatMoney, formatNumber, t, type MessageKey } from '../../i18n';
import { useTabParam } from '../../lib/useUrlState';
import { riyadhToday } from '../../features/projects/today';
import { ChartLegend, DonutChart, HBars, useChartPalette } from '../../features/reports/charts';
import { BudgetMeter, CardEmpty, Kpi, ReportCard } from '../../features/reports/parts';
import { formatPct, usedTone } from '../../features/reports/budget';
import { ProgressLine, ProjectStatusBadge, PROJECT_STATUSES, projectStatusLabel } from '../projects/parts';

const FILTERS = ['OPEN', 'ALL', ...PROJECT_STATUSES] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_KEY: Partial<Record<Filter, MessageKey>> = { OPEN: 'a9r.rep.filterOpen', ALL: 'a9r.rep.filterAll' };
const filterLabel = (f: Filter) => (FILTER_KEY[f] ? t(FILTER_KEY[f]!) : projectStatusLabel(f));

/** Money of one row in its own currency (a cross-project sum assumes the default SAR). */
const money = (v: number | null | undefined, currency?: string) => (v === null || v === undefined ? '' : formatMoney(v, currency ?? 'SAR'));

/**
 * «التقارير» (route `/reports`): the projects summary — status filter, the table (progress,
 * dates, task counts, budget, planned, actual, % used), three charts and the Excel export
 * (right-to-left sheets, no freeze panes, real number and date cells).
 */
export function ReportsPage() {
  const navigate = useNavigate();
  // A12 round 2: money fields are not sent without budget.read — hide them, never show zeros.
  const showMoney = can(useAuthStore((s) => s.user), 'budget.read');
  const [filter, setFilter] = useTabParam<Filter>('status', FILTERS, 'OPEN');
  const q = useProjectsReport(filter === 'OPEN' ? undefined : (filter as ProjectStatus | 'ALL'));
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const p = useChartPalette();
  const [exporting, setExporting] = useState(false);

  const totals = useMemo(() => {
    const s = { leaf: 0, done: 0, overdue: 0, deadline: 0, milestones: 0, budget: 0, planned: 0, actual: 0, withBudget: 0 };
    for (const r of rows) {
      s.leaf += r.leafCount;
      s.done += r.doneCount;
      s.overdue += r.overdueCount;
      s.deadline += r.deadlinePassedCount;
      s.milestones += r.milestoneCount;
      s.planned += r.project.plannedCost ?? 0;
      s.actual += r.project.actualCost ?? 0;
      if (r.project.budget !== null && r.project.budget !== undefined) {
        s.budget += r.project.budget;
        s.withBudget++;
      }
    }
    return s;
  }, [rows]);

  const progressChart = useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.project.progress - a.project.progress);
    return {
      categories: sorted.map((r) => r.project.name),
      series: [
        {
          name: t('a9r.col.progress'),
          color: p.primary,
          data: sorted.map((r) => Math.round(r.project.progress)),
          colors: sorted.map((r) => (r.project.progress >= 100 ? p.live : r.overdueCount ? p.amber : p.primary)),
        },
      ],
    };
  }, [rows, p]);

  const costChart = useMemo(() => {
    const list = rows.filter((r) => (r.project.budget ?? 0) > 0 || (r.project.plannedCost ?? 0) > 0 || (r.project.actualCost ?? 0) > 0);
    return {
      categories: list.map((r) => r.project.name),
      series: [
        { name: t('a9r.budget.budget'), color: p.dim2, data: list.map((r) => r.project.budget ?? null) },
        { name: t('a9r.budget.planned'), color: p.primary, data: list.map((r) => r.project.plannedCost ?? 0) },
        {
          name: t('a9r.budget.actual'),
          color: p.live,
          data: list.map((r) => r.project.actualCost ?? 0),
          colors: list.map((r) => (usedTone(r.project.budgetUsedPct) === 'over' ? p.red : null)),
        },
      ],
    };
  }, [rows, p]);

  const statusRows = useMemo(() => {
    const colors: Record<ProjectStatus, string> = { ACTIVE: p.primary, PLANNING: p.blue, ON_HOLD: p.amber, COMPLETED: p.live, ARCHIVED: p.dim2 };
    return PROJECT_STATUSES.map((s) => ({ name: projectStatusLabel(s), value: rows.filter((r) => r.project.status === s).length, color: colors[s] })).filter((r) => r.value > 0);
  }, [rows, p]);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const { buildProjectsReportWorkbook, workbookBlob, downloadFile, reportFileName } = await import('../../features/reports/excel');
      const wb = await buildProjectsReportWorkbook(rows, { generatedAt: new Date(), filterLabel: filterLabel(filter) });
      downloadFile(await workbookBlob(wb), reportFileName(riyadhToday()));
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const compact = (v: number) => formatMoney(v, 'SAR', { compact: true });

  return (
    <>
      <PageHeader
        title={t('nav.reports')}
        lead={t('a9r.rep.lead')}
        actions={
          <Button variant="default" leftSection={<IconFileSpreadsheet size={18} />} onClick={exportXlsx} loading={exporting} disabled={!rows.length}>
            {t('a9r.rep.export')}
          </Button>
        }
      />
      <div className="rp-stack">
        <div className="rp-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <Select
            label={t('a9r.rep.filter')}
            data={FILTERS.map((f) => ({ value: f, label: filterLabel(f) }))}
            value={filter}
            onChange={(v) => setFilter(v)}
            allowDeselect={false}
            w={240}
            maw="100%"
            comboboxProps={{ withinPortal: true }}
          />
          {q.data ? (
            <span className="rp-dim" style={{ fontSize: 'var(--fs-sm)', paddingBlockEnd: 8 }}>
              {t('a9r.rep.count', { n: rows.length })}
            </span>
          ) : null}
        </div>

        {q.isLoading ? (
          <LoadingBlock variant="dashboard" />
        ) : q.error ? (
          <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
        ) : !rows.length ? (
          <EmptyState
            icon={IconFolders}
            title={t('a9r.rep.emptyTitle')}
            body={filter === 'ALL' ? t('a9r.rep.emptyBodyAll') : t('a9r.rep.emptyBody')}
            action={filter === 'ALL' ? { label: t('a9r.rep.openProjects'), onClick: () => navigate('/projects') } : { label: t('a9r.rep.showAll'), onClick: () => setFilter('ALL') }}
          />
        ) : (
          <>
            <div className="rp-kpis">
              <Kpi icon={IconFolders} label={t('a9r.rep.kpiProjects')} value={formatNumber(rows.length)} />
              <Kpi icon={IconListCheck} label={t('a9r.rep.kpiTasks')} value={formatNumber(totals.leaf)} foot={t('a9r.rep.kpiDone', { n: totals.done })} />
              <Kpi icon={IconAlertTriangle} label={t('a9r.col.overdue')} value={formatNumber(totals.overdue)} tone={totals.overdue ? 'no' : undefined} foot={totals.deadline ? t('a9r.rep.kpiDeadline', { n: totals.deadline }) : undefined} />
              {showMoney ? <Kpi icon={IconCoin} small label={t('a9r.rep.kpiActual')} value={money(totals.actual)} foot={t('a9r.rep.kpiPlanned', { amount: money(totals.planned) })} /> : null}
            </div>

            <ReportCard flush title={t('a9r.rep.tableTitle')} sub={t('a9r.rep.tableSub')}>
              <div className="rp-table-scroll">
                <ReportTable rows={rows} totals={totals} money={showMoney} />
              </div>
            </ReportCard>

            <div className="rp-grid">
              <ReportCard title={t('a9r.rep.progressChart')}>
                <HBars
                  categories={progressChart.categories}
                  series={progressChart.series}
                  max={100}
                  format={(v) => formatPct(v, 0)}
                  showValues
                  label={t('a9r.rep.progressChart')}
                />
              </ReportCard>
              <ReportCard title={t('a9r.rep.statusChart')}>
                <DonutChart rows={statusRows} label={t('a9r.rep.statusChart')} center={{ value: formatNumber(rows.length), caption: t('a9r.rep.projectsWord') }} />
                <ChartLegend items={statusRows.map((r) => ({ label: r.name, color: r.color, value: formatNumber(r.value) }))} />
              </ReportCard>
            </div>

            {showMoney ? <ReportCard title={t('a9r.rep.costChart')} sub={t('a9r.rep.costChartSub')}>
              {costChart.categories.length ? (
                <>
                  <ChartLegend
                    items={[
                      { label: t('a9r.budget.budget'), color: p.dim2 },
                      { label: t('a9r.budget.planned'), color: p.primary },
                      { label: t('a9r.budget.actual'), color: p.live },
                      { label: t('a9r.rep.actualOverBudget'), color: p.red },
                    ]}
                  />
                  <HBars categories={costChart.categories} series={costChart.series} format={(v) => money(v)} axisFormat={compact} label={t('a9r.rep.costChart')} labelWidth={170} />
                </>
              ) : (
                <CardEmpty>{t('a9r.budget.noCosts')}</CardEmpty>
              )}
            </ReportCard> : null}
          </>
        )}
      </div>
    </>
  );
}

function ReportTable({ rows, totals, money: showMoney = true }: { money?: boolean; rows: ProjectReportRow[]; totals: { leaf: number; done: number; overdue: number; deadline: number; milestones: number; budget: number; planned: number; actual: number; withBudget: number } }) {
  return (
    <table className="rp-table" aria-label={t('a9r.rep.tableTitle')}>
      <thead>
        <tr>
          <th>{t('a9r.col.project')}</th>
          <th>{t('a9r.col.status')}</th>
          <th style={{ minWidth: 140 }}>{t('a9r.col.progress')}</th>
          <th>{t('a9r.col.dates')}</th>
          <th className="num">{t('a9r.col.leaf')}</th>
          <th className="num">{t('a9r.col.done')}</th>
          <th className="num">{t('a9r.col.overdue')}</th>
          <th className="num">{t('a9r.col.deadlinePassed')}</th>
          <th className="num">{t('a9r.col.milestones')}</th>
          {showMoney ? (
            <>
              <th className="num">{t('a9r.col.budget')}</th>
              <th className="num">{t('a9r.col.planned')}</th>
              <th className="num">{t('a9r.col.actual')}</th>
              <th className="num" style={{ minWidth: 110 }}>
                {t('a9r.col.used')}
              </th>
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pr = r.project;
          const tone = usedTone(pr.budgetUsedPct);
          return (
            <tr key={pr.id}>
              <td style={{ minWidth: 200, maxWidth: 320 }}>
                <Link to={`/projects/${pr.id}`} className="rp-link">
                  {pr.name}
                </Link>
              </td>
              <td>
                <ProjectStatusBadge status={pr.status} />
              </td>
              <td>
                <ProgressLine value={pr.progress} label={t('a9r.rep.progressOf', { name: pr.name })} />
              </td>
              <td style={{ whiteSpace: 'nowrap', fontSize: 'var(--fs-xs)' }}>
                <div>{formatDate(pr.startDate.slice(0, 10))}</div>
                <div className="rp-dim">{pr.endDate ? formatDate(pr.endDate.slice(0, 10)) : t('common.none')}</div>
              </td>
              <td className="num">{formatNumber(r.leafCount)}</td>
              <td className="num">{formatNumber(r.doneCount)}</td>
              <td className={r.overdueCount ? 'num rp-red' : 'num rp-dim'}>{formatNumber(r.overdueCount)}</td>
              <td className={r.deadlinePassedCount ? 'num rp-amber' : 'num rp-dim'}>{formatNumber(r.deadlinePassedCount)}</td>
              <td className="num">{formatNumber(r.milestoneCount)}</td>
              {showMoney ? <><td className="num">{pr.budget === null || pr.budget === undefined ? <span className="rp-dim">{t('common.none')}</span> : money(pr.budget, pr.currency)}</td>
              <td className="num">{money(pr.plannedCost ?? 0, pr.currency)}</td>
              <td className={tone === 'over' ? 'num rp-red' : 'num'}>{money(pr.actualCost ?? 0, pr.currency)}</td>
              <td className="num">
                {tone === 'none' ? (
                  <span className="rp-dim">{t('common.none')}</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
                    <span className={tone === 'over' ? 'rp-red' : tone === 'warn' ? 'rp-amber' : undefined} data-tone={tone}>
                      {formatPct(pr.budgetUsedPct)}
                    </span>
                    <BudgetMeter pct={pr.budgetUsedPct} size="sm" label={t('a9r.rep.usedOf', { name: pr.name })} />
                  </div>
                )}
              </td></> : null}
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4}>{t('a9r.people.total')}</td>
          <td className="num">{formatNumber(totals.leaf)}</td>
          <td className="num">{formatNumber(totals.done)}</td>
          <td className={totals.overdue ? 'num rp-red' : 'num'}>{formatNumber(totals.overdue)}</td>
          <td className="num">{formatNumber(totals.deadline)}</td>
          <td className="num">{formatNumber(totals.milestones)}</td>
          {showMoney ? (
            <>
              <td className="num">{totals.withBudget ? money(totals.budget) : t('common.none')}</td>
              <td className="num">{money(totals.planned)}</td>
              <td className="num">{money(totals.actual)}</td>
              <td />
            </>
          ) : null}
        </tr>
      </tfoot>
    </table>
  );
}
