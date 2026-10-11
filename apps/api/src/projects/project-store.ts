import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { WorkCalendar } from '@nuzli/scheduling';
import type { DependencyType, PermissionSubject, TaskDto, TaskVersionConflictDetails } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  PROJECT_SELECT,
  STORED_TASK_SELECT,
  TASK_DTO_SELECT,
  projectScopeWhere,
  toStored,
  toTaskDto,
  type ProjectRow,
  type ProjectStats,
} from './project-dto';
import {
  dateOf,
  diffTasks,
  isoOf,
  normalizeLeaf,
  pick,
  recompute,
  workCalendarOf,
  type StoredTask,
  type VersionedField,
} from './task-engine';

type Viewer = PermissionSubject & { id: string };

/** Interactive transactions that may rewrite a 2,000-task project need more than Prisma's 5 s. */
export const WRITE_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export interface StateDependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

/** A project loaded for a write, under a row lock on the project. */
export interface WriteState {
  project: { id: string; name: string; autoSchedule: boolean; calendarId: string };
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

  /** A task (not archived) of a project the viewer can see, else 404. */
  async visibleTask(id: string, viewer: Viewer) {
    const t = await this.prisma.task.findFirst({
      where: { id, archivedAt: null, project: projectScopeWhere(viewer) },
      select: { id: true, projectId: true, assigneeId: true, name: true, project: { select: { name: true, archivedAt: true } } },
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
        select: { projectId: true, type: true, durationDays: true, progress: true },
      }),
      db.task.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds }, archivedAt: null },
        _count: { _all: true },
        _max: { endDate: true },
      }),
    ]);
    for (const r of roots) {
      out.get(r.projectId)?.roots.push({ type: r.type, durationDays: r.durationDays, progress: Number(r.progress) });
    }
    for (const a of agg) {
      const s = out.get(a.projectId);
      if (!s) continue;
      s.taskCount = a._count._all;
      s.endDate = a._max.endDate ? isoOf(a._max.endDate) : null;
    }
    return out;
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

  /** TaskDtos in the order of `ids` (WBS from the refreshed cache). */
  async taskDtos(ids: string[], db: Db = this.prisma): Promise<TaskDto[]> {
    if (!ids.length) return [];
    const [rows, counts] = await Promise.all([
      db.task.findMany({ where: { id: { in: ids } }, select: TASK_DTO_SELECT }),
      this.attachmentCounts(ids, db),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [toTaskDto(r, counts)] : [];
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
        calendar: { select: { weekendDays: true, exceptions: { select: { date: true, isWorking: true } } } },
      },
    });
    if (!project) throw new AppError('NOT_FOUND');
    if (project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    const [rows, deps] = await Promise.all([
      tx.task.findMany({ where: { projectId, archivedAt: null }, select: STORED_TASK_SELECT }),
      tx.taskDependency.findMany({
        where: { projectId },
        select: { id: true, predecessorId: true, successorId: true, type: true, lagDays: true },
      }),
    ]);
    const tasks = rows.map(toStored);
    return {
      project: { id: project.id, name: project.name, autoSchedule: project.autoSchedule, calendarId: project.calendarId },
      cal: workCalendarOf(project.calendar),
      before: new Map(tasks.map((t) => [t.id, t])),
      tasks,
      deps,
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
    const diff = diffTasks(state.before, finals);
    const audits: Array<{ action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }> = [];
    const ids: string[] = [];

    if (opts.inserted) {
      const t = finals.find((f) => f.id === opts.inserted!.id) ?? opts.inserted;
      await tx.task.create({
        data: {
          id: t.id,
          projectId: t.projectId,
          parentId: t.parentId,
          sortOrder: t.sortOrder,
          wbsCache: t.wbsCache,
          name: t.name,
          type: t.type,
          startDate: dateOf(t.startDate),
          endDate: dateOf(t.endDate),
          durationDays: t.durationDays,
          progress: t.progress,
          status: t.status,
          priority: t.priority,
          assigneeId: t.assigneeId,
          description: t.description,
          createdById: opts.ctx.actorId,
        },
      });
      ids.push(t.id);
      audits.push({
        action: AuditAction.TASK_CREATED,
        entityType: 'task',
        entityId: t.id,
        after: { ...pick(t, ['name', 'type', 'parentId', 'startDate', 'endDate', 'durationDays', 'assigneeId']), wbs: t.wbsCache, ...opts.auditExtra },
      });
    }

    for (const { before, after, fields } of diff.versioned) {
      const data: Prisma.TaskUncheckedUpdateManyInput = {
        version: { increment: 1 },
        wbsCache: after.wbsCache,
      };
      for (const f of fields) assignField(data, f, after);
      if (fields.includes('endDate')) {
        data.dueSoonNotifiedAt = null;
        data.overdueNotifiedAt = null;
      }
      const res = await tx.task.updateMany({ where: { id: after.id, version: before.version }, data });
      if (res.count !== 1) throw versionConflict([{ id: after.id, currentVersion: null }]);
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
    return ids;
  }

  /**
   * Re-derives a whole project after its calendar or auto-schedule setting changed: every leaf
   * end is recomputed from start + duration with the (new) calendar, then the full forward pass
   * and roll-ups run. Returns the number of tasks written.
   */
  async rescheduleProject(tx: Db, projectId: string, ctx: RequestContext, cause: string): Promise<number> {
    const s = await this.lockAndLoad(tx, projectId);
    const parents = new Set(s.tasks.map((t) => t.parentId).filter((p): p is string => !!p));
    const normalized = s.tasks.map((t) => (parents.has(t.id) ? t : normalizeLeaf(t, s.cal, false)));
    const finals = recompute({ tasks: normalized, dependencies: s.deps, calendar: s.cal, autoSchedule: s.project.autoSchedule });
    const ids = await this.persist(tx, s, finals, {
      ctx,
      explicit: new Set(),
      explicitAction: AuditAction.TASK_MOVED,
      auditExtra: { cause },
    });
    return ids.length;
  }
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
    default:
      (data as Record<string, unknown>)[f] = t[f];
  }
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
