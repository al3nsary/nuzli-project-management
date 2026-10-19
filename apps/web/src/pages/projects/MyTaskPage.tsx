/**
 * The supervisor's task page `/my-tasks/:id` (owner request A9: «عندما يفتح المشرف المهمة يمكنه
 * أن يرى الملاحظات كشات ويمكنه الرد عليها»). The chat is the main area; the header carries the
 * task's identity, dates, deadline, status and progress; a side panel (desktop ≥ 992px) or a
 * second tab (phones) holds the checklist, time log, attachments, description, labels and fields.
 * A task that is not assigned to the viewer answers 404 → a friendly state with a way back.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Accordion, ActionIcon, Badge, Group, Select, SegmentedControl, Slider, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconChecklist, IconClock, IconFileText, IconFlag, IconLock, IconMessages, IconPaperclip, IconTag } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { can, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qkA9, useTask } from '../../api/a9Queries';
import { qk4, useMyTasks } from '../../api/projectQueries';
import type { TaskView } from '../../api/hoursWire';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatDate, formatNumber, t } from '../../i18n';
import { useTabParam } from '../../lib/useUrlState';
import { TaskChat } from '../../features/chat/TaskChat';
import { TaskChecklist } from '../../features/tasks/TaskChecklist';
import { TaskTimeLog } from '../../features/tasks/TaskTimeLog';
import { TaskAttachments } from '../../features/tasks/TaskAttachments';
import { TaskLabelsFieldsView } from '../../features/tasks/TaskLabelsFields';
import { taskWhen } from '../../features/tasks/when';
import { TASK_STATUSES, TaskStatusBadge, taskStatusLabel } from './parts';
import '../../features/tasks/tasks.css';

export function MyTaskPage() {
  const { id = '' } = useParams();
  const task = useTask(id);
  const mine = useMyTasks();
  const wide = useMediaQuery('(min-width: 992px)') ?? false;
  const [view, setView] = useTabParam('view', ['chat', 'details'] as const, 'chat');

  if (task.isLoading) return <LoadingBlock variant="detail" header />;
  if (task.isError) {
    if (task.error instanceof ApiError && (task.error.status === 404 || task.error.code === 'NOT_FOUND')) return <NotYours />;
    return <ErrorBlock error={task.error} onRetry={() => void task.refetch()} />;
  }
  const data = task.data;
  if (!data) return <NotYours />;
  const projectName = mine.data?.find((x) => x.id === id)?.project.name ?? null;

  return (
    <div className="nz-mt-page" data-wide={wide || undefined} data-view={wide ? undefined : view}>
      {/* Phones: the status and progress controls live on the details view so the chat keeps its height. */}
      <TaskHeader task={data} projectName={projectName} showUpdate={wide || view === 'details'} />
      {wide ? (
        <div className="nz-mt-grid">
          <div className="nz-mt-chat">
            <TaskChat taskId={data.id} taskName={data.name} assignee={data.assignee} />
          </div>
          <aside className="nz-mt-side" aria-label={t('a9s.task.details')}>
            <TaskSide task={data} />
          </aside>
        </div>
      ) : (
        <>
          <SegmentedControl
            className="nz-mt-switch"
            fullWidth
            value={view}
            onChange={setView}
            data={[
              {
                value: 'chat',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconMessages size={16} aria-hidden />
                    {t('a9s.task.tabChat')}
                  </Group>
                ),
              },
              {
                value: 'details',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconChecklist size={16} aria-hidden />
                    {t('a9s.task.tabDetails')}
                  </Group>
                ),
              },
            ]}
          />
          {view === 'chat' ? (
            <div className="nz-mt-chat">
              <TaskChat taskId={data.id} taskName={data.name} assignee={data.assignee} />
            </div>
          ) : (
            <div className="nz-mt-side nz-mt-side--phone">
              <TaskSide task={data} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NotYours() {
  return (
    <div className="nz-mt-missing">
      <EmptyState icon={IconLock} title={t('a9s.task.notYoursTitle')} body={t('a9s.task.notYoursBody')} />
      <Group justify="center" mt="md">
        <Link to="/my-tasks" className="nz-mt-back-link">
          <IconArrowLeft size={16} className="mirror-rtl" aria-hidden />
          {t('a9s.task.backToMine')}
        </Link>
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------- header with status + progress

function TaskHeader({ task, projectName, showUpdate = true }: { task: TaskView; projectName: string | null; showUpdate?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canUpdate = can(user, 'tasks.manage') || (task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned'));
  const [progress, setProgress] = useState(task.progress);
  const [busy, setBusy] = useState(false);
  useEffect(() => setProgress(task.progress), [task.progress, task.version]);

  const save = async (patch: { status?: TaskStatus; progress?: number }) => {
    setBusy(true);
    try {
      const res = await api.tasks.update(task.id, { version: task.version, ...patch });
      qc.setQueryData(qkA9.task(task.id), res.task);
      void qc.invalidateQueries({ queryKey: qk4.myTasks });
      void qc.invalidateQueries({ queryKey: ['task', task.id, 'activity'] });
      void qc.invalidateQueries({ queryKey: qk4.gantt(task.projectId) });
      notifications.show({ color: 'ok', message: t('myTasks.saved', { name: task.name }) });
    } catch (err) {
      setProgress(task.progress);
      const stale = err instanceof ApiError && err.code === 'CONFLICT_VERSION';
      notifications.show({ color: 'breach', message: stale ? t('a9s.task.conflict') : errorMessage(err) });
      if (stale) void qc.invalidateQueries({ queryKey: qkA9.task(task.id) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="nz-mt-head">
      <div className="nz-mt-head-row">
        <Tooltip label={t('a9s.task.backToMine')} openDelay={400}>
          <ActionIcon component={Link} to="/my-tasks" variant="default" size={44} radius="md" aria-label={t('a9s.task.backToMine')}>
            <IconArrowLeft size={20} className="mirror-rtl" />
          </ActionIcon>
        </Tooltip>
        <div className="nz-mt-title">
          <Text size="xs" c="dimmed" className="nz-mt-crumb" truncate>
            {projectName ? <span>{projectName}</span> : null}
            {projectName ? <span aria-hidden> · </span> : null}
            <span className="mono">{t('a9s.task.wbs', { wbs: task.wbs })}</span>
          </Text>
          <h1 className="nz-mt-name" tabIndex={-1}>
            {task.name}
          </h1>
        </div>
      </div>
      <div className="nz-mt-meta">
        <TaskStatusBadge status={task.status} />
        <Text span size="sm" c="dimmed">
          {taskWhen(task)}
        </Text>
        {task.deadline ? (
          <span className="nz-deadline" data-passed={task.deadlinePassed || undefined}>
            <IconFlag size={14} aria-hidden />
            {task.deadlinePassed ? t('a9s.deadline.passed', { date: formatDate(task.deadline) }) : t('a9s.deadline.on', { date: formatDate(task.deadline) })}
          </span>
        ) : null}
        {task.priority === 'URGENT' || task.priority === 'HIGH' ? (
          <Badge variant="light" color={task.priority === 'URGENT' ? 'breach' : 'signal'} radius="xl">
            {t(`priority.${task.priority}` as 'priority.HIGH')}
          </Badge>
        ) : null}
      </div>
      {showUpdate && canUpdate && task.type !== 'GROUP' ? (
        <div className="nz-mt-update" aria-busy={busy}>
          <Select
            className="nz-mt-status"
            label={t('task.status')}
            data={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s) }))}
            value={task.status}
            onChange={(v) => v && v !== task.status && void save({ status: v as TaskStatus })}
            allowDeselect={false}
            disabled={busy}
            comboboxProps={{ withinPortal: true }}
          />
          <div className="nz-mt-progress">
            <Text size="sm" fw={500} id={`mt-p-${task.id}`} mb={6}>
              {t('task.progressValue', { value: formatNumber(Math.round(progress)) })}
            </Text>
            <Slider
              aria-labelledby={`mt-p-${task.id}`}
              value={progress}
              onChange={setProgress}
              onChangeEnd={(v) => v !== task.progress && void save({ progress: v })}
              step={10}
              min={0}
              max={100}
              size="lg"
              thumbSize={26}
              color={progress >= 100 ? 'ok' : 'field'}
              label={(v) => `${formatNumber(v)}٪`}
              disabled={busy}
            />
          </div>
        </div>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------- secondary panel

function TaskSide({ task }: { task: TaskView }) {
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const assignee = task.assignee?.id === user?.id;
  const checklist = task.checklist;
  return (
    <Accordion multiple defaultValue={['checklist', 'description']} variant="separated" radius="md" className="nz-mt-acc" chevronPosition="right">
      <Accordion.Item value="checklist">
        <Accordion.Control icon={<IconChecklist size={18} />}>
          <Group gap={8} wrap="nowrap">
            {t('a9s.checklist.title')}
            {checklist?.total ? (
              <Badge size="sm" variant="light" color={checklist.done === checklist.total ? 'ok' : 'gray'} radius="xl" className="num">
                {t('a9s.checklist.count', { done: formatNumber(checklist.done), total: formatNumber(checklist.total) })}
              </Badge>
            ) : null}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <TaskChecklist taskId={task.id} projectId={task.projectId} mode={admin ? 'admin' : assignee ? 'assignee' : 'read'} />
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="description">
        <Accordion.Control icon={<IconFileText size={18} />}>{t('task.description')}</Accordion.Control>
        <Accordion.Panel>
          {task.description ? (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {task.description}
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              {t('a9s.task.noDescription')}
            </Text>
          )}
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="time">
        <Accordion.Control icon={<IconClock size={18} />}>{t('a9s.time.title')}</Accordion.Control>
        <Accordion.Panel>
          <TaskTimeLog taskId={task.id} admin={admin} canLog={admin || assignee} />
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="files">
        <Accordion.Control icon={<IconPaperclip size={18} />}>
          <Group gap={8} wrap="nowrap">
            {t('a9s.files.title')}
            {task.attachmentCount ? (
              <Badge size="sm" variant="light" color="gray" radius="xl" className="num">
                {formatNumber(task.attachmentCount)}
              </Badge>
            ) : null}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <TaskAttachments taskId={task.id} projectId={task.projectId} assigneeId={task.assignee?.id ?? null} />
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="meta">
        <Accordion.Control icon={<IconTag size={18} />}>{t('a9s.labels.titleFields')}</Accordion.Control>
        <Accordion.Panel>
          <TaskLabelsFieldsView taskId={task.id} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
