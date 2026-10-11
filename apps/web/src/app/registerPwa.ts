import { usePwaStore } from './pwaStore';

/**
 * Registers the service worker (production builds only). Prompt mode: a new version waits
 * until the user taps «تحديث الآن» in the «تحديث متاح» toast, so a form being filled is never
 * reloaded under the user's feet. The outbox is in IndexedDB, so an update never loses it.
 */
export async function registerPwa() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const { registerSW } = await import('virtual:pwa-register');
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      usePwaStore.getState().set({ needRefresh: true, update: () => updateSW(true) });
    },
    onOfflineReady() {
      usePwaStore.getState().set({ offlineReady: true });
    },
    onRegisteredSW(_url, registration) {
      // Long-lived field sessions still learn about new versions.
      if (registration) setInterval(() => void registration.update().catch(() => undefined), 60 * 60 * 1000);
    },
  });
}
