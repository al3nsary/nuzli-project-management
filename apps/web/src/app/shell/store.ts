import { create } from 'zustand';
import type { EntityKind } from '../nav';

/*
 * Client state of the shell (Zustand). The folded rail and the recent items are per-user
 * conveniences in localStorage, always wrapped in try/catch (private windows, blocked storage).
 * Keys hold the user id only — never personal data (CLAUDE.md rule 6).
 */

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the state just isn't remembered */
  }
};

export const foldKey = (userId: string) => `nz.side.mini.${userId}`;
export const recentKey = (userId: string) => `nz.recent.${userId}`;

export interface RecentItem {
  kind: EntityKind;
  id: string;
  name: string;
  path: string;
}

interface ShellState {
  userId: string | null;
  /** Side navigation folded to the 74px rail (desktop). */
  mini: boolean;
  /** Phone drawer. */
  drawer: boolean;
  palette: boolean;
  sheet: boolean;
  recent: RecentItem[];
  /** Loads the per-user conveniences when the signed-in user changes. */
  bindUser(userId: string | null): void;
  setMini(mini: boolean): void;
  toggleMini(): void;
  setDrawer(open: boolean): void;
  setPalette(open: boolean): void;
  setSheet(open: boolean): void;
  pushRecent(item: RecentItem): void;
}

export const useShellStore = create<ShellState>((set, get) => ({
  userId: null,
  mini: false,
  drawer: false,
  palette: false,
  sheet: false,
  recent: [],
  bindUser(userId) {
    if (get().userId === userId) return;
    let recent: RecentItem[] = [];
    if (userId) {
      try {
        const raw = JSON.parse(read(recentKey(userId)) ?? '[]') as unknown;
        if (Array.isArray(raw)) recent = raw.filter((r): r is RecentItem => Boolean(r && typeof r === 'object' && 'path' in r)).slice(0, 6);
      } catch {
        recent = [];
      }
    }
    set({ userId, mini: userId ? read(foldKey(userId)) === '1' : false, recent, drawer: false, palette: false, sheet: false });
  },
  setMini(mini) {
    const { userId } = get();
    if (userId) write(foldKey(userId), mini ? '1' : '0');
    set({ mini });
  },
  toggleMini() {
    get().setMini(!get().mini);
  },
  setDrawer: (drawer) => set({ drawer }),
  setPalette: (palette) => set({ palette, ...(palette ? { sheet: false } : {}) }),
  setSheet: (sheet) => set({ sheet, ...(sheet ? { palette: false } : {}) }),
  pushRecent(item) {
    const { userId, recent } = get();
    const next = [item, ...recent.filter((r) => r.path !== item.path)].slice(0, 6);
    if (next.length === recent.length && next.every((r, i) => r.path === recent[i]?.path && r.name === recent[i]?.name)) return;
    if (userId) write(recentKey(userId), JSON.stringify(next));
    set({ recent: next });
  },
}));
