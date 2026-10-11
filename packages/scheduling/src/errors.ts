/**
 * Thrown when dependencies (or a dependency between a task and its own
 * ancestor) form a cycle. `path` lists task ids and is closed: its first and
 * last entries are the same task (`['a', 'b', 'a']`).
 *
 * The message is technical; the API/UI map `code` to the Arabic text shown to users.
 */
export class CycleError extends Error {
  readonly code = 'DEPENDENCY_CYCLE' as const;
  readonly path: string[];

  constructor(path: string[]) {
    super(`Dependency cycle: ${path.join(' -> ')}`);
    this.name = 'CycleError';
    this.path = path;
  }
}

/** Thrown when `parentId` links form a loop, so some tasks never reach a root. */
export class HierarchyError extends Error {
  readonly code = 'HIERARCHY_CYCLE' as const;
  readonly taskIds: string[];

  constructor(taskIds: string[]) {
    super(`Task hierarchy loop involving: ${taskIds.slice(0, 10).join(', ')}`);
    this.name = 'HierarchyError';
    this.taskIds = taskIds;
  }
}

/** Thrown by `moveTask` / `resizeTask` for an unknown id or an impossible edit. */
export class TaskEditError extends Error {
  readonly code: 'TASK_NOT_FOUND' | 'NOT_RESIZABLE';

  constructor(code: 'TASK_NOT_FOUND' | 'NOT_RESIZABLE', message: string) {
    super(message);
    this.name = 'TaskEditError';
    this.code = code;
  }
}
