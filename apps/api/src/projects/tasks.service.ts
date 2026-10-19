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
  type DependencyDto,
  type duplicateTaskSchema,
  type DuplicateTaskResult,
  type MyTaskDto,
  type PermissionSubject,
  type TaskArchiveResult,
  type taskBatchSchema,
  type TaskBatchResult,
  type taskBulkArchiveSchema,
  type TaskBulkArchiveResult,
  type taskBulkSchema,
  type TaskBulkResult,
  type TaskDto,
  type taskRestoreSchema,
  type TaskRestoreResult,
  type TaskUpdateResult,
  type updateTaskSchema,
} from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { STORED_TASK_SELECT, TASK_DTO_SELECT, toDependencyDto, toStored, toTaskDto } from './project-dto';
import { mapTaskDbError, ProjectStore, WRITE_TX_OPTIONS, type WriteState } from './project-store';
import {
  applyScheduleEdit,
  assertValidParent,
  coerceStart,
  hoursToMinutes,
  minutesToHours,
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
type TaskBulk = z.output<typeof taskBulkSchema>;
type TaskBulkArchive = z.output<typeof taskBulkArchiveSchema>;
type TaskRestore = z.output<typeof taskRestoreSchema>;
type DuplicateTask = z.output<typeof duplicateTaskSchema>;
type CreateDependency = z.output<typeof createDependencySchema>;

/** Fields a supervisor may change on a task assigned to them (ADR-007). */
export const SUPERVISOR_FIELDS = new Set(['version', 'progress', 'status']);

/** Suffix of a duplicated task's name (A9). */
export const COPY_SUFFIX = ' (نسخة)';

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function siblingsOf(tasks: readonly StoredTask[], parentId: string | null, exceptId?: string): StoredTask[] {
  return tasks
    .filter((t) => t.parentId === parentId && t.id !== exceptId)
    .sort((a, b) => a.sortOrder - b.sortOrder || cmpId(a.id, b.id));
}

export function copyName(name: string): string {
  return name.slice(0, 300 - COPY_SUFFIX.length) + COPY_SUFFIX;
}

/** Defaults of the A9 columns for a new task. */
export const A9_TASK_DEFAULTS = { plannedCost: 0, actualCost: 0, deadline: null, barColor: null, labelIds: [] as string[] };

/**
 * Tasks and dependencies (brief §6.1, §6.4; docs/API.md "Phase 4" and "A9"). Every write locks
 * the project, checks versions, applies the edit, re-runs `@nuzli/scheduling` on the server
 * (`recompute`, which also rolls costs up) and persists only what changed, in one transaction
 * (ADR-017). Writes that change existing tasks return the `previous` map (ADR-095).
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
          startDate: coerceStart(input.startDate, s.project.durationUnit, s.cal),
          endDate: coerceStart(input.startDate, s.project.durationUnit, s.cal),
          durationDays: input.durationDays,
          ...(s.project.durationUnit === 'HOUR'
            ? { durationHours: input.durationHours ?? minutesToHours(Math.max(1, input.durationDays) * s.cal.standardMinutesPerDay) }
            : {}),
          progress: input.progress,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          description: input.description ?? null,
          version: 0,
          ...A9_TASK_DEFAULTS,
          plannedCost: input.plannedCost ?? 0,
          actualCost: input.actualCost ?? 0,
          deadline: input.deadline ?? null,
          barColor: input.barColor ?? null,
        },
        s.cal,
        true,
        s.project.durationUnit,
      );
      const finals = recompute({
        tasks: [...tasks, draft],
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
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

    const { ids, previous, previousAssignee, projectName } = await this.tx(async (tx) => {
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
      if (input.plannedCost !== undefined) next.plannedCost = input.plannedCost;
      if (input.actualCost !== undefined) next.actualCost = input.actualCost;
      if (input.deadline !== undefined) next.deadline = input.deadline;
      if (input.barColor !== undefined) next.barColor = input.barColor;
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
        input.startDate !== undefined || input.durationDays !== undefined || input.durationHours !== undefined || next.type !== cur.type;
      if (scheduleTouched && !hasChildren) {
        next = applyScheduleEdit(
          next,
          { startDate: input.startDate, durationDays: input.durationDays, durationHours: input.durationHours },
          s.cal,
          s.project.durationUnit,
        );
      }
      const finals = recompute({
        tasks: s.tasks.map((t) => (t.id === id ? next : t)),
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
        changed: [id],
      });
      const out = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        explicit: new Set([id]),
        explicitAction: AuditAction.TASK_UPDATED,
      });
      return { ...out, previousAssignee: cur.assigneeId, projectName: s.project.name };
    });

    const dtos = await this.store.taskDtos([id, ...ids.filter((x) => x !== id)]);
    const task = dtos[0]!;
    if (task.assignee && task.assignee.id !== previousAssignee) this.notifyAssigned(task, projectName, viewer);
    return { task, affected: dtos.slice(1), previous };
  }

  // ─────────────────────────────────────────── batch (one drag-end, or an undo/redo step)

  async batch(projectId: string, input: TaskBatch, viewer: Viewer, ctx: RequestContext): Promise<TaskBatchResult> {
    await this.store.visibleProject(projectId, viewer);
    const seen = new Set<string>();
    for (const c of input.changes) {
      if (seen.has(c.id)) throw new AppError('VALIDATION_FAILED', { fieldErrors: { changes: ['مهمة مكرّرة في الدفعة نفسها'] }, id: c.id });
      seen.add(c.id);
    }
    const assignees = [...new Set(input.changes.map((c) => c.assigneeId).filter((a): a is string => !!a))];
    for (const a of assignees) await this.assertAssignee(a);

    const { ids, previous, before, projectName } = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      // ADR-017: all versions first; any mismatch → 409 and nothing is written.
      this.store.checkVersions(s, input.changes);
      await this.store.assertLabels(tx, projectId, input.changes.flatMap((c) => c.labelIds ?? []));
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

      // 2. Dates and the plain fields.
      const hasChildren = new Set([...work.values()].map((t) => t.parentId).filter((p): p is string => !!p));
      for (const c of input.changes) {
        let next = { ...work.get(c.id)! };
        if (c.progress !== undefined) next.progress = c.progress;
        if (c.status !== undefined) next.status = c.status;
        if (c.name !== undefined) next.name = c.name;
        if (c.priority !== undefined) next.priority = c.priority;
        if (c.assigneeId !== undefined) next.assigneeId = c.assigneeId;
        if (c.plannedCost !== undefined) next.plannedCost = c.plannedCost;
        if (c.actualCost !== undefined) next.actualCost = c.actualCost;
        if (c.deadline !== undefined) next.deadline = c.deadline;
        if (c.barColor !== undefined) next.barColor = c.barColor;
        if (c.labelIds !== undefined) next.labelIds = [...new Set(c.labelIds)].sort();
        const dated = c.startDate !== undefined || c.endDate !== undefined || c.durationDays !== undefined || c.durationHours !== undefined;
        if (dated && !hasChildren.has(c.id)) {
          next = applyScheduleEdit(
            next,
            { startDate: c.startDate, endDate: c.endDate, durationDays: c.durationDays, durationHours: c.durationHours },
            s.cal,
            s.project.durationUnit,
          );
        }
        work.set(c.id, next);
      }

      // 3. The server re-runs the engine: the client's shifted successors are recomputed, not trusted.
      const finals = recompute({
        tasks: s.tasks.map((t) => work.get(t.id)!),
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
        changed: input.changes.map((c) => c.id),
      });
      const out = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        explicit: new Set(input.changes.map((c) => c.id)),
        explicitAction: AuditAction.TASK_MOVED,
        auditExtra: { batch: true },
      });
      return { ...out, before: s.before, projectName: s.project.name };
    });
    const tasks = await this.store.taskDtos(ids);
    this.notifyReassigned(tasks, before, projectName, viewer);
    return { tasks, previous };
  }

  // ─────────────────────────────────────────── bulk edit (A9)

  async bulk(projectId: string, input: TaskBulk, viewer: Viewer, ctx: RequestContext): Promise<TaskBulkResult> {
    await this.store.visibleProject(projectId, viewer);
    const ids = this.uniqueVersioned(input.ids, input.versions);
    const p = input.patch;
    if (p.assigneeId) await this.assertAssignee(p.assigneeId);

    const out = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      this.store.checkVersions(s, ids.map((id) => ({ id, version: input.versions[id]! })));
      await this.store.assertLabels(tx, projectId, [...(p.labelIdsAdd ?? []), ...(p.labelIdsRemove ?? [])]);
      const work = new Map(s.before);
      for (const id of ids) {
        const next = { ...work.get(id)! };
        if (p.status !== undefined) next.status = p.status;
        if (p.priority !== undefined) next.priority = p.priority;
        if (p.assigneeId !== undefined) next.assigneeId = p.assigneeId;
        if (p.progress !== undefined) next.progress = p.progress;
        if (p.barColor !== undefined) next.barColor = p.barColor;
        if (p.labelIdsAdd || p.labelIdsRemove) {
          const set = new Set(next.labelIds);
          for (const l of p.labelIdsAdd ?? []) set.add(l);
          for (const l of p.labelIdsRemove ?? []) set.delete(l);
          next.labelIds = [...set].sort();
        }
        work.set(id, next);
      }
      // Shift: every selected leaf and every leaf under a selected group, once.
      const shifted = new Set<string>();
      if (p.shiftWorkingDays) {
        const parents = new Set(s.tasks.map((t) => t.parentId).filter((x): x is string => !!x));
        for (const id of ids) for (const sub of subtreeIds(s.tasks, id)) if (!parents.has(sub)) shifted.add(sub);
        for (const leafId of shifted) {
          const t = work.get(leafId)!;
          // HOUR projects: a working day = the calendar's standard day of working minutes.
          const startDate =
            s.project.durationUnit === 'HOUR'
              ? s.cal.addWorkingMinutes(t.startDate, p.shiftWorkingDays * s.cal.standardMinutesPerDay)
              : s.cal.addWorkingDays(t.startDate, p.shiftWorkingDays);
          work.set(leafId, normalizeLeaf({ ...t, startDate }, s.cal, false, s.project.durationUnit));
        }
      }
      const explicit = new Set([...ids, ...shifted]);
      const finals = recompute({
        tasks: s.tasks.map((t) => work.get(t.id)!),
        dependencies: s.deps,
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
        changed: [...explicit],
      });
      const res = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        explicit,
        explicitAction: AuditAction.TASK_UPDATED,
        auditExtra: { bulk: true },
      });
      return { ...res, before: s.before, projectName: s.project.name };
    });
    const tasks = await this.store.taskDtos(out.ids);
    this.notifyReassigned(tasks, out.before, out.projectName, viewer);
    return { tasks, previous: out.previous };
  }

  /** Unique ids, each with a version in `versions` (else VALIDATION_FAILED). */
  private uniqueVersioned(ids: string[], versions: Record<string, number>): string[] {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => versions[id] === undefined);
    if (missing.length) throw new AppError('VALIDATION_FAILED', { fieldErrors: { versions: ['أرسل نسخة كل مهمة محدّدة'] }, ids: missing });
    return unique;
  }

  // ─────────────────────────────────────────── archive (one, or bulk) and restore

  async archive(id: string, viewer: Viewer, ctx: RequestContext): Promise<TaskArchiveResult> {
    const visible = await this.store.visibleTask(id, viewer);
    const r = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, visible.projectId);
      return this.archiveIn(tx, s, [id], ctx);
    });
    return { archivedIds: r.archivedIds, affected: await this.store.taskDtos(r.ids), previous: r.previous, deletedDependencies: r.deletedDependencies };
  }

  async bulkArchive(projectId: string, input: TaskBulkArchive, viewer: Viewer, ctx: RequestContext): Promise<TaskBulkArchiveResult> {
    await this.store.visibleProject(projectId, viewer);
    const ids = this.uniqueVersioned(input.ids, input.versions);
    const r = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, projectId);
      this.store.checkVersions(s, ids.map((id) => ({ id, version: input.versions[id]! })));
      return this.archiveIn(tx, s, ids, ctx);
    });
    return { archivedIds: r.archivedIds, affected: await this.store.taskDtos(r.ids), previous: r.previous, deletedDependencies: r.deletedDependencies };
  }

  /** Archives the subtrees of `rootIds`, removes their dependencies, re-runs the engine. */
  private async archiveIn(tx: Db, s: WriteState, rootIds: string[], ctx: RequestContext) {
    const archived: string[] = [];
    const gone = new Set<string>();
    for (const root of rootIds) {
      if (gone.has(root)) continue;
      for (const sub of subtreeIds(s.tasks, root)) {
        if (!gone.has(sub)) {
          gone.add(sub);
          archived.push(sub);
        }
      }
    }
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
      durationUnit: s.project.durationUnit,
      changed: [],
    });
    const out = await this.store.persistDetailed(tx, remaining, finals, {
      ctx,
      explicit: new Set(),
      explicitAction: AuditAction.TASK_MOVED,
      auditExtra: { cause: 'archive', archivedTaskIds: rootIds },
    });
    await this.audit.logMany(
      ctx,
      rootIds
        .filter((r) => s.before.has(r))
        .map((r) => {
          const root = s.before.get(r)!;
          const sub = subtreeIds(s.tasks, r);
          return {
            action: AuditAction.TASK_ARCHIVED,
            entityType: 'task',
            entityId: r,
            before: { name: root.name, wbs: root.wbsCache, parentId: root.parentId },
            after: {
              archivedIds: sub,
              deletedDependencies: deps
                .filter((d) => sub.includes(d.predecessorId) || sub.includes(d.successorId))
                .map((d) => ({ id: d.id, predecessorId: d.predecessorId, successorId: d.successorId })),
            },
          };
        }),
      tx,
    );
    return {
      archivedIds: archived,
      ids: out.ids,
      previous: out.previous,
      deletedDependencies: deps.map((d): DependencyDto => toDependencyDto(d, s.project.durationUnit)),
    };
  }

  /**
   * Un-archives tasks (the undo of an archive). Every restored task's parent must be live or
   * restored with it. Restored rows get `version + 1`; the engine re-runs on the whole project.
   */
  async restore(projectId: string, input: TaskRestore, viewer: Viewer, ctx: RequestContext): Promise<TaskRestoreResult> {
    await this.store.visibleProject(projectId, viewer);
    const ids = [...new Set(input.ids)];
    const out = await this.tx(async (tx) => {
      const s0 = await this.store.lockAndLoad(tx, projectId);
      const rows = await tx.task.findMany({
        where: { id: { in: ids }, projectId, archivedAt: { not: null } },
        select: STORED_TASK_SELECT,
      });
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => r.id));
        throw new AppError('NOT_FOUND', { taskIds: ids.filter((i) => !found.has(i)) });
      }
      const restoring = new Set(ids);
      for (const r of rows) {
        if (r.parentId && !restoring.has(r.parentId) && !s0.before.has(r.parentId)) {
          throw new AppError('TASK_PARENT_INVALID', { taskId: r.id, parentId: r.parentId });
        }
      }
      await tx.task.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null, version: { increment: 1 } } });
      const s = await this.store.lockAndLoad(tx, projectId);
      const finals = recompute({ tasks: s.tasks, dependencies: s.deps, calendar: s.cal, autoSchedule: s.project.autoSchedule, durationUnit: s.project.durationUnit });
      const res = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        explicit: new Set(),
        explicitAction: AuditAction.TASK_MOVED,
        auditExtra: { cause: 'restore' },
      });
      await this.audit.logMany(
        ctx,
        rows.map((r) => ({ action: AuditAction.TASK_RESTORED, entityType: 'task', entityId: r.id, after: { name: r.name, parentId: r.parentId } })),
        tx,
      );
      for (const id of ids) delete res.previous[id];
      return res;
    });
    const restored = await this.store.taskDtos(ids);
    const affected = await this.store.taskDtos(out.ids.filter((i) => !ids.includes(i)));
    return { restored, affected, previous: out.previous };
  }

  // ─────────────────────────────────────────── duplicate (A9)

  /**
   * Copies a task (with its subtree by default) right after the original: names get « (نسخة)»,
   * dependencies inside the copied subtree are remapped, labels, custom values and checklist
   * items are copied; comments, attachments and time entries are not. The engine re-runs.
   */
  async duplicate(id: string, input: DuplicateTask, viewer: Viewer, ctx: RequestContext): Promise<DuplicateTaskResult> {
    const visible = await this.store.visibleTask(id, viewer);
    const out = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, visible.projectId);
      const root = s.before.get(id);
      if (!root) throw new AppError('NOT_FOUND');
      const sourceIds = input.withSubtasks ? subtreeIds(s.tasks, id) : [id];
      const idMap = new Map<string, string>(sourceIds.map((src) => [src, randomUUID()]));
      const siblings = siblingsOf(s.tasks, root.parentId);
      const at = siblings.findIndex((t) => t.id === id);
      const rootSort = sortOrderBetween(root.sortOrder, siblings[at + 1]?.sortOrder ?? null);
      const hasKids = s.tasks.some((t) => t.parentId === id);
      const copies: StoredTask[] = sourceIds.map((src) => {
        const t = s.before.get(src)!;
        const isRoot = src === id;
        return {
          ...t,
          id: idMap.get(src)!,
          parentId: isRoot ? t.parentId : idMap.get(t.parentId!)!,
          sortOrder: isRoot ? rootSort : t.sortOrder,
          wbsCache: '',
          name: copyName(t.name),
          // A group copied without its children becomes a plain task.
          type: isRoot && !input.withSubtasks && hasKids ? 'TASK' : t.type,
          version: 0,
          labelIds: [...t.labelIds],
        };
      });
      const inside = new Set(sourceIds);
      const newDeps = s.deps
        .filter((d) => inside.has(d.predecessorId) && inside.has(d.successorId))
        .map((d) => ({
          id: randomUUID(),
          predecessorId: idMap.get(d.predecessorId)!,
          successorId: idMap.get(d.successorId)!,
          type: d.type,
          lagDays: d.lagDays,
          lagMinutes: d.lagMinutes,
          ...(d.lagHours !== undefined ? { lagHours: d.lagHours } : {}),
        }));
      const finals = recompute({
        tasks: [...s.tasks, ...copies],
        dependencies: [...s.deps, ...newDeps],
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
        changed: copies.map((c) => c.id),
      });
      const res = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        insertedMany: copies,
        explicit: new Set(copies.map((c) => c.id)),
        explicitAction: AuditAction.TASK_CREATED,
        auditExtra: { duplicatedFrom: id },
      });
      if (newDeps.length) {
        await tx.taskDependency.createMany({
          data: newDeps.map((d) => ({
            id: d.id,
            predecessorId: d.predecessorId,
            successorId: d.successorId,
            type: d.type,
            lagDays: d.lagDays,
            lagMinutes: d.lagMinutes,
            projectId: s.project.id,
            createdById: ctx.actorId,
          })),
        });
      }
      await this.copyTaskDetails(tx, idMap, ctx.actorId);
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TASK_DUPLICATED,
          entityType: 'task',
          entityId: idMap.get(id)!,
          after: { sourceId: id, withSubtasks: input.withSubtasks, copies: copies.length, dependencies: newDeps.length },
        },
        tx,
      );
      return { ...res, idMap, newDeps, unit: s.project.durationUnit };
    });
    const copyIds = [...out.idMap.values()];
    const copySet = new Set(copyIds);
    const tasks = await this.store.taskDtos(copyIds);
    const affected = await this.store.taskDtos(out.ids.filter((x) => !copySet.has(x)));
    return {
      tasks,
      affected,
      idMap: Object.fromEntries(out.idMap),
      dependencies: out.newDeps.map((d) => toDependencyDto(d, out.unit)),
      previous: out.previous,
    };
  }

  /** Copies custom values and checklist items from source tasks to their copies (`src → copy`). */
  async copyTaskDetails(
    tx: Db,
    idMap: ReadonlyMap<string, string>,
    actorId: string | null,
    opts: { resetChecklist?: boolean; values?: boolean } = {},
  ): Promise<void> {
    const resetChecklist = opts.resetChecklist ?? false;
    const sources = [...idMap.keys()];
    if (!sources.length) return;
    const [values, items] = await Promise.all([
      opts.values === false
        ? Promise.resolve([] as Array<{ taskId: string; fieldId: string; value: Prisma.JsonValue }>)
        : tx.taskCustomValue.findMany({ where: { taskId: { in: sources } }, select: { taskId: true, fieldId: true, value: true } }),
      tx.taskChecklistItem.findMany({ where: { taskId: { in: sources } }, select: { taskId: true, text: true, done: true, sort: true, doneById: true, doneAt: true } }),
    ]);
    if (values.length) {
      await tx.taskCustomValue.createMany({
        data: values.map((v) => ({ taskId: idMap.get(v.taskId)!, fieldId: v.fieldId, value: v.value as Prisma.InputJsonValue, updatedById: actorId })),
      });
    }
    if (items.length) {
      await tx.taskChecklistItem.createMany({
        data: items.map((i) => ({
          taskId: idMap.get(i.taskId)!,
          text: i.text,
          sort: i.sort,
          done: resetChecklist ? false : i.done,
          doneById: resetChecklist ? null : i.doneById,
          doneAt: resetChecklist ? null : i.doneAt,
          createdById: actorId,
        })),
      });
    }
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
    const { ids, dep: created, unit } = await this.tx(async (tx) => {
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
      // A9 hours: HOUR projects store the lag in working minutes (lagHours wins over lagDays there);
      // lag_days keeps the value rounded to whole standard days.
      const hour = s.project.durationUnit === 'HOUR';
      const lagMinutes = hour
        ? input.lagHours !== undefined
          ? hoursToMinutes(input.lagHours)
          : input.lagDays * s.cal.standardMinutesPerDay
        : 0;
      const lagDays = hour ? Math.round(lagMinutes / s.cal.standardMinutesPerDay) || 0 : input.lagDays;
      const dep = {
        id,
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        type: input.type,
        lagDays,
        lagMinutes,
        ...(hour ? { lagHours: minutesToHours(lagMinutes) } : {}),
      };
      // A link between a task and its own ancestor is a cycle too: the engine throws it here.
      const finals = recompute({
        tasks: s.tasks,
        dependencies: [...s.deps, dep],
        calendar: s.cal,
        autoSchedule: s.project.autoSchedule,
        durationUnit: s.project.durationUnit,
        changed: [input.predecessorId],
      });
      await tx.taskDependency.create({
        data: { id, predecessorId: dep.predecessorId, successorId: dep.successorId, type: dep.type, lagDays, lagMinutes, projectId, createdById: ctx.actorId },
      });
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
      return { ids: changed, dep, unit: s.project.durationUnit };
    });
    return {
      ...toDependencyDto(created, unit),
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
          before: { predecessorId: dep.predecessorId, successorId: dep.successorId, type: dep.type, lagDays: dep.lagDays, lagMinutes: dep.lagMinutes },
        },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── my tasks

  /** Supervisor's assigned tasks across non-archived projects, by end date, with due flags. */
  async mine(viewer: Viewer, now = new Date()): Promise<MyTaskDto[]> {
    const rows = await this.prisma.task.findMany({
      where: { assigneeId: viewer.id, archivedAt: null, project: { archivedAt: null, isTemplate: false } },
      select: { ...TASK_DTO_SELECT, project: { select: { id: true, name: true, calendarId: true } } },
      orderBy: [{ endDate: 'asc' }, { startDate: 'asc' }, { name: 'asc' }],
    });
    if (!rows.length) return [];
    const calendarIds = [...new Set(rows.map((r) => r.project.calendarId))];
    const ids = rows.map((r) => r.id);
    const [counts, calendars, extras] = await Promise.all([
      this.store.attachmentCounts(ids),
      this.prisma.calendar.findMany({
        where: { id: { in: calendarIds } },
        select: { id: true, weekendDays: true, workingHours: true, exceptions: { select: { date: true, isWorking: true, workingHours: true } } },
      }),
      this.store.taskExtras(ids, this.prisma, now),
    ]);
    const cals = new Map(calendars.map((c) => [c.id, workCalendarOf(c)]));
    const today = riyadhToday(now);
    return rows.map((r) => {
      const dto = toTaskDto(r, counts, undefined, extras);
      const cal = cals.get(r.project.calendarId) ?? workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
      return { ...dto, project: { id: r.project.id, name: r.project.name }, ...dueFlags(dto, today, cal) };
    });
  }

  /** Loads a project's live tasks as StoredTasks (reports, templates). */
  async storedTasks(projectId: string, db: Db = this.prisma): Promise<StoredTask[]> {
    const rows = await db.task.findMany({ where: { projectId, archivedAt: null }, select: STORED_TASK_SELECT });
    return rows.map(toStored);
  }

  private notifyReassigned(tasks: TaskDto[], before: ReadonlyMap<string, StoredTask>, projectName: string, viewer: Viewer): void {
    for (const t of tasks) {
      const prev = before.get(t.id);
      if (prev && t.assignee && t.assignee.id !== prev.assigneeId) this.notifyAssigned(t, projectName, viewer);
    }
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

