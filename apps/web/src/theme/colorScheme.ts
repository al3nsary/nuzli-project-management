/**
 * Owner request A10 («اللايت مود هو الافتراضي»): the white identity shows for everyone by
 * default, whatever the device's dark setting; dark is an explicit choice (user menu, profile,
 * command palette). ADR-127.
 *
 * - Mantine starts on `light` and reads/writes its scheme through `nzColorSchemeManager`, which
 *   never answers `auto`: anything but an explicit `dark` is `light`.
 * - `tokens.css` applies the dark tokens only under `[data-mantine-color-scheme='dark']` — the
 *   `prefers-color-scheme` media query is gone.
 * - The stored preference `auto` (the old default, still accepted by the API schema) means light.
 * - `migrateStoredColorScheme` rewrites a stored `auto` (or anything unknown) to `light` once, under a
 *   versioned flag, so a device that followed the OS before A10 opens light.
 */
import { useCallback } from 'react';
import { useComputedColorScheme, useMantineColorScheme, type MantineColorSchemeManager } from '@mantine/core';
import { useApi } from '../api/context';
import { useAuthStore } from '../stores/auth';

export type SchemeChoice = 'light' | 'dark';

/** Mantine's localStorage key (kept, so a dark choice made before A10 survives). */
export const SCHEME_STORAGE_KEY = 'mantine-color-scheme-value';
/** Versioned one-time migration flag (A10 = 2). */
export const THEME_MIGRATION_KEY = 'nz.theme.migration';
export const THEME_MIGRATION_VERSION = '2';

/** The scheme a stored or server preference means: only an explicit `dark` is dark. */
export function effectiveScheme(pref: string | null | undefined): SchemeChoice {
  return pref === 'dark' ? 'dark' : 'light';
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * One-time migration (A10): `auto` (the old default) and unknown values become `light`; an explicit
 * `dark` stays. Runs before the first render. Safe without storage (private mode).
 */
export function migrateStoredColorScheme(store: Storage | null = storage()): void {
  if (!store) return;
  try {
    if (store.getItem(THEME_MIGRATION_KEY) === THEME_MIGRATION_VERSION) return;
    const cur = store.getItem(SCHEME_STORAGE_KEY);
    if (cur !== 'dark') store.setItem(SCHEME_STORAGE_KEY, 'light');
    store.setItem(THEME_MIGRATION_KEY, THEME_MIGRATION_VERSION);
  } catch {
    /* storage blocked: the manager below still maps everything but dark to light */
  }
}

/** A Mantine colour-scheme manager that never resolves to the OS setting. */
export function nzColorSchemeManager(key = SCHEME_STORAGE_KEY): MantineColorSchemeManager {
  let handler: ((e: StorageEvent) => void) | null = null;
  return {
    get: () => {
      try {
        return effectiveScheme(storage()?.getItem(key));
      } catch {
        return 'light';
      }
    },
    set: (value) => {
      try {
        storage()?.setItem(key, effectiveScheme(value));
      } catch {
        /* ignore */
      }
    },
    subscribe: (onUpdate) => {
      handler = (e: StorageEvent) => {
        if (e.storageArea === storage() && e.key === key) onUpdate(effectiveScheme(e.newValue));
      };
      window.addEventListener('storage', handler);
    },
    unsubscribe: () => {
      if (handler) window.removeEventListener('storage', handler);
      handler = null;
    },
    clear: () => {
      try {
        storage()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * The light/dark switch (user menu, command palette): applies at once and, when signed in, saves
 * the choice as the user's preference so the next sign-in keeps it.
 */
export function useThemeToggle() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light') as SchemeChoice;
  const choose = useCallback(
    (next: SchemeChoice) => {
      setColorScheme(next);
      if (!user || effectiveScheme(user.preferences.theme) === next) return;
      api.me
        .update({ preferences: { theme: next } })
        .then((u) => setUser(u))
        .catch(() => undefined);
    },
    [api, user, setUser, setColorScheme],
  );
  const toggle = useCallback(() => choose(scheme === 'dark' ? 'light' : 'dark'), [choose, scheme]);
  return { scheme, toggle, choose };
}
