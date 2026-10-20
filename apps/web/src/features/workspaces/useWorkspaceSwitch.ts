import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { AuthSession } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useAuthStore } from '../../stores/auth';
import { wipeDevice } from '../../app/useSessionActions';
import { offlineDb } from '../violations/offline/db';
import { t } from '../../i18n';

/** Violations recorded on this device that never reached the server (they are lost on switch). */
export async function unsyncedCount(): Promise<number> {
  try {
    return await offlineDb().outbox.count();
  } catch {
    return 0;
  }
}

/**
 * A12 (ADR-146): entering another workspace issues a NEW session for it. Before using it the
 * device drops everything of the previous workspace — the query cache, the offline roster and
 * outbox, the in-memory print run — so nothing of one workspace is ever shown in another.
 */
export function useWorkspaceSwitch() {
  const api = useApi();
  const qc = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const [busyId, setBusyId] = useState<string | null>(null);

  const enter = useCallback(
    async (workspaceId: string, opts: { quiet?: boolean } = {}): Promise<AuthSession | null> => {
      setBusyId(workspaceId);
      try {
        await qc.cancelQueries();
        await wipeDevice();
        const session = await api.auth.switchWorkspace(workspaceId);
        api.setAccessToken(session.accessToken);
        qc.clear();
        setSession(session);
        if (!opts.quiet && session.activeWorkspace) {
          notifications.show({
            color: 'field',
            message: t('workspaceSwitch.done', { name: session.activeWorkspace.name }),
          });
        }
        return session;
      } catch (err) {
        notifications.show({ color: 'breach', title: t('workspaceSwitch.failed'), message: errorMessage(err) });
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [api, qc, setSession],
  );

  return { enter, busyId };
}

/**
 * Re-reads the session (workspace list, single-workspace mode, the caller's roles) after an owner
 * created, archived or restored a workspace or changed memberships.
 */
export function useRefreshSession() {
  const api = useApi();
  const setSession = useAuthStore((s) => s.setSession);
  return useCallback(async () => {
    const session = await api.auth.refresh();
    if (session) {
      api.setAccessToken(session.accessToken);
      setSession(session);
    }
    return session;
  }, [api, setSession]);
}
