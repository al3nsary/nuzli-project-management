import { Link } from 'react-router-dom';
import { Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCamera, IconCloudUpload, IconUsers } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/auth';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { useRosterInfo, useUnsyncedCount } from '../../features/violations/offline/runtime';

/** The monitor's home: one big action, the outbox and the roster status. */
export function MonitorHome() {
  const user = useAuthStore((s) => s.user);
  const pending = useUnsyncedCount(user?.id);
  const roster = useRosterInfo();
  return (
    <Stack gap="md" maw={640}>
      <Button component={Link} to="/violations/new" size="lg" color="breach" leftSection={<IconCamera size={22} />} h={64}>
        {t('nav.recordViolation')}
      </Button>
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
        <Card padding="md">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon variant="light" color={pending ? 'signal' : 'ok'} size={40} radius="md" aria-hidden>
              <IconCloudUpload size={22} />
            </ThemeIcon>
            <div>
              <Text size="sm" c="dimmed">
                {t('nav.pendingSync')}
              </Text>
              <Text className="display num" fz="1.75rem" lh={1.2}>
                {formatNumber(pending)}
              </Text>
              <Button component={Link} to="/violations/pending" variant="subtle" size="compact-sm" px={0}>
                {t('home.openPending')}
              </Button>
            </div>
          </Group>
        </Card>
        <Card padding="md">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon variant="light" color="slate" size={40} radius="md" aria-hidden>
              <IconUsers size={22} />
            </ThemeIcon>
            <div>
              <Text size="sm" c="dimmed">
                {t('home.roster')}
              </Text>
              <Text className="display num" fz="1.75rem" lh={1.2}>
                {formatNumber(roster?.count ?? 0)}
              </Text>
              <Text size="xs" c="dimmed">
                {roster?.lastRosterAt
                  ? t('home.rosterAt', { at: formatDateTime(roster.lastRosterAt) })
                  : t('record.roster.never')}
              </Text>
            </div>
          </Group>
        </Card>
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        {t('home.monitorHint')}
      </Text>
    </Stack>
  );
}
