import { Fragment, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronDown, IconHistory } from '@tabler/icons-react';
import type { AuditEntryDto } from '@nuzli/shared';
import { useAudit, useUsers } from '../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, roleLabel } from '../components/ui';
import { formatDateTime, hasKey, t, tKey } from '../i18n';

/** Audit action codes written in Phase 1 (the API and the demo use the same names). */
export const AUDIT_ACTIONS = [
  'registration.requested',
  'registration.approved',
  'registration.rejected',
  'user.created',
  'user.role_changed',
  'user.suspended',
  'user.reactivated',
  'settings.updated',
  'auth.password_changed',
  // Phase 2
  'team.created',
  'team.updated',
  'team.approved',
  'team.rejected',
  'team.archived',
  'team.supervisor_changed',
  'team.visibility_changed',
  'member.created',
  'member.updated',
  'members.moved',
  'members.imported',
  'color.created',
  'color.updated',
  'reference.created',
  'reference.updated',
  'reference.deleted',
  'card_template.created',
  'card_template.updated',
  'card_template.archived',
  'card_size.created',
  'card_size.deleted',
  'logo.created',
  'logo.deleted',
  'logo.default_set',
  'cards.printed',
  'cards.pdf_exported',
  // Phase 3
  'violation_type.created',
  'violation_type.updated',
  'violation.updated',
  'violation.status_changed',
  'violation.response_added',
  'violation.id_photo_viewed',
  'violations.exported',
  'violations.dashboard_exported',
  'violations.photos_purged',
] as const;

const ENTITY_TYPES = [
  'user',
  'settings',
  'team',
  'team_member',
  'team_color',
  'department',
  'job_title',
  'card_template',
  'card_size',
  'logo',
  'print_batch',
  'violation',
  'violation_type',
  'violation_file',
] as const;

function display(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return t('common.none');
  if (field === 'role' || field === 'requestedRole') return roleLabel(String(value));
  if (field === 'status') {
    const v = String(value);
    // Account statuses and violation statuses share the field name.
    return hasKey(`status.${v}`) ? tKey(`status.${v}`, 'common.none') : tKey(`vstatus.${v}`, 'common.none');
  }
  if (field === 'severity') return tKey(`severity.${String(value)}`, 'common.none');
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fieldLabel(field: string): string {
  if (hasKey(`audit.fieldName.${field}`)) return tKey(`audit.fieldName.${field}`, 'audit.field');
  if (hasKey(`settings.${field}`)) return tKey(`settings.${field}`, 'audit.field');
  return field;
}

/** Before/after per field; changed rows are highlighted. */
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  if (!keys.length)
    return (
      <Text size="sm" c="dimmed">
        {t('audit.noDiff')}
      </Text>
    );
  return (
    <Table.ScrollContainer minWidth={420}>
      <Table withTableBorder withColumnBorders fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('audit.field')}</Table.Th>
            <Table.Th>{t('audit.before')}</Table.Th>
            <Table.Th>{t('audit.after')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {keys.map((k) => {
            const changed = JSON.stringify(b[k]) !== JSON.stringify(a[k]);
            return (
              <Table.Tr key={k} className={changed ? 'nz-diff-changed' : undefined}>
                <Table.Td fw={500}>{fieldLabel(k)}</Table.Td>
                <Table.Td
                  c={changed ? 'dimmed' : undefined}
                  td={changed && k in b ? 'line-through' : undefined}
                >
                  {display(b[k], k)}
                </Table.Td>
                <Table.Td fw={changed ? 600 : undefined}>{display(a[k], k)}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function Entry({ entry, targetName }: { entry: AuditEntryDto; targetName?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box py="sm" style={{ borderBottom: '1px solid var(--line)' }}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <Box style={{ minWidth: 0, flex: '1 1 280px' }}>
          <Group gap={8} wrap="wrap">
            <Text fw={600}>{tKey(`audit.action.${entry.action}`, 'audit.action.other')}</Text>
            <Badge color="slate" variant="outline" size="sm">
              {tKey(`audit.entity.${entry.entityType}`, 'audit.entity.other')}
              {targetName ? `: ${targetName}` : ''}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {t('audit.col.actor')}: {entry.actor?.fullName ?? t('common.system')} ·{' '}
            <span className="mono">{formatDateTime(entry.at)}</span>
          </Text>
        </Box>
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          rightSection={
            <IconChevronDown
              size={14}
              style={{
                transform: open ? 'rotate(180deg)' : undefined,
                transition: 'transform 150ms ease-out',
              }}
            />
          }
        >
          {open ? t('audit.hideDiff') : t('audit.showDiff')}
        </Button>
      </Group>
      <Collapse in={open}>
        <Box pt="sm">
          <AuditDiff before={entry.before} after={entry.after} />
        </Box>
      </Collapse>
    </Box>
  );
}

export function AuditPage() {
  const [action, setAction] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<string | null>(null);
  const [actorId, setActorId] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const filters = {
    action: action ?? undefined,
    entityType: entityType ?? undefined,
    actorId: actorId ?? undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const q = useAudit({ ...filters, page, pageSize: 20 });
  const people = useUsers({ pageSize: 200 });
  const names = useMemo(
    () => new Map((people.data?.items ?? []).map((u) => [u.id, u.fullName])),
    [people.data],
  );
  const set =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setPage(1);
    };
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader title={t('audit.title')} lead={t('audit.lead')} />
      <Card mb="md" p="md">
        <SimpleGrid cols={{ base: 1, xs: 2, md: 5 }} spacing="sm">
          <Select
            label={t('audit.filterAction')}
            placeholder={t('common.all')}
            data={AUDIT_ACTIONS.map((a) => ({
              value: a,
              label: tKey(`audit.action.${a}`, 'audit.action.other'),
            }))}
            value={action}
            onChange={set(setAction)}
            clearable
            size="sm"
          />
          <Select
            label={t('audit.col.entity')}
            placeholder={t('common.all')}
            data={ENTITY_TYPES.map((e) => ({
              value: e,
              label: tKey(`audit.entity.${e}`, 'audit.entity.other'),
            }))}
            value={entityType}
            onChange={set(setEntityType)}
            clearable
            size="sm"
          />
          <Select
            label={t('audit.filterActor')}
            placeholder={t('common.all')}
            data={(people.data?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }))}
            value={actorId}
            onChange={set(setActorId)}
            searchable
            clearable
            size="sm"
          />
          <TextInput
            label={t('audit.from')}
            type="date"
            value={from}
            onChange={(e) => set(setFrom)(e.currentTarget.value)}
            size="sm"
          />
          <TextInput
            label={t('audit.to')}
            type="date"
            value={to}
            onChange={(e) => set(setTo)(e.currentTarget.value)}
            size="sm"
          />
        </SimpleGrid>
      </Card>

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={IconHistory}
          title={t('audit.empty')}
          body={t('audit.emptyBody')}
          action={
            filtered
              ? {
                  label: t('users.clearFilters'),
                  onClick: () => {
                    setAction(null);
                    setEntityType(null);
                    setActorId(null);
                    setFrom('');
                    setTo('');
                    setPage(1);
                  },
                }
              : undefined
          }
        />
      ) : (
        <Card py={0}>
          <Stack gap={0}>
            {q.data.items.map((e) => (
              <Fragment key={e.id}>
                <Entry
                  entry={e}
                  targetName={
                    e.entityType === 'user' && e.entityId ? names.get(e.entityId) : undefined
                  }
                />
              </Fragment>
            ))}
          </Stack>
          {q.data.total > q.data.pageSize ? (
            <Group justify="center" py="md">
              <Pagination
                total={Math.ceil(q.data.total / q.data.pageSize)}
                value={page}
                onChange={setPage}
              />
            </Group>
          ) : null}
        </Card>
      )}
    </>
  );
}
