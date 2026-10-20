import { create } from 'zustand';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ApiClient } from '../../../api/client';
import { useAuthStore } from '../../../stores/auth';
import { getMeta, offlineDb, type OfflineDb, type OutboxItem } from './db';
import { SyncEngine, type SyncState } from './sync';
import { refreshRoster } from './roster';
import { inWorkspace, unsyncedElsewhere, type OtherWorkspaceUnsynced } from './outbox';

/** UI state of the sync engine and the roster refresh. */
interface OfflineUiState extends SyncState {
  rosterRefreshing: boolean;
  rosterError: string | null;
  /** The app was reopened offline with the cached profile (no live session yet). */
  offlineSession: boolean;
  set(patch: Partial<OfflineUiState>): void;
}

export const useOfflineStore = create<OfflineUiState>((set) => ({
  running: false,
  lastRunAt: null,
  authRequired: false,
  offline: false,
  rosterRefreshing: false,
  rosterError: null,
  offlineSession: false,
  set: (patch) => set(patch),
}));

let engine: SyncEngine | null = null;
let engineApi: ApiClient | null = null;
let currentUserId: string | null = null;
/** A12 (H3): undefined = a server without workspaces; null = none chosen yet. */
let currentWorkspaceId: string | null | undefined = undefined;

export function setOfflineUser(id: string | null) {
  currentUserId = id;
}

/** A12 (H3): the session's workspace — the sync engine sends only that workspace's items. */
export function setOfflineWorkspace(id: string | null | undefined) {
  currentWorkspaceId = id;
}

export function offlineWorkspaceId(): string | null | undefined {
  return currentWorkspaceId;
}

/** The single engine of this tab, bound to the active adapter. */
export function getSyncEngine(api: ApiClient, db: OfflineDb = offlineDb()): SyncEngine {
  if (!engine || engineApi !== api) {
    engine?.stop();
    engineApi = api;
    engine = new SyncEngine({
      api,
      db,
      getUserId: () => currentUserId,
      getWorkspaceId: () => currentWorkspaceId,
      onState: (s) => useOfflineStore.getState().set(s),
    });
  }
  return engine;
}

export function peekSyncEngine(): SyncEngine | null {
  return engine;
}

/** Refreshes the roster now; network errors only update the status line. */
export async function refreshRosterNow(api: ApiClient, userId: string, db: OfflineDb = offlineDb(), workspaceId?: string | null) {
  const store = useOfflineStore.getState();
  if (store.rosterRefreshing) return;
  store.set({ rosterRefreshing: true, rosterError: null });
  try {
    await refreshRoster(api, db, userId, workspaceId ?? currentWorkspaceId ?? null);
  } catch (err) {
    store.set({ rosterError: (err as { message_ar?: string }).message_ar ?? null });
  } finally {
    useOfflineStore.getState().set({ rosterRefreshing: false });
  }
}

// ---------------------------------------------------------------- live hooks (IndexedDB)

/**
 * The signed-in user's outbox in the active workspace, newest first. A12 (H3): items recorded in
 * another workspace are not listed here (they wait for that workspace; see useOutboxElsewhere).
 */
export function useOutbox(userId: string | null | undefined, workspace?: string | null): OutboxItem[] | undefined {
  const active = useAuthStore((s) => s.activeWorkspace?.id ?? null);
  const workspaceId = workspace === undefined ? active : workspace;
  return useLiveQuery(
    async () =>
      userId
        ? (await offlineDb().outbox.where('userId').equals(userId).toArray())
            .filter((i) => inWorkspace(i, workspaceId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    [userId, workspaceId],
  );
}

/** Items not yet on the server in the active workspace (badge on «بانتظار المزامنة»). */
export function useUnsyncedCount(userId: string | null | undefined, workspace?: string | null): number {
  const active = useAuthStore((s) => s.activeWorkspace?.id ?? null);
  const workspaceId = workspace === undefined ? active : workspace;
  return (
    useLiveQuery(
      () =>
        userId
          ? offlineDb()
              .outbox.where('userId')
              .equals(userId)
              .filter((i) => i.status !== 'synced' && inWorkspace(i, workspaceId))
              .count()
          : 0,
      [userId, workspaceId],
    ) ?? 0
  );
}

/** A12 (H3): unsynced items recorded in other workspaces (kept; sent when the user returns there). */
export function useOutboxElsewhere(userId: string | null | undefined, workspace?: string | null): OtherWorkspaceUnsynced[] {
  const active = useAuthStore((s) => s.activeWorkspace?.id ?? null);
  const workspaceId = workspace === undefined ? active : workspace;
  return useLiveQuery(() => unsyncedElsewhere(offlineDb(), userId, workspaceId).catch(() => []), [userId, workspaceId]) ?? [];
}

export function useOutboxItem(id: string | null | undefined): OutboxItem | undefined {
  return useLiveQuery(() => (id ? offlineDb().outbox.get(id) : undefined), [id]);
}

export function useRosterInfo(): { count: number; lastRosterAt: string | null } | undefined {
  return useLiveQuery(async () => {
    const db = offlineDb();
    return {
      count: await db.roster.count(),
      lastRosterAt: (await getMeta<string>(db, 'lastRosterAt')) ?? null,
    };
  }, []);
}
