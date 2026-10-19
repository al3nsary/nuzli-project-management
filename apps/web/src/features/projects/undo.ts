/**
 * Undo / redo for the project screens (A9, ADR-095 — the client half is ADR-106).
 *
 * Every task write answers `previous`: the before-values of exactly the fields that changed, per
 * task. The inverse operation is the same batch endpoint with those values and the versions the
 * write itself produced — so if anybody changed one of those tasks in the meantime the server
 * answers 409 and the chain stops (the UI clears the redo stack and says why). Running an inverse
 * answers its own `previous`, which is the next redo. Creates/duplicates are undone by archiving
 * the new tasks; archives by restoring them and re-creating the links they took away.
 * Pure data + a tiny store; the API calls live in `useProjectWrites`.
 */
import { create } from 'zustand';
import type { DependencyDto, TaskDto, TaskPrevious, TaskPreviousMap } from '@nuzli/shared';

/** Fields the batch endpoint accepts; `type` is informational and `description` goes through PATCH. */
const BATCH_FIELDS = new Set([
  'parentId',
  'sortOrder',
  'name',
  'startDate',
  'endDate',
  'durationDays',
  'durationHours',
  'progress',
  'status',
  'priority',
  'assigneeId',
  'plannedCost',
  'actualCost',
  'deadline',
  'barColor',
  'labelIds',
]);

export type BatchChange = { id: string; version: number } & Record<string, unknown>;

export type UndoOp =
  | {
      kind: 'batch';
      changes: BatchChange[];
      /** Description edits (not part of the batch schema), applied with PATCH after the batch. */
      descriptions?: Array<{ id: string; description: string | null }>;
    }
  /** Archive the subtrees of these roots (undo of a create or duplicate, redo of an archive). */
  | { kind: 'archive'; ids: string[]; versions: Record<string, number> }
  /** Restore archived tasks and re-create the links the archive removed (undo of an archive). */
  | { kind: 'restore'; ids: string[]; dependencies: DependencyDto[] };

export interface UndoEntry {
  /** What the user did, for the button tooltip («تراجع: نقل مهمة»). */
  label: string;
  op: UndoOp;
}

/** The inverse of a write: `previous` sent back with the versions from the same answer. */
export function inverseOf(previous: TaskPreviousMap | undefined, tasks: readonly Pick<TaskDto, 'id' | 'version'>[]): UndoOp | null {
  if (!previous) return null;
  const versions = new Map(tasks.map((t) => [t.id, t.version]));
  const changes: BatchChange[] = [];
  const descriptions: Array<{ id: string; description: string | null }> = [];
  for (const [id, prev] of Object.entries(previous)) {
    const version = versions.get(id);
    if (version === undefined) continue;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prev as TaskPrevious & { durationHours?: number | null })) {
      if (k === 'description') descriptions.push({ id, description: (v as string | null) ?? null });
      else if (BATCH_FIELDS.has(k) && !(k === 'durationHours' && v === null)) fields[k] = v;
    }
    if (Object.keys(fields).length) changes.push({ id, version, ...fields });
    else if (descriptions.some((d) => d.id === id)) changes.push({ id, version });
  }
  if (!changes.length && !descriptions.length) return null;
  return descriptions.length ? { kind: 'batch', changes, descriptions } : { kind: 'batch', changes };
}

/** Roots of a set of tasks: ids whose parent is not in the set (archiving a root takes its subtree). */
export function rootsOf(tasks: readonly Pick<TaskDto, 'id' | 'parentId'>[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => !t.parentId || !ids.has(t.parentId)).map((t) => t.id);
}

/** The undo of a create / duplicate: archive the new roots at the versions they were created with. */
export function archiveOp(created: readonly Pick<TaskDto, 'id' | 'parentId' | 'version'>[]): UndoOp {
  const roots = rootsOf(created);
  const versions: Record<string, number> = {};
  for (const t of created) if (roots.includes(t.id)) versions[t.id] = t.version;
  return { kind: 'archive', ids: roots, versions };
}

// ---------------------------------------------------------------- the per-project stacks

const LIMIT = 50;

interface Stacks {
  undo: UndoEntry[];
  redo: UndoEntry[];
}

interface UndoState {
  byProject: Record<string, Stacks>;
  /** A new user action: pushed on undo, the redo stack is cleared. */
  record(projectId: string, entry: UndoEntry): void;
  /** Pops the last undo entry (the caller runs it and pushes the inverse with `pushRedo`). */
  popUndo(projectId: string): UndoEntry | undefined;
  popRedo(projectId: string): UndoEntry | undefined;
  pushUndo(projectId: string, entry: UndoEntry): void;
  pushRedo(projectId: string, entry: UndoEntry): void;
  /** A 409 (or any failure) ends the chain. */
  clearRedo(projectId: string): void;
  clear(projectId: string): void;
}

const empty: Stacks = { undo: [], redo: [] };
const cap = (list: UndoEntry[]) => (list.length > LIMIT ? list.slice(list.length - LIMIT) : list);

export const useUndoStore = create<UndoState>((set, get) => {
  const of = (id: string) => get().byProject[id] ?? empty;
  const put = (id: string, s: Stacks) => set((st) => ({ byProject: { ...st.byProject, [id]: s } }));
  return {
    byProject: {},
    record: (id, entry) => put(id, { undo: cap([...of(id).undo, entry]), redo: [] }),
    popUndo: (id) => {
      const s = of(id);
      const e = s.undo.at(-1);
      if (e) put(id, { ...s, undo: s.undo.slice(0, -1) });
      return e;
    },
    popRedo: (id) => {
      const s = of(id);
      const e = s.redo.at(-1);
      if (e) put(id, { ...s, redo: s.redo.slice(0, -1) });
      return e;
    },
    pushUndo: (id, entry) => put(id, { ...of(id), undo: cap([...of(id).undo, entry]) }),
    pushRedo: (id, entry) => put(id, { ...of(id), redo: cap([...of(id).redo, entry]) }),
    clearRedo: (id) => put(id, { ...of(id), redo: [] }),
    clear: (id) => put(id, { undo: [], redo: [] }),
  };
});
