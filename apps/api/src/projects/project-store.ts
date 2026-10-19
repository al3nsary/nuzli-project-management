import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WorkCalendar } from '@nuzli/scheduling';
import type { DependencyType, PermissionSubject, TaskDto, TaskPrevious, TaskPreviousMap, TaskVersionConflictDetails } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  PROJECT_SELECT,
  STORED_TASK_SELECT,
  TASK_DTO_SELECT,
  projectScopeWhere,
  taskScopeWhere,
  toStored,
  toTaskDto,
  type ProjectRow,
  type ProjectStats,
  type TaskExtras,
} from './project-dto';
import {
  dateOf,
  diffTasks,
  dueDayOf,
  endDayOfLocal,
  hoursToMinutes,
  instantOf,
  isLocalDateTime,
  isoOf,
  minutesToHours,
  normalizeLeaf,
  pick,
  recompute,
  riyadhToday,
  workCalendarOf,
  type StoredTask,
  type Unit,
  type VersionedField,
} from './task-engine';
import { dependenciesToDays, dependenciesToHours, tasksToDays, tasksToHours } from '@nuzli/scheduling';

type Viewer = PermissionSubject & { id: string };

/** Interactive transactions that may rewrite a 2,000-task project need more than Prisma's 5 s. */
export const WRITE_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export interface StateDependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  /** A9 hours: stored lag in working minutes (HOUR projects schedule with it). */
  lagMinutes: number;
  /** Set for HOUR projects only (= lagMinutes / 60), so the engine reads hours there. */
  lagHours?: number;
}

/** A project loaded for a write, under a row lock on the project. */
export interface WriteState {
  project: { id: string; name: string; autoSchedule: boolean; calendarId: string; durationUnit: Unit };
  cal: WorkCalendar;
  /** Non-archived tasks as loaded (never mutated). */
  before: Map<string, StoredTask>;
  tasks: StoredTask[];
  deps: StateDependency[];
}

export interface PersistOptions {
  ctx: RequestContext;
  /** A task to insert (built with a server-generated id before recomputing). */
  inserted?: StoredTask;
  /** A9: several tasks to insert (duplicate, templates), parents before children. */
  insertedMany?: StoredTask[];
  /** Tasks the user edited: audited with `explicitAction`; others that moved get `task.moved` + `auto: true`. */
  explicit: ReadonlySet<string>;
  explicitAction: string;
  /** Extra fields for every audit entry of this write (e.g. `{ cause: 'calendar' }`). */
  auditExtra?: Record<string, unknown>;
}

/**
 * Data access shared by the Phase 4 services: scoped reads, DTO assembly, and the one write
 * path for tasks — lock the project, load it, (caller edits + recomputes), persist the diff
 * with optimistic versions, audit. Every task write in the API goes through `persist`.
 */
@Injectable()
export class ProjectStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────── reads

  /** The project if the viewer may see it, else 404 (its existence is not revealed). */
  async visibleProject(id: string, viewer: Viewer, db: Db = this.prisma): Promise<ProjectRow> {
    const p = await db.project.findFirst({ where: { AND: [{ id }, projectScopeWhere(viewer)] }, select: PROJECT_SELECT });
    if (!p) throw new AppError('NOT_FOUND');
    return p;
  }

  /**
   * A task (not archived) the viewer may see, else 404 (A9, ADR-092): admins any task;
   * supervisors only a task assigned to them in a live project.
   */
  async visibleTask(id: string, viewer: Viewer, db: Db = this.prisma) {
    const t = await db.task.findFirst({
      where: { AND: [{ id, archivedAt: null }, taskScopeWhere(viewer)] },
      select: {
        id: true,
        projectId: true,
        parentId: true,
        assigneeId: true,
        createdById: true,
        name: true,
        project: { select: { name: true, archivedAt: true, isTemplate: true } },
      },
    });
    if (!t) throw new AppError('NOT_FOUND');
    return t;
  }

  async projectStats(projectIds: string[], db: Db = this.prisma): Promise<Map<string, ProjectStats>> {
    const out = new Map<string, ProjectStats>(projectIds.map((id) => [id, { roots: [], endDate: null, taskCount: 0 }]));
    if (!projectIds.length) return out;
    const [roots, agg] = await Promise.all([
      db.task.findMany({
        where: { projectId: { in: projectIds }, parentId: null, archivedAt: null },
        select: { id: true, projectId: true, type: true, durationDays: true, durationMinutes: true, progress: true, plannedCost: true, actualCost: true },
      }),
      db.task.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds }, archivedAt: null },
        _count: { _all: true },
        _max: { endDate: true },
      }),
    ]);
    // Calculations audit H2: a root GROUP without live children weighs 0 in the project progress.
    const groupIds = roots.filter((r) => r.type === 'GROUP').map((r) => r.id);
    const filled = new Set<string>();
    if (groupIds.length) {
      const kids = await db.task.groupBy({ by: ['parentId'], where: { parentId: { in: groupIds }, archivedAt: null }, _count: { _all: true } });
      for (const k of kids) if (k.parentId) filled.add(k.parentId);
    }
    for (const r of roots) {
      out.get(r.projectId)?.roots.push({
        type: r.type,
        durationDays: r.durationDays,
        ...(r.durationMinutes != null ? { durationHours: minutesToHours(r.durationMinutes) } : {}),
        progress: Number(r.progress),
        plannedCost: Number(r.plannedCost),
        actualCost: Number(r.actualCost),
        isEmptyGroup: r.type === 'GROUP' && !filled.has(r.id),
      });
    }
    for (const a of agg) {
      const s = out.get(a.projectId);
      if (!s) continue;
      s.taskCount = a._count._all;
      s.endDate = a._max.endDate ? isoOf(a._max.endDate) : null;
    }
    return out;
  }

  /**
   * A10: comments of each task the viewer has not read — not their own and newer than their
   * `task_comment_reads` mark — in ONE grouped query over the project (or the given tasks).
   * Tasks without unread comments are absent from the map.
   */
  async unreadCounts(viewerId: string, scope: { projectId: string } | { taskIds: string[] }, db: Db = this.prisma): Promise<Map<string, number>> {
    if ('taskIds' in scope && !scope.taskIds.length) return new Map();
    const rows = await db.$queryRaw<Array<{ taskId: string; unread: number }>>(unreadCountsSql(viewerId, scope));
    return new Map((rows ?? []).map((r) => [r.taskId, Number(r.unread)]));
  }

  /** READY, non-deleted attachments per task id. */
  async attachmentCounts(taskIds: string[], db: Db = this.prisma): Promise<Map<string, number>> {
    if (!taskIds.length) return new Map();
    const rows = await db.file.groupBy({
      by: ['entityId'],
      where: { entityType: 'task', entityId: { in: taskIds }, status: 'READY', deletedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.entityId).map((r) => [r.entityId as string, r._count._all]));
  }

  /** A9: checklist counts and custom values per task id. */
  async taskExtras(taskIds: string[], db: Db = this.prisma, now: Date = new Date()): Promise<TaskExtras> {
    const today = riyadhToday(now);
    if (!taskIds.length) return { checklist: new Map(), customValues: new Map(), today };
    const [items, values] = await Promise.all([
      db.taskChecklistItem.groupBy({ by: ['taskId', 'done'], where: { taskId: { in: taskIds } }, _count: { _all: true } }),
      db.taskCustomValue.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, fieldId: true, value: true } }),
    ]);
    const checklist = new Map<string, { total: number; done: number }>();
    for (const g of items) {
      const c = checklist.get(g.taskId) ?? { total: 0, done: 0 };
      c.total += g._count._all;
      if (g.done) c.done += g._count._all;
      checklist.set(g.taskId, c);
    }
    const customValues = new Map<string, Record<string, unknown>>();
    for (const v of values) {
      const m = customValues.get(v.taskId) ?? {};
      m[v.fieldId] = v.value;
      customValues.set(v.taskId, m);
    }
    return { checklist, customValues, today };
  }

  /** TaskDtos in the order of `ids` (WBS from the refreshed cache). */
  async taskDtos(ids: string[], db: Db = this.prisma): Promise<TaskDto[]> {
    if (!ids.length) return [];
    const [rows, counts, extras] = await Promise.all([
      db.task.findMany({ where: { id: { in: ids } }, select: TASK_DTO_SELECT }),
      this.attachmentCounts(ids, db),
      this.taskExtras(ids, db),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [toTaskDto(r, counts, undefined, extras)] : [];
    });
  }

  // ─────────────────────────────────────────── writes

  /** Locks the project row (serialises writers of one project) and loads its schedule. */
  async lockAndLoad(tx: Db, projectId: string): Promise<WriteState> {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        autoSchedule: true,
        calendarId: true,
        durationUnit: true,
        calendar: {
          select: { weekendDays: true, workingHours: true, exceptions: { select: { date: true, isWorking: true, workingHours: true } } },
        },
      },
    });
    if (!project) throw new AppError('NOT_FOUND');
    if (project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    const [rows, deps] = await Promise.all([
      tx.task.findMany({ where: { projectId, archivedAt: null }, select: STORED_TASK_SELECT }),
      tx.taskDependency.findMany({
        where: { projectId },
        select: { id: true, predecessorId: true, successorId: true, type: true, lagDays: true, lagMinutes: true },
      }),
    ]);
    const unit: Unit = project.durationUnit ?? 'DAY';
    const tasks = rows.map(toStored);
    return {
      project: { id: project.id, name: project.name, autoSchedule: project.autoSchedule, calendarId: project.calendarId, durationUnit: unit },
      cal: workCalendarOf(project.calendar),
      before: new Map(tasks.map((t) => [t.id, t])),
      tasks,
      deps: deps.map((d) => {
        const lagMinutes = d.lagMinutes ?? 0;
        return unit === 'HOUR' ? { ...d, lagMinutes, lagHours: minutesToHours(lagMinutes) } : { ...d, lagMinutes };
      }),
    };
  }

  /**
   * ADR-017: every expected version must match the loaded row, else `409 CONFLICT_VERSION`
   * listing each conflicting id with its current version (null = archived or not in this
   * project). Called before anything is written, so a conflict writes nothing.
   */
  checkVersions(state: WriteState, expected: ReadonlyArray<{ id: string; version: number }>): void {
    const conflicts: TaskVersionConflictDetails['conflicts'] = [];
    for (const e of expected) {
      const cur = state.before.get(e.id);
      if (!cur || cur.version !== e.version) conflicts.push({ id: e.id, currentVersion: cur?.version ?? null });
    }
    if (conflicts.length) throw versionConflict(conflicts);
  }

  /**
   * Writes the recomputed list: inserts the new task, updates every really changed task with
   * `version + 1` guarded by its loaded version (`WHERE id AND version`), refreshes WBS-only
   * changes without a version bump, resets the due/overdue flags when the end date moved, and
   * audits each changed task. Returns the ids to send back (new + changed + renumbered).
   */
  async persist(tx: Db, state: WriteState, finals: StoredTask[], opts: PersistOptions): Promise<string[]> {
    return (await this.persistDetailed(tx, state, finals, opts)).ids;
  }

  /**
   * `persist` plus the A9 undo contract (ADR-095): `previous` holds, per changed existing task,
   * the before-values of exactly the fields that changed (wire format), so the client can send
   * them back through the batch endpoint as the inverse operation.
   */
  async persistDetailed(
    tx: Db,
    state: WriteState,
    finals: StoredTask[],
    opts: PersistOptions,
  ): Promise<{ ids: string[]; previous: TaskPreviousMap }> {
    const diff = diffTasks(state.before, finals);
    const audits: Array<{ action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }> = [];
    const ids: string[] = [];
    const previous: TaskPreviousMap = {};

    const inserts = [...(opts.inserted ? [opts.inserted] : []), ...(opts.insertedMany ?? [])];
    const finalById = new Map(finals.map((f) => [f.id, f]));
    for (const draft of inserts) {
      const t = finalById.get(draft.id) ?? draft;
      await tx.task.create({
        data: {
          id: t.id,
          projectId: t.projectId,
          parentId: t.parentId,
          sortOrder: t.sortOrder,
          wbsCache: t.wbsCache,
          name: t.name,
          type: t.type,
          ...timeColumns(t),
          durationDays: t.durationDays,
          progress: t.progress,
          status: t.status,
          priority: t.priority,
          assigneeId: t.assigneeId,
          description: t.description,
          plannedCost: t.plannedCost,
          actualCost: t.actualCost,
          deadline: t.deadline ? dateOf(t.deadline) : null,
          barColor: t.barColor,
          createdById: opts.ctx.actorId,
        },
      });
      if (t.labelIds.length) {
        await tx.taskLabel.createMany({ data: t.labelIds.map((labelId) => ({ taskId: t.id, labelId })), skipDuplicates: true });
      }
      ids.push(t.id);
      audits.push({
        action: AuditAction.TASK_CREATED,
        entityType: 'task',
        entityId: t.id,
        after: {
          ...pick(t, ['name', 'type', 'parentId', 'startDate', 'endDate', 'durationDays', 'assigneeId']),
          ...(t.plannedCost ? { plannedCost: t.plannedCost } : {}),
          wbs: t.wbsCache,
          ...opts.auditExtra,
        },
      });
    }

    for (const { before, after, fields } of diff.versioned) {
      const data: Prisma.TaskUncheckedUpdateManyInput = {
        version: { increment: 1 },
        wbsCache: after.wbsCache,
      };
      for (const f of fields) assignField(data, f, after);
      if (fields.includes('startDate') || fields.includes('endDate') || fields.includes('durationHours')) Object.assign(data, timeColumns(after));
      // Calculations audit L10: reminders are daily, so they are re-armed only when the DUE DAY
      // moves (an HOUR edit that changes only the time within the same day sends nothing again).
      if (fields.includes('endDate') && dueDayOf(before) !== dueDayOf(after)) {
        data.dueSoonNotifiedAt = null;
        data.overdueNotifiedAt = null;
      }
      if (fields.includes('deadline')) data.deadlineNotifiedAt = null;
      const res = await tx.task.updateMany({ where: { id: after.id, version: before.version }, data });
      if (res.count !== 1) throw versionConflict([{ id: after.id, currentVersion: null }]);
      if (fields.includes('labelIds')) await this.writeLabels(tx, after.id, before.labelIds, after.labelIds);
      previous[after.id] = previousOf(before, fields);
      ids.push(after.id);
      const isExplicit = opts.explicit.has(after.id);
      audits.push({
        action: isExplicit ? opts.explicitAction : AuditAction.TASK_MOVED,
        entityType: 'task',
        entityId: after.id,
        before: pick(before, fields),
        after: { ...pick(after, fields), ...(isExplicit ? {} : { auto: true }), ...opts.auditExtra },
      });
    }

    for (const t of diff.wbsOnly) {
      await tx.task.updateMany({ where: { id: t.id }, data: { wbsCache: t.wbsCache } });
      ids.push(t.id);
    }

    await this.audit.logMany(opts.ctx, audits, tx);
    return { ids, previous };
  }

  /** Replaces a task's label rows (the task row itself carries the version). */
  private async writeLabels(tx: Db, taskId: string, before: string[], after: string[]): Promise<void> {
    const gone = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    if (gone.length) await tx.taskLabel.deleteMany({ where: { taskId, labelId: { in: gone } } });
    if (added.length) await tx.taskLabel.createMany({ data: added.map((labelId) => ({ taskId, labelId })), skipDuplicates: true });
  }

  /** Throws LABEL_NOT_IN_PROJECT unless every id is a label of the project. */
  async assertLabels(tx: Db, projectId: string, labelIds: readonly string[]): Promise<void> {
    const unique = [...new Set(labelIds)];
    if (!unique.length) return;
    const rows = await tx.projectLabel.findMany({ where: { id: { in: unique }, projectId }, select: { id: true } });
    if (rows.length !== unique.length) {
      const ok = new Set(rows.map((r) => r.id));
      throw new AppError('LABEL_NOT_IN_PROJECT', { labelIds: unique.filter((l) => !ok.has(l)) });
    }
  }

  /**
   * Re-derives a whole project after its calendar or auto-schedule setting changed: every leaf
   * end is recomputed from start + duration with the (new) calendar, then the full forward pass
   * and roll-ups run. Returns the number of tasks written.
   */
  async rescheduleProject(tx: Db, projectId: string, ctx: RequestContext, cause: string): Promise<number> {
    const s = await this.lockAndLoad(tx, projectId);
    const parents = new Set(s.tasks.map((t) => t.parentId).filter((p): p is string => !!p));
    const normalized = s.tasks.map((t) => (parents.has(t.id) ? t : normalizeLeaf(t, s.cal, false, s.project.durationUnit)));
    const finals = recompute({
      tasks: normalized,
      dependencies: s.deps,
      calendar: s.cal,
      autoSchedule: s.project.autoSchedule,
      durationUnit: s.project.durationUnit,
    });
    const ids = await this.persist(tx, s, finals, {
      ctx,
      explicit: new Set(),
      explicitAction: AuditAction.TASK_MOVED,
      auditExtra: { cause },
    });
    return ids.length;
  }

  /**
   * A9 hours (ADR-109): converts a project DAY ↔ HOUR in the caller's transaction with the
   * engine's conversions (tasksToHours / tasksToDays, dependenciesToHours / dependenciesToDays):
   * every task keeps its working days; DAY → HOUR gives each task the full working hours of
   * those days, HOUR → DAY counts a partial day as a whole day. Lags are multiplied / divided by
   * the standard day length (rounded to whole days). The full forward pass then runs in the new
   * unit. Milestone caveat: in DAY projects a milestone occupies its day (an FS successor starts
   * the next working day); in HOUR projects it is an instant at the first working minute of its
   * day. The forward pass never pulls a task earlier, so successors keep their converted dates.
   * Archived tasks are converted too (a restore must find them in the right unit).
   * Returns the number of live tasks written and the previous unit.
   */
  async convertUnit(tx: Db, projectId: string, unit: Unit, ctx: RequestContext): Promise<{ tasks: number; from: Unit }> {
    const s0 = await this.lockAndLoad(tx, projectId);
    const from = s0.project.durationUnit;
    if (from === unit) return { tasks: 0, from };
    const toUnit = <T extends StoredTask>(list: T[]): T[] =>
      unit === 'HOUR'
        ? tasksToHours(list, s0.cal)
        : tasksToDays(list, s0.cal).map((t) => {
            const out = { ...t };
            delete out.durationHours;
            return out;
          });
    // Archived rows: converted in place (no audit, no engine — they are out of the schedule).
    const archivedRows = await tx.task.findMany({ where: { projectId, archivedAt: { not: null } }, select: STORED_TASK_SELECT });
    for (const t of toUnit(archivedRows.map(toStored))) {
      await tx.task.updateMany({ where: { id: t.id }, data: { ...timeColumns(t), durationDays: t.durationDays } });
    }
    await tx.project.update({ where: { id: projectId }, data: { durationUnit: unit } });
    const converted = toUnit(s0.tasks);
    const deps: StateDependency[] =
      unit === 'HOUR'
        ? dependenciesToHours(s0.deps, s0.cal).map((d) => ({ ...d, lagMinutes: hoursToMinutes(d.lagHours ?? 0) }))
        : dependenciesToDays(
            s0.deps.map((d) => ({ ...d, lagHours: minutesToHours(d.lagMinutes) })),
            s0.cal,
          ).map((d) => {
            const out: StateDependency = { ...d, lagMinutes: 0 };
            delete out.lagHours;
            return out;
          });
    for (const d of deps) {
      await tx.taskDependency.update({ where: { id: d.id }, data: { lagDays: d.lagDays, lagMinutes: d.lagMinutes } });
    }
    const state: WriteState = { ...s0, project: { ...s0.project, durationUnit: unit } };
    const finals = recompute({
      tasks: converted,
      dependencies: deps,
      calendar: s0.cal,
      autoSchedule: s0.project.autoSchedule,
      durationUnit: unit,
    });
    const ids = await this.persist(tx, state, finals, {
      ctx,
      explicit: new Set(),
      explicitAction: AuditAction.TASK_MOVED,
      auditExtra: { cause: 'project.converted', durationUnit: unit },
    });
    return { tasks: ids.length, from };
  }
}

/**
 * The date/time columns of a task row (ADR-109): DATE columns always (the day of the first and
 * of the last working minute in HOUR projects); start_at/end_at/duration_minutes only for HOUR
 * tasks (local date-times), NULL for DAY tasks.
 */
export function timeColumns(t: Pick<StoredTask, 'startDate' | 'endDate' | 'durationHours'>): {
  startDate: Date;
  endDate: Date;
  startAt: Date | null;
  endAt: Date | null;
  durationMinutes: number | null;
} {
  if (!isLocalDateTime(t.startDate)) {
    return { startDate: dateOf(t.startDate), endDate: dateOf(t.endDate), startAt: null, endAt: null, durationMinutes: null };
  }
  return {
    startDate: dateOf(t.startDate),
    endDate: dateOf(endDayOfLocal(t.startDate, t.endDate)),
    startAt: instantOf(t.startDate),
    endAt: instantOf(t.endDate),
    durationMinutes: hoursToMinutes(t.durationHours ?? 0),
  };
}

function assignField(
  data: Prisma.TaskUncheckedUpdateManyInput,
  f: VersionedField,
  t: StoredTask,
): void {
  switch (f) {
    case 'startDate':
      data.startDate = dateOf(t.startDate);
      break;
    case 'endDate':
      data.endDate = dateOf(t.endDate);
      break;
    case 'parentId':
      data.parentId = t.parentId;
      break;
    case 'assigneeId':
      data.assigneeId = t.assigneeId;
      break;
    case 'deadline':
      data.deadline = t.deadline ? dateOf(t.deadline) : null;
      break;
    case 'labelIds':
      // Written to task_labels by writeLabels.
      break;
    case 'durationHours':
      // Written with the other time columns by timeColumns.
      break;
    default:
      (data as Record<string, unknown>)[f] = t[f];
  }
}

/** Before-values of the changed fields in wire format (the undo contract, ADR-095). */
export function previousOf(t: StoredTask, fields: readonly VersionedField[]): TaskPrevious {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = f === 'labelIds' ? [...t.labelIds] : t[f];
  return out as TaskPrevious;
}

export function versionConflict(conflicts: TaskVersionConflictDetails['conflicts']): AppError {
  const details: TaskVersionConflictDetails = { refresh: 'tasks', conflicts };
  return new AppError('CONFLICT_VERSION', details);
}

/** The DB trigger (SQLSTATE 23514) raises `ASSIGNEE_NOT_SUPERVISOR`; map it like the service check. */
export function mapTaskDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof Error && /ASSIGNEE_NOT_SUPERVISOR/.test(err.message)) return new AppError('ASSIGNEE_NOT_SUPERVISOR');
  return err;
}

/** The SQL of `ProjectStore.unreadCounts` (exported for the text check in the unit tests). */
export function unreadCountsSql(viewerId: string, scope: { projectId: string } | { taskIds: string[] }): Prisma.Sql {
  const where =
    'projectId' in scope
      ? Prisma.sql`t.project_id = ${scope.projectId}::uuid AND t.archived_at IS NULL`
      : Prisma.sql`c.task_id = ANY(${scope.taskIds}::uuid[])`;
  return Prisma.sql`
    SELECT c.task_id AS "taskId", count(*)::int AS "unread"
      FROM task_comments c
      JOIN tasks t ON t.id = c.task_id
      LEFT JOIN task_comment_reads r ON r.task_id = c.task_id AND r.user_id = ${viewerId}::uuid
     WHERE ${where}
       AND c.author_id <> ${viewerId}::uuid
       AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)
     GROUP BY c.task_id`;
}
