import { create } from 'zustand';
import type { AuthSession, UserDto } from '@nuzli/shared';
import { setDisplayPrefs } from '../i18n/format';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  /** Held in memory only (ADR-010). Never written to storage. */
  accessToken: string | null;
  setSession(session: AuthSession | null): void;
  setUser(user: UserDto): void;
  clear(): void;
}

function applyPrefs(user: UserDto | null) {
  setDisplayPrefs({
    digits: user?.preferences.digits ?? 'latn',
    showHijri: user?.preferences.showHijri ?? false,
  });
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  accessToken: null,
  setSession(session) {
    applyPrefs(session?.user ?? null);
    set(
      session
        ? { status: 'authenticated', user: session.user, accessToken: session.accessToken }
        : { status: 'anonymous', user: null, accessToken: null },
    );
  },
  setUser(user) {
    applyPrefs(user);
    set({ user });
  },
  clear() {
    applyPrefs(null);
    set({ status: 'anonymous', user: null, accessToken: null });
  },
}));

export const useCurrentUser = () => useAuthStore((s) => s.user);
