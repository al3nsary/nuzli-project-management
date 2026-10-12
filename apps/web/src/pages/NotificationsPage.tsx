import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Group, Pagination, SegmentedControl, Stack } from '@mantine/core';
import { notifications as toast } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconBellOff, IconChecks } from '@tabler/icons-react';
import { useApi } from '../api/context';
import { errorMessage } from '../api/errors';
import { useNotifications, useUnreadCount } from '../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui';
import { NotificationItem, useOpenNotification } from '../app/NotificationBell';
import { t } from '../i18n';

export function NotificationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const q = useNotifications({ unread: filter === 'unread' || undefined, page, pageSize: 20 });
  const unread = useUnreadCount();
  const open = useOpenNotification();

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (err) => toast.show({ color: 'breach', message: errorMessage(err) }),
  });

  return (
    <>
      <PageHeader
        title={t('notif.title')}
        actions={
          unread.data?.count ? (
            <Button
              variant="light"
              leftSection={<IconChecks size={18} />}
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {t('notif.markAllRead')}
            </Button>
          ) : undefined
        }
      />
      <Group mb="md">
        <SegmentedControl
          value={filter}
          onChange={(v) => {
            setFilter(v as 'all' | 'unread');
            setPage(1);
          }}
          data={[
            { value: 'all', label: t('notif.filterAll') },
            { value: 'unread', label: t('notif.filterUnread') },
          ]}
        />
      </Group>
      {q.isLoading ? (
        <LoadingBlock variant="list" />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={IconBellOff}
          title={filter === 'unread' ? t('notif.emptyUnread') : t('notif.empty')}
          body={t('notif.emptyBody')}
          action={{ label: t('notif.emptyAction'), onClick: () => navigate('/profile') }}
        />
      ) : (
        <Card p="xs">
          <Stack gap={2}>
            {q.data.items.map((n) => (
              <NotificationItem key={n.id} n={n} onOpen={(x) => void open(x)} />
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
