import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { AuthSession } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useAuthStore } from '../../stores/auth';
import { getMeta, offlineDb } from '../violations/offline/db';
import { clearWorkspaceCache, unsyncedElsewhere } from '../violations/offline/outbox';
import { offlineWorkspaceId, peekSyncEngine, setOfflineWorkspace } from '../violations/offline/runtime';
import { dropPrintRun } from '../cards/printRun';
import { tCount, t } from '../../i18n';

/**
 * A12 (ADR-146, security review H3/L4 → ADR-162): entering a workspace issues a NEW session for
 * it. Before using it the device drops what belongs to the previous workspace — the query cache,
 * the in-memory print run and (when the workspace changes) the offline roster, types and form
 * settings — so nothing of one workspace is shown in another. **The unsynced outbox is never
 * deleted here** (it used to be, silently, from «اختر القسم»): each item carries its workspace,
 * waits on the device while another workspace is active, and is sent when its workspace is
 * entered again. Only signing out removes it, after a warning with the count.
 */
export function useWorkspaceSwitch() {
  const api = useApi();
  const qc = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const [busyId, setBusyId] = useState<string | null>(null);

  const enter = useCallback(
    async (workspaceId: string, opts: { quiet?: boolean } = {}): Promise<AuthSession | null> => {
      setBusyId(workspaceId);
      // While the session changes hands nothing is sent (no item may go out under the other
      // workspace's token); the runtime restarts the engine for the new workspace.
      const engine = peekSyncEngine();
      const previous = offlineWorkspaceId();
      setOfflineWorkspace(null);
      engine?.stop();
      try {
        await qc.cancelQueries();
        const session = await api.auth.switchWorkspace(workspaceId);
        setOfflineWorkspace(session.activeWorkspace?.id ?? null);
        dropPrintRun();
        try {
          const db = offlineDb();
          const rosterWs = await getMeta<string>(db, 'rosterWorkspaceId');
          if (rosterWs && rosterWs !== workspaceId) await clearWorkspaceCache(db);
        } catch {
          // IndexedDB unavailable (private mode): nothing was stored.
        }
        api.setAccessToken(session.accessToken);
        qc.clear();
        setSession(session);
        if (!opts.quiet && session.activeWorkspace) {
          notifications.show({
            color: 'field',
            message: t('workspaceSwitch.done', { name: session.activeWorkspace.name }),
          });
        }
        // Unsynced violations of another workspace stay on the device: say so, never delete them.
        const userId = session.user?.id ?? null;
        const waiting = await unsyncedElsewhere(offlineDb(), userId, session.activeWorkspace?.id ?? null).catch(() => []);
        const n = waiting.reduce((sum, w) => sum + w.count, 0);
        if (n > 0) {
          notifications.show({
            color: 'signal',
            autoClose: 10_000,
            message: tCount('workspaceSwitch.keptElsewhere', n, { name: waiting.map((w) => w.workspaceName ?? '').filter(Boolean).join('، ') }),
          });
        }
        return session;
      } catch (err) {
        setOfflineWorkspace(previous);
        engine?.start();
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
