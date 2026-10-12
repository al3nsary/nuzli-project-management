/**
 * Working calendars (brief §6.1, §10; ADR-059): weekend days, holidays and working overrides.
 * Changing working days re-derives every project on the calendar (the API says how many tasks
 * moved in the audit log). No holiday data is invented: the demo's samples are marked «(تجريبي)».
 */
import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalendarPlus, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import type { CalendarListDto } from '../../api/client';
import { qk4, useCalendars } from '../../api/projectQueries';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, t, tKey } from '../../i18n';

const DAYS = [0, 1, 2, 3, 4, 5, 6]; // Sunday first (skill nuzli-arabic-rtl)

export function CalendarsPage() {
  const calendars = useCalendars();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (calendars.isLoading) return <LoadingBlock variant="form" header />;
  if (calendars.isError) return <ErrorBlock error={calendars.error} onRetry={() => void calendars.refetch()} />;
  const list = calendars.data ?? [];
  const current = list.find((c) => c.id === selected) ?? list[0] ?? null;
  return (
    <>
      <PageHeader
        title={t('nav.calendars')}
        lead={t('calendars.lead')}
        actions={
          <Button leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)}>
            {t('calendars.create')}
          </Button>
        }
      />
      {!list.length ? (
        <EmptyState icon={IconCalendarPlus} title={t('calendars.empty')} action={{ label: t('calendars.create'), onClick: () => setCreating(true) }} />
      ) : (
        <Stack>
          {list.length > 1 ? (
            <SegmentedControl
              value={current?.id ?? ''}
              onChange={setSelected}
              data={list.map((c) => ({ value: c.id, label: c.name }))}
              style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
              className="nz-scroll-x"
            />
          ) : null}
          {current ? <CalendarEditor key={current.id} calendar={current} /> : null}
        </Stack>
      )}
      <CreateCalendar opened={creating} onClose={() => setCreating(false)} onCreated={setSelected} />
    </>
  );
}

function CalendarEditor({ calendar }: { calendar: CalendarListDto }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState(calendar.name);
  const [weekend, setWeekend] = useState<number[]>(calendar.weekendDays);
  const [busy, setBusy] = useState(false);
  const [ex, setEx] = useState({ date: '', name: '', isWorking: 'false' });
  const [error, setError] = useState<unknown>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.calendars });
    // Projects on this calendar were re-derived by the server.
    void qc.invalidateQueries({ queryKey: ['gantt'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: qk4.myTasks });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.calendars.update(calendar.id, { name: name.trim(), weekendDays: weekend });
      await refresh();
      notifications.show({ color: 'ok', message: t('calendars.saved') });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const addException = async () => {
    setError(null);
    try {
      await api.calendars.addException(calendar.id, { date: ex.date, name: ex.name.trim(), isWorking: ex.isWorking === 'true' });
      setEx({ date: '', name: '', isWorking: 'false' });
      await refresh();
      notifications.show({ color: 'ok', message: t('calendars.exceptionAdded') });
    } catch (err) {
      setError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.calendars.removeException(calendar.id, id);
      await refresh();
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  return (
    <Stack className="surface-card" p="lg" gap="md">
      <Group justify="space-between">
        <Title order={2} fz="lg">
          {calendar.name}
        </Title>
        {calendar.isDefault ? (
          <Badge variant="light" color="field">
            {t('calendars.default')}
          </Badge>
        ) : null}
      </Group>
      <FormError error={error} />
      <TextInput label={t('calendars.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} maw={420} />
      <div>
        <Text fw={500} size="sm" mb={6}>
          {t('calendars.weekend')}
        </Text>
        <Group gap="md">
          {DAYS.map((d) => (
            <Checkbox
              key={d}
              label={tKey(`weekday.${d}`, 'common.none')}
              checked={weekend.includes(d)}
              onChange={(e) => setWeekend((w) => (e.currentTarget.checked ? [...w, d] : w.filter((x) => x !== d)).sort())}
            />
          ))}
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('calendars.weekendHint')}
        </Text>
      </div>
      <Group>
        <Button onClick={() => void save()} loading={busy} disabled={weekend.length >= 7 || !name.trim()}>
          {t('calendars.save')}
        </Button>
      </Group>

      <Title order={3} fz="md" mt="sm">
        {t('calendars.exceptions')}
      </Title>
      {calendar.exceptions.length ? (
        <Table.ScrollContainer minWidth={420}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('calendars.date')}</Table.Th>
                <Table.Th>{t('calendars.exceptionName')}</Table.Th>
                <Table.Th>{t('calendars.kind')}</Table.Th>
                <Table.Th aria-label={t('common.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {calendar.exceptions.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{formatDate(e.date)}</Table.Td>
                  <Table.Td>{e.name}</Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={e.isWorking ? 'field' : 'signal'}>
                      {e.isWorking ? t('calendars.workingDay') : t('calendars.holiday')}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="breach" aria-label={t('calendars.removeException', { name: e.name })} onClick={() => void remove(e.id)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text c="dimmed" size="sm">
          {t('calendars.noExceptions')}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 4 }} spacing="sm" style={{ alignItems: 'end' }}>
        <TextInput type="date" label={t('calendars.date')} value={ex.date} onChange={(e) => setEx({ ...ex, date: e.currentTarget.value })} />
        <TextInput label={t('calendars.exceptionName')} value={ex.name} onChange={(e) => setEx({ ...ex, name: e.currentTarget.value })} />
        <SegmentedControl
          value={ex.isWorking}
          onChange={(v) => setEx({ ...ex, isWorking: v })}
          data={[
            { value: 'false', label: t('calendars.holiday') },
            { value: 'true', label: t('calendars.workingDay') },
          ]}
        />
        <Button variant="light" onClick={() => void addException()} disabled={!ex.date || !ex.name.trim()}>
          {t('calendars.addException')}
        </Button>
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        {t('calendars.rescheduleHint')}
      </Text>
    </Stack>
  );
}

function CreateCalendar({ opened, onClose, onCreated }: { opened: boolean; onClose(): void; onCreated(id: string): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setError(null);
    try {
      const c = await api.calendars.create({ name: name.trim(), weekendDays: [5, 6] });
      await qc.invalidateQueries({ queryKey: qk4.calendars });
      onCreated(c.id);
      setName('');
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t('calendars.create')}>
      <Stack>
        <FormError error={error} />
        <TextInput label={t('calendars.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Text size="sm" c="dimmed">
          {t('calendars.createHint')}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={name.trim().length < 2}>
            {t('calendars.createSubmit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
