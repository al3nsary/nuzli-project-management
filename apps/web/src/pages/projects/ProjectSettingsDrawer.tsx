import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  Drawer,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  useDirection,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, ProjectStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useSupervisors } from '../../api/queries';
import { qk4, useCalendars, useProjectAccess } from '../../api/projectQueries';
import { FormError } from '../../components/ui';
import { formatDate, formatNumber, t } from '../../i18n';
import { PROJECT_STATUSES, projectStatusLabel } from './parts';

/** Admin: project fields, auto-schedule, calendar and supervisor view access (brief §6.1). */
export function ProjectSettingsDrawer({ opened, onClose, project }: { opened: boolean; onClose(): void; project: ProjectDto }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { dir } = useDirection();
  const calendars = useCalendars(opened);
  const supervisors = useSupervisors(opened);
  const access = useProjectAccess(project.id, opened);
  const [form, setForm] = useState({ name: project.name, description: project.description ?? '', startDate: project.startDate, status: project.status, calendarId: project.calendarId, autoSchedule: project.autoSchedule });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [grantee, setGrantee] = useState<string | null>(null);
  useEffect(() => {
    if (opened) setForm({ name: project.name, description: project.description ?? '', startDate: project.startDate, status: project.status, calendarId: project.calendarId, autoSchedule: project.autoSchedule });
  }, [opened, project]);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: qk4.gantt(project.id) }), qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: qk4.myTasks })]);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (form.name.trim() !== project.name) patch.name = form.name.trim();
      if (form.description.trim() && form.description !== (project.description ?? '')) patch.description = form.description;
      if (form.startDate !== project.startDate) patch.startDate = form.startDate;
      if (form.status !== project.status) patch.status = form.status;
      if (form.calendarId !== project.calendarId) patch.calendarId = form.calendarId;
      if (form.autoSchedule !== project.autoSchedule) patch.autoSchedule = form.autoSchedule;
      if (Object.keys(patch).length) {
        await api.projects.update(project.id, patch);
        await refresh();
        notifications.show({ color: 'ok', message: patch.calendarId || patch.autoSchedule === true ? t('projects.savedRescheduled') : t('common.saved') });
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!grantee) return;
    try {
      await api.projects.grantAccess(project.id, { userId: grantee });
      setGrantee(null);
      await qc.invalidateQueries({ queryKey: qk4.access(project.id) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };
  const revoke = async (userId: string) => {
    try {
      await api.projects.revokeAccess(project.id, userId);
      await qc.invalidateQueries({ queryKey: qk4.access(project.id) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };
  const archive = () =>
    modals.openConfirmModal({
      title: t('projects.archiveTitle'),
      children: <Text size="sm">{t('projects.archiveBody', { name: project.name })}</Text>,
      labels: { confirm: t('projects.archive'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.projects.archive(project.id);
          await qc.invalidateQueries({ queryKey: ['projects'] });
          onClose();
          navigate('/projects');
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  const granted = new Set((access.data ?? []).map((a) => a.user.id));
  return (
    <Drawer opened={opened} onClose={onClose} position={dir === 'rtl' ? 'left' : 'right'} size="md" title={t('projects.settings')}>
      <Stack>
        <FormError error={error} />
        <TextInput label={t('projects.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
        <Textarea label={t('projects.description')} autosize minRows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
        <TextInput type="date" label={t('projects.startDate')} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.currentTarget.value })} />
        <Select label={t('projects.status')} data={PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => ({ value: s, label: projectStatusLabel(s) }))} value={form.status} onChange={(v) => v && setForm({ ...form, status: v as ProjectStatus })} allowDeselect={false} />
        <Select
          label={t('projects.calendar')}
          description={t('projects.calendarChangeHint')}
          data={(calendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          value={form.calendarId}
          onChange={(v) => v && setForm({ ...form, calendarId: v })}
          allowDeselect={false}
        />
        <Switch label={t('projects.autoSchedule')} description={t('projects.autoScheduleHint')} checked={form.autoSchedule} onChange={(e) => setForm({ ...form, autoSchedule: e.currentTarget.checked })} />
        <Group justify="flex-end">
          <Button onClick={() => void save()} loading={busy}>
            {t('projects.saveSettings')}
          </Button>
        </Group>

        <Divider />
        <Title order={3} fz="md">
          {t('projects.access')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('projects.accessHint')}
        </Text>
        {(access.data ?? []).map((a) => (
          <Group key={a.user.id} justify="space-between" wrap="nowrap">
            <div>
              <Text size="sm" fw={500}>
                {a.user.fullName}
              </Text>
              <Text size="xs" c="dimmed">
                {t('projects.grantedAt', { date: formatDate(a.grantedAt) })}
              </Text>
            </div>
            <ActionIcon variant="subtle" color="breach" aria-label={t('projects.revoke', { name: a.user.fullName })} onClick={() => void revoke(a.user.id)}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        {access.data && !access.data.length ? (
          <Text size="sm" c="dimmed">
            {t('projects.noAccess')}
          </Text>
        ) : null}
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <Select
            label={t('projects.grantTo')}
            placeholder={t('projects.pickSupervisor')}
            data={(supervisors.data ?? []).filter((u) => !granted.has(u.id)).map((u) => ({ value: u.id, label: u.fullName }))}
            value={grantee}
            onChange={setGrantee}
            searchable
            style={{ flex: 1 }}
          />
          <Button variant="light" leftSection={<IconUserPlus size={16} />} onClick={() => void grant()} disabled={!grantee}>
            {t('projects.grant')}
          </Button>
        </Group>

        <Divider />
        <Alert color="gray" variant="light">
          <Text size="sm">{t('projects.archiveHint', { count: formatNumber(project.taskCount) })}</Text>
          <Button mt="xs" size="xs" color="breach" variant="light" onClick={archive}>
            {t('projects.archive')}
          </Button>
        </Alert>
      </Stack>
    </Drawer>
  );
}
