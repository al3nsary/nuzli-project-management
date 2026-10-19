import { useMemo } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { Text } from '@mantine/core';
import { IconUserQuestion, IconUsers } from '@tabler/icons-react';
import type { ProjectPersonDto } from '@nuzli/shared';
import { useProjectPeople } from '../../../api/a9Queries';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../../components/ui';
import { UserAvatar } from '../../../components/UserAvatar';
import { TeamBadge } from '../../../theme/TeamBadge';
import { formatMinutes, formatMoney, formatNumber, t } from '../../../i18n';
import { formatPct, isOverBudget } from '../../../features/reports/budget';
import '../../../features/reports/reports.css';
import { ProgressLine } from '../parts';
import type { TabProps } from './types';

/** Assignees first by planned cost, the «غير مسندة» bucket last. */
export function sortPeople(rows: readonly ProjectPersonDto[]): ProjectPersonDto[] {
  return [...rows].sort((a, b) => {
    if (!a.assignee !== !b.assignee) return a.assignee ? -1 : 1;
    return b.taskCount - a.taskCount || b.plannedCost - a.plannedCost;
  });
}

function Who({ row }: { row: ProjectPersonDto }) {
  if (!row.assignee) {
    return (
      <span className="rp-person">
        <span className="rp-unassigned-ic" aria-hidden>
          <IconUserQuestion size={18} stroke={1.6} />
        </span>
        <span className="rp-person-name">{t('a9r.people.unassigned')}</span>
      </span>
    );
  }
  return (
    <span className="rp-person">
      <UserAvatar name={row.assignee.fullName} size={34} ring={false} />
      <span className="rp-person-name">{row.assignee.fullName}</span>
    </span>
  );
}

function Team({ row }: { row: ProjectPersonDto }) {
  if (!row.assignee) return <span className="rp-dim">{t('common.none')}</span>;
  if (!row.assignee.teamName) return <span className="rp-dim">{t('a9r.people.noTeam')}</span>;
  // Team colour always next to the team name (design rule).
  return <TeamBadge name={row.assignee.teamName} color={row.assignee.teamColor ?? 'var(--dim2)'} size="sm" />;
}

/**
 * «الأشخاص» of a project (GanttPRO People): each assignee with avatar, team (vest band in the team
 * colour, with the name), task / done / overdue counts, progress, planned and actual cost, share of
 * the planned cost and logged time; the unassigned tasks as their own row. Table on desktop,
 * cards on phones.
 */
export function ProjectPeopleTab(props: TabProps) {
  const id = props.data.project.id;
  const currency = props.data.project.currency ?? 'SAR';
  const people = useProjectPeople(id);
  const phone = useMediaQuery('(max-width: 47.99em)', false, { getInitialValueInEffect: false }) ?? false;
  const rows = useMemo(() => sortPeople(people.data ?? []), [people.data]);
  const money = (v: number) => formatMoney(v, currency);

  if (people.isLoading) return <LoadingBlock variant={phone ? 'tasks' : 'table'} rows={5} />;
  if (people.error) return <ErrorBlock error={people.error} onRetry={() => void people.refetch()} />;
  if (!rows.length) return <EmptyState icon={IconUsers} title={t('a9r.people.emptyTitle')} body={t('a9r.people.emptyBody')} />;

  const totals = rows.reduce(
    (s, r) => ({
      tasks: s.tasks + r.taskCount,
      done: s.done + r.doneCount,
      overdue: s.overdue + r.overdueCount,
      planned: s.planned + r.plannedCost,
      actual: s.actual + r.actualCost,
      logged: s.logged + r.loggedMinutes,
    }),
    { tasks: 0, done: 0, overdue: 0, planned: 0, actual: 0, logged: 0 },
  );
  const assigned = rows.filter((r) => r.assignee).length;

  if (phone) {
    return (
      <div className="rp-stack" data-testid="project-people">
        <Text size="sm" c="dimmed">
          {t('a9r.people.summary', { n: assigned, tasks: totals.tasks })}
        </Text>
        {rows.map((r) => (
          <article key={r.assignee?.id ?? 'none'} className="rp-person-card" aria-label={r.assignee?.fullName ?? t('a9r.people.unassigned')}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <Who row={r} />
              <Team row={r} />
            </div>
            <ProgressLine value={r.progress} />
            <div className="rp-person-stats">
              <div className="rp-person-stat">
                <span>{t('a9r.people.tasks')}</span>
                <b>{formatNumber(r.taskCount)}</b>
              </div>
              <div className="rp-person-stat">
                <span>{t('a9r.people.done')}</span>
                <b>{formatNumber(r.doneCount)}</b>
              </div>
              <div className="rp-person-stat">
                <span>{t('a9r.people.overdue')}</span>
                <b className={r.overdueCount ? 'rp-red' : undefined}>{formatNumber(r.overdueCount)}</b>
              </div>
              <div className="rp-person-stat">
                <span>{t('a9r.budget.planned')}</span>
                <b>{money(r.plannedCost)}</b>
              </div>
              <div className="rp-person-stat">
                <span>{t('a9r.budget.actual')}</span>
                <b className={isOverBudget(r) ? 'rp-red' : undefined}>{money(r.actualCost)}</b>
              </div>
              <div className="rp-person-stat">
                <span>{t('a9r.people.share')}</span>
                <b>{formatPct(r.budgetShare)}</b>
              </div>
            </div>
            <Text size="xs" c="dimmed">
              {t('a9r.people.loggedLine', { time: r.loggedMinutes ? formatMinutes(r.loggedMinutes) : t('common.none') })}
            </Text>
          </article>
        ))}
      </div>
    );
  }

  return (
    <section className="rp-card rp-card--flush" aria-labelledby="rp-people-title" data-testid="project-people">
      <header className="rp-card-head">
        <div>
          <h3 className="rp-card-title" id="rp-people-title">
            {t('a9r.people.title')}
          </h3>
          <p className="rp-card-sub">{t('a9r.people.summary', { n: assigned, tasks: totals.tasks })}</p>
        </div>
      </header>
      <div className="rp-table-scroll">
        <table className="rp-table">
          <thead>
            <tr>
              <th>{t('a9r.people.person')}</th>
              <th>{t('a9r.people.team')}</th>
              <th className="num">{t('a9r.people.tasks')}</th>
              <th className="num">{t('a9r.people.done')}</th>
              <th className="num">{t('a9r.people.overdue')}</th>
              <th style={{ minWidth: 150 }}>{t('a9r.people.progress')}</th>
              <th className="num">{t('a9r.budget.planned')}</th>
              <th className="num">{t('a9r.budget.actual')}</th>
              <th className="num">{t('a9r.people.share')}</th>
              <th className="num">{t('a9r.people.logged')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.assignee?.id ?? 'none'}>
                <td style={{ maxWidth: 260 }}>
                  <Who row={r} />
                </td>
                <td>
                  <Team row={r} />
                </td>
                <td className="num">{formatNumber(r.taskCount)}</td>
                <td className="num">{formatNumber(r.doneCount)}</td>
                <td className={r.overdueCount ? 'num rp-red' : 'num rp-dim'}>{formatNumber(r.overdueCount)}</td>
                <td>
                  <ProgressLine value={r.progress} label={t('a9r.people.progressOf', { name: r.assignee?.fullName ?? t('a9r.people.unassigned') })} />
                </td>
                <td className="num">{money(r.plannedCost)}</td>
                <td className={isOverBudget(r) ? 'num rp-red' : 'num'}>{money(r.actualCost)}</td>
                <td className="num">{formatPct(r.budgetShare)}</td>
                <td className="num">{r.loggedMinutes ? formatMinutes(r.loggedMinutes) : <span className="rp-dim">{t('common.none')}</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>{t('a9r.people.total')}</td>
              <td className="num">{formatNumber(totals.tasks)}</td>
              <td className="num">{formatNumber(totals.done)}</td>
              <td className={totals.overdue ? 'num rp-red' : 'num'}>{formatNumber(totals.overdue)}</td>
              <td />
              <td className="num">{money(totals.planned)}</td>
              <td className="num">{money(totals.actual)}</td>
              <td />
              <td className="num">{totals.logged ? formatMinutes(totals.logged) : t('common.none')}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
