import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GanttDto, TaskDto } from '@nuzli/shared';
import { useApi } from './context';
import { ApiError } from './errors';
import { qk4 } from './projectQueries';
import { mergeTasks, runOptimisticBatch } from '../features/gantt/batch';

/**
 * Writes on one project: the optimistic drag batch (ADR-017), single-task updates and other
 * writes whose answers (`affected`) are merged into the Gantt cache without a refetch.
 */
export function useProjectWrites(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const key = qk4.gantt(projectId);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const get = useCallback(() => qc.getQueryData<GanttDto>(key), [qc, key]);
  const set = useCallback((g: GanttDto) => qc.setQueryData(key, g), [qc, key]);

  /** Merges tasks returned by any write and refreshes the lists that depend on them. */
  const merge = useCallback(
    (tasks: TaskDto[]) => {
      const cur = get();
      if (cur) set(mergeTasks(cur, tasks));
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: qk4.myTasks });
    },
    [get, set, qc],
  );

  /** Re-reads the chart (structure changed, or after a conflict). */
  const refresh = useCallback(async () => {
    setConflict(false);
    await qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  }, [qc, key]);

  const commitBatch = useCallback(
    async (changes: TaskDto[]): Promise<{ ok: boolean; error?: unknown }> => {
      setSaving(true);
      try {
        const out = await runOptimisticBatch({ get, set, send: (body) => api.tasks.batch(projectId, body), changes });
        if (!out.ok && out.conflict) setConflict(true);
        if (out.ok) {
          void qc.invalidateQueries({ queryKey: ['projects'] });
          void qc.invalidateQueries({ queryKey: qk4.myTasks });
          return { ok: true };
        }
        return { ok: false, error: out.error };
      } finally {
        setSaving(false);
      }
    },
    [api, projectId, get, set, qc],
  );

  /** Wraps a write: a CONFLICT_VERSION answer turns on the refresh prompt. */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSaving(true);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_VERSION') setConflict(true);
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, conflict, setConflict, commitBatch, merge, refresh, run };
}
