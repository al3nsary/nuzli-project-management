import {
  Box,
  Button,
  Divider,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useAuthStore } from '../stores/auth';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationDto } from '@nuzli/shared';
import { useApi } from '../api/context';
import { useNotifications, useUnreadCount } from '../api/queries';
import { formatDateTime, formatNumber, t } from '../i18n';
import { notificationLink, notificationText } from './notificationText';

export function NotificationItem({
  n,
  onOpen,
}: {
  n: NotificationDto;
  onOpen: (n: NotificationDto) => void;
}) {
  const unread = !n.readAt;
  return (
    <UnstyledButton
      onClick={() => onOpen(n)}
      p="sm"
      style={{
        borderRadius: 12,
        display: 'block',
        width: '100%',
        background: unread ? 'var(--sheen)' : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Box
          mt={8}
          w={8}
          h={8}
          style={{
            borderRadius: 99,
            flex: 'none',
            background: unread ? 'var(--accent)' : 'transparent',
          }}
          aria-label={unread ? t('notif.unread') : undefined}
        />
        <Box style={{ minWidth: 0 }}>
          <Text size="sm" fw={unread ? 600 : 400}>
            {notificationText(n)}
          </Text>
          <Text size="xs" c="dimmed">
            {formatDateTime(n.createdAt)}
          </Text>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

export function useOpenNotification() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (n: NotificationDto) => {
    if (!n.readAt) {
      await api.notifications.markRead(n.id).catch(() => undefined);
      await qc.invalidateQueries({ queryKey: ['notifications'] });
    }
    const link = notificationLink(n, useAuthStore.getState().user?.role);
    if (link) navigate(link);
  };
}

export function NotificationBell() {
  const api = useApi();
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const list = useNotifications({ pageSize: 6 });
  const open = useOpenNotification();
  const count = unread.data?.count ?? 0;

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const label = count
    ? `${t('shell.notifications')} — ${t('shell.unreadCount', { count })}`
    : t('shell.notifications');

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width="min(340px, calc(100vw - 24px))"
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <button type="button" className="nz-iconbtn" aria-label={label} onClick={() => setOpened((o) => !o)}>
          <IconBell size={19} stroke={1.8} aria-hidden />
          {count ? (
            <span className="nz-bdg" aria-hidden>
              {formatNumber(Math.min(count, 99))}
            </span>
          ) : null}
        </button>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" px="md" py="sm">
          <Text fw={600}>{t('shell.notifications')}</Text>
          {count ? (
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() => markAll.mutate()}
              loading={markAll.isPending}
            >
              {t('shell.markAllRead')}
            </Button>
          ) : null}
        </Group>
        <Divider />
        <ScrollArea.Autosize mah={360}>
          <Stack gap={2} p={6}>
            {list.data?.items.length ? (
              list.data.items.map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  onOpen={(x) => {
                    setOpened(false);
                    void open(x);
                  }}
                />
              ))
            ) : (
              <Text c="dimmed" size="sm" p="md" ta="center">
                {t('shell.noNotifications')}
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
        <Divider />
        <Box p={6}>
          <Button
            variant="subtle"
            fullWidth
            onClick={() => {
              setOpened(false);
              navigate('/notifications');
            }}
          >
            {t('shell.viewAllNotifications')}
          </Button>
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}
