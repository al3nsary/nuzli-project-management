import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { detectCycle, wouldCreateCycle } from '@nuzli/scheduling';
import {
  can,
  ENABLED_DEPENDENCY_TYPES,
  type createDependencySchema,
  type createTaskSchema,
  type CreatedDependencyDto,
  type CreatedTaskDto,
  type MyTaskDto,
  type PermissionSubject,
  type TaskArchiveResult,
  type taskBatchSchema,
  type TaskBatchResult,
  type TaskDto,
  type TaskUpdateResult,
  type updateTaskSchema,
} from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TASK_DTO_SELECT, toDependencyDto, toTaskDto } from './project-dto';
import { mapTaskDbError, ProjectStore, WRITE_TX_OPTIONS, type WriteState } from './project-store';
import {
  applyScheduleEdit,
  assertValidParent,
  dueFlags,
  needsRenumber,
  normalizeLeaf,
  recompute,
  riyadhToday,
  sortOrderBetween,
  subtreeIds,
  workCalendarOf,
  type StoredTask,
} from './task-engine';

type Viewer = PermissionSubject & { id: string; fullName?: string };
type CreateTask = z.output<typeof createTaskSchema>;
type UpdateTask = z.output<typeof updateTaskSchema>;
type TaskBatch = z.output<typeof taskBatchSchema>;
type CreateDependency = z.output<typeof createDependencySchema>;

/** Fields a supervisor may change on a task assigned to them (ADR-007). */
export const SUPERVISOR_FIELDS = new Set(['version', 'progress', 'status']);

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function siblingsOf(tasks: readonly StoredTask[], parentId: string | null, exceptId?: string): StoredTask[] {
  return tasks
    .filter((t) => t.parentId === parentId && t.id !== exceptId)
    .sort((a, b) => a.sortOrder - b.sortOrder || cmpId(a.id, b.id));
}

/**
 * Tasks and dependencies (brief §6.1, §6.4; docs/API.md "Phase 4"). Every write locks the
 * project, checks versions, applies the edit, re-runs `@nuzli/scheduling` on the server
 * (`recompute`) and persists only what changed, in one transaction (ADR-017).
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, WRITE_TX_OPTIONS);
    } catch (err) {
      throw mapTaskDbError(err);
    }
  }

  /** Brief §1/§6.1: tasks go to ACTIVE supervisors only (the DB trigger checks the role too). */
  async assertAssignee(userId: string): Promise<void> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!u || u.role !== 'SUPERVISOR' || u.status !== 'ACTIVE') throw new AppError('ASSIGNEE_NOT_SUPERVISOR');
  }

  async get(id: string, viewer: Viewer): Promise<TaskDto> {
    await this.store.visibleTask(id, viewer);
    const [dto] = await this.store.taskDtos([id]);
    if (!dto) throw new AppError('NOT_FOUND');
    return dto;
  }

  // ─────────────────────────────────────────── create

  async create(projectId: string, input: CreateTask, viewer: Viewer, ctx: RequestContext): Promise<CreatedTaskDto> {
    await this.store.visibleProject(projectId, viewer);
    if (input.assigneeId) await this.assertAssignee(input.assigneeId);
    const id = randomUUID();
    const { ids, projectName } = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      const parentId = input.parentId ?? null;
      assertValidParent(s.before, null, parentId);
      let tasks = s.tasks;
      let siblings = siblingsOf(tasks, parentId);
      const locate = () => {
        if (!input.afterId) return { prev: siblings.at(-1)?.sortOrder ?? null, next: null };
        const i = siblings.findIndex((t) => t.id === input.afterId);
        if (i < 0) throw new AppError('VALIDATION_FAILED', { fieldErrors: { afterId: ['المهمة المرجعية ليست في المستوى نفسه'] } });
        return { prev: siblings[i]!.sortOrder, next: siblings[i + 1]?.sortOrder ?? null };
      };
      let { prev, next } = locate();
      if (needsRenumber(prev, next)) {
        // Fractional keys ran out of precision: renumber this sibling group 1..n (order unchanged).
        const order = new Map(siblings.map((t, i) => [t.id, i + 1]));
        tasks = tasks.map((t) => (order.has(t.id) ? { ...t, sortOrder: order.get(t.id)! } : t));
        siblings = siblingsOf(tasks, parentId);
        ({ prev, next } = locate());
      }
      const draft = normalizeLeaf(
        {
          id,
          projectId,
          parentId,
          sortOrder: sortOrderBetween(prev, next),
          wbsCache: '',
          name: input.name,
          type: input.type,
          startDate: input.startDate,
          endDate: input.startDate,
          durationDays: input.durationDays,
          progress: input.progress,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          description: input.description ?? null,
          version: 0,
        },
        s.cal,
      );
      const finals = recompute({
        tasks: [...tasks, draft],
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        changed: [id],
      });
      const changed = await this.store.persist(tx, s, finals, {
        ctx,
        inserted: draft,
        explicit: new Set([id]),
        explicitAction: AuditAction.TASK_CREATED,
      });
      return { ids: changed, projectName: s.project.name };
    });
    const dtos = await this.store.taskDtos(ids);
    const task = dtos.find((d) => d.id === id)!;
    if (input.assigneeId) this.notifyAssigned(task, projectName, viewer);
    return { ...task, affected: dtos.filter((d) => d.id !== id) };
  }

  // ─────────────────────────────────────────── update (one task)

  async update(id: string, input: UpdateTask, viewer: Viewer, ctx: RequestContext): Promise<TaskUpdateResult> {
    const visible = await this.store.visibleTask(id, viewer);
    if (!can(viewer, 'tasks.manage')) {
      // ADR-007: a supervisor changes only progress/status, and only on tasks assigned to them.
      if (!can(viewer, 'tasks.updateAssigned') || visible.assigneeId !== viewer.id) throw new AppError('FORBIDDEN');
      const extra = Object.entries(input)
        .filter(([k, v]) => v !== undefined && !SUPERVISOR_FIELDS.has(k))
        .map(([k]) => k);
      if (extra.length) throw new AppError('FORBIDDEN', { fields: extra });
    }
    if (input.assigneeId) await this.assertAssignee(input.assigneeId);

    const { ids, previousAssignee, projectName } = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, visible.projectId);
      this.store.checkVersions(s, [{ id, version: input.version }]);
      const cur = s.before.get(id)!;
      let next: StoredTask = { ...cur };
      if (input.name !== undefined) next.name = input.name;
      if (input.priority !== undefined) next.priority = input.priority;
      if (input.description !== undefined) next.description = input.description;
      if (input.status !== undefined) next.status = input.status;
      if (input.progress !== undefined) next.progress = input.progress;
      if (input.assigneeId !== undefined) next.assigneeId = input.assigneeId;
      const hasChildren = s.tasks.some((t) => t.parentId === id);
      if (input.type !== undefined && input.type !== cur.type) {
        if (input.type === 'MILESTONE' && hasChildren) throw new AppError('TASK_PARENT_INVALID', { taskId: id });
        next.type = input.type;
      }
      if (input.parentId !== undefined && input.parentId !== cur.parentId) {
        assertValidParent(s.before, id, input.parentId);
        next.parentId = input.parentId;
        next.sortOrder = sortOrderBetween(siblingsOf(s.tasks, input.parentId, id).at(-1)?.sortOrder ?? null, null);
      }
      const scheduleTouched =
        input.startDate !== undefined || input.durationDays !== undefined || next.type !== cur.type;
      if (scheduleTouched && !hasChildren) {
        next = applyScheduleEdit(next, { startDate: input.startDate, durationDays: input.durationDays }, s.cal);
      }
      const finals = recompute({
        tasks: s.tasks.map((t) => (t.id === id ? next : t)),
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        changed: [id],
      });
      const changed = await this.store.persist(tx, s, finals, {
        ctx,
        explicit: new Set([id]),
        explicitAction: AuditAction.TASK_UPDATED,
      });
      return { ids: changed, previousAssignee: cur.assigneeId, projectName: s.project.name };
    });

    const dtos = await this.store.taskDtos([id, ...ids.filter((x) => x !== id)]);
    const task = dtos[0]!;
    if (task.assignee && task.assignee.id !== previousAssignee) this.notifyAssigned(task, projectName, viewer);
    return { task, affected: dtos.slice(1) };
  }

  // ─────────────────────────────────────────── batch (one drag-end)

  async batch(projectId: string, input: TaskBatch, viewer: Viewer, ctx: RequestContext): Promise<TaskBatchResult> {
    await this.store.visibleProject(projectId, viewer);
    const seen = new Set<string>();
    for (const c of input.changes) {
      if (seen.has(c.id)) throw new AppError('VALIDATION_FAILED', { fieldErrors: { changes: ['مهمة مكرّرة في الدفعة نفسها'] }, id: c.id });
      seen.add(c.id);
    }
    const ids = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      // ADR-017: all versions first; any mismatch → 409 and nothing is written.
      this.store.checkVersions(s, input.changes);
      const work = new Map(s.before);

      // 1. Structure (reorder / indent / outdent).
      for (const c of input.changes) {
        const cur = work.get(c.id)!;
        const next = { ...cur };
        if (c.parentId !== undefined) next.parentId = c.parentId;
        if (c.sortOrder !== undefined) next.sortOrder = c.sortOrder;
        else if (c.parentId !== undefined && c.parentId !== cur.parentId) {
          next.sortOrder = sortOrderBetween(siblingsOf([...work.values()], c.parentId, c.id).at(-1)?.sortOrder ?? null, null);
        }
        work.set(c.id, next);
      }
      for (const c of input.changes) {
        if (c.parentId !== undefined && c.parentId !== s.before.get(c.id)!.parentId) assertValidParent(work, c.id, c.parentId);
      }

      // 2. Dates, progress, status.
      const hasChildren = new Set([...work.values()].map((t) => t.parentId).filter((p): p is string => !!p));
      for (const c of input.changes) {
        let next = work.get(c.id)!;
        if (c.progress !== undefined) next = { ...next, progress: c.progress };
        if (c.status !== undefined) next = { ...next, status: c.status };
        const dated = c.startDate !== undefined || c.endDate !== undefined || c.durationDays !== undefined;
        if (dated && !hasChildren.has(c.id)) {
          next = applyScheduleEdit(next, { startDate: c.startDate, endDate: c.endDate, durationDays: c.durationDays }, s.cal);
        }
        work.set(c.id, next);
      }

      // 3. The server re-runs the engine: the client's shifted successors are recomputed, not trusted.
      const finals = recompute({
        tasks: s.tasks.map((t) => work.get(t.id)!),
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        changed: input.changes.map((c) => c.id),
      });
      return this.store.persist(tx, s, finals, {
        ctx,
        explicit: new Set(input.changes.map((c) => c.id)),
        explicitAction: AuditAction.TASK_MOVED,
        auditExtra: { batch: true },
      });
    });
    return { tasks: await this.store.taskDtos(ids) };
  }

  // ─────────────────────────────────────────── archive

  async archive(id: string, viewer: Viewer, ctx: RequestContext): Promise<TaskArchiveResult> {
    const visible = await this.store.visibleTask(id, viewer);
    const { archivedIds, ids } = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, visible.projectId);
      const archived = subtreeIds(s.tasks, id);
      const gone = new Set(archived);
      const deps = s.deps.filter((d) => gone.has(d.predecessorId) || gone.has(d.successorId));
      const now = new Date();
      await tx.task.updateMany({ where: { id: { in: archived }, archivedAt: null }, data: { archivedAt: now, version: { increment: 1 } } });
      if (deps.length) await tx.taskDependency.deleteMany({ where: { id: { in: deps.map((d) => d.id) } } });
      const remaining: WriteState = {
        ...s,
        tasks: s.tasks.filter((t) => !gone.has(t.id)),
        deps: s.deps.filter((d) => !gone.has(d.predecessorId) && !gone.has(d.successorId)),
      };
      const finals = recompute({
        tasks: remaining.tasks,
        dependencies: remaining.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        changed: [],
      });
      const changed = await this.store.persist(tx, remaining, finals, {
        ctx,
        explicit: new Set(),
        explicitAction: AuditAction.TASK_MOVED,
        auditExtra: { cause: 'archive', archivedTaskId: id },
      });
      const root = s.before.get(id)!;
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TASK_ARCHIVED,
          entityType: 'task',
          entityId: id,
          before: { name: root.name, wbs: root.wbsCache, parentId: root.parentId },
          after: { archivedIds: archived, deletedDependencies: deps.map((d) => ({ id: d.id, predecessorId: d.predecessorId, successorId: d.successorId })) },
        },
        tx,
      );
      return { archivedIds: archived, ids: changed };
    });
    return { archivedIds, affected: await this.store.taskDtos(ids) };
  }

  // ─────────────────────────────────────────── dependencies

  async createDependency(
    projectId: string,
    input: CreateDependency,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<CreatedDependencyDto> {
    await this.store.visibleProject(projectId, viewer);
    // Brief §6.1: all four types are modelled, only FS is enabled (shared ENABLED_DEPENDENCY_TYPES).
    if (!ENABLED_DEPENDENCY_TYPES.includes(input.type)) throw new AppError('DEPENDENCY_TYPE_DISABLED', { type: input.type });
    if (input.predecessorId === input.successorId) {
      throw new AppError('DEPENDENCY_SELF', { path: [input.predecessorId, input.predecessorId] });
    }
    const id = randomUUID();
    const ids = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      const missing = [input.predecessorId, input.successorId].filter((t) => !s.before.has(t));
      if (missing.length) throw new AppError('NOT_FOUND', { taskIds: missing });
      if (s.deps.some((d) => d.predecessorId === input.predecessorId && d.successorId === input.successorId)) {
        throw new AppError('DEPENDENCY_EXISTS');
      }
      if (wouldCreateCycle(s.deps, input.predecessorId, input.successorId)) {
        const path = detectCycle(s.deps, { predecessorId: input.predecessorId, successorId: input.successorId }) ?? [
          input.predecessorId,
          input.successorId,
          input.predecessorId,
        ];
        throw new AppError('DEPENDENCY_CYCLE', { path });
      }
      const dep = { id, predecessorId: input.predecessorId, successorId: input.successorId, type: input.type, lagDays: input.lagDays };
      // A link between a task and its own ancestor is a cycle too: the engine throws it here.
      const finals = recompute({
        tasks: s.tasks,
        dependencies: [...s.deps, dep],
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        changed: [input.predecessorId],
      });
      await tx.taskDependency.create({ data: { ...dep, projectId, createdById: ctx.actorId } });
      const changed = await this.store.persist(tx, s, finals, {
        ctx,
        explicit: new Set(),
        explicitAction: AuditAction.TASK_MOVED,
        auditExtra: { cause: 'dependency', dependencyId: id },
      });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.DEPENDENCY_CREATED, entityType: 'dependency', entityId: id, after: { ...dep, shifted: changed.length } },
        tx,
      );
      return changed;
    });
    return {
      ...toDependencyDto({ id, predecessorId: input.predecessorId, successorId: input.successorId, type: input.type, lagDays: input.lagDays }),
      affected: await this.store.taskDtos(ids),
    };
  }

  /** Removing a finish-to-start link never forces a task later, so nothing is rescheduled. */
  async deleteDependency(id: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    const dep = await this.prisma.taskDependency.findUnique({ where: { id } });
    if (!dep) throw new AppError('NOT_FOUND');
    await this.store.visibleProject(dep.projectId, viewer);
    await this.tx(async (tx) => {
      await this.store.lockAndLoad(tx, dep.projectId);
      const res = await tx.taskDependency.deleteMany({ where: { id } });
      if (res.count !== 1) throw new AppError('NOT_FOUND');
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.DEPENDENCY_DELETED,
          entityType: 'dependency',
          entityId: id,
          before: { predecessorId: dep.predecessorId, successorId: dep.successorId, type: dep.type, lagDays: dep.lagDays },
        },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── my tasks

  /** Supervisor's assigned tasks across non-archived projects, by end date, with due flags. */
  async mine(viewer: Viewer, now = new Date()): Promise<MyTaskDto[]> {
    const rows = await this.prisma.task.findMany({
      where: { assigneeId: viewer.id, archivedAt: null, project: { archivedAt: null } },
      select: { ...TASK_DTO_SELECT, project: { select: { id: true, name: true, calendarId: true } } },
      orderBy: [{ endDate: 'asc' }, { startDate: 'asc' }, { name: 'asc' }],
    });
    if (!rows.length) return [];
    const calendarIds = [...new Set(rows.map((r) => r.project.calendarId))];
    const [counts, calendars] = await Promise.all([
      this.store.attachmentCounts(rows.map((r) => r.id)),
      this.prisma.calendar.findMany({
        where: { id: { in: calendarIds } },
        select: { id: true, weekendDays: true, exceptions: { select: { date: true, isWorking: true } } },
      }),
    ]);
    const cals = new Map(calendars.map((c) => [c.id, workCalendarOf(c)]));
    const today = riyadhToday(now);
    return rows.map((r) => {
      const dto = toTaskDto(r, counts);
      const cal = cals.get(r.project.calendarId) ?? workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
      return { ...dto, project: { id: r.project.id, name: r.project.name }, ...dueFlags(dto, today, cal) };
    });
  }

  private notifyAssigned(task: TaskDto, projectName: string, viewer: Viewer): void {
    if (!task.assignee || task.assignee.id === viewer.id) return;
    this.notifications.safe(
      this.notifications.notify([task.assignee.id], 'TASK_ASSIGNED', {
        taskId: task.id,
        taskName: task.name,
        projectId: task.projectId,
        projectName,
        startDate: task.startDate,
        endDate: task.endDate,
        assignedBy: viewer.fullName ?? null,
      }),
    );
  }
}
