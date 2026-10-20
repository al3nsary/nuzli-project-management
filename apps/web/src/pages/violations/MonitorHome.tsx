import { Link } from 'react-router-dom';
import { Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCamera, IconCloudUpload, IconUserQuestion, IconUsers } from '@tabler/icons-react';
import { useMyViolations } from '../../api/queries';
import { useOnline } from '../../lib/useOnline';
import { useAuthStore } from '../../stores/auth';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { useRosterInfo, useUnsyncedCount } from '../../features/violations/offline/runtime';
import { OutboxElsewhereNotice } from './MyViolationsPage';

/** The monitor's home: one big action, the outbox and the roster status. */
export function MonitorHome() {
  const user = useAuthStore((s) => s.user);
  const pending = useUnsyncedCount(user?.id);
  const roster = useRosterInfo();
  const online = useOnline();
  // A9: what I recorded without a person, still waiting to be assigned (I may assign any time).
  const unassigned = useMyViolations({ assigned: 'false', pageSize: 1 }, online);
  const waiting = unassigned.data?.total ?? 0;
  return (
    <Stack gap="md" maw={640}>
      <Button component={Link} to="/violations/new" size="lg" color="breach" leftSection={<IconCamera size={22} />} h={64}>
        {t('nav.recordViolation')}
      </Button>
      <OutboxElsewhereNotice />
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
        {waiting ? (
          <Card padding="md" data-tone="wait">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" color="signal" size={40} radius="md" aria-hidden>
                <IconUserQuestion size={22} />
              </ThemeIcon>
              <div>
                <Text size="sm" c="dimmed">
                  {t('home.unassigned')}
                </Text>
                <Text className="display num" fz="1.75rem" lh={1.2}>
                  {formatNumber(waiting)}
                </Text>
                <Button component={Link} to="/violations/mine" variant="subtle" size="compact-sm" px={0}>
                  {t('home.openUnassigned')}
                </Button>
              </div>
            </Group>
          </Card>
        ) : null}
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        {t('home.monitorHint')}
      </Text>
    </Stack>
  );
}
