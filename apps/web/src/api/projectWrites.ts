import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { DependencyDto, GanttDto, TaskBulkResult, TaskDto, TaskPreviousMap } from '@nuzli/shared';
import type { z } from 'zod';
import type { createTaskSchemaH, updateTaskSchemaH } from './hoursWire';
import type { taskBulkSchema } from '@nuzli/shared';
import { useApi } from './context';
import { ApiError, errorMessage } from './errors';
import { qk4 } from './projectQueries';
import { invalidateProjectReads } from './a9Queries';
import { mergeTasks, runOptimisticBatch } from '../features/gantt/batch';
import { archiveOp, inverseOf, rootsOf, useUndoStore, type UndoEntry, type UndoOp } from '../features/projects/undo';
import { t } from '../i18n';

type BulkPatch = z.input<typeof taskBulkSchema>['patch'];

/**
 * Writes on one project: the optimistic drag batch (ADR-017), single-task updates and the A9
 * writes (duplicate, bulk, archive) whose answers are merged into the Gantt cache. Every write
 * records its inverse for undo/redo (ADR-095 / ADR-106): Ctrl+Z / Ctrl+Y run them through the same
 * endpoints; a 409 ends the redo chain with a message.
 */
export function useProjectWrites(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const key = qk4.gantt(projectId);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const store = useUndoStore();
  const stacks = useUndoStore((s) => s.byProject[projectId]);

  const get = useCallback(() => qc.getQueryData<GanttDto>(key), [qc, key]);
  const set = useCallback((g: GanttDto) => qc.setQueryData(key, g), [qc, key]);

  /** Merges tasks returned by any write and refreshes the lists that depend on them. */
  const merge = useCallback(
    (tasks: TaskDto[]) => {
      const cur = get();
      if (cur) set(mergeTasks(cur, tasks));
      invalidateProjectReads(qc, projectId);
    },
    [get, set, qc, projectId],
  );

  /** Re-reads the chart (structure changed, or after a conflict). */
  const refresh = useCallback(async () => {
    setConflict(false);
    await qc.invalidateQueries({ queryKey: key });
    invalidateProjectReads(qc, projectId);
  }, [qc, key, projectId]);

  const record = useCallback(
    (label: string, op: UndoOp | null) => {
      if (op) store.record(projectId, { label, op });
    },
    [store, projectId],
  );

  const commitBatch = useCallback(
    async (changes: TaskDto[], label = t('undo.label.move')): Promise<{ ok: boolean; error?: unknown }> => {
      setSaving(true);
      try {
        const out = await runOptimisticBatch({ get, set, send: (body) => api.tasks.batch(projectId, body), changes });
        if (!out.ok && out.conflict) setConflict(true);
        if (out.ok) {
          if (out.result) record(label, inverseOf(out.result.previous, out.result.tasks));
          invalidateProjectReads(qc, projectId);
          return { ok: true };
        }
        return { ok: false, error: out.error };
      } finally {
        setSaving(false);
      }
    },
    [api, projectId, get, set, qc, record],
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

  // ---------------------------------------------------------------- A9 writes with undo

  const updateTask = useCallback(
    async (id: string, patch: z.input<typeof updateTaskSchemaH>, label = t('undo.label.edit')) => {
      const res = await run(() => api.tasks.update(id, patch));
      merge([res.task, ...res.affected]);
      record(label, inverseOf(res.previous, [res.task, ...res.affected]));
      return res;
    },
    [api, run, merge, record],
  );

  const createTask = useCallback(
    async (input: z.input<typeof createTaskSchemaH>, label = t('undo.label.create')) => {
      const res = await run(() => api.tasks.create(projectId, input));
      await refresh();
      record(label, archiveOp([res]));
      return res;
    },
    [api, projectId, run, refresh, record],
  );

  const duplicate = useCallback(
    async (id: string, withSubtasks = true) => {
      const res = await run(() => api.tasks.duplicate(id, { withSubtasks }));
      await refresh();
      record(t('undo.label.duplicate'), archiveOp(res.tasks));
      return res;
    },
    [api, run, refresh, record],
  );

  const bulk = useCallback(
    async (ids: string[], patch: BulkPatch, label = t('undo.label.bulk')): Promise<TaskBulkResult> => {
      const g = get();
      const versions = Object.fromEntries(ids.map((id) => [id, g?.tasks.find((x) => x.id === id)?.version ?? 0]));
      const res = await run(() => api.tasks.bulk(projectId, { ids, versions, patch }));
      merge(res.tasks);
      record(label, inverseOf(res.previous, res.tasks));
      return res;
    },
    [api, projectId, get, run, merge, record],
  );

  const archive = useCallback(
    async (ids: string[]) => {
      const g = get();
      const tasks = (g?.tasks ?? []).filter((x) => ids.includes(x.id));
      const roots = rootsOf(tasks);
      const versions = Object.fromEntries(roots.map((id) => [id, tasks.find((x) => x.id === id)!.version]));
      const res = await run(() => api.tasks.bulkArchive(projectId, { ids: roots, versions }));
      await refresh();
      record(t('undo.label.archive'), { kind: 'restore', ids: res.archivedIds, dependencies: res.deletedDependencies });
      return res;
    },
    [api, projectId, get, run, refresh, record],
  );

  /** Runs an inverse operation and answers the operation that reverses it again. */
  const runOp = useCallback(
    async (op: UndoOp): Promise<UndoOp | null> => {
      if (op.kind === 'batch') {
        let tasks: TaskDto[] = [];
        let previous: TaskPreviousMap = {};
        if (op.changes.length) {
          const res = await api.tasks.batch(projectId, { changes: op.changes as never });
          tasks = res.tasks;
          previous = res.previous ?? {};
        }
        for (const d of op.descriptions ?? []) {
          const cur = tasks.find((x) => x.id === d.id) ?? get()?.tasks.find((x) => x.id === d.id);
          if (!cur) continue;
          const res = await api.tasks.update(d.id, { version: cur.version, description: d.description ?? '' });
          tasks = [...tasks.filter((x) => x.id !== d.id), res.task, ...res.affected];
          previous = { ...previous, [d.id]: { ...(previous[d.id] ?? {}), ...(res.previous?.[d.id] ?? {}) } };
        }
        merge(tasks);
        return inverseOf(previous, tasks);
      }
      if (op.kind === 'archive') {
        const res = await api.tasks.bulkArchive(projectId, { ids: op.ids, versions: op.versions });
        await refresh();
        return { kind: 'restore', ids: res.archivedIds, dependencies: res.deletedDependencies };
      }
      const res = await api.tasks.restore(projectId, op.ids);
      const latest = new Map([...res.restored, ...res.affected].map((x) => [x.id, x]));
      for (const d of op.dependencies) {
        const dep = await api.dependencies.create(projectId, { predecessorId: d.predecessorId, successorId: d.successorId, type: 'FS', lagDays: d.lagDays });
        for (const x of dep.affected) latest.set(x.id, x);
      }
      await refresh();
      const restored = res.restored.map((x) => latest.get(x.id) ?? x);
      return archiveOp(restored);
    },
    [api, projectId, get, merge, refresh],
  );

  const step = useCallback(
    async (direction: 'undo' | 'redo') => {
      const entry: UndoEntry | undefined = direction === 'undo' ? store.popUndo(projectId) : store.popRedo(projectId);
      if (!entry) return;
      setSaving(true);
      try {
        const reverse = await runOp(entry.op);
        if (reverse) {
          const next = { label: entry.label, op: reverse };
          if (direction === 'undo') store.pushRedo(projectId, next);
          else store.pushUndo(projectId, next);
        }
        notifications.show({ color: 'ok', message: t(direction === 'undo' ? 'undo.done' : 'undo.redone', { label: entry.label }) });
      } catch (err) {
        // ADR-095: a 409 (somebody changed these tasks meanwhile) ends the redo chain.
        store.clearRedo(projectId);
        const stale = err instanceof ApiError && err.code === 'CONFLICT_VERSION';
        notifications.show({ color: 'breach', message: stale ? t('undo.conflict') : errorMessage(err) });
        if (stale) await refresh();
      } finally {
        setSaving(false);
      }
    },
    [store, projectId, runOp, refresh],
  );

  return {
    saving,
    conflict,
    setConflict,
    commitBatch,
    merge,
    refresh,
    run,
    record,
    updateTask,
    createTask,
    duplicate,
    bulk,
    archive,
    undo: () => step('undo'),
    redo: () => step('redo'),
    canUndo: Boolean(stacks?.undo.length),
    canRedo: Boolean(stacks?.redo.length),
    undoLabel: stacks?.undo.at(-1)?.label ?? null,
    redoLabel: stacks?.redo.at(-1)?.label ?? null,
  };
}

export type ProjectWrites = ReturnType<typeof useProjectWrites>;
export type { DependencyDto };
