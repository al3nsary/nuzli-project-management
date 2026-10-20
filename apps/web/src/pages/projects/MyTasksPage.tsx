/**
 * «مهامي» — the supervisor's home (owner request A9: «اجعل المشرف لا يرى إدارة المشروع، فقط يرى
 * المهام المسندة إليه»). The tasks assigned to the signed-in user across projects, grouped
 * overdue / due soon / later / done, with search, a status filter and the unread comment count of
 * each task's chat. Project names are plain text: supervisors cannot open projects (API 403).
 * A card opens the task page `/my-tasks/:id`, whose main area is the chat. Phone-first (360px).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Accordion, Badge, Group, Progress, SegmentedControl, Select, Text, TextInput } from '@mantine/core';
import { IconChecklist, IconFlag, IconListCheck, IconMessageCircle, IconSearch, IconSearchOff } from '@tabler/icons-react';
import type { MyTaskDto, TaskStatus } from '@nuzli/shared';
import { useMyTasks } from '../../api/projectQueries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatNumber, t, tCount } from '../../i18n';
import { useTabParam } from '../../lib/useUrlState';
import { useUnreadByTask } from '../../features/tasks/useUnreadByTask';
import { taskWhen } from '../../features/tasks/when';
import { TASK_STATUSES, TaskStatusBadge, bucketOf, taskStatusLabel, type Bucket } from './parts';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import '../../features/tasks/tasks.css';

const STATUS_FILTERS = ['all', ...TASK_STATUSES] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
/** A12 round 2: own tasks vs the tasks of the other supervisors of the same team(s). */
const SCOPES = ['all', 'mine', 'team'] as const;
type Scope = (typeof SCOPES)[number];
const isTeamTask = (task: MyTaskDto) => task.assignedToMe === false;

const BUCKET_TONE: Record<Bucket, string> = { overdue: 'var(--red)', soon: 'var(--amber)', later: 'var(--primary)', done: 'var(--live)' };

/** Arabic-insensitive match (alef forms, taa marbuta, diacritics). */
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

export function MyTasksPage() {
  const tasks = useMyTasks();
  const unread = useUnreadByTask();
  const [q, setQ] = useState('');
  const [status, setStatus] = useTabParam<StatusFilter>('status', STATUS_FILTERS, 'all');
  const [scope, setScope] = useTabParam<Scope>('scope', SCOPES, 'all');

  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const shown = useMemo(() => {
    const term = normalizeSearch(q);
    return all.filter(
      (task) =>
        (status === 'all' || task.status === status) &&
        (scope === 'all' || (scope === 'team') === isTeamTask(task)) &&
        (!term || normalizeSearch(task.name).includes(term) || normalizeSearch(task.project.name).includes(term) || task.wbs.startsWith(term)),
    );
  }, [all, q, status, scope]);
  const hasTeam = useMemo(() => all.some(isTeamTask), [all]);
  const groups = useMemo(() => {
    const g: Record<Bucket, MyTaskDto[]> = { overdue: [], soon: [], later: [], done: [] };
    for (const task of shown) g[bucketOf(task)].push(task);
    return g;
  }, [shown]);
  const unreadTotal = useMemo(() => all.reduce((n, x) => n + (unread.get(x.id) ?? 0), 0), [all, unread]);

  if (tasks.isLoading) return <LoadingBlock variant="tasks" header />;
  if (tasks.isError) return <ErrorBlock error={tasks.error} onRetry={() => void tasks.refetch()} />;

  const filtered = Boolean(q.trim()) || status !== 'all' || scope !== 'all';

  return (
    <div className="nz-mytasks">
      <PageHeader title={t('nav.myTasks')} lead={t('a9s.myTasks.lead')} />
      {!all.length ? (
        <EmptyState icon={IconChecklist} title={t('myTasks.empty')} body={t('a9s.myTasks.emptyBody')} />
      ) : (
        <>
          <div className="nz-mytasks-summary" aria-label={t('a9s.myTasks.summary')}>
            <SummaryTile tone="var(--red)" label={t('myTasks.bucket.overdue')} value={all.filter((x) => bucketOf(x) === 'overdue').length} />
            <SummaryTile tone="var(--amber)" label={t('myTasks.bucket.soon')} value={all.filter((x) => bucketOf(x) === 'soon').length} />
            <SummaryTile tone="var(--primary)" label={t('a9s.myTasks.open')} value={all.filter((x) => x.status !== 'DONE').length} />
            <SummaryTile tone="var(--red)" label={t('a9s.myTasks.unreadTile')} value={unreadTotal} />
          </div>
          {hasTeam ? (
            <div className="nz-mytasks-scope">
              <SegmentedControl
                aria-label={t('a12roles.mine.scope')}
                value={scope}
                onChange={(v) => setScope(v)}
                data={SCOPES.map((x) => ({ value: x, label: t(`a12roles.mine.scope.${x}`) }))}
                data-testid="mytask-scope"
              />
            </div>
          ) : null}
          <div className="nz-mytasks-tools" role="search">
            <TextInput
              className="nz-mytasks-search"
              leftSection={<IconSearch size={18} aria-hidden />}
              placeholder={t('a9s.myTasks.search')}
              aria-label={t('a9s.myTasks.search')}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              size="md"
              type="search"
            />
            <Select
              className="nz-mytasks-status"
              aria-label={t('a9s.myTasks.statusFilter')}
              data={STATUS_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('a9s.myTasks.allStatuses') : taskStatusLabel(s) }))}
              value={status}
              onChange={(v) => setStatus(v)}
              allowDeselect={false}
              size="md"
              comboboxProps={{ withinPortal: true }}
            />
          </div>

          {!shown.length ? (
            <EmptyState
              icon={IconSearchOff}
              title={t('a9s.myTasks.noMatch')}
              body={t('a9s.myTasks.noMatchBody')}
              action={
                filtered
                  ? {
                      label: t('a9s.myTasks.clear'),
                      onClick: () => {
                        setQ('');
                        setStatus(null);
                        setScope(null);
                      },
                    }
                  : undefined
              }
            />
          ) : (
            <div className="nz-mytasks-groups">
              {(['overdue', 'soon', 'later'] as const).map((b) =>
                groups[b].length ? (
                  <section key={b} aria-labelledby={`bucket-${b}`} className="nz-bucket">
                    <h2 id={`bucket-${b}`} className="nz-bucket-h">
                      <span className="nz-bucket-dot" style={{ background: BUCKET_TONE[b] }} aria-hidden />
                      {t(`myTasks.bucket.${b}`)}
                      <Badge variant="light" color="gray" radius="xl" className="num" size="sm">
                        {formatNumber(groups[b].length)}
                      </Badge>
                    </h2>
                    <ul className="nz-task-cards">
                      {groups[b].map((task) => (
                        <li key={task.id}>
                          <TaskCard task={task} bucket={b} unread={unread.get(task.id) ?? 0} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
              {groups.done.length ? (
                <Accordion variant="contained" radius="md" defaultValue={status === 'DONE' ? 'done' : null}>
                  <Accordion.Item value="done">
                    <Accordion.Control>{t('myTasks.doneCount', { count: groups.done.length })}</Accordion.Control>
                    <Accordion.Panel>
                      <ul className="nz-task-cards">
                        {groups.done.map((task) => (
                          <li key={task.id}>
                            <TaskCard task={task} bucket="done" unread={unread.get(task.id) ?? 0} />
                          </li>
                        ))}
                      </ul>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryTile({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <div className="nz-sum-tile" data-zero={value === 0 || undefined} style={{ ['--tone' as string]: tone }}>
      <span className="nz-sum-value num">{formatNumber(value)}</span>
      <span className="nz-sum-label">{label}</span>
    </div>
  );
}

function TaskCard({ task, bucket, unread }: { task: MyTaskDto; bucket: Bucket; unread: number }) {
  const checklist = task.checklist;
  const late = bucket === 'overdue';
  const team = isTeamTask(task);
  const owner = team ? (task.assignee ? t('a12roles.mine.badgeTeamOf', { name: task.assignee.fullName }) : t('a12roles.mine.badgeTeam')) : t('a12roles.mine.badgeMine');
  const label = [task.name, task.project.name, task.assignedToMe === undefined ? '' : owner, taskStatusLabel(task.status as TaskStatus), unread ? tCount('a9s.myTasks.unreadAria', unread) : '']
    .filter(Boolean)
    .join('، ');
  return (
    <Link to={`/my-tasks/${task.id}`} className="nz-task-card" data-bucket={bucket} aria-label={label}>
      <div className="nz-task-card-top">
        <Text span size="xs" c="dimmed" truncate className="nz-task-card-project">
          {task.project.name}
        </Text>
        {unread ? (
          <span className="nz-unread-badge" aria-hidden>
            <IconMessageCircle size={14} />
            <span className="num">{formatNumber(unread)}</span>
          </span>
        ) : null}
      </div>
      {task.assignedToMe !== undefined ? (
        <span className="nz-task-card-owner">
          <span className={team ? 'pill blue' : 'pill brand'} data-testid={team ? 'mytask-badge-team' : 'mytask-badge-mine'}>
            {owner}
          </span>
          {team ? <DualRoleBadge user={task.assignee} compact /> : null}
        </span>
      ) : null}
      <Text className="nz-task-card-name" fw={600}>
        {task.name}
      </Text>
      <div className="nz-task-card-meta">
        <Text span size="sm" c={late ? 'var(--red)' : 'dimmed'} fw={late ? 600 : 400}>
          {late ? t('a9s.myTasks.late', { when: taskWhen(task) }) : taskWhen(task)}
        </Text>
        {task.deadline ? (
          <span className="nz-deadline" data-passed={task.deadlinePassed || undefined}>
            <IconFlag size={14} aria-hidden />
            {task.deadlinePassed ? t('a9s.deadline.passed', { date: formatDate(task.deadline) }) : t('a9s.deadline.on', { date: formatDate(task.deadline) })}
          </span>
        ) : null}
      </div>
      <div className="nz-task-card-foot">
        <TaskStatusBadge status={task.status} />
        {checklist && checklist.total ? (
          <span className="nz-check-count" data-complete={checklist.done === checklist.total || undefined}>
            <IconListCheck size={15} aria-hidden />
            <span className="num">{t('a9s.checklist.count', { done: formatNumber(checklist.done), total: formatNumber(checklist.total) })}</span>
          </span>
        ) : null}
        <Group gap={6} wrap="nowrap" className="nz-task-card-progress">
          <Progress value={task.progress} color={task.progress >= 100 ? 'ok' : 'field'} size="sm" radius="xl" style={{ flex: 1 }} aria-hidden />
          <Text span size="xs" className="num" c="dimmed">
            {`${formatNumber(Math.round(task.progress))}٪`}
          </Text>
        </Group>
      </div>
    </Link>
  );
}
