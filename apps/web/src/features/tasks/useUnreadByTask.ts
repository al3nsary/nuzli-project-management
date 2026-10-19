import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { useAuthStore } from '../../stores/auth';

/**
 * Unread comment counts per task id from the communication hub (`GET /hub?filter=all`). The key
 * starts with `'hub'`, so marking a thread read (which invalidates `['hub']`) refreshes the
 * badges. 100 is the largest page the API allows — far more than a supervisor's discussed tasks.
 */
export function useUnreadByTask(enabled = true): Map<string, number> {
  const api = useApi();
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const hub = useQuery({
    queryKey: ['hub', 'all', '', '', 'unread-map'],
    queryFn: () => api.hub.list({ filter: 'all', pageSize: 100 }),
    enabled: signedIn && enabled,
    refetchInterval: 60_000,
  });
  return useMemo(() => new Map((hub.data?.items ?? []).map((i) => [i.task.id, i.unreadCount])), [hub.data]);
}
