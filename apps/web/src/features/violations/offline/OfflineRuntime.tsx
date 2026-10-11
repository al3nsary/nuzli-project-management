import { useEffect, useRef } from 'react';
import { can } from '@nuzli/shared';
import { useApi } from '../../../api/context';
import { useAuthStore } from '../../../stores/auth';
import { getMeta, offlineDb, setMeta } from './db';
import { ROSTER_REFRESH_MS } from './roster';
import { getSyncEngine, refreshRosterNow, setOfflineUser } from './runtime';
import { rememberOfflineUser } from './session';
import { requestPersistentStorage } from './sync';

/**
 * Starts the offline machinery for users who record violations: the sync engine and its
 * triggers, persistent storage, the offline profile, and the roster refresh — on login,
 * every 15 minutes while online, and when the connection comes back (brief §7.4).
 */
export function OfflineRuntime() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const prevStatus = useRef(status);
  const justLoggedIn = prevStatus.current === 'anonymous' && status === 'authenticated';
  prevStatus.current = status;
  const forceRoster = useRef(false);
  if (justLoggedIn) forceRoster.current = true;

  const canRecord = can(user, 'violations.create') && !user?.mustChangePassword;
  const userId = canRecord ? user?.id ?? null : null;

  useEffect(() => {
    setOfflineUser(userId);
    if (!userId || !user) return;
    const db = offlineDb();
    void rememberOfflineUser(db, user);
    void requestPersistentStorage().then((ok) => setMeta(db, 'persisted', ok));
    const stop = getSyncEngine(api).start();

    const maybeRefresh = async (force = false) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const last = await getMeta<string>(db, 'lastRosterAt');
      const owner = await getMeta<string>(db, 'rosterUserId');
      const stale = !last || Date.now() - Date.parse(last) > ROSTER_REFRESH_MS;
      if (force || owner !== userId || stale) await refreshRosterNow(api, userId, db);
    };
    void maybeRefresh(forceRoster.current);
    forceRoster.current = false;
    const interval = setInterval(() => void maybeRefresh(), ROSTER_REFRESH_MS);
    const onOnline = () => void maybeRefresh();
    window.addEventListener('online', onOnline);
    return () => {
      stop();
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
    };
    // `user` changes on every profile edit; the runtime only cares about who is signed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, userId]);

  return null;
}
