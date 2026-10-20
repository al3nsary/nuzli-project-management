import { create } from 'zustand';

export type UpdateStatus = 'idle' | 'unsupported' | 'checking' | 'upToDate' | 'available' | 'error';

/** Service-worker update state (A12 «يُثبَّت مرة واحدة»; see app/pwa/updates.ts). */
interface PwaState {
  /** A new version is installed and waiting: the «تحديث متاح — حدّث الآن» banner shows. */
  needRefresh: boolean;
  offlineReady: boolean;
  /** Result of the last check (the «البحث عن تحديث» button in «المزيد»). */
  status: UpdateStatus;
  lastCheckedAt: number | null;
  /** «حدّث الآن» was pressed: the page reloads as soon as it is safe. */
  updating: boolean;
  /** A violation upload is in flight; the reload waits for it to finish. */
  waitingForSync: boolean;
  /** Activates the waiting service worker and reloads (after any in-flight sync). */
  update: (() => Promise<void>) | null;
  /** Asks the server for a newer service worker now. */
  check: (() => Promise<UpdateStatus>) | null;
  set(patch: Partial<PwaState>): void;
}

export const usePwaStore = create<PwaState>((set) => ({
  needRefresh: false,
  offlineReady: false,
  status: 'idle',
  lastCheckedAt: null,
  updating: false,
  waitingForSync: false,
  update: null,
  check: null,
  set: (patch) => set(patch),
}));
