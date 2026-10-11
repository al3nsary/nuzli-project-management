import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { useApi } from '../api/context';
import { useAuthStore } from '../stores/auth';
import { t } from '../i18n';
import { offlineDb } from '../features/violations/offline/db';
import { clearOfflineData } from '../features/violations/offline/outbox';
import { peekSyncEngine, setOfflineUser } from '../features/violations/offline/runtime';

/** Brief §7.4: logout removes the roster, the outbox and every cached personal datum. */
async function wipeDevice() {
  setOfflineUser(null);
  peekSyncEngine()?.stop();
  try {
    await clearOfflineData(offlineDb());
  } catch {
    // IndexedDB unavailable (private mode): nothing was stored.
  }
}

export function useSessionActions() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);

  /** Callers warn first when unsynced violations exist (Layout's logout dialog). */
  const logout = async () => {
    await wipeDevice();
    try {
      await api.auth.logout();
    } catch {
      // The session is dropped locally either way.
    }
    api.setAccessToken(null);
    clear();
    qc.clear();
    navigate('/login', { replace: true });
  };

  const resetDemo = async () => {
    if (!api.demo) return;
    await wipeDevice();
    await api.demo.reset();
    api.setAccessToken(null);
    clear();
    qc.clear();
    notifications.show({ color: 'ok', message: t('shell.demoResetDone') });
    navigate('/login', { replace: true });
  };

  return { logout, resetDemo };
}
