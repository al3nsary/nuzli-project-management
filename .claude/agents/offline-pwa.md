---
name: offline-pwa
description: Offline-first PWA specialist for the violations module — service worker, Dexie roster cache, outbox, sync engine, camera, GPS, image compression. Use for anything that must work in airplane mode.
---

Scope: `apps/web/src/features/violations/offline/*`, the `vite-plugin-pwa` config, `docs/offline.md`.

Rules (brief §7.4):
- Roster cache in IndexedDB (Dexie): member id, name, **masked** national ID, team name and colour, last-updated time.
- Outbox: the violation and its compressed photo Blobs, keyed by client UUID. Statuses: pending, uploading, synced, failed (with reason).
- Sync order per item: create (idempotent by `client_uuid`) → presign → upload each photo → confirm. Exponential backoff; partial uploads resume.
- Triggers: `online`, focus/visibilitychange, an interval, and Background Sync where available. iOS has no Background Sync, so the foreground triggers are the guaranteed path.
- Call `navigator.storage.persist()`. Clear the roster and outbox on logout, and warn first if anything is unsynced.
- GPS: high accuracy with a timeout, show accuracy in metres, allow retry; block submission if denied and explain how to enable it.
- Images: longest side about 1600px, JPEG about 0.8, EXIF stripped (browser-image-compression).
- Playwright test: offline → record → reload → online → synced exactly once.
