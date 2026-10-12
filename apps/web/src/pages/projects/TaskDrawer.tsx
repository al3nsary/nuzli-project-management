import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Drawer,
  FileButton,
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
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconLink, IconPaperclip, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, can, type GanttDto, type Priority, type TaskDto, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { useSupervisors, useUsers } from '../../api/queries';
import {
  qk4,
  useProjectAccess,
  useTaskActivity,
  useTaskAttachments,
  useTaskComments,
} from '../../api/projectQueries';
import type { useProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { FormError } from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, t, tKey } from '../../i18n';
import { calendarOf } from '../../features/gantt/batch';
import { linkMessage } from '../../features/gantt/Gantt';
import { checkNewLink, engineState } from '../../features/gantt/batch';
import { AssigneeChip, PRIORITIES, TASK_STATUSES, TaskStatusBadge, priorityLabel, taskStatusLabel, taskTypeLabel } from './parts';

type Writes = ReturnType<typeof useProjectWrites>;

export function TaskDrawer({ data, taskId, writes, onClose }: { data: GanttDto; taskId: string | null; writes: Writes; onClose(): void }) {
  const task = data.tasks.find((x) => x.id === taskId) ?? null;
  const [tab, setTab] = useState<string | null>('details');
  const { dir } = useDirection();
  useEffect(() => setTab('details'), [taskId]);
  return (
    <Drawer
      opened={Boolean(task)}
      onClose={onClose}
      position={dir === 'rtl' ? 'left' : 'right'} // inline-end
      size="lg"
      title={task ? `${task.wbs} · ${task.name}` : ''}
      styles={{ title: { fontWeight: 700 } }}
    >
      {task ? (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="details">{t('task.tab.details')}</Tabs.Tab>
            <Tabs.Tab value="comments">{t('task.tab.comments', { count: formatNumber(task.commentCount) })}</Tabs.Tab>
            <Tabs.Tab value="files">{t('task.tab.files', { count: formatNumber(task.attachmentCount) })}</Tabs.Tab>
            <Tabs.Tab value="activity">{t('task.tab.activity')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="details">
            <TaskDetails key={`${task.id}:${task.version}`} data={data} task={task} writes={writes} onClose={onClose} />
          </Tabs.Panel>
          <Tabs.Panel value="comments">
            <TaskComments data={data} task={task} />
          </Tabs.Panel>
          <Tabs.Panel value="files">
            <TaskFiles task={task} />
          </Tabs.Panel>
          <Tabs.Panel value="activity">
            <TaskActivity task={task} />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------- details

function TaskDetails({ data, task, writes, onClose }: { data: GanttDto; task: TaskDto; writes: Writes; onClose(): void }) {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const mine = task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned');
  const isGroup = data.tasks.some((x) => x.parentId === task.id);
  const supervisors = useSupervisors(admin);
  const cal = useMemo(() => calendarOf(data.calendar), [data.calendar]);
  const [form, setForm] = useState({
    name: task.name,
    type: task.type,
    startDate: task.startDate,
    durationDays: task.durationDays,
    progress: task.progress,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assignee?.id ?? null,
    description: task.description ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const endPreview = form.type === 'MILESTONE' ? cal.addWorkingDays(form.startDate || task.startDate, 0) : cal.endFromDuration(form.startDate || task.startDate, Math.max(1, form.durationDays || 1));

  const save = async () => {
    setError(null);
    const patch: Record<string, unknown> = { version: task.version };
    if (form.progress !== task.progress) patch.progress = form.progress;
    if (form.status !== task.status) patch.status = form.status;
    if (admin) {
      if (form.name.trim() !== task.name) patch.name = form.name.trim();
      if (form.priority !== task.priority) patch.priority = form.priority;
      if ((form.assigneeId ?? null) !== (task.assignee?.id ?? null)) patch.assigneeId = form.assigneeId;
      if ((form.description || null) !== (task.description || null) && form.description.trim()) patch.description = form.description;
      if (!isGroup) {
        if (form.type !== task.type) patch.type = form.type;
        if (form.startDate !== task.startDate) patch.startDate = form.startDate;
        if (form.durationDays !== task.durationDays && form.type !== 'MILESTONE') patch.durationDays = form.durationDays;
      }
    }
    if (Object.keys(patch).length === 1) {
      onClose();
      return;
    }
    try {
      const res = await writes.run(() => api.tasks.update(task.id, patch as never));
      writes.merge([res.task, ...res.affected]);
      notifications.show({
        color: 'ok',
        message: res.affected.length ? t('task.savedShifted', { count: formatNumber(res.affected.length) }) : t('common.saved'),
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
          const res = await writes.run(() => api.tasks.archive(task.id));
          onClose();
          await writes.refresh();
          notifications.show({ color: 'ok', message: t('task.archived', { count: formatNumber(res.archivedIds.length) }) });
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  const readOnly = !admin && !mine;
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
          {t('task.supervisorHint')}
        </Alert>
      ) : null}
      <Group gap="xs">
        <TaskStatusBadge status={task.status} />
        <Text size="sm" c="dimmed">
          {taskTypeLabel(isGroup ? 'GROUP' : task.type)}
        </Text>
      </Group>
      <TextInput label={t('task.name')} value={form.name} onChange={(e) => set('name', e.currentTarget.value)} disabled={!admin} required />
      {!isGroup ? (
        <Select
          label={t('task.type')}
          data={(['TASK', 'MILESTONE'] as const).map((x) => ({ value: x, label: taskTypeLabel(x) }))}
          value={form.type === 'GROUP' ? 'TASK' : form.type}
          onChange={(v) => v && set('type', v as TaskDto['type'])}
          disabled={!admin}
          allowDeselect={false}
        />
      ) : null}
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
        />
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        {t('task.endComputed', { date: formatDate(isGroup ? task.endDate : endPreview) })}
      </Text>
      <div>
        <Text size="sm" fw={500} mb={4} id="task-progress-label">
          {t('task.progressValue', { value: formatNumber(Math.round(form.progress)) })}
        </Text>
        <Slider
          aria-labelledby="task-progress-label"
          value={form.progress}
          onChange={(v) => set('progress', v)}
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
          onChange={(v) => v && set('status', v as TaskStatus)}
          disabled={readOnly}
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
        <Group justify="space-between" mt="sm">
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

function Dependencies({ data, task, writes, editable }: { data: GanttDto; task: TaskDto; writes: Writes; editable: boolean }) {
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
        {lagDays ? <Text span size="xs" c="dimmed">{` (${t('task.lag', { days: formatNumber(lagDays) })})`}</Text> : null}
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

// ---------------------------------------------------------------- comments with @mentions

interface Person {
  id: string;
  fullName: string;
}

function useMentionCandidates(data: GanttDto): Person[] {
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'users.read');
  const admins = useUsers({ role: 'ADMIN', status: 'ACTIVE', pageSize: 200 }, admin);
  const access = useProjectAccess(data.project.id, can(user, 'projects.manage'));
  return useMemo(() => {
    const m = new Map<string, Person>();
    m.set(data.project.owner.id, data.project.owner);
    for (const x of data.tasks) if (x.assignee) m.set(x.assignee.id, { id: x.assignee.id, fullName: x.assignee.fullName });
    for (const u of admins.data?.items ?? []) m.set(u.id, { id: u.id, fullName: u.fullName });
    for (const a of access.data ?? []) m.set(a.user.id, { id: a.user.id, fullName: a.user.fullName });
    if (user) m.delete(user.id);
    return [...m.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'));
  }, [data, admins.data, access.data, user]);
}

function TaskComments({ data, task }: { data: GanttDto; task: TaskDto }) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const comments = useTaskComments(task.id);
  const people = useMentionCandidates(data);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canComment = can(user, 'tasks.comment');

  const matches = query ? people.filter((p) => p.fullName.includes(query.text)).slice(0, 6) : [];

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.currentTarget.value;
    setBody(v);
    const caret = e.currentTarget.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\n/.test(before.slice(at)) && before.length - at <= 30) {
      setQuery({ start: at, text: before.slice(at + 1) });
      setActive(0);
    } else setQuery(null);
  };

  const pick = (p: Person) => {
    if (!query) return;
    const caret = query.start + 1 + query.text.length;
    const next = `${body.slice(0, query.start)}@${p.fullName} ${body.slice(caret)}`;
    setBody(next);
    setMentions((m) => new Map(m).set(p.id, p.fullName));
    setQuery(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!query || !matches.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === 'Escape') setQuery(null);
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      // Only mentions whose name is still in the text are sent.
      const ids = [...mentions].filter(([, name]) => text.includes(`@${name}`)).map(([id]) => id);
      await api.tasks.addComment(task.id, { body: text, mentions: ids });
      setBody('');
      setMentions(new Map());
      await qc.invalidateQueries({ queryKey: qk4.comments(task.id) });
      void qc.invalidateQueries({ queryKey: qk4.gantt(task.projectId) });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      {comments.data?.length ? (
        comments.data.map((c) => (
          <div key={c.id} className="surface-card" style={{ padding: 12 }}>
            <Group justify="space-between" gap="xs">
              <Text fw={600} size="sm">
                {c.author.fullName}
              </Text>
              <Text size="xs" c="dimmed">
                {formatDateTime(c.createdAt)}
              </Text>
            </Group>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {c.body}
            </Text>
          </div>
        ))
      ) : (
        <Text c="dimmed" size="sm">
          {comments.isLoading ? t('app.loading') : t('task.noComments')}
        </Text>
      )}
      {canComment ? (
        <Stack gap={6}>
          <FormError error={error} />
          <Textarea
            ref={ref}
            label={t('task.newComment')}
            description={t('task.mentionHint')}
            autosize
            minRows={3}
            value={body}
            onChange={onChange}
            onKeyDown={onKeyDown}
            aria-autocomplete="list"
            aria-controls="nz-mentions"
            aria-expanded={Boolean(query && matches.length)}
          />
          {query && matches.length ? (
            <div id="nz-mentions" role="listbox" aria-label={t('task.mentionList')} className="nz-mention-list">
              {matches.map((p, i) => (
                <button key={p.id} type="button" role="option" aria-selected={i === active} className="nz-mention-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                  {p.fullName}
                </button>
              ))}
            </div>
          ) : null}
          <Group justify="flex-end">
            <Button onClick={() => void send()} loading={busy} disabled={!body.trim()}>
              {t('task.sendComment')}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- attachments

function TaskFiles({ task }: { task: TaskDto }) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const files = useTaskAttachments(task.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canUpload = can(user, 'tasks.manage') || task.assignee?.id === user?.id;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.attachments(task.id) });
    void qc.invalidateQueries({ queryKey: qk4.gantt(task.projectId) });
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
      setError(ApiError.of('FILE_TYPE_NOT_ALLOWED', 415));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(ApiError.of('FILE_TOO_LARGE', 413));
      return;
    }
    setBusy(true);
    try {
      const p = await api.files.presign({ entityType: 'task', entityId: task.id, kind: 'ATTACHMENT', contentType: file.type as never, sizeBytes: file.size });
      await api.files.upload(p, file);
      await api.files.confirm(p.fileId);
      await refresh();
      notifications.show({ color: 'ok', message: t('task.fileUploaded') });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const open = async (fileId: string) => {
    try {
      const { url } = await api.tasks.attachmentUrl(task.id, fileId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(err);
    }
  };

  const remove = async (fileId: string) => {
    try {
      await api.tasks.removeAttachment(task.id, fileId);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Stack>
      <FormError error={error} />
      {files.data?.length ? (
        files.data.map((f, i) => (
          <Group key={f.id} justify="space-between" wrap="nowrap" className="surface-card" p="sm">
            <div style={{ minWidth: 0 }}>
              <Anchor component="button" type="button" onClick={() => void open(f.id)}>
                {t('task.fileName', { n: formatNumber(i + 1), type: f.mimeType === 'application/pdf' ? 'PDF' : t('task.image') })}
              </Anchor>
              <Text size="xs" c="dimmed">
                {t('task.fileMeta', { by: f.uploadedBy?.fullName ?? t('common.unknownUser'), at: formatDateTime(f.createdAt), size: formatNumber(Math.ceil(f.sizeBytes / 1024)) })}
              </Text>
            </div>
            {can(user, 'tasks.manage') || f.uploadedBy?.id === user?.id ? (
              <ActionIcon variant="subtle" color="breach" aria-label={t('task.removeFile')} onClick={() => void remove(f.id)}>
                <IconTrash size={16} />
              </ActionIcon>
            ) : null}
          </Group>
        ))
      ) : (
        <Text c="dimmed" size="sm">
          {files.isLoading ? t('app.loading') : t('task.noFiles')}
        </Text>
      )}
      {canUpload ? (
        <FileButton onChange={(f) => void upload(f)} accept={ALLOWED_UPLOAD_TYPES.join(',')}>
          {(props) => (
            <Button {...props} variant="light" leftSection={<IconPaperclip size={16} />} loading={busy}>
              {t('task.attachFile')}
            </Button>
          )}
        </FileButton>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- activity

function TaskActivity({ task }: { task: TaskDto }) {
  const activity = useTaskActivity(task.id);
  if (activity.isLoading) return <Text c="dimmed">{t('app.loading')}</Text>;
  if (!activity.data?.length) return <Text c="dimmed">{t('task.noActivity')}</Text>;
  return (
    <Stack gap={0}>
      {activity.data.map((a) => {
        const after = (a.after && typeof a.after === 'object' ? a.after : {}) as Record<string, unknown>;
        const auto = after.auto === true;
        const fields = Object.keys(after).filter((k) => ['startDate', 'endDate', 'progress', 'status', 'durationDays', 'name', 'assigneeId'].includes(k));
        return (
          <div key={a.id} style={{ paddingBlock: 8, borderBlockEnd: '1px solid var(--line)' }}>
            <Group justify="space-between" gap="xs">
              <Text size="sm" fw={600}>
                {tKey(`audit.action.${a.action}`, 'audit.action.other')}
                {auto ? (
                  <Text span size="xs" c="dimmed">
                    {` — ${t('task.autoShift')}`}
                  </Text>
                ) : null}
              </Text>
              <Text size="xs" c="dimmed">
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
  if (field === 'progress') return `${label}: ${formatNumber(Number(value))}٪`;
  if (field === 'startDate' || field === 'endDate') return `${label}: ${formatDate(String(value))}`;
  if (field === 'assigneeId') return label;
  return `${label}: ${String(value)}`;
}
