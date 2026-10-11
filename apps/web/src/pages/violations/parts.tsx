import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Group, Loader, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClockExclamation,
  IconCloudOff,
  IconCloudUpload,
} from '@tabler/icons-react';
import type { Severity, ViolationStatus } from '@nuzli/shared';
import { formatNumber, t, tKey } from '../../i18n';
import type { OutboxItem } from '../../features/violations/offline/db';
import { TeamBadge } from '../../theme/TeamBadge';

/** Status colours: state, never decoration (design skill). */
const STATUS_COLOR: Record<ViolationStatus, string> = {
  SUBMITTED: 'field',
  UNDER_REVIEW: 'signal',
  CONFIRMED: 'breach',
  CANCELLED: 'slate',
};

export const VIOLATION_STATUSES: ViolationStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'CONFIRMED', 'CANCELLED'];
export const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const statusLabel = (s: string) => tKey(`vstatus.${s}`, 'common.none');
export const severityLabel = (s: string | null | undefined) =>
  s ? tKey(`severity.${s}`, 'severity.NONE') : t('severity.NONE');

export function ViolationStatusBadge({ status }: { status: ViolationStatus }) {
  return (
    <Badge color={STATUS_COLOR[status]} variant={status === 'CONFIRMED' ? 'filled' : 'light'}>
      {statusLabel(status)}
    </Badge>
  );
}

const SEVERITY_COLOR: Record<Severity, string> = {
  LOW: 'slate',
  MEDIUM: 'signal',
  HIGH: 'breach',
  CRITICAL: 'breach',
};

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (!severity) return null;
  return (
    <Badge
      color={SEVERITY_COLOR[severity]}
      variant={severity === 'CRITICAL' ? 'filled' : 'outline'}
      size="sm"
      style={{ flexShrink: 0, overflow: 'visible' }}
    >
      {severityLabel(severity)}
    </Badge>
  );
}

export function DriftBadge() {
  return (
    <Tooltip label={t('violations.driftHint')} multiline w={240} withArrow>
      <Badge color="signal" variant="light" leftSection={<IconClockExclamation size={14} />}>
        {t('violations.drift')}
      </Badge>
    </Tooltip>
  );
}

/** Snapshot team, or a clear note when the member had no team at that moment. */
export function SnapshotTeam({
  team,
  size = 'sm',
}: {
  team: { name: string; color: { hex: string } } | null;
  size?: 'sm' | 'md';
}) {
  if (!team) {
    return (
      <Badge color="signal" variant="outline" size={size}>
        {t('violations.noTeamAtTime')}
      </Badge>
    );
  }
  return <TeamBadge name={team.name} color={team.color.hex} size={size} />;
}

const OUTBOX_META: Record<
  OutboxItem['status'],
  { color: string; icon: ReactNode; label: () => string }
> = {
  pending: {
    color: 'signal',
    icon: <IconCloudOff size={14} />,
    label: () => t('outbox.status.pending'),
  },
  uploading: {
    color: 'field',
    icon: <Loader size={10} color="field" />,
    label: () => t('outbox.status.uploading'),
  },
  synced: {
    color: 'ok',
    icon: <IconCircleCheck size={14} />,
    label: () => t('outbox.status.synced'),
  },
  failed: {
    color: 'breach',
    icon: <IconAlertTriangle size={14} />,
    label: () => t('outbox.status.failed'),
  },
};

export function OutboxStatusBadge({ status }: { status: OutboxItem['status'] }) {
  const m = OUTBOX_META[status];
  return (
    <Badge color={m.color} variant="light" leftSection={m.icon}>
      {m.label()}
    </Badge>
  );
}

/** «الصور: ٢ من ٤» for an outbox item. */
export function OutboxProgress({ item }: { item: OutboxItem }) {
  const done = item.photos.filter((p) => p.confirmed).length;
  return (
    <Group gap={6} wrap="nowrap">
      <IconCloudUpload size={16} color="var(--muted)" aria-hidden />
      <Text size="sm" c="dimmed">
        {t('outbox.photosProgress', { done, total: item.photos.length })}
        {item.violationId ? '' : ` · ${t('outbox.notCreated')}`}
      </Text>
    </Group>
  );
}

/** Object URL for a Blob, revoked on change/unmount. */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export const metres = (m: number) => t('violations.metres', { n: Math.round(m) });

export const fmtCoord = (n: number) => n.toFixed(5);

export function countLabel(n: number) {
  return formatNumber(n);
}
