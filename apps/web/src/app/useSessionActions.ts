import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { useApi } from '../api/context';
import { useAuthStore } from '../stores/auth';
import { t } from '../i18n';
import { offlineDb } from '../features/violations/offline/db';
import { clearOfflineData } from '../features/violations/offline/outbox';
import { peekSyncEngine, setOfflineUser } from '../features/violations/offline/runtime';
import { dropPrintRun } from '../features/cards/printRun';

/**
 * Brief §7.4 + security review "logout clears caches": the roster, the outbox and its photos,
 * the offline profile, the in-memory print run (full IDs) — and the caller clears the query cache.
 * The service worker caches only the app shell (ADR-071), never API data.
 */
export async function wipeDevice() {
  dropPrintRun();
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
