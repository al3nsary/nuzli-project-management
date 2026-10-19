/**
 * The time log of one task (A9). The assignee logs their own time and edits or deletes their own
 * entries; an admin logs for any active user (`userId`) and edits or deletes any entry.
 */
import { useMemo, useState } from 'react';
import { ActionIcon, Button, Group, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconClock, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { TimeEntryDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qkA9, useTaskTime } from '../../api/a9Queries';
import { useUsers } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { formatDate, formatMinutes, formatNumber, riyadhDay, t } from '../../i18n';

interface Draft {
  date: string;
  hours: number;
  minutes: number;
  note: string;
  userId: string | null;
}

const blank = (userId: string | null): Draft => ({ date: riyadhDay(), hours: 1, minutes: 0, note: '', userId });
const totalOf = (d: Draft) => Math.round((d.hours || 0) * 60 + (d.minutes || 0));

export function TaskTimeLog({ taskId, admin, canLog }: { taskId: string; admin: boolean; canLog: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const entries = useTaskTime(taskId);
  const people = useUsers({ status: 'ACTIVE', pageSize: 200 }, admin);
  const [draft, setDraft] = useState<Draft>(() => blank(null));
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = useMemo(() => (entries.data ?? []).reduce((n, e) => n + e.minutes, 0), [entries.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qkA9.taskTime(taskId) });
    void qc.invalidateQueries({ queryKey: ['time'] });
    void qc.invalidateQueries({ queryKey: ['workload'] });
  };

  const message = (err: unknown) => {
    if (err instanceof ApiError) {
      const f = err.fieldErrors;
      return f.minutes ?? f.date ?? f.userId ?? f.note ?? errorMessage(err);
    }
    return errorMessage(err);
  };

  const submit = async () => {
    const minutes = totalOf(draft);
    if (minutes < 1) {
      setError(t('a9s.time.tooShort'));
      return;
    }
    if (minutes > 1440) {
      setError(t('a9s.time.tooLong'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const note = draft.note.trim() || undefined;
      if (editing) {
        await api.timeEntries.update(editing, { date: draft.date, minutes, ...(note ? { note } : {}) });
        notifications.show({ color: 'ok', message: t('a9s.time.updated') });
      } else {
        await api.tasks.addTimeEntry(taskId, { date: draft.date, minutes, note, ...(admin && draft.userId && draft.userId !== user?.id ? { userId: draft.userId } : {}) });
        notifications.show({ color: 'ok', message: t('a9s.time.added', { value: formatMinutes(minutes) }) });
      }
      setDraft(blank(null));
      setEditing(null);
      setOpen(false);
      refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const edit = (e: TimeEntryDto) => {
    setEditing(e.id);
    setOpen(true);
    setError(null);
    setDraft({ date: e.date, hours: Math.floor(e.minutes / 60), minutes: e.minutes % 60, note: e.note ?? '', userId: e.user.id });
  };

  const remove = (e: TimeEntryDto) =>
    modals.openConfirmModal({
      title: t('a9s.time.removeTitle'),
      children: <Text size="sm">{t('a9s.time.removeBody', { value: formatMinutes(e.minutes), date: formatDate(e.date) })}</Text>,
      labels: { confirm: t('a9s.time.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.timeEntries.remove(e.id);
          refresh();
          notifications.show({ color: 'ok', message: t('a9s.time.removed') });
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  const mayEdit = (e: TimeEntryDto) => admin || e.user.id === user?.id;

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap={6}>
          <IconClock size={18} aria-hidden style={{ color: 'var(--accent)' }} />
          <Text size="sm" fw={600}>
            {t('a9s.time.total', { value: formatMinutes(total) })}
          </Text>
        </Group>
        {canLog && !open ? (
          <Button
            size="sm"
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              setOpen(true);
              setEditing(null);
              setDraft(blank(null));
            }}
          >
            {t('a9s.time.add')}
          </Button>
        ) : null}
      </Group>

      {open ? (
        <div className="surface-card nz-time-form">
          <Text size="sm" fw={600} mb="xs">
            {editing ? t('a9s.time.editTitle') : t('a9s.time.addTitle')}
          </Text>
          <Stack gap="xs">
            {admin && !editing ? (
              <Select
                label={t('a9s.time.user')}
                placeholder={t('a9s.time.userSelf')}
                data={(people.data?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }))}
                value={draft.userId}
                onChange={(v) => setDraft((d) => ({ ...d, userId: v }))}
                searchable
                clearable
                nothingFoundMessage={t('a9s.time.noUser')}
              />
            ) : null}
            <Group grow gap="xs" wrap="nowrap" align="flex-start">
              <TextInput type="date" label={t('a9s.time.date')} value={draft.date} max={riyadhDay()} onChange={(e) => setDraft((d) => ({ ...d, date: e.currentTarget.value }))} />
            </Group>
            <Group grow gap="xs" wrap="nowrap" align="flex-start">
              <NumberInput label={t('a9s.time.hours')} min={0} max={24} value={draft.hours} onChange={(v) => setDraft((d) => ({ ...d, hours: Number(v) || 0 }))} allowDecimal={false} />
              <NumberInput label={t('a9s.time.minutes')} min={0} max={59} step={5} value={draft.minutes} onChange={(v) => setDraft((d) => ({ ...d, minutes: Number(v) || 0 }))} allowDecimal={false} />
            </Group>
            <TextInput label={t('a9s.time.note')} maxLength={500} value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.currentTarget.value }))} />
            {error ? (
              <Text size="sm" c="var(--red)" role="alert">
                {error}
              </Text>
            ) : null}
            <Group justify="flex-end" gap="xs">
              <Button
                variant="default"
                onClick={() => {
                  setOpen(false);
                  setEditing(null);
                  setError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void submit()} loading={busy}>
                {editing ? t('a9s.time.saveEdit') : t('a9s.time.save', { value: formatMinutes(totalOf(draft)) })}
              </Button>
            </Group>
          </Stack>
        </div>
      ) : null}

      {entries.isLoading ? (
        <Text size="sm" c="dimmed">
          {t('app.loading')}
        </Text>
      ) : entries.isError ? (
        <Text size="sm" c="var(--red)">
          {errorMessage(entries.error)}
        </Text>
      ) : !entries.data?.length ? (
        <Text size="sm" c="dimmed">
          {t('a9s.time.empty')}
        </Text>
      ) : (
        <ul className="nz-time-list" aria-label={t('a9s.time.title')}>
          {entries.data.map((e) => (
            <li key={e.id} className="nz-time-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={8} wrap="nowrap">
                  <Text size="sm" fw={600} className="num">
                    {formatMinutes(e.minutes)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatDate(e.date)}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" truncate>
                  {e.user.fullName}
                  {e.note ? ` · ${e.note}` : ''}
                </Text>
              </div>
              {mayEdit(e) ? (
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" color="gray" size={36} aria-label={t('a9s.time.edit')} onClick={() => edit(e)}>
                    <IconPencil size={17} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="breach" size={36} aria-label={t('a9s.time.remove')} onClick={() => remove(e)}>
                    <IconTrash size={17} />
                  </ActionIcon>
                </Group>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {entries.data?.length ? (
        <Text size="xs" c="dimmed">
          {t('a9s.time.count', { count: formatNumber(entries.data.length) })}
        </Text>
      ) : null}
    </Stack>
  );
}
