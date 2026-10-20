/**
 * The admin task drawer inside a project (A9). Tabs in the URL (`?ttab=`): details (with deadline,
 * bar colour, budget and hours for HOUR projects — saved through `writes.updateTask` so Ctrl+Z
 * undoes it), checklist, labels & custom fields, the task chat, attachments, time log and
 * activity. `lg` on desktop, full screen on phones.
 */
import { AccessTaskChat } from '../../features/participants/AccessTaskChat';
import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  ColorInput,
  Drawer,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  useDirection,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconFlag, IconLink, IconRefresh, IconTrash } from '@tabler/icons-react';
import type { Priority, TaskStatus } from '@nuzli/shared';
import { syncStatusProgress } from '@nuzli/scheduling';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { useSupervisors } from '../../api/queries';
import { useTaskActivity } from '../../api/projectQueries';
import type { ProjectWrites } from '../../api/projectWrites';
import { unitOf, type GanttView, type TaskView } from '../../api/hoursWire';
import { useProjectAccess, useTaskAccess } from '../../features/participants/access';
import { FormError } from '../../components/ui';
import { formatDate, formatDateTime, formatLocalTime, formatMoney, formatNumber, t, tCount, tKey } from '../../i18n';
import { calendarOf, checkNewLink, engineState } from '../../features/gantt/batch';
import { linkMessage } from '../../features/gantt/Gantt';
import { useTabParam } from '../../lib/useUrlState';
import { TaskChat } from '../../features/chat/TaskChat';
import { TaskChecklist } from '../../features/tasks/TaskChecklist';
import { TaskTimeLog } from '../../features/tasks/TaskTimeLog';
import { TaskAttachments } from '../../features/tasks/TaskAttachments';
import { TaskLabelsFieldsEditor, TaskLabelsFieldsView } from '../../features/tasks/TaskLabelsFields';
import { taskWhen } from '../../features/tasks/when';
import { AssigneeChip, PRIORITIES, TASK_STATUSES, TaskStatusBadge, priorityLabel, taskStatusLabel, taskTypeLabel } from './parts';
import '../../features/tasks/tasks.css';

type Writes = ProjectWrites;

const TABS = ['details', 'checklist', 'meta', 'comments', 'files', 'time', 'activity'] as const;

/** Bar colour swatches (task data colours, not chrome): indigo, blue, teal, green, amber, orange, red, purple, grey. */
const BAR_SWATCHES = ['#5030e5', '#1565C0', '#00838F', '#2E7D32', '#A35C00', '#E65100', '#C62828', '#6A1B9A', '#546E7A'];

export function TaskDrawer({ data, taskId, writes, onClose }: { data: GanttView; taskId: string | null; writes: Writes; onClose(): void }) {
  const task = data.tasks.find((x) => x.id === taskId) ?? null;
  // The tab is in the URL (?ttab=) so a link can open a task on its comments.
  const [tab, setTab] = useTabParam('ttab', TABS, 'details');
  const { dir } = useDirection();
  const phone = useMediaQuery('(max-width: 767px)') ?? false;
  return (
    <Drawer
      opened={Boolean(task)}
      onClose={onClose}
      position={dir === 'rtl' ? 'left' : 'right'} // inline-end
      size={phone ? '100%' : 'lg'}
      title={task ? `${task.wbs} · ${task.name}` : ''}
      styles={{ title: { fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, body: { paddingBlockStart: 0 } }}
    >
      {task ? (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md" className="nz-drawer-tabs">
            <Tabs.Tab value="details">{t('task.tab.details')}</Tabs.Tab>
            <Tabs.Tab value="checklist">
              {task.checklist?.total
                ? t('a9s.drawer.tabChecklistCount', { done: formatNumber(task.checklist.done), total: formatNumber(task.checklist.total) })
                : t('a9s.drawer.tabChecklist')}
            </Tabs.Tab>
            <Tabs.Tab value="meta">{t('a9s.drawer.tabMeta')}</Tabs.Tab>
            <Tabs.Tab value="comments">{t('task.tab.comments', { count: task.commentCount })}</Tabs.Tab>
            <Tabs.Tab value="files">{t('task.tab.files', { count: task.attachmentCount })}</Tabs.Tab>
            <Tabs.Tab value="time">{t('a9s.drawer.tabTime')}</Tabs.Tab>
            <Tabs.Tab value="activity">{t('task.tab.activity')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="details">
            <TaskDetails key={`${task.id}:${task.version}`} data={data} task={task} writes={writes} onClose={onClose} />
          </Tabs.Panel>
          <Tabs.Panel value="checklist">
            <TaskChecklistTab task={task} />
          </Tabs.Panel>
          <Tabs.Panel value="meta">
            <MetaTab data={data} task={task} writes={writes} />
          </Tabs.Panel>
          <Tabs.Panel value="comments">
            <div className="nz-drawer-chat">
              <AccessTaskChat taskId={task.id} taskName={task.name} projectId={task.projectId} assignee={task.assignee} />
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="files">
            <FilesTab task={task} />
          </Tabs.Panel>
          <Tabs.Panel value="time">
            <TimeTab task={task} />
          </Tabs.Panel>
          <Tabs.Panel value="activity">
            <TaskActivity task={task} />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Drawer>
  );
}

// A12 round 2: the account's rights plus the participant level on this project (features/participants/access).
function TaskChecklistTab({ task }: { task: TaskView }) {
  const access = useTaskAccess(task);
  return <TaskChecklist taskId={task.id} projectId={task.projectId} mode={access.checklist} />;
}

function FilesTab({ task }: { task: TaskView }) {
  const access = useTaskAccess(task);
  return <TaskAttachments taskId={task.id} projectId={task.projectId} assigneeId={task.assignee?.id ?? null} canUpload={access.attach} />;
}

function MetaTab({ data, task, writes }: { data: GanttView; task: TaskView; writes: Writes }) {
  return useTaskAccess(task).edit ? <TaskLabelsFieldsEditor data={data} task={task} writes={writes} /> : <TaskLabelsFieldsView taskId={task.id} />;
}

function TimeTab({ task }: { task: TaskView }) {
  const access = useTaskAccess(task);
  return <TaskTimeLog taskId={task.id} admin={access.timeAdmin} canLog={access.logTime} />;
}

// ---------------------------------------------------------------- details

const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

function TaskDetails({ data, task, writes, onClose }: { data: GanttView; task: TaskView; writes: Writes; onClose(): void }) {
  const api = useApi();
  const access = useTaskAccess(task);
  const project = useProjectAccess(task.projectId);
  const admin = access.edit;
  const mine = access.status;
  // A12 round 2: money is absent without budget.read and read-only without budget.manage.
  const showMoney = project.budgetRead;
  const editMoney = admin && project.budgetManage;
  const isGroup = data.tasks.some((x) => x.parentId === task.id);
  const hours = unitOf(data.project) === 'HOUR';
  const currency = data.project.currency ?? 'SAR';
  const supervisors = useSupervisors(admin);
  const cal = useMemo(() => calendarOf(data.calendar), [data.calendar]);
  const [form, setForm] = useState({
    name: task.name,
    type: task.type,
    startDate: hours ? task.startDate.slice(0, 16) : task.startDate.slice(0, 10),
    durationDays: task.durationDays,
    durationHours: task.durationHours ?? 0,
    progress: task.progress,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assignee?.id ?? null,
    description: task.description ?? '',
    deadline: task.deadline ?? '',
    barColor: task.barColor ?? '',
    plannedCost: task.plannedCost ?? 0,
    actualCost: task.actualCost ?? 0,
  });
  const [error, setError] = useState<unknown>(null);
  const [colorError, setColorError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  /** Calculations audit H1: status and progress move together in the form, as the server will store them. */
  const setStatusProgress = (edit: { status?: TaskStatus; progress?: number }) =>
    setForm((f) => ({ ...f, ...syncStatusProgress({ status: f.status, progress: f.progress }, edit) }));
  const endPreview =
    form.type === 'MILESTONE'
      ? cal.addWorkingDays(form.startDate || task.startDate, 0)
      : cal.endFromDuration(form.startDate || task.startDate, Math.max(1, form.durationDays || 1));

  const save = async () => {
    setError(null);
    if (form.barColor && !isHex(form.barColor)) {
      setColorError(t('a9s.drawer.colorInvalid'));
      return;
    }
    const patch: Record<string, unknown> = { version: task.version };
    if (!isGroup) {
      if (form.progress !== task.progress) patch.progress = form.progress;
      if (form.status !== task.status) patch.status = form.status;
    }
    if (admin) {
      if (form.name.trim() !== task.name) patch.name = form.name.trim();
      if (form.priority !== task.priority) patch.priority = form.priority;
      if ((form.assigneeId ?? null) !== (task.assignee?.id ?? null)) patch.assigneeId = form.assigneeId;
      if ((form.description || null) !== (task.description || null) && form.description.trim()) patch.description = form.description;
      if ((form.deadline || null) !== (task.deadline ?? null)) patch.deadline = form.deadline || null;
      const color = form.barColor ? form.barColor.toUpperCase() : null;
      if (color !== (task.barColor ? task.barColor.toUpperCase() : null)) patch.barColor = color;
      if (!isGroup) {
        if (form.type !== task.type) patch.type = form.type;
        if (hours) {
          if (form.startDate !== task.startDate.slice(0, 16)) patch.startDate = form.startDate;
          if (form.type !== 'MILESTONE' && form.durationHours !== (task.durationHours ?? 0)) patch.durationHours = form.durationHours;
        } else {
          if (form.startDate !== task.startDate.slice(0, 10)) patch.startDate = form.startDate;
          if (form.durationDays !== task.durationDays && form.type !== 'MILESTONE') patch.durationDays = form.durationDays;
        }
        if (editMoney && form.plannedCost !== (task.plannedCost ?? 0)) patch.plannedCost = form.plannedCost;
        if (editMoney && form.actualCost !== (task.actualCost ?? 0)) patch.actualCost = form.actualCost;
      }
    }
    if (Object.keys(patch).length === 1) {
      onClose();
      return;
    }
    try {
      const res = await writes.updateTask(task.id, patch as never, t('undo.label.edit'));
      notifications.show({
        color: 'ok',
        message: res.affected.length ? tCount('task.savedShifted', res.affected.length) : t('common.saved'),
      });
    } catch (err) {
      setError(err);
    }
  };

  const archive = () =>
    modals.openConfirmModal({
      title: t('task.archiveTitle'),
      children: <Text size="sm">{isGroup ? t('task.archiveGroupBody', { name: task.name }) : t('task.archiveBody', { name: task.name })}</Text>,
      labels: { confirm: t('task.archive'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          const res = await writes.archive([task.id]);
          onClose();
          notifications.show({ color: 'ok', message: tCount('task.archived', res.archivedIds.length) });
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  const readOnly = !admin && !mine;
  const money = (v: number) => formatMoney(v, currency);
  return (
    <Stack>
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      <FormError error={error instanceof ApiError && error.code === 'CONFLICT_VERSION' ? null : error} />
      {readOnly ? (
        <Alert color="gray" variant="light">
          {t('task.readOnly')}
        </Alert>
      ) : !admin ? (
        <Alert color="field" variant="light">
          {project.level === 'CONTRIBUTOR' ? t('a12roles.contributorHint') : t('task.supervisorHint')}
        </Alert>
      ) : null}
      <Group gap="xs" wrap="wrap">
        <TaskStatusBadge status={task.status} />
        <Text size="sm" c="dimmed">
          {taskTypeLabel(isGroup ? 'GROUP' : task.type)}
        </Text>
        {task.deadline ? (
          <span className="nz-deadline" data-passed={task.deadlinePassed || undefined}>
            <IconFlag size={14} aria-hidden />
            {task.deadlinePassed ? t('a9s.deadline.passed', { date: formatDate(task.deadline) }) : t('a9s.deadline.on', { date: formatDate(task.deadline) })}
          </span>
        ) : null}
        {showMoney && task.overBudget ? (
          <Badge color="breach" variant="light" radius="xl">
            {t('a9s.drawer.overBudget')}
          </Badge>
        ) : null}
      </Group>
      <TextInput label={t('task.name')} value={form.name} onChange={(e) => set('name', e.currentTarget.value)} disabled={!admin} required />
      {!isGroup ? (
        <Select
          label={t('task.type')}
          data={(['TASK', 'MILESTONE'] as const).map((x) => ({ value: x, label: taskTypeLabel(x) }))}
          value={form.type === 'GROUP' ? 'TASK' : form.type}
          onChange={(v) => v && set('type', v as TaskView['type'])}
          disabled={!admin}
          allowDeselect={false}
        />
      ) : null}

      {hours ? (
        <>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              type="datetime-local"
              label={t('a9s.drawer.startTime')}
              value={form.startDate}
              step={900}
              onChange={(e) => set('startDate', e.currentTarget.value)}
              disabled={!admin || isGroup}
            />
            <NumberInput
              label={t('a9s.drawer.durationHours')}
              description={t('a9s.drawer.durationHoursHint')}
              min={form.type === 'MILESTONE' ? 0 : 0.25}
              max={87_600}
              step={0.25}
              decimalScale={2}
              value={form.type === 'MILESTONE' ? 0 : form.durationHours}
              onChange={(v) => set('durationHours', Math.max(0.25, Math.round((Number(v) || 0.25) * 4) / 4))}
              disabled={!admin || isGroup || form.type === 'MILESTONE'}
            />
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {t('a9s.drawer.whenNow', { when: taskWhen(task) })}
          </Text>
        </>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput type="date" label={t('task.start')} value={form.startDate} onChange={(e) => set('startDate', e.currentTarget.value)} disabled={!admin || isGroup} />
            <NumberInput
              label={t('task.duration')}
              description={t('task.durationHint')}
              min={form.type === 'MILESTONE' ? 0 : 1}
              max={3650}
              value={form.type === 'MILESTONE' ? 0 : form.durationDays}
              onChange={(v) => set('durationDays', Number(v) || 1)}
              disabled={!admin || isGroup || form.type === 'MILESTONE'}
              allowDecimal={false}
            />
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            {t('task.endComputed', { date: formatDate(isGroup ? task.endDate : endPreview) })}
          </Text>
        </>
      )}

      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <TextInput
          type="date"
          label={t('a9s.drawer.deadline')}
          description={t('a9s.drawer.deadlineHint')}
          value={form.deadline}
          onChange={(e) => set('deadline', e.currentTarget.value)}
          disabled={!admin}
          rightSection={
            admin && form.deadline ? (
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('a9s.drawer.clearDeadline')} onClick={() => set('deadline', '')}>
                <IconTrash size={14} />
              </ActionIcon>
            ) : null
          }
        />
        <ColorInput
          label={t('a9s.drawer.barColor')}
          description={t('a9s.drawer.barColorHint')}
          placeholder={t('a9s.drawer.barColorDefault')}
          format="hex"
          swatches={BAR_SWATCHES}
          swatchesPerRow={9}
          value={form.barColor}
          onChange={(v) => {
            setColorError(null);
            set('barColor', v);
          }}
          disabled={!admin}
          withEyeDropper={false}
          error={colorError}
          rightSection={
            admin && form.barColor ? (
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('a9s.drawer.clearColor')} onClick={() => set('barColor', '')}>
                <IconTrash size={14} />
              </ActionIcon>
            ) : null
          }
        />
      </SimpleGrid>

      {showMoney ? (
      <div className="surface-card nz-drawer-budget">
        <Text fw={600} size="sm" mb={6}>
          {t('a9s.drawer.budget')}
        </Text>
        {isGroup ? (
          <SimpleGrid cols={2} spacing="xs">
            <div>
              <Text size="xs" c="dimmed">
                {t('a9s.drawer.plannedCost')}
              </Text>
              <Text fw={600} className="num">
                {money(task.plannedCost ?? 0)}
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">
                {t('a9s.drawer.actualCost')}
              </Text>
              <Text fw={600} className="num" c={task.overBudget ? 'var(--red)' : undefined}>
                {money(task.actualCost ?? 0)}
              </Text>
            </div>
            <Text size="xs" c="dimmed" style={{ gridColumn: '1 / -1' }}>
              {t('a9s.drawer.groupSums')}
            </Text>
          </SimpleGrid>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
            <NumberInput
              label={t('a9s.drawer.plannedCost')}
              min={0}
              decimalScale={2}
              thousandSeparator=","
              value={form.plannedCost}
              onChange={(v) => set('plannedCost', Math.max(0, Number(v) || 0))}
              rightSection={<Text size="xs" c="dimmed">{currency === 'SAR' ? t('money.sar') : currency}</Text>}
              rightSectionWidth={44}
              disabled={!editMoney}
            />
            <NumberInput
              label={t('a9s.drawer.actualCost')}
              min={0}
              decimalScale={2}
              thousandSeparator=","
              value={form.actualCost}
              onChange={(v) => set('actualCost', Math.max(0, Number(v) || 0))}
              rightSection={<Text size="xs" c="dimmed">{currency === 'SAR' ? t('money.sar') : currency}</Text>}
              rightSectionWidth={44}
              disabled={!editMoney}
              error={form.actualCost > form.plannedCost && form.plannedCost > 0 ? t('a9s.drawer.overBy', { value: money(form.actualCost - form.plannedCost) }) : undefined}
            />
          </SimpleGrid>
        )}
      </div>
      ) : null}

      <div>
        <Text size="sm" fw={500} mb={4} id="task-progress-label">
          {t('task.progressValue', { value: formatNumber(Math.round(form.progress)) })}
        </Text>
        <Slider
          aria-labelledby="task-progress-label"
          value={form.progress}
          onChange={(v) => setStatusProgress({ progress: v })}
          step={5}
          min={0}
          max={100}
          disabled={readOnly || isGroup}
          color={form.progress >= 100 ? 'ok' : 'field'}
          label={(v) => `${formatNumber(v)}٪`}
        />
      </div>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <Select
          label={t('task.status')}
          data={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s) }))}
          value={form.status}
          onChange={(v) => v && setStatusProgress({ status: v as TaskStatus })}
          disabled={readOnly || isGroup}
          description={isGroup ? t('task.groupStatusDerived') : undefined}
          allowDeselect={false}
        />
        <Select
          label={t('task.priority')}
          data={PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
          value={form.priority}
          onChange={(v) => v && set('priority', v as Priority)}
          disabled={!admin}
          allowDeselect={false}
        />
      </SimpleGrid>
      {admin ? (
        <Select
          label={t('task.assignee')}
          description={t('task.assigneeHint')}
          placeholder={t('task.unassigned')}
          data={(supervisors.data ?? []).map((u) => ({ value: u.id, label: u.fullName }))}
          value={form.assigneeId}
          onChange={(v) => set('assigneeId', v)}
          searchable
          clearable
          nothingFoundMessage={t('task.noSupervisors')}
        />
      ) : (
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('task.assignee')}
          </Text>
          <AssigneeChip assignee={task.assignee} />
        </div>
      )}
      <Textarea label={t('task.description')} autosize minRows={2} value={form.description} onChange={(e) => set('description', e.currentTarget.value)} disabled={!admin} />
      <Dependencies data={data} task={task} writes={writes} editable={admin} />
      {!readOnly ? (
        <Group justify="space-between" mt="sm" className="nz-drawer-actions">
          {admin ? (
            <Button variant="subtle" color="breach" leftSection={<IconTrash size={16} />} onClick={archive}>
              {t('task.archive')}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={() => void save()} loading={writes.saving}>
            {t('task.save')}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

export function ConflictAlert({ onRefresh }: { onRefresh(): void }) {
  return (
    <Alert color="signal" role="alert" title={t('gantt.conflict')}>
      <Button size="xs" mt="xs" leftSection={<IconRefresh size={14} />} onClick={onRefresh}>
        {t('gantt.refresh')}
      </Button>
    </Alert>
  );
}

function Dependencies({ data, task, writes, editable }: { data: GanttView; task: TaskView; writes: Writes; editable: boolean }) {
  const api = useApi();
  const names = new Map(data.tasks.map((x) => [x.id, x]));
  const preds = data.dependencies.filter((d) => d.successorId === task.id);
  const succs = data.dependencies.filter((d) => d.predecessorId === task.id);
  const [pred, setPred] = useState<string | null>(null);
  const [lag, setLag] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!pred) return;
    setError(null);
    const check = checkNewLink(engineState(data), pred, task.id);
    if (!check.ok) {
      setError(linkMessage(check.reason, check.path, data.tasks));
      return;
    }
    try {
      const dep = await writes.run(() => api.dependencies.create(task.projectId, { predecessorId: pred, successorId: task.id, type: 'FS', lagDays: lag }));
      writes.merge(dep.affected);
      await writes.refresh();
      setPred(null);
      setLag(0);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'DEPENDENCY_CYCLE' ? linkMessage('cycle', (err.details as { path?: string[] })?.path, data.tasks) : errorMessage(err));
    }
  };
  const remove = async (id: string) => {
    try {
      await writes.run(() => api.dependencies.remove(id));
      await writes.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const item = (id: string, otherId: string, lagDays: number) => (
    <Group key={id} justify="space-between" wrap="nowrap" gap="xs">
      <Text size="sm" truncate>
        <span className="mono">{names.get(otherId)?.wbs}</span> {names.get(otherId)?.name ?? '—'}
        {lagDays ? <Text span size="xs" c="dimmed">{` (${lagDays > 0 ? tCount('task.lag', lagDays) : tCount('task.lead', -lagDays)})`}</Text> : null}
      </Text>
      {editable ? (
        <ActionIcon variant="subtle" color="breach" aria-label={t('task.removeLink')} onClick={() => void remove(id)}>
          <IconTrash size={16} />
        </ActionIcon>
      ) : null}
    </Group>
  );
  return (
    <Stack gap="xs" className="surface-card" p="sm">
      <Group gap={6}>
        <IconLink size={16} aria-hidden />
        <Text fw={600} size="sm">
          {t('task.dependencies')}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        {t('task.predecessors')}
      </Text>
      {preds.length ? preds.map((d) => item(d.id, d.predecessorId, d.lagDays)) : <Text size="sm" c="dimmed">{t('common.none')}</Text>}
      <Text size="xs" c="dimmed">
        {t('task.successors')}
      </Text>
      {succs.length ? succs.map((d) => item(d.id, d.successorId, d.lagDays)) : <Text size="sm" c="dimmed">{t('common.none')}</Text>}
      {editable ? (
        <Group align="flex-end" gap="xs" wrap="wrap">
          <Select
            label={t('task.addPredecessor')}
            data={data.tasks.filter((x) => x.id !== task.id).map((x) => ({ value: x.id, label: `${x.wbs} ${x.name}` }))}
            value={pred}
            onChange={setPred}
            searchable
            style={{ flex: '1 1 200px' }}
            limit={50}
          />
          <NumberInput label={t('task.lagLabel')} value={lag} onChange={(v) => setLag(Number(v) || 0)} min={-365} max={365} w={110} />
          <Button variant="light" onClick={() => void add()} disabled={!pred}>
            {t('task.addLink')}
          </Button>
        </Group>
      ) : null}
      {error ? (
        <Alert color="breach" role="alert">
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- activity

const SHOWN_FIELDS = ['startDate', 'endDate', 'progress', 'status', 'durationDays', 'durationHours', 'name', 'assigneeId', 'priority', 'deadline', 'barColor', 'plannedCost', 'actualCost', 'labelIds'];

export function TaskActivity({ task }: { task: TaskView }) {
  const activity = useTaskActivity(task.id);
  if (activity.isLoading) return <Text c="dimmed">{t('app.loading')}</Text>;
  if (!activity.data?.length) return <Text c="dimmed">{t('task.noActivity')}</Text>;
  return (
    <Stack gap={0}>
      {activity.data.map((a) => {
        const after = (a.after && typeof a.after === 'object' ? a.after : {}) as Record<string, unknown>;
        const auto = after.auto === true;
        const fields = Object.keys(after).filter((k) => SHOWN_FIELDS.includes(k));
        return (
          <div key={a.id} style={{ paddingBlock: 8, borderBlockEnd: '1px solid var(--line)' }}>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text size="sm" fw={600}>
                {tKey(`audit.action.${a.action}`, 'audit.action.other')}
                {auto ? (
                  <Text span size="xs" c="dimmed">
                    {` — ${t('task.autoShift')}`}
                  </Text>
                ) : null}
              </Text>
              <Text size="xs" c="dimmed" style={{ flex: '0 0 auto' }}>
                {formatDateTime(a.at)}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {a.actor?.fullName ?? t('common.system')}
              {fields.length ? ` · ${fields.map((f) => describe(f, after[f])).join('، ')}` : ''}
            </Text>
          </div>
        );
      })}
    </Stack>
  );
}

function describe(field: string, value: unknown): string {
  const label = tKey(`audit.fieldName.${field}`, 'audit.field');
  if (field === 'status') return `${label}: ${taskStatusLabel(String(value))}`;
  if (field === 'priority') return `${label}: ${priorityLabel(String(value))}`;
  if (field === 'progress') return `${label}: ${formatNumber(Number(value))}٪`;
  if (field === 'plannedCost' || field === 'actualCost') return `${label}: ${formatMoney(Number(value))}`;
  if (field === 'durationHours') return `${label}: ${formatNumber(Number(value))}`;
  if (field === 'startDate' || field === 'endDate' || field === 'deadline') {
    if (value === null || value === undefined || value === '') return `${label}: ${t('common.none')}`;
    const s = String(value);
    return `${label}: ${formatDate(s.slice(0, 10))}${s.length > 10 ? ` ${formatLocalTime(s)}` : ''}`;
  }
  if (field === 'assigneeId' || field === 'barColor' || field === 'labelIds') return label;
  return `${label}: ${String(value)}`;
}
