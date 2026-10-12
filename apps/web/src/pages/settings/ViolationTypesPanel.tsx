import { useState } from 'react';
import { Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertOctagon, IconPlus } from '@tabler/icons-react';
import { violationTypeSchema, type Severity, type ViolationTypeDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { useInvalidateViolations, useViolationTypes } from '../../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui';
import { t } from '../../i18n';
import { SEVERITIES, severityLabel } from '../violations/parts';

const NONE = 'NONE';
const severityData = () => [
  { value: NONE, label: t('severity.NONE') },
  ...SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) })),
];

function TypeRow({ item }: { item: ViolationTypeDto }) {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [error, setError] = useState<string | null>(null);
  const run = async (input: Parameters<typeof api.violationTypes.update>[1]) => {
    setError(null);
    try {
      await api.violationTypes.update(item.id, input);
      await invalidate();
      notifications.show({ color: 'ok', message: t('common.saved') });
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };
  return (
    <Table.Tr>
      <Table.Td>
        {editing ? (
          <TextInput aria-label={t('vtypes.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} size="sm" error={error} />
        ) : (
          <>
            <Text fw={500} c={item.isActive ? undefined : 'dimmed'}>
              {item.name}
            </Text>
            {error ? (
              <Text size="xs" c="var(--breach)">
                {error}
              </Text>
            ) : null}
          </>
        )}
      </Table.Td>
      <Table.Td>
        <Select
          aria-label={t('vtypes.severity')}
          data={severityData()}
          value={item.severity ?? NONE}
          onChange={(v) => v && void run({ severity: v === NONE ? null : (v as Severity) })}
          allowDeselect={false}
          size="sm"
          w={150}
        />
      </Table.Td>
      <Table.Td>
        <Badge color={item.isActive ? 'ok' : 'slate'} variant="light">
          {item.isActive ? t('reference.active') : t('reference.inactive')}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {editing ? (
            <>
              <Button
                size="compact-sm"
                onClick={async () => {
                  if (await run({ name })) setEditing(false);
                }}
              >
                {t('common.save')}
              </Button>
              <Button size="compact-sm" variant="subtle" color="slate" onClick={() => { setEditing(false); setName(item.name); }}>
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button size="compact-sm" variant="subtle" onClick={() => setEditing(true)}>
                {t('vtypes.rename')}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color={item.isActive ? 'breach' : 'field'}
                onClick={() => void run({ isActive: !item.isActive })}
              >
                {item.isActive ? t('vtypes.deactivate') : t('vtypes.activate')}
              </Button>
            </>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** Violation types catalogue (brief §7.2 step 4): name, optional severity, active. No delete. */
export function ViolationTypesPanel() {
  const api = useApi();
  const invalidate = useInvalidateViolations();
  const q = useViolationTypes(true);
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState<string>(NONE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const parsed = violationTypeSchema.safeParse({
      name,
      severity: severity === NONE ? null : severity,
      isActive: true,
    });
    if (!parsed.success) {
      setErrors({ name: parsed.error.issues[0]?.message ?? t('common.required') });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.violationTypes.create(parsed.data);
      await invalidate();
      setName('');
      setSeverity(NONE);
      notifications.show({ color: 'ok', message: t('vtypes.added') });
    } catch (err) {
      setErrors({ name: err instanceof ApiError ? err.message_ar : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (q.isLoading) return <LoadingBlock variant="table" />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('vtypes.lead')}
      </Text>
      {items.length === 0 ? (
        <EmptyState icon={IconAlertOctagon} title={t('vtypes.emptyTitle')} body={t('vtypes.emptyBody')} />
      ) : (
        <Card padding={0}>
          <Table.ScrollContainer minWidth={560}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('vtypes.name')}</Table.Th>
                  <Table.Th>{t('vtypes.severity')}</Table.Th>
                  <Table.Th>{t('reference.status')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => (
                  <TypeRow key={`${item.id}-${item.name}-${item.isActive}-${item.severity}`} item={item} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
      <Card>
        <Title order={3} fz="md" mb="sm">
          {t('vtypes.addTitle')}
        </Title>
        <Group align="flex-start" gap="sm" wrap="wrap">
          <TextInput
            label={t('vtypes.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={errors.name}
            style={{ flex: '1 1 240px' }}
          />
          <Select
            label={t('vtypes.severity')}
            data={severityData()}
            value={severity}
            onChange={(v) => setSeverity(v ?? NONE)}
            allowDeselect={false}
            w={180}
          />
          <Button mt={25} leftSection={<IconPlus size={18} />} onClick={() => void add()} loading={busy}>
            {t('vtypes.add')}
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
