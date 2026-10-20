import { useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { offlineDb } from '../../features/violations/offline/db';
import { unsyncedCount } from '../../features/violations/offline/outbox';
import { tCount, t } from '../../i18n';
import { useSessionActions } from '../useSessionActions';

/**
 * Sign-out with the brief §7.4 warning: if violations recorded on this device never reached the
 * server, ask first — signing out wipes the outbox. Shared by the top-bar menu and «المزيد».
 */
export function useLogoutFlow() {
  const { logout } = useSessionActions();
  const [unsynced, setUnsynced] = useState(0);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    const n = await unsyncedCount(offlineDb()).catch(() => 0);
    if (n > 0) setUnsynced(n);
    else void logout();
  };

  const dialog = (
    <Modal opened={unsynced > 0} onClose={() => setUnsynced(0)} title={t('shell.logoutUnsyncedTitle')}>
      <Stack>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <IconAlertTriangle size={24} color="var(--red)" style={{ flexShrink: 0 }} aria-hidden />
          <Text>{tCount('shell.logoutUnsyncedBody', unsynced)}</Text>
        </Group>
        <Group justify="flex-end" gap="xs" className="nz-sheet-actions">
          <Button variant="default" onClick={() => setUnsynced(0)}>
            {t('shell.logoutStay')}
          </Button>
          <Button
            color="breach"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await logout();
              } finally {
                setBusy(false);
                setUnsynced(0);
              }
            }}
          >
            {tCount('shell.logoutWipe', unsynced)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { request, dialog };
}
