import { useMemo, useState } from 'react';
import { Group, Text } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { useWorkload } from '../../../api/a9Queries';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../../components/ui';
import { t } from '../../../i18n';
import { riyadhToday } from '../../../features/projects/today';
import { WorkloadGrid } from '../../../features/workload/WorkloadGrid';
import { RangeControl } from '../../../features/workload/RangeControl';
import { gridSummary, projectRange, type Range } from '../../../features/workload/math';
import '../../../features/reports/reports.css';
import type { TabProps } from './types';

/** Distinct assignee ids of the project's tasks (the people of this workload view). */
export function assigneeIdsOf(tasks: readonly { assignee: { id: string } | null }[]): string[] {
  return [...new Set(tasks.map((x) => x.assignee?.id).filter((x): x is string => Boolean(x)))].sort();
}

/**
 * «عبء العمل» of one project (GanttPRO Workload tab): the shared heat grid for the people
 * assigned in this project, over the project span clipped to 92 days around today. Allocations
 * count every project of each person (their real load), as the API computes them.
 */
export function ProjectWorkloadTab(props: TabProps) {
  const { project, calendar, tasks } = props.data;
  const today = riyadhToday();
  const userIds = useMemo(() => assigneeIdsOf(tasks), [tasks]);
  const [range, setRange] = useState<Range>(() => projectRange(project.startDate, project.endDate, today));
  const [clamped, setClamped] = useState(false);
  const q = useWorkload(range.from, range.to, userIds, userIds.length > 0);
  const summary = useMemo(() => (q.data ? gridSummary(q.data) : null), [q.data]);

  if (!userIds.length) {
    return <EmptyState icon={IconUsers} title={t('a9r.wl.tabEmptyTitle')} body={t('a9r.wl.tabEmptyBody')} />;
  }

  return (
    <div className="rp-stack" data-testid="project-workload">
      <div className="rp-card">
        <RangeControl
          range={range}
          today={today}
          clamped={clamped}
          onChange={(r) => {
            setClamped(r.clamped);
            setRange({ from: r.from, to: r.to });
          }}
        />
      </div>
      {q.isLoading ? (
        <LoadingBlock variant="table" rows={Math.min(6, userIds.length)} />
      ) : q.error || !q.data ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Text size="sm" c="dimmed">
              {t('a9r.wl.tabNote')}
            </Text>
            {summary?.overloadedPeople ? (
              <Text size="sm" c="var(--red)" fw={600}>
                {t('a9r.wl.tabOverloaded', { n: summary.overloadedPeople, days: summary.overloadDays })}
              </Text>
            ) : null}
          </Group>
          <WorkloadGrid data={q.data} weekendDays={calendar.weekendDays} today={today} label={t('a9r.wl.gridAria')} />
        </>
      )}
    </div>
  );
}
