/**
 * «مهامي» (brief §6.1, §12: excellent on phones): the supervisor's tasks across projects grouped
 * by due date — overdue, due soon (≤ 2 working days), later — with a quick progress slider and
 * status change (ADR-007). Each change is one `PATCH /tasks/:id` with the task's version.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Accordion, Anchor, Badge, Group, NativeSelect, Slider, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChecklist } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { MyTaskDto, TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qk4, useMyTasks } from '../../api/projectQueries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatNumber, t } from '../../i18n';
import { TASK_STATUSES, bucketOf, taskStatusLabel, type Bucket } from './parts';
import './projects.css';

const BUCKET_TONE: Record<Bucket, string> = { overdue: 'var(--breach)', soon: 'var(--signal)', later: 'var(--field)', done: 'var(--ok)' };


export function MyTasksPage() {
  const tasks = useMyTasks();
  if (tasks.isLoading) return <LoadingBlock />;
  if (tasks.isError) return <ErrorBlock error={tasks.error} onRetry={() => void tasks.refetch()} />;
  const all = tasks.data ?? [];
  const groups: Record<Bucket, MyTaskDto[]> = { overdue: [], soon: [], later: [], done: [] };
  for (const task of all) groups[bucketOf(task)].push(task);

  return (
    <>
      <PageHeader title={t('nav.myTasks')} lead={t('myTasks.lead')} />
      {!all.length ? (
        <EmptyState icon={IconChecklist} title={t('myTasks.empty')} body={t('myTasks.emptyBody')} />
      ) : (
        <Stack gap="lg">
          {(['overdue', 'soon', 'later'] as const).map((b) =>
            groups[b].length ? (
              <section key={b} aria-labelledby={`bucket-${b}`}>
                <Group gap="xs" mb="xs">
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: BUCKET_TONE[b] }} />
                  <Text id={`bucket-${b}`} fw={700} fz="lg">
                    {t(`myTasks.bucket.${b}`)}
                  </Text>
                  <Badge variant="light" color="gray" radius="xl" className="num">
                    {formatNumber(groups[b].length)}
                  </Badge>
                </Group>
                <Stack gap="sm">
                  {groups[b].map((task) => (
                    <MyTaskCard key={task.id} task={task} bucket={b} />
                  ))}
                </Stack>
              </section>
            ) : null,
          )}
          {groups.done.length ? (
            <Accordion variant="contained" radius="md">
              <Accordion.Item value="done">
                <Accordion.Control>{t('myTasks.doneCount', { count: formatNumber(groups.done.length) })}</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="sm">
                    {groups.done.map((task) => (
                      <MyTaskCard key={task.id} task={task} bucket="done" />
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          ) : null}
        </Stack>
      )}
    </>
  );
}

function MyTaskCard({ task, bucket }: { task: MyTaskDto; bucket: Bucket }) {
  const api = useApi();
  const qc = useQueryClient();
  const [progress, setProgress] = useState(task.progress);
  const [prev, setPrev] = useState(task.progress);
  const [busy, setBusy] = useState(false);
  if (prev !== task.progress) {
    setPrev(task.progress);
    setProgress(task.progress);
  }

  const save = async (patch: { progress?: number; status?: TaskStatus }) => {
    setBusy(true);
    try {
      await api.tasks.update(task.id, { version: task.version, ...patch });
      await qc.invalidateQueries({ queryKey: qk4.myTasks });
      void qc.invalidateQueries({ queryKey: qk4.gantt(task.projectId) });
      notifications.show({ color: 'ok', message: t('myTasks.saved', { name: task.name }) });
    } catch (err) {
      setProgress(task.progress);
      notifications.show({
        color: 'breach',
        message: err instanceof ApiError && err.code === 'CONFLICT_VERSION' ? t('gantt.conflict') : errorMessage(err),
      });
      if (err instanceof ApiError && err.code === 'CONFLICT_VERSION') void qc.invalidateQueries({ queryKey: qk4.myTasks });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="surface-card nz-mytask" style={{ borderInlineStart: `4px solid ${BUCKET_TONE[bucket]}` }} aria-busy={busy}>
      <Anchor component={Link} to={`/projects/${task.project.id}`} size="xs" c="dimmed">
        {task.project.name}
      </Anchor>
      <Text fw={600} lh={1.4}>
        {task.name}
      </Text>
      <Group gap="xs" mt={2} wrap="wrap">
        <Text size="sm" c={bucket === 'overdue' ? 'var(--breach)' : 'dimmed'} fw={bucket === 'overdue' ? 600 : 400}>
          {bucket === 'overdue' ? t('myTasks.wasDue', { date: formatDate(task.endDate) }) : t('myTasks.due', { date: formatDate(task.endDate) })}
        </Text>
      </Group>
      <Text size="sm" fw={500} mt="sm" id={`p-${task.id}`}>
        {t('task.progressValue', { value: formatNumber(Math.round(progress)) })}
      </Text>
      <Slider
        aria-labelledby={`p-${task.id}`}
        value={progress}
        onChange={setProgress}
        onChangeEnd={(v) => v !== task.progress && void save({ progress: v })}
        step={10}
        min={0}
        max={100}
        size="lg"
        thumbSize={28}
        color={progress >= 100 ? 'ok' : 'field'}
        label={(v) => `${formatNumber(v)}٪`}
        disabled={busy}
        mb="xs"
      />
      <NativeSelect
        label={t('task.status')}
        value={task.status}
        data={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s) }))}
        onChange={(e) => void save({ status: e.currentTarget.value as TaskStatus })}
        disabled={busy}
        size="md"
      />
    </article>
  );
}
