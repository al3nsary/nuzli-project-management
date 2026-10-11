import { can, type UserDto } from '@nuzli/shared';
import { getMeta, setMeta, type OfflineDb } from './db';

/**
 * A monitor must be able to reopen the app in airplane mode (brief §16 Phase 3). The access
 * token lives in memory only (ADR-010), so after an offline reload there is no session to
 * refresh. We keep the signed-in recorder's display profile (no email, mobile or national ID)
 * so the shell and the record form can open; the first request after reconnecting refreshes
 * the real session through the httpOnly cookie. Cleared on logout with the rest (ADR-073).
 */
export async function rememberOfflineUser(db: OfflineDb, user: UserDto) {
  if (!can(user, 'violations.create')) return;
  const profile: UserDto = {
    ...user,
    email: '',
    mobile: '',
    nationalIdMasked: '',
    nationalId: undefined,
    lastLoginAt: null,
  };
  await setMeta(db, 'offlineUser', profile);
}

export async function loadOfflineUser(db: OfflineDb): Promise<UserDto | null> {
  const u = await getMeta<UserDto>(db, 'offlineUser');
  return u && can(u, 'violations.create') ? u : null;
}
