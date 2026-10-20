import { create } from 'zustand';
import type { AuthSession, UserDto, WorkspaceSummaryDto } from '@nuzli/shared';
import { setDisplayPrefs } from '../i18n/format';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

/**
 * A12: the signed-in user as `can()` must see them. The API sends `role` (the display role in the
 * active workspace — OWNER / ADMIN / SUPERVISOR / MONITOR / ASSISTANT / MEMBER since A12 round 3,
 * display only) and `workspaceRoles`; `can()` grants the union of `roles`, so an assistant gets
 * their `grants` and nothing else.
 */
export type SessionUser = UserDto & { roles?: readonly string[] };

export function normalizeUser(user: UserDto): SessionUser {
  if (!user.workspaceRoles) return user;
  return { ...user, roles: user.workspaceRoles };
}

interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  /** Held in memory only (ADR-010). Never written to storage. */
  accessToken: string | null;
  /** A12: the workspaces (أقسام) the user can enter; empty before sign-in. */
  workspaces: WorkspaceSummaryDto[];
  /** A12: the workspace the session is bound to; null until one is chosen. */
  activeWorkspace: WorkspaceSummaryDto | null;
  /** A12: one workspace in the whole system → no picker, no switcher, the UI as before. */
  singleWorkspace: boolean;
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
  workspaces: [],
  activeWorkspace: null,
  singleWorkspace: true,
  setSession(session) {
    applyPrefs(session?.user ?? null);
    set(
      session
        ? {
            status: 'authenticated',
            user: normalizeUser(session.user),
            accessToken: session.accessToken,
            workspaces: session.workspaces ?? [],
            // Pre-A12 servers send nothing: one implicit workspace.
            activeWorkspace:
              session.activeWorkspace !== undefined
                ? session.activeWorkspace
                : null,
            singleWorkspace: session.singleWorkspace ?? true,
          }
        : { status: 'anonymous', user: null, accessToken: null, workspaces: [], activeWorkspace: null, singleWorkspace: true },
    );
  },
  setUser(user) {
    applyPrefs(user);
    set({ user: normalizeUser(user) });
  },
  clear() {
    applyPrefs(null);
    set({ status: 'anonymous', user: null, accessToken: null, workspaces: [], activeWorkspace: null, singleWorkspace: true });
  },
}));

export const useCurrentUser = () => useAuthStore((s) => s.user);

/** A12: the active workspace's name (shown under the Nozoly logo); null before one is chosen. */
export const useActiveWorkspace = () => useAuthStore((s) => s.activeWorkspace);

/**
 * A12: true when the session needs the «اختر القسم» screen — several workspaces and none chosen.
 * Pre-A12 sessions (no `workspaces` sent) never do.
 */
export function needsWorkspacePick(s: Pick<AuthState, 'workspaces' | 'activeWorkspace' | 'status'>): boolean {
  return s.status === 'authenticated' && !s.activeWorkspace && s.workspaces.length > 1;
}
