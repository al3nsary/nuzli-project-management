import { create } from 'zustand';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ApiClient } from '../../../api/client';
import { getMeta, offlineDb, type OfflineDb, type OutboxItem } from './db';
import { SyncEngine, type SyncState } from './sync';
import { refreshRoster } from './roster';

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

export function setOfflineUser(id: string | null) {
  currentUserId = id;
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
      onState: (s) => useOfflineStore.getState().set(s),
    });
  }
  return engine;
}

export function peekSyncEngine(): SyncEngine | null {
  return engine;
}

/** Refreshes the roster now; network errors only update the status line. */
export async function refreshRosterNow(api: ApiClient, userId: string, db: OfflineDb = offlineDb()) {
  const store = useOfflineStore.getState();
  if (store.rosterRefreshing) return;
  store.set({ rosterRefreshing: true, rosterError: null });
  try {
    await refreshRoster(api, db, userId);
  } catch (err) {
    store.set({ rosterError: (err as { message_ar?: string }).message_ar ?? null });
  } finally {
    useOfflineStore.getState().set({ rosterRefreshing: false });
  }
}

// ---------------------------------------------------------------- live hooks (IndexedDB)

/** The signed-in user's outbox, newest first. */
export function useOutbox(userId: string | null | undefined): OutboxItem[] | undefined {
  return useLiveQuery(
    async () =>
      userId
        ? (await offlineDb().outbox.where('userId').equals(userId).toArray()).sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )
        : [],
    [userId],
  );
}

/** Items not yet on the server (badge on «بانتظار المزامنة»). */
export function useUnsyncedCount(userId: string | null | undefined): number {
  return (
    useLiveQuery(
      () =>
        userId
          ? offlineDb()
              .outbox.where('userId')
              .equals(userId)
              .filter((i) => i.status !== 'synced')
              .count()
          : 0,
      [userId],
    ) ?? 0
  );
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
