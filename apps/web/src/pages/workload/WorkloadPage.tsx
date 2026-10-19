import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconCalendarStats, IconClockHour4, IconUsers } from '@tabler/icons-react';
import { useWorkload } from '../../api/a9Queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatHours, formatNumber, t } from '../../i18n';
import { riyadhToday } from '../../features/projects/today';
import { WorkloadGrid } from '../../features/workload/WorkloadGrid';
import { RangeControl } from '../../features/workload/RangeControl';
import { clampRange, daysInclusive, gridSummary, hoursOf, presetRange, type Range } from '../../features/workload/math';
import { Kpi, daysText } from '../../features/reports/parts';
import '../../features/reports/reports.css';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The range from `?from=&to=` (deep-linkable), the next two weeks otherwise. */
function useRange(today: string): [Range, (r: Range) => void] {
  const [params, setParams] = useSearchParams();
  const from = params.get('from');
  const to = params.get('to');
  const range = useMemo(() => {
    if (from && to && ISO.test(from) && ISO.test(to)) {
      const r = clampRange(from, to);
      return { from: r.from, to: r.to };
    }
    return presetRange('twoWeeks', today);
  }, [from, to, today]);
  const set = (r: Range) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('from', r.from);
        next.set('to', r.to);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  return [range, set];
}

/**
 * «عبء العمل» (route `/workload`, admins): allocated hours per supervisor per day against the
 * daily capacity, overloads in red, weekends hatched, logged time beside, totals per person.
 */
export function WorkloadPage() {
  const navigate = useNavigate();
  const today = riyadhToday();
  const [range, setRange] = useRange(today);
  const [clamped, setClamped] = useState(false);
  const q = useWorkload(range.from, range.to);
  const summary = useMemo(() => (q.data ? gridSummary(q.data) : null), [q.data]);
  const assigned = q.data?.people.reduce((n, p) => n + p.totalAssignedMinutes, 0) ?? 0;
  const logged = q.data?.people.reduce((n, p) => n + p.totalLoggedMinutes, 0) ?? 0;

  return (
    <>
      <PageHeader title={t('nav.workload')} lead={t('a9r.wl.lead')} />
      <div className="rp-stack">
        <div className="rp-card">
          <RangeControl
            range={range}
            today={today}
            clamped={clamped}
            onChange={(r) => {
              setClamped(r.clamped);
              setRange(r);
            }}
          />
          <Text size="xs" c="dimmed" mt="xs">
            {t('a9r.wl.rangeLine', { days: daysText(daysInclusive(range.from, range.to)), from: formatDate(range.from), to: formatDate(range.to) })}
          </Text>
        </div>

        {q.isLoading ? (
          <LoadingBlock variant="table" rows={6} />
        ) : q.error ? (
          <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data || !q.data.people.length ? (
          <EmptyState
            icon={IconUsers}
            title={t('a9r.wl.emptyTitle')}
            body={t('a9r.wl.emptyBody')}
            action={{ label: t('a9r.wl.emptyAction'), onClick: () => navigate('/users') }}
          />
        ) : (
          <>
            <div className="rp-kpis">
              <Kpi icon={IconUsers} label={t('a9r.wl.kpiPeople')} value={formatNumber(summary?.people ?? 0)} />
              <Kpi
                icon={IconAlertTriangle}
                label={t('a9r.wl.kpiOverloaded')}
                value={formatNumber(summary?.overloadedPeople ?? 0)}
                tone={summary?.overloadedPeople ? 'no' : undefined}
                foot={summary?.overloadDays ? t('a9r.wl.kpiOverDays', { n: summary.overloadDays }) : t('a9r.wl.kpiNoOver')}
              />
              <Kpi icon={IconCalendarStats} small label={t('a9r.wl.kpiAssigned')} value={formatHours(hoursOf(assigned))} />
              <Kpi icon={IconClockHour4} small label={t('a9r.wl.kpiLogged')} value={formatHours(hoursOf(logged))} />
            </div>
            <Group justify="space-between" gap="xs" wrap="wrap">
              <Text size="sm" fw={600}>
                {t('a9r.wl.gridTitle')}
              </Text>
              {q.isFetching ? (
                <Text size="xs" c="dimmed">
                  {t('a9r.wl.updating')}
                </Text>
              ) : null}
            </Group>
            <WorkloadGrid data={q.data} today={today} label={t('a9r.wl.gridAria')} />
          </>
        )}
      </div>
    </>
  );
}
