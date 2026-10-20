/**
 * The chat-centred task screen (owner requests A9 + A10). Supervisors open it as their page
 * `/my-tasks/:id`; admins open the very same screen over a project (Gantt, list, board) from the
 * chat icon on every task row — `?chat=<taskId>`, a large side panel on desktop and full screen
 * on phones, closed by Esc or the browser's back. The chat is the main area; the header carries
 * the task's identity, dates, deadline, status and progress; a side panel (≥ 992px) or a second
 * tab (phones) holds the checklist, description, time log, attachments, activity, labels and fields.
 */
import { AccessTaskChat } from '../../features/participants/AccessTaskChat';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Accordion, ActionIcon, Badge, Drawer, Group, Select, SegmentedControl, Slider, Text, Tooltip, useDirection } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconChecklist, IconClock, IconFileText, IconFlag, IconHistory, IconInfoCircle, IconLock, IconMessages, IconPaperclip, IconTag, IconX } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qkA9, useTask } from '../../api/a9Queries';
import { qk4 } from '../../api/projectQueries';
import type { TaskView } from '../../api/hoursWire';
import { useTaskAccess } from '../../features/participants/access';
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
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { TaskActivity } from './TaskDrawer';
import '../../features/tasks/tasks.css';

type WorkspaceView = 'chat' | 'details';
const WORKSPACE_VIEWS = ['chat', 'details'] as const;

export interface TaskWorkspaceProps {
  taskId: string;
  /** 'page' = the supervisor's /my-tasks/:id (phone tab in ?view=); 'panel' = over a project. */
  variant?: 'page' | 'panel';
  projectName?: string | null;
  onClose?: () => void;
  titleId?: string;
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  return props.variant === 'panel' ? <PanelWorkspace {...props} /> : <PageWorkspace {...props} />;
}

/** The page keeps its phone tab in the URL (?view=details); the panel keeps it locally (?view= is the project tab). */
function PageWorkspace(props: TaskWorkspaceProps) {
  const [view, setView] = useTabParam('view', WORKSPACE_VIEWS, 'chat');
  return <WorkspaceBody {...props} view={view} setView={(v) => setView(v)} />;
}

function PanelWorkspace(props: TaskWorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>('chat');
  return <WorkspaceBody {...props} view={view} setView={setView} />;
}

function WorkspaceBody({
  taskId,
  variant = 'page',
  projectName = null,
  onClose,
  titleId,
  view,
  setView,
}: TaskWorkspaceProps & { view: WorkspaceView; setView(v: WorkspaceView): void }) {
  const task = useTask(taskId);
  const wide = useMediaQuery('(min-width: 992px)') ?? false;
  const panel = variant === 'panel';

  if (task.isLoading) return <LoadingBlock variant="detail" header />;
  if (task.isError) {
    if (task.error instanceof ApiError && (task.error.status === 404 || task.error.code === 'NOT_FOUND')) return <NotYours panel={panel} onClose={onClose} />;
    return <ErrorBlock error={task.error} onRetry={() => void task.refetch()} />;
  }
  const data = task.data;
  if (!data) return <NotYours panel={panel} onClose={onClose} />;

  return (
    <div className="nz-mt-page" data-wide={wide || undefined} data-panel={panel || undefined} data-view={wide ? undefined : view}>
      {/* Phones: the status and progress controls live on the details view so the chat keeps its height. */}
      <TaskHeader task={data} projectName={projectName} showUpdate={wide || view === 'details'} onClose={panel ? onClose : undefined} titleId={titleId} />
      {wide ? (
        <div className="nz-mt-grid">
          <div className="nz-mt-chat">
            <AccessTaskChat taskId={data.id} taskName={data.name} projectId={data.projectId} assignee={data.assignee} />
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
            onChange={(v) => setView(v as WorkspaceView)}
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
              <AccessTaskChat taskId={data.id} taskName={data.name} projectId={data.projectId} assignee={data.assignee} />
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

/**
 * The admin's entry (A10): the task screen as a large side panel over the project (inline end,
 * desktop) or full screen (phones). Esc and the back button close it (the caller binds ?chat=).
 */
export function TaskChatDrawer({ taskId, projectName, onClose }: { taskId: string | null; projectName?: string | null; onClose(): void }) {
  const { dir } = useDirection();
  const phone = useMediaQuery('(max-width: 767px)') ?? false;
  const titleId = useId();
  return (
    <Drawer
      opened={Boolean(taskId)}
      onClose={onClose}
      position={dir === 'rtl' ? 'left' : 'right'} // inline-end
      size={phone ? '100%' : 'min(1180px, 94vw)'}
      withCloseButton={false}
      closeOnEscape
      trapFocus
      aria-labelledby={titleId}
      classNames={{ content: 'nz-chat-drawer', body: 'nz-chat-drawer-body' }}
    >
      {taskId ? <TaskWorkspace key={taskId} taskId={taskId} variant="panel" projectName={projectName} onClose={onClose} titleId={titleId} /> : null}
    </Drawer>
  );
}

function NotYours({ panel, onClose }: { panel: boolean; onClose?: () => void }) {
  return (
    <div className="nz-mt-missing">
      <EmptyState icon={IconLock} title={t('a9s.task.notYoursTitle')} body={t('a9s.task.notYoursBody')} />
      <Group justify="center" mt="md">
        {panel ? (
          <button type="button" className="nz-mt-back-link" onClick={onClose}>
            <IconX size={16} aria-hidden />
            {t('a10.chat.close')}
          </button>
        ) : (
          <Link to="/my-tasks" className="nz-mt-back-link">
            <IconArrowLeft size={16} className="mirror-rtl" aria-hidden />
            {t('a9s.task.backToMine')}
          </Link>
        )}
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------- header with status + progress

function TaskHeader({
  task,
  projectName,
  showUpdate = true,
  onClose,
  titleId,
}: {
  task: TaskView;
  projectName: string | null;
  showUpdate?: boolean;
  /** Panel variant: a close button instead of the link back to «مهامي». */
  onClose?: () => void;
  titleId?: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  // A12 round 2: admins, the assignee, a contributor/editor participant, or a co-supervisor (team task).
  const access = useTaskAccess(task);
  const canUpdate = access.status;
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
        {onClose ? (
          <Tooltip label={t('a10.chat.close')} openDelay={400}>
            <ActionIcon variant="default" size={44} radius="md" aria-label={t('a10.chat.close')} onClick={onClose} data-autofocus>
              <IconX size={20} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Tooltip label={t('a9s.task.backToMine')} openDelay={400}>
            <ActionIcon component={Link} to="/my-tasks" variant="default" size={44} radius="md" aria-label={t('a9s.task.backToMine')}>
              <IconArrowLeft size={20} className="mirror-rtl" />
            </ActionIcon>
          </Tooltip>
        )}
        <div className="nz-mt-title">
          <Text size="xs" c="dimmed" className="nz-mt-crumb" truncate>
            {projectName ? <span>{projectName}</span> : null}
            {projectName ? <span aria-hidden> · </span> : null}
            <span className="mono">{t('a9s.task.wbs', { wbs: task.wbs })}</span>
          </Text>
          {onClose ? (
            <h2 className="nz-mt-name" id={titleId} tabIndex={-1}>
              {task.name}
            </h2>
          ) : (
            <h1 className="nz-mt-name" tabIndex={-1}>
              {task.name}
            </h1>
          )}
        </div>
      </div>
      <div className="nz-mt-meta">
        <TaskStatusBadge status={task.status} />
        {access.team ? (
          <span className="pill blue" title={t('a12roles.task.teamHint')}>
            {task.assignee ? t('a12roles.mine.badgeTeamOf', { name: task.assignee.fullName }) : t('a12roles.mine.badgeTeam')}
          </span>
        ) : null}
        {access.team ? <DualRoleBadge user={task.assignee} compact /> : null}
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
  const access = useTaskAccess(task);
  const checklist = task.checklist;
  return (
    <>
    {access.team ? (
      <p className="nz-mt-team-note" data-testid="team-task-note">
        <IconInfoCircle size={16} aria-hidden />
        {t('a12roles.task.teamOnly')}
      </p>
    ) : null}
    <Accordion multiple defaultValue={['checklist', 'description']} variant="separated" radius="md" className="nz-mt-acc" chevronPosition="right">
      {!access.team ? (
        <>
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
          <TaskChecklist taskId={task.id} projectId={task.projectId} mode={access.checklist} />
        </Accordion.Panel>
      </Accordion.Item>
        </>
      ) : null}
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
      {!access.team ? (
        <>
      <Accordion.Item value="time">
        <Accordion.Control icon={<IconClock size={18} />}>{t('a9s.time.title')}</Accordion.Control>
        <Accordion.Panel>
          <TaskTimeLog taskId={task.id} admin={access.timeAdmin} canLog={access.logTime} />
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
          <TaskAttachments taskId={task.id} projectId={task.projectId} assigneeId={task.assignee?.id ?? null} canUpload={access.attach} />
        </Accordion.Panel>
      </Accordion.Item>
        </>
      ) : null}
      <Accordion.Item value="activity">
        <Accordion.Control icon={<IconHistory size={18} />}>{t('task.tab.activity')}</Accordion.Control>
        <Accordion.Panel>
          <TaskActivity task={task} />
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="meta">
        <Accordion.Control icon={<IconTag size={18} />}>{t('a9s.labels.titleFields')}</Accordion.Control>
        <Accordion.Panel>
          <TaskLabelsFieldsView taskId={task.id} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
    </>
  );
}
