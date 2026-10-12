import { useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type { PhotoUrlDto } from '@nuzli/shared';
import { useApi } from './context';
import { ApiError } from './errors';
import type { PhotoTarget } from './client';
import { useAuthStore } from '../stores/auth';
import { useOnline } from '../lib/useOnline';

/**
 * Signed photo URLs (owner request A8, ADR-090). They live in the in-memory query cache only —
 * never localStorage, IndexedDB or the offline roster — and go stale a minute before they
 * expire, so a remount or focus fetches a fresh one. The key carries `photoFileId`, so a new
 * photo is a new key (cache-bust) even before the lists are refetched.
 */
export const photoKey = (target: PhotoTarget, fileId?: string | null) =>
  ['photo', target.kind, target.id, fileId ?? null] as const;

/** Re-fetch this long before `expiresAt`. */
export const PHOTO_URL_MARGIN_MS = 60_000;
const NO_PHOTO_STALE_MS = 5 * 60_000;

export function photoStaleTime(data: PhotoUrlDto | null | undefined, now = Date.now()): number {
  if (!data) return NO_PHOTO_STALE_MS;
  return Math.max(0, Date.parse(data.expiresAt) - now - PHOTO_URL_MARGIN_MS);
}

/**
 * The photo URL of a user or member, or null (no photo, out of scope, offline). `hasPhoto`
 * false skips the request; undefined (unknown, e.g. a team's supervisor) asks once and takes
 * 404 as "no photo".
 */
export function usePhotoUrl(
  target: PhotoTarget | null,
  opts: { fileId?: string | null; hasPhoto?: boolean; enabled?: boolean } = {},
): string | null {
  const api = useApi();
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const online = useOnline();
  const enabled =
    signedIn && online && Boolean(target) && opts.hasPhoto !== false && (opts.enabled ?? true);
  const q = useQuery({
    queryKey: target ? photoKey(target, opts.fileId) : ['photo', 'none'],
    queryFn: async (): Promise<PhotoUrlDto | null> => {
      try {
        return await api.photos.url(target!);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
        throw err;
      }
    },
    enabled,
    staleTime: (query: Query<PhotoUrlDto | null, Error, PhotoUrlDto | null, readonly unknown[]>) =>
      photoStaleTime(query.state.data),
    gcTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  if (!enabled) return null;
  const data = q.data;
  if (!data || Date.parse(data.expiresAt) <= Date.now()) return null;
  return data.url;
}

/**
 * After an upload, replace or remove: drop every cached photo URL and the lists that carry
 * `hasPhoto`/`photoFileId`, and refresh the signed-in user when it is their own photo.
 */
export function useInvalidatePhotos() {
  const qc = useQueryClient();
  const api = useApi();
  const setUser = useAuthStore((s) => s.setUser);
  return async (target?: PhotoTarget) => {
    const me = useAuthStore.getState().user;
    if (target && (target.kind === 'me' || target.id === me?.id)) {
      try {
        setUser(await api.auth.me());
      } catch {
        // The lists below still refresh; the top bar catches up on the next session refresh.
      }
    }
    await Promise.all(
      ['photo', 'users', 'user', 'members', 'member', 'teams', 'team'].map((key) =>
        qc.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
}
