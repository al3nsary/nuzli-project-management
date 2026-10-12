import { useQuery } from '@tanstack/react-query';
import type { ProjectListQuery } from '@nuzli/shared';
import { useApi } from './context';
import { useAuthStore } from '../stores/auth';

/** Phase 4 query keys. The Gantt payload is the single source for the three project views. */
export const qk4 = {
  projects: (q?: ProjectListQuery) => ['projects', q ?? {}] as const,
  project: (id: string) => ['project', id] as const,
  gantt: (id: string) => ['gantt', id] as const,
  access: (id: string) => ['project', id, 'access'] as const,
  myTasks: ['tasks', 'mine'] as const,
  calendars: ['calendars'] as const,
  comments: (id: string) => ['task', id, 'comments'] as const,
  activity: (id: string) => ['task', id, 'activity'] as const,
  attachments: (id: string) => ['task', id, 'attachments'] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export function useProjects(q: ProjectListQuery = {}, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.projects(q), queryFn: () => api.projects.list(q), enabled: useSignedIn() && enabled });
}

export function useGantt(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk4.gantt(id ?? ''),
    queryFn: () => api.projects.gantt(id as string),
    enabled: useSignedIn() && Boolean(id),
    // Edits merge the server's answer; avoid surprise refetches in the middle of a drag.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

export function useProjectAccess(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.access(id), queryFn: () => api.projects.access(id), enabled: useSignedIn() && enabled });
}

export function useMyTasks(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.myTasks, queryFn: () => api.tasks.mine(), enabled: useSignedIn() && enabled });
}

export function useCalendars(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.calendars, queryFn: () => api.calendars.list(), enabled: useSignedIn() && enabled });
}

export function useTaskComments(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: qk4.comments(id ?? ''), queryFn: () => api.tasks.comments(id as string), enabled: useSignedIn() && Boolean(id) });
}

export function useTaskActivity(id: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.activity(id ?? ''), queryFn: () => api.tasks.activity(id as string), enabled: useSignedIn() && Boolean(id) && enabled });
}

export function useTaskAttachments(id: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk4.attachments(id ?? ''), queryFn: () => api.tasks.attachments(id as string), enabled: useSignedIn() && Boolean(id) && enabled });
}

