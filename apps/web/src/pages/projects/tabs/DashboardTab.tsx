import { useMemo } from 'react';
import { Badge } from '@mantine/core';
import {
  IconAlarm,
  IconCircleCheck,
  IconClock,
  IconFlag,
  IconListCheck,
  IconProgress,
  IconAlertTriangle,
} from '@tabler/icons-react';
import type { Priority, TaskStatus } from '@nuzli/shared';
import { useBudget, useProjectDashboard } from '../../../api/a9Queries';
import { ErrorBlock, LoadingBlock } from '../../../components/ui';
import { formatDate, formatMinutes, formatMoney, formatNumber, getDisplayPrefs, t, tCount, type MessageKey } from '../../../i18n';
import { BudgetSection } from '../../../features/reports/BudgetSection';
import { BurnChart, ChartLegend, DonutChart, HBars, useChartPalette } from '../../../features/reports/charts';
import { CardEmpty, Kpi, ReportCard, daysText, overdueText } from '../../../features/reports/parts';
import { formatPct } from '../../../features/reports/budget';
import { riyadhToday } from '../../../features/projects/today';
import { daysInclusive } from '../../../features/workload/math';
import { priorityLabel, taskStatusLabel } from '../parts';
import type { TabProps } from './types';

const STATUS_ORDER: TaskStatus[] = ['DONE', 'IN_PROGRESS', 'ON_HOLD', 'NOT_STARTED'];
const PRIORITY_ORDER: Priority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const KIND_KEY: Record<'DEADLINE' | 'MILESTONE' | 'END', MessageKey> = {
  DEADLINE: 'a9r.dash.kind.DEADLINE',
  MILESTONE: 'a9r.dash.kind.MILESTONE',
  END: 'a9r.dash.kind.END',
};
const KIND_COLOR = { DEADLINE: 'signal', MILESTONE: 'field', END: 'gray' } as const;

const tileFmt = () =>
  new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDisplayPrefs().digits}`, { month: 'short', timeZone: 'UTC' });

/**
 * «لوحة المعلومات» of one project (GanttPRO Dashboard): KPI cards, the status donut, priority
 * bars, overdue tasks, what is due in the next 14 days, the budget burn and the «الميزانية»
 * section. Every task row opens the task drawer.
 */
export function ProjectDashboardTab(props: TabProps) {
  const id = props.data.project.id;
  const dash = useProjectDashboard(id);
  const budget = useBudget(id);
  const p = useChartPalette();
  const currency = props.data.project.currency ?? budget.data?.currency ?? 'SAR';
  const today = riyadhToday();

  const statusRows = useMemo(() => {
    const colors: Record<TaskStatus, string> = { DONE: p.live, IN_PROGRESS: p.primary, ON_HOLD: p.amber, NOT_STARTED: p.dim2 };
    return STATUS_ORDER.map((s) => ({ name: taskStatusLabel(s), value: dash.data?.statusDistribution[s] ?? 0, color: colors[s] }));
  }, [dash.data, p]);

  const prioritySeries = useMemo(() => {
    const colors: Record<Priority, string> = { URGENT: p.red, HIGH: p.amber, MEDIUM: p.primary, LOW: p.dim2 };
    return [
      {
        name: t('a9r.dash.tasks'),
        color: p.primary,
        data: PRIORITY_ORDER.map((x) => dash.data?.priorityDistribution[x] ?? 0),
        colors: PRIORITY_ORDER.map((x) => colors[x]),
      },
    ];
  }, [dash.data, p]);
  const priorityCats = useMemo(() => PRIORITY_ORDER.map((x) => priorityLabel(x)), []);

  const money = useMemo(() => (v: number) => formatMoney(v, currency), [currency]);
  const compact = useMemo(() => (v: number) => formatMoney(v, currency, { compact: true }), [currency]);
  const burnNames = useMemo(
    () => ({
      planned: t('a9r.dash.burnCumulative'),
      weekly: t('a9r.dash.burnWeekly'),
      budget: t('a9r.budget.budget'),
      actual: t('a9r.dash.burnActual'),
      weekOf: (d: string) => t('a9r.dash.weekOf', { date: d }),
    }),
    [],
  );

  if (dash.isLoading) return <LoadingBlock variant="dashboard" />;
  if (dash.error || !dash.data) return <ErrorBlock error={dash.error} onRetry={() => void dash.refetch()} />;

  const d = dash.data;
  const k = d.kpis;
  const donePct = k.leafCount ? Math.round((k.done / k.leafCount) * 100) : 0;
  const tile = tileFmt();

  return (
    <div className="rp-stack" data-testid="project-dashboard">
      <div className="rp-kpis">
        <Kpi icon={IconListCheck} label={t('a9r.dash.kpiTasks')} value={formatNumber(k.leafCount)} foot={t('a9r.dash.kpiTasksFoot', { n: k.notStarted })} />
        <Kpi icon={IconCircleCheck} label={t('a9r.dash.kpiDone')} value={formatNumber(k.done)} foot={t('a9r.dash.kpiDoneFoot', { pct: formatPct(donePct, 0) })} />
        <Kpi icon={IconProgress} label={t('a9r.dash.kpiInProgress')} value={formatNumber(k.inProgress)} foot={k.onHold ? t('a9r.dash.kpiOnHold', { n: k.onHold }) : undefined} />
        <Kpi icon={IconAlertTriangle} label={t('a9r.dash.kpiOverdue')} value={formatNumber(k.overdue)} tone={k.overdue ? 'no' : undefined} />
        <Kpi icon={IconAlarm} label={t('a9r.dash.kpiDeadlinePassed')} value={formatNumber(k.deadlinePassed)} tone={k.deadlinePassed ? 'wait' : undefined} />
        <Kpi
          icon={IconFlag}
          label={t('a9r.dash.kpiMilestones')}
          value={t('a9r.dash.ofTotal', { done: k.milestonesDone, total: k.milestones })}
          foot={k.milestones ? t('a9r.dash.kpiMilestonesFoot') : t('a9r.dash.noMilestones')}
        />
        <Kpi icon={IconClock} small label={t('a9r.dash.kpiLogged')} value={k.loggedMinutes ? formatMinutes(k.loggedMinutes) : t('common.none')} />
      </div>

      <div className="rp-grid">
        <ReportCard title={t('a9r.dash.statusTitle')} sub={t('a9r.dash.statusSub')}>
          {k.leafCount ? (
            <>
              <DonutChart
                rows={statusRows}
                label={t('a9r.dash.statusTitle')}
                center={{ value: formatPct(donePct, 0), caption: t('a9r.dash.donutCaption') }}
              />
              <ChartLegend items={statusRows.map((r) => ({ label: r.name, color: r.color, value: formatNumber(r.value) }))} />
            </>
          ) : (
            <CardEmpty>{t('a9r.dash.noTasks')}</CardEmpty>
          )}
        </ReportCard>
        <ReportCard title={t('a9r.dash.priorityTitle')} sub={t('a9r.dash.prioritySub')}>
          {k.leafCount ? (
            <HBars categories={priorityCats} series={prioritySeries} showValues labelWidth={80} label={t('a9r.dash.priorityTitle')} />
          ) : (
            <CardEmpty>{t('a9r.dash.noTasks')}</CardEmpty>
          )}
        </ReportCard>
      </div>

      <div className="rp-grid">
        <ReportCard title={t('a9r.dash.overdueTitle')} sub={d.overdue.length ? t('a9r.dash.overdueSub', { n: k.overdue }) : undefined}>
          {d.overdue.length ? (
            <ul className="rp-list">
              {d.overdue.map((o) => (
                <li key={o.taskId}>
                  <button type="button" className="rp-row-btn" onClick={() => props.onOpenTask(o.taskId)} aria-label={t('a9r.openTask', { name: o.name })}>
                    <span className="rp-row-main">
                      <span className="rp-row-name">{o.name}</span>
                      <span className="rp-row-meta">
                        <span className="rp-wbs">{o.wbs}</span>
                        <span>{o.assignee?.fullName ?? t('a9r.unassigned')}</span>
                        <span>{t('a9r.dash.endedOn', { date: formatDate(o.endDate.slice(0, 10)) })}</span>
                      </span>
                    </span>
                    <Badge color="breach" variant="light" radius="xl" style={{ flex: 'none' }} title={t('a9r.overdueTip')}>
                      {overdueText(o.daysOverdue)}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <CardEmpty>{t('a9r.dash.noOverdue')}</CardEmpty>
          )}
        </ReportCard>

        <ReportCard title={t('a9r.dash.upcomingTitle', { span: tCount('a9r.days', 14) })} sub={t('a9r.dash.upcomingSub')}>
          {d.upcoming.length ? (
            <ul className="rp-list">
              {d.upcoming.map((u) => {
                const day = u.date.slice(0, 10);
                const inDays = daysInclusive(today, day) - 1;
                return (
                  <li key={`${u.kind}-${u.taskId}`}>
                    <button type="button" className="rp-row-btn" onClick={() => props.onOpenTask(u.taskId)} aria-label={t('a9r.openTask', { name: u.name })}>
                      <span className="rp-date-tile" aria-hidden>
                        <b className="num">{formatNumber(Number(day.slice(8, 10)))}</b>
                        <span>{tile.format(new Date(`${day}T00:00:00Z`))}</span>
                      </span>
                      <span className="rp-row-main">
                        <span className="rp-row-name">{u.name}</span>
                        <span className="rp-row-meta">
                          <span className="rp-wbs">{u.wbs}</span>
                          <span>{u.assignee?.fullName ?? t('a9r.unassigned')}</span>
                          <span>{inDays <= 0 ? t('a9r.dash.today') : inDays === 1 ? t('a9r.dash.tomorrow') : t('a9r.dash.inDays', { days: daysText(inDays) })}</span>
                        </span>
                      </span>
                      <Badge color={KIND_COLOR[u.kind]} variant="light" radius="xl" style={{ flex: 'none' }}>
                        {t(KIND_KEY[u.kind])}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <CardEmpty>{t('a9r.dash.noUpcoming')}</CardEmpty>
          )}
        </ReportCard>
      </div>

      <ReportCard title={t('a9r.dash.burnTitle')} sub={t('a9r.dash.burnSub')}>
        {d.budgetBurn.plannedByWeek.length ? (
          <>
            <ChartLegend
              items={[
                { label: t('a9r.dash.burnCumulative'), color: p.primary, value: money(d.budgetBurn.plannedCost) },
                { label: t('a9r.dash.burnWeekly'), color: p.tint },
                ...(d.budgetBurn.budget !== null ? [{ label: t('a9r.budget.budget'), color: p.red, dashed: true, value: money(d.budgetBurn.budget) }] : []),
                { label: t('a9r.dash.burnActual'), color: p.live, dashed: true, value: money(d.budgetBurn.actualCost) },
              ]}
            />
            <BurnChart
              weeks={d.budgetBurn.plannedByWeek}
              budget={d.budgetBurn.budget}
              actual={d.budgetBurn.actualCost}
              format={money}
              axisFormat={compact}
              names={burnNames}
              label={t('a9r.dash.burnTitle')}
            />
          </>
        ) : (
          <CardEmpty>{t('a9r.budget.noCosts')}</CardEmpty>
        )}
      </ReportCard>

      <BudgetSection report={budget.data} loading={budget.isLoading} error={budget.error} onOpenTask={props.onOpenTask} />
    </div>
  );
}
