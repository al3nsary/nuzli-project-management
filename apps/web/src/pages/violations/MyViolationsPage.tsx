import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Pagination,
  Stack,
  Tabs,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCamera,
  IconCloudCheck,
  IconCloudOff,
  IconListDetails,
  IconRefresh,
  IconTrash,
  IconWifiOff,
} from '@tabler/icons-react';
import type { ViolationDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useMyViolations } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { TeamBadge } from '../../theme/TeamBadge';
import { offlineDb, type OutboxItem } from '../../features/violations/offline/db';
import { deleteItem, retryItem } from '../../features/violations/offline/outbox';
import {
  getSyncEngine,
  useOfflineStore,
  useOutbox,
  useUnsyncedCount,
} from '../../features/violations/offline/runtime';
import { useOnline } from '../../lib/useOnline';
import { OutboxProgress, OutboxStatusBadge, SnapshotTeam, ViolationStatusBadge } from './parts';
import { ViolationDrawer } from './ViolationDrawer';

/** One server violation as a tappable card (phones first). */
export function ViolationRowCard({ v, onOpen }: { v: ViolationDto; onOpen: () => void }) {
  return (
    <UnstyledButton className="nz-vcard" onClick={onOpen}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} truncate>
            {v.member.fullName}
          </Text>
          <Text size="sm" c="dimmed" truncate>
            {v.type.name}
          </Text>
        </Box>
        <ViolationStatusBadge status={v.status} />
      </Group>
      <Group justify="space-between" wrap="wrap" gap="xs" mt={8}>
        <SnapshotTeam team={v.team} />
        <Text size="xs" c="dimmed">
          {formatDateTime(v.capturedAt)}
        </Text>
      </Group>
    </UnstyledButton>
  );
}

function OutboxCard({ item, onDelete }: { item: OutboxItem; onDelete: () => void }) {
  const api = useApi();
  return (
    <Card padding="md" className="nz-outbox-card" data-status={item.status}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} truncate>
            {item.display.memberName}
          </Text>
          <Text className="mono ltr" size="sm" c="dimmed">
            {item.display.nationalIdMasked}
          </Text>
        </Box>
        <OutboxStatusBadge status={item.status} />
      </Group>
      <Group gap="xs" mt={8} wrap="wrap">
        {item.display.teamName && item.display.teamColor ? (
          <TeamBadge name={item.display.teamName} color={item.display.teamColor} size="sm" />
        ) : null}
        <Text size="sm">{item.display.typeName}</Text>
      </Group>
      <Group justify="space-between" mt={8} wrap="wrap" gap="xs">
        <Text size="xs" c="dimmed">
          {t('outbox.recordedAt', { at: formatDateTime(item.payload.capturedAt) })}
        </Text>
        {item.status !== 'synced' ? <OutboxProgress item={item} /> : null}
      </Group>
      {item.error && item.status !== 'synced' ? (
        <Alert
          mt="sm"
          color={item.status === 'failed' ? 'breach' : 'signal'}
          icon={item.status === 'failed' ? <IconAlertTriangle size={16} /> : <IconCloudOff size={16} />}
          p="xs"
        >
          <Text size="sm">{item.error}</Text>
          {item.status === 'pending' && item.attempts > 0 && item.nextAttemptAt > Date.now() ? (
            <Text size="xs" c="dimmed">
              {t('outbox.nextAttempt', { at: formatDateTime(new Date(item.nextAttemptAt)) })}
            </Text>
          ) : null}
        </Alert>
      ) : null}
      {item.status === 'failed' || (item.status === 'pending' && item.attempts > 0) ? (
        <Group mt="sm" gap="xs">
          <Button
            size="compact-md"
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={async () => {
              await retryItem(offlineDb(), item.id);
              void getSyncEngine(api).run();
            }}
          >
            {t('outbox.retry')}
          </Button>
          {item.status === 'failed' ? (
            <Button size="compact-md" variant="subtle" color="breach" leftSection={<IconTrash size={16} />} onClick={onDelete}>
              {t('outbox.delete')}
            </Button>
          ) : null}
        </Group>
      ) : null}
    </Card>
  );
}

/** «بانتظار المزامنة»: the device outbox with per-item status, retry and delete-failed. */
export function PendingList() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const items = useOutbox(user?.id);
  const running = useOfflineStore((s) => s.running);
  const authRequired = useOfflineStore((s) => s.authRequired);
  const lastRunAt = useOfflineStore((s) => s.lastRunAt);
  const online = useOnline();
  const navigate = useNavigate();
  const [toDelete, setToDelete] = useState<OutboxItem | null>(null);
  const unsynced = (items ?? []).filter((i) => i.status !== 'synced');

  if (!items) return <LoadingBlock />;
  return (
    <Stack gap="md">
      <Card padding="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap={8} wrap="nowrap">
            {online ? <IconCloudCheck size={20} color="var(--ok)" aria-hidden /> : <IconWifiOff size={20} color="var(--signal)" aria-hidden />}
            <Box>
              <Text size="sm" fw={600}>
                {online ? t('outbox.online') : t('outbox.offline')}
              </Text>
              <Text size="xs" c="dimmed">
                {lastRunAt ? t('outbox.lastRun', { at: formatDateTime(new Date(lastRunAt)) }) : t('outbox.autoNote')}
              </Text>
            </Box>
          </Group>
          <Button
            size="compact-md"
            leftSection={<IconRefresh size={16} />}
            loading={running}
            disabled={!online || unsynced.length === 0}
            onClick={() => void getSyncEngine(api).runNow()}
          >
            {t('outbox.syncNow')}
          </Button>
        </Group>
      </Card>
      {authRequired ? (
        <Alert color="signal" icon={<IconAlertTriangle size={18} />}>
          {t('sync.err.auth')}
        </Alert>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          icon={IconCloudCheck}
          title={t('outbox.emptyTitle')}
          body={t('outbox.emptyBody')}
          action={{ label: t('nav.recordViolation'), onClick: () => navigate('/violations/new') }}
        />
      ) : (
        <Stack gap="sm">
          {items.map((item) => (
            <OutboxCard key={item.id} item={item} onDelete={() => setToDelete(item)} />
          ))}
        </Stack>
      )}
      <Modal opened={Boolean(toDelete)} onClose={() => setToDelete(null)} title={t('outbox.deleteTitle')}>
        <Stack>
          <Text>{t('outbox.deleteBody', { name: toDelete?.display.memberName ?? '' })}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setToDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="breach"
              onClick={async () => {
                if (toDelete) await deleteItem(offlineDb(), toDelete.id);
                setToDelete(null);
              }}
            >
              {t('outbox.deleteConfirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function SentList() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const online = useOnline();
  const navigate = useNavigate();
  const q = useMyViolations({ page, pageSize: 20 });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) {
    if (!online) {
      return (
        <Alert color="signal" icon={<IconWifiOff size={18} />}>
          {t('mine.offline')}
        </Alert>
      );
    }
    return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  }
  const data = q.data;
  if (!data || data.total === 0) {
    return (
      <EmptyState
        icon={IconListDetails}
        title={t('mine.emptyTitle')}
        body={t('mine.emptyBody')}
        action={{ label: t('nav.recordViolation'), onClick: () => navigate('/violations/new') }}
      />
    );
  }
  const pages = Math.ceil(data.total / data.pageSize);
  return (
    <Stack gap="sm">
      {data.items.map((v) => (
        <ViolationRowCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />
      ))}
      {pages > 1 ? <Pagination value={page} onChange={setPage} total={pages} mt="sm" /> : null}
      <ViolationDrawer id={open} onClose={() => setOpen(null)} />
    </Stack>
  );
}

/** «مخالفاتي»: what I sent (server) and «بانتظار المزامنة» (device outbox). */
export function MyViolationsPage({ initialTab = 'sent' }: { initialTab?: 'sent' | 'pending' }) {
  const user = useAuthStore((s) => s.user);
  const count = useUnsyncedCount(user?.id);
  const navigate = useNavigate();
  const tab = initialTab;
  return (
    <Box maw={760} mx="auto">
      <PageHeader
        title={tab === 'pending' ? t('nav.pendingSync') : t('nav.myViolations')}
        actions={
          <Button component={Link} to="/violations/new" leftSection={<IconCamera size={18} />} visibleFrom="sm">
            {t('nav.recordViolation')}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => navigate(v === 'pending' ? '/violations/pending' : '/violations/mine', { replace: true })}
        keepMounted={false}
      >
        <Tabs.List mb="md" grow>
          <Tabs.Tab value="sent">{t('mine.tabSent')}</Tabs.Tab>
          <Tabs.Tab
            value="pending"
            rightSection={
              count ? (
                <Badge color="signal" variant="filled" size="sm" circle={count < 10}>
                  {formatNumber(count)}
                </Badge>
              ) : null
            }
          >
            {t('nav.pendingSync')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="sent">
          <SentList />
        </Tabs.Panel>
        <Tabs.Panel value="pending">
          <PendingList />
        </Tabs.Panel>
      </Tabs>
    </Box>
  );
}

export function PendingSyncPage() {
  return <MyViolationsPage initialTab="pending" />;
}
