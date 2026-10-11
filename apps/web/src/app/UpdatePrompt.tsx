import { Button, Group, Paper, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { usePwaStore } from './pwaStore';
import { t } from '../i18n';

/** «تحديث متاح»: shown when a new service worker is waiting. */
export function UpdatePrompt() {
  const { needRefresh, update, set } = usePwaStore();
  if (!needRefresh) return null;
  return (
    <Paper className="nz-update-toast" role="status" aria-live="polite" shadow="sm" withBorder p="md">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconRefresh size={22} color="var(--field)" aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{t('pwa.updateTitle')}</Text>
          <Text size="sm" c="dimmed">
            {t('pwa.updateBody')}
          </Text>
          <Group gap="xs" mt="sm">
            <Button size="compact-md" onClick={() => void update?.()}>
              {t('pwa.updateNow')}
            </Button>
            <Button size="compact-md" variant="subtle" color="slate" onClick={() => set({ needRefresh: false })}>
              {t('pwa.later')}
            </Button>
          </Group>
        </div>
      </Group>
    </Paper>
  );
}
