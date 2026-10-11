import { create } from 'zustand';

/** Service-worker update state (vite-plugin-pwa, prompt mode). */
interface PwaState {
  needRefresh: boolean;
  offlineReady: boolean;
  /** Activates the waiting service worker and reloads. */
  update: (() => Promise<void>) | null;
  set(patch: Partial<PwaState>): void;
}

export const usePwaStore = create<PwaState>((set) => ({
  needRefresh: false,
  offlineReady: false,
  update: null,
  set: (patch) => set(patch),
}));
