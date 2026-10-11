/// <reference lib="webworker" />
/**
 * Nuzli service worker (vite-plugin-pwa, injectManifest — ADR-071).
 *
 * Caches: the app shell (index.html, JS and CSS chunks), self-hosted fonts and icons — all
 * precached from the build manifest, so the app opens in airplane mode.
 * Never caches: API responses (they carry personal data; the roster lives in IndexedDB only),
 * map tiles, or anything cross-origin.
 * Background Sync: wakes the open app to flush the outbox (Chromium); iOS has none, so the
 * foreground triggers in the page are the guaranteed path (docs/offline.md).
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const SYNC_TAG = 'nuzli-outbox';
const SYNC_MESSAGE = 'nuzli-sync';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// The first install takes over the open page at once, so lazy chunks (the record form) load
// from the precache even if the connection drops before the next reload. Updates still wait
// for «تحديث الآن» (SKIP_WAITING below).
clientsClaim();

// SPA navigations fall back to the precached index.html — but never for the API or files.
const scope = new URL(self.registration.scope);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(new URL('index.html', scope).pathname), {
    denylist: [/\/api\//, /\/files\//, /\.[a-z0-9]+$/i],
  }),
);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

self.addEventListener('sync', (event) => {
  const e = event as SyncEvent;
  if (e.tag !== SYNC_TAG) return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: SYNC_MESSAGE });
    }),
  );
});
