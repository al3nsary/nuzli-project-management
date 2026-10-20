import { usePwaStore, type UpdateStatus } from '../pwaStore';

/*
 * A12 — updates «يُثبَّت مرة واحدة»: the app is installed once and keeps itself current.
 *
 *  - Checks: when the app opens (registration), when it comes back to the foreground
 *    (visibilitychange → visible, window focus) and every 30 minutes while open; checks closer
 *    than a minute apart are skipped (focus and visibility fire together).
 *  - A new service worker installs in the background and WAITS (prompt mode): a form being
 *    filled is never reloaded under the user's feet. The persistent «تحديث متاح — حدّث الآن»
 *    banner shows, and «المزيد» has «البحث عن تحديث» with the current version.
 *  - «حدّث الآن»: if a violation is uploading right now, wait until that upload finishes; then
 *    SKIP_WAITING → the new worker takes control (clientsClaim) → one reload. The outbox lives in
 *    IndexedDB, which an update never touches, so unsynced violations survive.
 */

export const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
export const MIN_CHECK_GAP_MS = 60 * 1000;
/** If the new worker never reports control (an old engine), reload anyway after this long. */
export const RELOAD_FALLBACK_MS = 4000;

/** The part of workbox-window's `Workbox` we use (mocked in tests). */
export interface WorkboxLike {
  addEventListener(type: 'waiting' | 'controlling' | 'activated' | 'installed', cb: (e: { isUpdate?: boolean; wasWaitingBeforeRegister?: boolean }) => void): void;
  register(): Promise<ServiceWorkerRegistration | undefined>;
  update(): Promise<void>;
  messageSkipWaiting(): void;
}

export interface UpdaterDeps {
  wb: WorkboxLike;
  reload(): void;
  /** True while a violation upload is in flight. */
  isSyncing(): boolean;
  /** Calls `cb` once the sync engine is idle; returns an unsubscribe. */
  onSyncIdle(cb: () => void): () => void;
  /** Where focus/visibility/online events come from. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> };
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export interface Updater {
  start(): Promise<void>;
  stop(): void;
  check(manual?: boolean): Promise<UpdateStatus>;
  apply(): Promise<void>;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const store = usePwaStore.getState;
  const now = deps.now ?? (() => Date.now());
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const unevery = deps.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = target?.document ?? (typeof document !== 'undefined' ? document : undefined);
  let registration: ServiceWorkerRegistration | undefined;
  let requested = false;
  let reloaded = false;
  let lastCheck = 0;
  let timer: unknown = null;

  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    deps.reload();
  };

  deps.wb.addEventListener('waiting', () => {
    store().set({ needRefresh: true, status: 'available' });
  });
  deps.wb.addEventListener('controlling', () => {
    // Only the update the user asked for reloads the page (the first install just takes over).
    if (requested) reloadOnce();
  });
  deps.wb.addEventListener('activated', (e) => {
    if (!e.isUpdate) store().set({ offlineReady: true });
  });

  async function check(manual = false): Promise<UpdateStatus> {
    const t = now();
    if (!manual && t - lastCheck < MIN_CHECK_GAP_MS) return store().status;
    lastCheck = t;
    if (store().needRefresh) return 'available';
    if (manual) store().set({ status: 'checking' });
    try {
      await deps.wb.update();
      const found = Boolean(registration?.waiting || registration?.installing) || store().needRefresh;
      const status: UpdateStatus = found ? 'available' : 'upToDate';
      // Automatic checks only ever raise «available» (via the waiting event); they stay quiet otherwise.
      if (manual || found) store().set({ status, lastCheckedAt: now() });
      return status;
    } catch {
      if (manual) store().set({ status: 'error', lastCheckedAt: now() });
      return 'error';
    }
  }

  async function apply(): Promise<void> {
    if (requested) return;
    requested = true;
    store().set({ updating: true });
    if (deps.isSyncing()) {
      store().set({ waitingForSync: true });
      await new Promise<void>((resolve) => {
        const off = deps.onSyncIdle(() => {
          off();
          resolve();
        });
      });
      store().set({ waitingForSync: false });
    }
    deps.wb.messageSkipWaiting();
    later(reloadOnce, RELOAD_FALLBACK_MS);
  }

  const onVisible = () => {
    if (!doc || doc.visibilityState === 'visible') void check();
  };
  const onFocus = () => void check();

  return {
    async start() {
      store().set({ update: apply, check: () => check(true) });
      registration = await deps.wb.register();
      lastCheck = now();
      doc?.addEventListener('visibilitychange', onVisible);
      target?.addEventListener('focus', onFocus);
      target?.addEventListener('online', onFocus);
      timer = every(() => void check(), UPDATE_INTERVAL_MS);
    },
    stop() {
      doc?.removeEventListener('visibilitychange', onVisible);
      target?.removeEventListener('focus', onFocus);
      target?.removeEventListener('online', onFocus);
      if (timer !== null) unevery(timer);
      timer = null;
    },
    check,
    apply,
  };
}
