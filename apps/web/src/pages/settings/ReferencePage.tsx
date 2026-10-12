import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Anchor,
  Badge,
  Button,
  Card,
  ColorInput,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import { referenceItemSchema, teamColorSchema, type ReferenceItemDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import type { ReferenceKind } from '../../api/client';
import { qk2, usePalette, useReference } from '../../api/queries';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { t } from '../../i18n';
import { IconListDetails } from '@tabler/icons-react';
import { ViolationTypesPanel } from './ViolationTypesPanel';

function ItemRow({ kind, item }: { kind: ReferenceKind; item: ReferenceItemDto }) {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk2.reference(kind) }),
      qc.invalidateQueries({ queryKey: ['audit'] }),
    ]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    try {
      await fn();
      await refresh();
      if (ok) notifications.show({ color: 'ok', message: ok });
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message_ar : String(err));
      return false;
    }
  };
  const active = item.isActive !== false;
  return (
    <Table.Tr>
      <Table.Td>
        {editing ? (
          <TextInput
            aria-label={t('reference.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={error}
            size="sm"
          />
        ) : (
          <>
            <Text fw={500} c={active ? undefined : 'dimmed'}>
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
        <Badge color={active ? 'ok' : 'slate'} variant="light">
          {active ? t('reference.active') : t('reference.inactive')}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          {editing ? (
            <>
              <Button
                size="compact-sm"
                onClick={async () => {
                  if (await run(() => api.reference.update(kind, item.id, { name }), t('common.saved')))
                    setEditing(false);
                }}
              >
                {t('reference.saveName')}
              </Button>
              <Button size="compact-sm" variant="default" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button size="compact-sm" variant="subtle" onClick={() => setEditing(true)}>
                {t('reference.rename')}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={() => void run(() => api.reference.update(kind, item.id, { isActive: !active }))}
              >
                {active ? t('reference.deactivate') : t('reference.activate')}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="breach"
                onClick={() =>
                  void run(async () => {
                    const res = await api.reference.remove(kind, item.id);
                    notifications.show({
                      color: 'ok',
                      message:
                        res?.result === 'DEACTIVATED' ? t('reference.deactivatedInUse') : t('reference.deleted'),
                    });
                  })
                }
              >
                {t('reference.delete')}
              </Button>
            </>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function ReferenceList({ kind }: { kind: ReferenceKind }) {
  const api = useApi();
  const qc = useQueryClient();
  const items = useReference(kind);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const add = async () => {
    const parsed = referenceItemSchema.safeParse({ name });
    if (!parsed.success) {
      setFieldError(t('reference.nameShort'));
      return;
    }
    setFieldError(undefined);
    setError(null);
    try {
      await api.reference.create(kind, { name });
      setName('');
      await qc.invalidateQueries({ queryKey: qk2.reference(kind) });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.name) setFieldError(err.fieldErrors.name);
      else setError(err);
    }
  };

  if (items.isLoading) return <LoadingBlock variant="table" />;
  if (items.isError) return <ErrorBlock error={items.error} />;
  return (
    <Stack gap="md">
      <Card>
        <Group align="flex-start" gap="sm" wrap="wrap">
          <TextInput
            label={t(kind === 'departments' ? 'reference.newDepartment' : 'reference.newJobTitle')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={fieldError}
            style={{ flex: '1 1 260px' }}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <Button mt={25} leftSection={<IconPlus size={18} />} onClick={() => void add()}>
            {t('reference.add')}
          </Button>
        </Group>
        <FormError error={error} />
      </Card>
      {items.data?.length ? (
        <Card p={0}>
          <Table.ScrollContainer minWidth={480}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('reference.name')}</Table.Th>
                  <Table.Th>{t('reference.status')}</Table.Th>
                  <Table.Th>{t('common.actions')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.data.map((item) => (
                  <ItemRow key={`${item.id}:${item.name}`} kind={kind} item={item} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ) : (
        <EmptyState icon={IconListDetails} title={t('reference.empty')} />
      )}
    </Stack>
  );
}

function PalettePanel() {
  const api = useApi();
  const qc = useQueryClient();
  const palette = usePalette();
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['colors'] }),
      qc.invalidateQueries({ queryKey: ['audit'] }),
    ]);

  const add = async () => {
    const parsed = teamColorSchema.safeParse({ name, hex });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      await api.colors.create({ name, hex });
      setName('');
      setHex('#');
      await refresh();
      notifications.show({ color: 'ok', message: t('palette.added') });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    }
  };

  const toggle = async (id: string, isActive: boolean) => {
    setError(null);
    try {
      await api.colors.update(id, { isActive });
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  if (palette.isLoading) return <LoadingBlock variant="cards" />;
  if (palette.isError) return <ErrorBlock error={palette.error} />;
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t('palette.lead')}
      </Text>
      <FormError error={error} />
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="sm">
        {(palette.data ?? []).map((c) => (
          <Card key={c.id} padding="sm" className="nz-palette-card" data-active={c.isActive || undefined}>
            <Group wrap="nowrap" gap="sm" align="flex-start">
              <span className="nz-swatch-chip" style={{ background: c.hex, width: 40, height: 40 }} aria-hidden />
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text fw={600} truncate>
                  {c.name}
                </Text>
                <Text size="xs" c="dimmed" className="ltr mono">
                  {c.hex}
                </Text>
              </div>
            </Group>
            <Text size="sm" mt="xs">
              {c.inUseBy ? (
                <>
                  {t('palette.usedBy')}{' '}
                  <Anchor component={Link} to={`/teams/${c.inUseBy.teamId}`}>
                    {c.inUseBy.teamName}
                  </Anchor>
                </>
              ) : (
                <Text span c="dimmed">
                  {c.isActive ? t('palette.free') : t('palette.retired')}
                </Text>
              )}
            </Text>
            <Button
              mt="xs"
              size="compact-sm"
              variant="subtle"
              color={c.isActive ? 'breach' : 'field'}
              onClick={() => void toggle(c.id, !c.isActive)}
            >
              {c.isActive ? t('palette.retire') : t('palette.restore')}
            </Button>
          </Card>
        ))}
      </SimpleGrid>
      <Card>
        <Title order={3} fz="md" mb="sm">
          {t('palette.addTitle')}
        </Title>
        <Group align="flex-start" gap="sm" wrap="wrap">
          <TextInput
            label={t('palette.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={errors.name}
            style={{ flex: '1 1 200px' }}
          />
          <ColorInput
            label={t('palette.hex')}
            format="hex"
            value={hex}
            onChange={setHex}
            error={errors.hex}
            classNames={{ input: 'ltr mono' }}
            style={{ flex: '1 1 160px' }}
          />
          <Button mt={25} leftSection={<IconPlus size={18} />} onClick={() => void add()}>
            {t('palette.add')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          {t('palette.contrastHint')}
        </Text>
      </Card>
    </Stack>
  );
}

/** Reference data (brief §10): departments, job titles and the team colour palette. */
export function ReferencePage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'departments';
  return (
    <>
      <PageHeader title={t('reference.title')} lead={t('reference.lead')} />
      <Tabs value={tab} onChange={(v) => setParams(v ? { tab: v } : {}, { replace: true })} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="departments">{t('reference.tab.departments')}</Tabs.Tab>
          <Tabs.Tab value="job-titles">{t('reference.tab.jobTitles')}</Tabs.Tab>
          <Tabs.Tab value="colors">{t('reference.tab.colors')}</Tabs.Tab>
          <Tabs.Tab value="violation-types">{t('reference.tab.violationTypes')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="departments">
          <ReferenceList kind="departments" />
        </Tabs.Panel>
        <Tabs.Panel value="job-titles">
          <ReferenceList kind="job-titles" />
        </Tabs.Panel>
        <Tabs.Panel value="colors">
          <PalettePanel />
        </Tabs.Panel>
        <Tabs.Panel value="violation-types">
          <ViolationTypesPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
