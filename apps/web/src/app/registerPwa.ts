import { usePwaStore } from './pwaStore';
import { createUpdater } from './pwa/updates';
import { useOfflineStore } from '../features/violations/offline/runtime';

/**
 * Registers the service worker (production builds only) with workbox-window and starts the update
 * checks of `createUpdater` (A12): on open, on focus/visibility, every 30 minutes. Prompt mode — a
 * new version waits for «تحديث الآن»; the reload waits for any violation upload in flight; the
 * outbox (IndexedDB) is never touched by an update.
 */
export async function registerPwa() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    usePwaStore.getState().set({ status: 'unsupported' });
    return;
  }
  const { Workbox } = await import('workbox-window');
  const base = import.meta.env.BASE_URL;
  const wb = new Workbox(`${base}sw.js`, { scope: base, type: 'classic' });
  const updater = createUpdater({
    wb,
    reload: () => window.location.reload(),
    isSyncing: () => useOfflineStore.getState().running,
    onSyncIdle: (cb) => {
      if (!useOfflineStore.getState().running) {
        queueMicrotask(cb);
        return () => undefined;
      }
      return useOfflineStore.subscribe((s) => {
        if (!s.running) cb();
      });
    },
  });
  try {
    await updater.start();
  } catch {
    usePwaStore.getState().set({ status: 'error' });
  }
}
