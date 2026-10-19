/**
 * A9 read hooks (TanStack Query) and the per-user view preferences (`/me/view-prefs`, ADR-097).
 * Every screen of the A9 project experience reads through these; writes invalidate with
 * `invalidateProjectReads` so the budget, people, dashboard and calendar tabs stay in step with
 * the Gantt cache.
 */
import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { HubFilter, ViewPrefDto } from '@nuzli/shared';
import { useApi } from './context';
import { useAuthStore } from '../stores/auth';
import { qk4 } from './projectQueries';

export const qkA9 = {
  budget: (id: string) => ['project', id, 'budget'] as const,
  people: (id: string) => ['project', id, 'people'] as const,
  dashboard: (id: string) => ['project', id, 'dashboard'] as const,
  calendar: (id: string, from: string, to: string) => ['project', id, 'calendar', from, to] as const,
  templates: ['project-templates'] as const,
  report: (status?: string) => ['reports', 'projects', status ?? ''] as const,
  checklist: (taskId: string) => ['task', taskId, 'checklist'] as const,
  taskFields: (taskId: string) => ['task', taskId, 'fields'] as const,
  taskLabels: (taskId: string) => ['task', taskId, 'labels'] as const,
  taskTime: (taskId: string) => ['task', taskId, 'time'] as const,
  task: (taskId: string) => ['task', taskId, 'dto'] as const,
  myTime: (from: string, to: string) => ['time', 'mine', from, to] as const,
  viewPrefs: (projectId: string | null) => ['view-prefs', projectId ?? ''] as const,
  portfolios: ['portfolios'] as const,
  portfolio: (id: string) => ['portfolios', id] as const,
  workload: (from: string, to: string, userIds?: string) => ['workload', from, to, userIds ?? ''] as const,
  hub: (filter: HubFilter, projectId?: string, q?: string) => ['hub', filter, projectId ?? '', q ?? ''] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

/** After any task write: the read models of the project and the cross-project pages are stale. */
export function invalidateProjectReads(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: ['project', projectId] });
  void qc.invalidateQueries({ queryKey: ['projects'] });
  void qc.invalidateQueries({ queryKey: ['reports'] });
  void qc.invalidateQueries({ queryKey: ['workload'] });
  void qc.invalidateQueries({ queryKey: ['portfolios'] });
  void qc.invalidateQueries({ queryKey: qk4.myTasks });
}

export function useBudget(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.budget(id), queryFn: () => api.projects.budget(id), enabled: useSignedIn() && enabled && !!id });
}

export function useProjectPeople(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.people(id), queryFn: () => api.projects.people(id), enabled: useSignedIn() && enabled && !!id });
}

export function useProjectDashboard(id: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.dashboard(id), queryFn: () => api.projects.dashboard(id), enabled: useSignedIn() && enabled && !!id });
}

export function useProjectCalendar(id: string, from: string, to: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qkA9.calendar(id, from, to),
    queryFn: () => api.projects.calendar(id, { from, to }),
    enabled: useSignedIn() && enabled && !!id,
    placeholderData: (prev) => prev,
  });
}

export function useTemplates(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.templates, queryFn: () => api.projects.templates(), enabled: useSignedIn() && enabled });
}

export function useProjectsReport(status?: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED' | 'ALL', enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.report(status), queryFn: () => api.projects.report(status ? { status } : {}), enabled: useSignedIn() && enabled });
}

export function useTask(taskId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.task(taskId ?? ''), queryFn: () => api.tasks.get(taskId as string), enabled: useSignedIn() && enabled && !!taskId });
}

export function useChecklist(taskId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.checklist(taskId ?? ''), queryFn: () => api.tasks.checklist(taskId as string), enabled: useSignedIn() && enabled && !!taskId });
}

export function useTaskFields(taskId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.taskFields(taskId ?? ''), queryFn: () => api.tasks.customFields(taskId as string), enabled: useSignedIn() && enabled && !!taskId });
}

export function useTaskLabels(taskId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.taskLabels(taskId ?? ''), queryFn: () => api.tasks.labels(taskId as string), enabled: useSignedIn() && enabled && !!taskId });
}

export function useTaskTime(taskId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.taskTime(taskId ?? ''), queryFn: () => api.tasks.timeEntries(taskId as string), enabled: useSignedIn() && enabled && !!taskId });
}

export function useMyTime(from: string, to: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.myTime(from, to), queryFn: () => api.timeEntries.mine({ from, to }), enabled: useSignedIn() && enabled, placeholderData: (p) => p });
}

export function usePortfolios(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.portfolios, queryFn: () => api.portfolios.list(), enabled: useSignedIn() && enabled });
}

export function usePortfolio(id: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.portfolio(id ?? ''), queryFn: () => api.portfolios.get(id as string), enabled: useSignedIn() && enabled && !!id });
}

export function useWorkload(from: string, to: string, userIds?: string[], enabled = true) {
  const api = useApi();
  const key = userIds?.length ? [...userIds].sort().join(',') : undefined;
  return useQuery({
    queryKey: qkA9.workload(from, to, key),
    queryFn: () => api.workload({ from, to, userIds }),
    enabled: useSignedIn() && enabled,
    placeholderData: (p) => p,
  });
}

export function useHub(filter: HubFilter, projectId?: string, q?: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qkA9.hub(filter, projectId, q), queryFn: () => api.hub.list({ filter, projectId, q }), enabled: useSignedIn() && enabled });
}

// ---------------------------------------------------------------- view preferences (ADR-097)

/** All preferences of the signed-in user for a project (or the global ones with `null`). */
export function useViewPrefs(projectId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qkA9.viewPrefs(projectId),
    queryFn: () => api.viewPrefs.list(projectId ? { projectId } : {}),
    enabled: useSignedIn() && enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * One preference as `[value, set, loading]`. `set` updates the cache at once (the screen reacts
 * immediately) and saves to `/me/view-prefs`; a failed save is reverted by refetching.
 */
export function useViewPref<T>(key: string, projectId: string | null, fallback: T, enabled = true): [T, (v: T) => void, boolean] {
  const api = useApi();
  const qc = useQueryClient();
  const prefs = useViewPrefs(projectId, enabled);
  const qkey = qkA9.viewPrefs(projectId);
  const mutation = useMutation({
    mutationFn: (value: T) => api.viewPrefs.put({ projectId: projectId ?? undefined, key, value }),
    onError: () => void qc.invalidateQueries({ queryKey: qkey }),
  });
  const value = useMemo(() => {
    const hit = prefs.data?.find((p) => p.key === key);
    return hit ? (hit.value as T) : fallback;
    // `fallback` is a literal at call sites; the stored value is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.data, key]);
  const set = useCallback(
    (v: T) => {
      qc.setQueryData<ViewPrefDto[]>(qkey, (cur = []) => {
        const next = cur.filter((p) => p.key !== key);
        next.push({ projectId, key, value: v, updatedAt: new Date().toISOString() });
        return next;
      });
      mutation.mutate(v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, key, projectId],
  );
  return [value, set, prefs.isLoading];
}
