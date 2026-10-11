import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './context';
import { useAuthStore } from '../stores/auth';
import type { AuditQuery, NotificationQuery, PageQuery, UserListQuery } from './client';

/** Query keys in one place so mutations invalidate the right lists. */
export const qk = {
  users: (q?: UserListQuery) => ['users', q ?? {}] as const,
  user: (id: string) => ['user', id] as const,
  registrations: (q?: PageQuery) => ['registrations', q ?? {}] as const,
  audit: (q?: AuditQuery) => ['audit', q ?? {}] as const,
  notifications: (q?: NotificationQuery) => ['notifications', q ?? {}] as const,
  unread: ['notifications', 'unread-count'] as const,
  settings: ['settings'] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export function useUsers(q: UserListQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.users(q),
    queryFn: () => api.users.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useUser(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk.user(id ?? ''),
    queryFn: () => api.users.get(id as string),
    enabled: useSignedIn() && Boolean(id),
    staleTime: 0,
  });
}

export function useRegistrations(q: PageQuery = {}, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.registrations(q),
    queryFn: () => api.registrations.list(q),
    enabled: useSignedIn() && enabled,
  });
}

export function useAudit(q: AuditQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.audit(q),
    queryFn: () => api.audit.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useNotifications(q: NotificationQuery) {
  const api = useApi();
  return useQuery({
    queryKey: qk.notifications(q),
    queryFn: () => api.notifications.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn(),
  });
}

export function useUnreadCount() {
  const api = useApi();
  return useQuery({
    queryKey: qk.unread,
    queryFn: () => api.notifications.unreadCount(),
    enabled: useSignedIn(),
    refetchInterval: 60_000,
  });
}

export function useSettings() {
  const api = useApi();
  return useQuery({
    queryKey: qk.settings,
    queryFn: () => api.settings.get(),
    enabled: useSignedIn(),
  });
}

/** After any user/registration change: lists, counts, audit and notifications may all move. */
export function useInvalidateAccounts() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['users'] }),
      qc.invalidateQueries({ queryKey: ['user'] }),
      qc.invalidateQueries({ queryKey: ['registrations'] }),
      qc.invalidateQueries({ queryKey: ['audit'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
}
