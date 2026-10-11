import { useState } from 'react';
import { Badge, Box, Button, Card, Collapse, Group, Select, SimpleGrid, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconAdjustmentsHorizontal, IconRestore, IconSquareDashed, IconX } from '@tabler/icons-react';
import type { Severity, ViolationFilter, ViolationStatus } from '@nuzli/shared';
import { useAllMembers, useTeams, useUsers, useViolationTypes } from '../../api/queries';
import { formatNumber, t } from '../../i18n';
import { activeFilterCount } from '../../features/violations/filterStore';
import { SEVERITIES, VIOLATION_STATUSES, severityLabel, statusLabel } from './parts';

/**
 * The shared filter bar of the violations list and dashboard (brief §7.5): date range, team,
 * member, monitor, type, status, severity, and the map area (drawn on the map, shown here).
 */
export function FilterBar({
  value,
  onChange,
  onReset,
}: {
  value: ViolationFilter;
  onChange: (patch: Partial<ViolationFilter>) => void;
  onReset: () => void;
}) {
  const wide = useMediaQuery('(min-width: 48em)', true);
  const [open, setOpen] = useState(false);
  const teams = useTeams({ status: 'ALL' });
  const members = useAllMembers();
  const monitors = useUsers({ role: 'MONITOR', pageSize: 200 });
  const admins = useUsers({ role: 'ADMIN', pageSize: 200 });
  const types = useViolationTypes(true);
  const count = activeFilterCount(value);

  const recorders = [...(monitors.data?.items ?? []), ...(admins.data?.items ?? [])];
  const fields = (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm" verticalSpacing="sm">
      <TextInput
        type="date"
        label={t('vfilter.from')}
        value={value.from ?? ''}
        max={value.to}
        onChange={(e) => onChange({ from: e.currentTarget.value || undefined })}
        size="sm"
        classNames={{ input: 'num' }}
      />
      <TextInput
        type="date"
        label={t('vfilter.to')}
        value={value.to ?? ''}
        min={value.from}
        onChange={(e) => onChange({ to: e.currentTarget.value || undefined })}
        size="sm"
        classNames={{ input: 'num' }}
      />
      <Select
        label={t('vfilter.team')}
        placeholder={t('common.all')}
        data={(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name }))}
        value={value.teamId ?? null}
        onChange={(v) => onChange({ teamId: v ?? undefined })}
        clearable
        searchable
        size="sm"
      />
      <Select
        label={t('vfilter.member')}
        placeholder={t('common.all')}
        data={(members.data ?? []).map((m) => ({ value: m.id, label: m.fullName }))}
        value={value.memberId ?? null}
        onChange={(v) => onChange({ memberId: v ?? undefined })}
        clearable
        searchable
        size="sm"
        nothingFoundMessage={t('vfilter.nothing')}
      />
      <Select
        label={t('vfilter.monitor')}
        placeholder={t('common.all')}
        data={recorders.map((u) => ({ value: u.id, label: u.fullName }))}
        value={value.recordedBy ?? null}
        onChange={(v) => onChange({ recordedBy: v ?? undefined })}
        clearable
        searchable
        size="sm"
      />
      <Select
        label={t('vfilter.type')}
        placeholder={t('common.all')}
        data={(types.data ?? []).map((ty) => ({ value: ty.id, label: ty.name }))}
        value={value.typeId ?? null}
        onChange={(v) => onChange({ typeId: v ?? undefined })}
        clearable
        searchable
        size="sm"
      />
      <Select
        label={t('vfilter.status')}
        placeholder={t('common.all')}
        data={VIOLATION_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        value={value.status ?? null}
        onChange={(v) => onChange({ status: (v as ViolationStatus | null) ?? undefined })}
        clearable
        size="sm"
      />
      <Select
        label={t('vfilter.severity')}
        placeholder={t('common.all')}
        data={SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))}
        value={value.severity ?? null}
        onChange={(v) => onChange({ severity: (v as Severity | null) ?? undefined })}
        clearable
        size="sm"
      />
    </SimpleGrid>
  );

  return (
    <Card padding="md" mb="md" className="nz-filterbar no-print">
      <Group justify="space-between" wrap="wrap" gap="xs" mb={wide || open ? 'sm' : 0}>
        <Group gap="xs">
          {!wide ? (
            <Button
              variant="light"
              size="compact-md"
              leftSection={<IconAdjustmentsHorizontal size={16} />}
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {t('vfilter.title')}
              {count ? (
                <Badge ms={6} size="sm" color="field" variant="filled" circle>
                  {formatNumber(count)}
                </Badge>
              ) : null}
            </Button>
          ) : null}
          {value.bbox ? (
            <Badge
              color="field"
              variant="light"
              size="lg"
              leftSection={<IconSquareDashed size={14} />}
              rightSection={
                <IconX
                  size={14}
                  style={{ cursor: 'pointer' }}
                  aria-label={t('map.clearArea')}
                  onClick={() => onChange({ bbox: undefined })}
                />
              }
            >
              {t('vfilter.area')}
            </Badge>
          ) : null}
        </Group>
        <Button variant="subtle" color="slate" size="compact-sm" leftSection={<IconRestore size={14} />} onClick={onReset}>
          {t('vfilter.reset')}
        </Button>
      </Group>
      {wide ? fields : <Collapse in={open}>{<Box pt="xs">{fields}</Box>}</Collapse>}
    </Card>
  );
}
