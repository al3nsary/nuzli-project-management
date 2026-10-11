import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { computeWbs } from '@nuzli/scheduling';
import type {
  createProjectSchema,
  GanttDto,
  grantProjectAccessSchema,
  PermissionSubject,
  ProjectAccessDto,
  ProjectDto,
  ProjectListQuery,
  updateProjectSchema,
} from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import {
  CALENDAR_SELECT,
  DEPENDENCY_SELECT,
  PROJECT_SELECT,
  TASK_DTO_SELECT,
  projectScopeWhere,
  toCalendarDto,
  toDependencyDto,
  toProjectDto,
  toStored,
  toTaskDto,
  type ProjectRow,
  type ProjectStats,
} from './project-dto';
import { ProjectStore, WRITE_TX_OPTIONS, mapTaskDbError } from './project-store';
import { dateOf, isoOf, projectProgress } from './task-engine';
import { buildTasksWorkbook, compareWbs } from './tasks-export';

type Viewer = PermissionSubject & { id: string };
type CreateProject = z.output<typeof createProjectSchema>;
type UpdateProject = z.output<typeof updateProjectSchema>;
type GrantAccess = z.output<typeof grantProjectAccessSchema>;

const PROJECT_FIELDS = ['name', 'description', 'startDate', 'status', 'calendarId', 'autoSchedule'] as const;

/** Projects, access grants, the Gantt payload and the Excel export (brief §6.1). */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
  ) {}

  private async dto(p: ProjectRow, stats?: ProjectStats): Promise<ProjectDto> {
    return toProjectDto(p, stats ?? (await this.store.projectStats([p.id])).get(p.id)!);
  }

  async list(q: ProjectListQuery, viewer: Viewer): Promise<ProjectDto[]> {
    const status: Prisma.ProjectWhereInput =
      q.status === 'ALL'
        ? {}
        : q.status === 'ARCHIVED'
          ? { OR: [{ archivedAt: { not: null } }, { status: 'ARCHIVED' }] }
          : { archivedAt: null, ...(q.status ? { status: q.status } : {}) };
    const rows = await this.prisma.project.findMany({
      where: {
        AND: [projectScopeWhere(viewer), status, q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}],
      },
      select: PROJECT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const stats = await this.store.projectStats(rows.map((r) => r.id));
    return rows.map((r) => toProjectDto(r, stats.get(r.id)!));
  }

  async get(id: string, viewer: Viewer): Promise<ProjectDto> {
    return this.dto(await this.store.visibleProject(id, viewer));
  }

  private async calendarIdOrDefault(calendarId: string | undefined): Promise<string> {
    const cal = calendarId
      ? await this.prisma.calendar.findUnique({ where: { id: calendarId }, select: { id: true } })
      : await this.prisma.calendar.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!cal) {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] } });
    }
    return cal.id;
  }

  async create(input: CreateProject, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const calendarId = await this.calendarIdOrDefault(input.calendarId);
    const p = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          startDate: dateOf(input.startDate),
          status: input.status,
          calendarId,
          autoSchedule: input.autoSchedule,
          ownerId: viewer.id,
          createdById: viewer.id,
          ...(input.status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
        },
        select: PROJECT_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.PROJECT_CREATED,
          entityType: 'project',
          entityId: created.id,
          after: { ...input, calendarId, description: input.description ? `${input.description.length} حرفًا` : null },
        },
        tx,
      );
      return created;
    });
    return toProjectDto(p, { roots: [], endDate: null, taskCount: 0 });
  }

  /**
   * Changing the calendar, or switching auto-schedule on, re-derives every task (ends from
   * durations with the new calendar, then the forward pass) in the same transaction.
   * `status: 'ARCHIVED'` archives; any other status on an archived project restores it.
   */
  async update(id: string, input: UpdateProject, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const cur = await this.store.visibleProject(id, viewer);
    if (input.calendarId !== undefined) await this.calendarIdOrDefault(input.calendarId);
    const before: Record<string, unknown> = {
      name: cur.name,
      description: cur.description,
      startDate: isoOf(cur.startDate),
      status: cur.status,
      calendarId: cur.calendarId,
      autoSchedule: cur.autoSchedule,
    };
    const changed = PROJECT_FIELDS.filter((f) => input[f] !== undefined && input[f] !== before[f]);
    if (!changed.length) return this.dto(cur);
    if (cur.archivedAt && !(input.status && input.status !== 'ARCHIVED')) throw new AppError('PROJECT_ARCHIVED');

    const p = await this.prisma
      .$transaction(async (tx) => {
        const data: Prisma.ProjectUncheckedUpdateInput = {};
        for (const f of changed) {
          if (f === 'startDate') data.startDate = dateOf(input.startDate!);
          else (data as Record<string, unknown>)[f] = input[f];
        }
        if (input.status === 'ARCHIVED') data.archivedAt = new Date();
        else if (input.status && cur.archivedAt) data.archivedAt = null;
        const updated = await tx.project.update({ where: { id }, data, select: PROJECT_SELECT });
        let rescheduled = 0;
        const reschedule =
          !updated.archivedAt &&
          (changed.includes('calendarId') || (changed.includes('autoSchedule') && input.autoSchedule === true));
        if (reschedule) rescheduled = await this.store.rescheduleProject(tx, id, ctx, 'project.updated');
        const after: Record<string, unknown> = {};
        for (const f of changed) after[f] = f === 'description' ? (input.description ? `${input.description.length} حرفًا` : null) : input[f];
        await this.audit.logCtx(
          ctx,
          {
            action: input.status === 'ARCHIVED' ? AuditAction.PROJECT_ARCHIVED : AuditAction.PROJECT_UPDATED,
            entityType: 'project',
            entityId: id,
            before: Object.fromEntries(changed.map((f) => [f, f === 'description' ? null : before[f]])),
            after: { ...after, ...(reschedule ? { rescheduledTasks: rescheduled } : {}) },
          },
          tx,
        );
        return updated;
      }, WRITE_TX_OPTIONS)
      .catch((err: unknown) => {
        throw mapTaskDbError(err);
      });
    return this.dto(p);
  }

  /** `DELETE /projects/:id` archives (history matters, brief §11). */
  async archive(id: string, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const cur = await this.store.visibleProject(id, viewer);
    if (cur.archivedAt) return this.dto(cur);
    const p = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: { archivedAt: new Date(), status: 'ARCHIVED' },
        select: PROJECT_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.PROJECT_ARCHIVED, entityType: 'project', entityId: id, before: { status: cur.status }, after: { status: 'ARCHIVED' } },
        tx,
      );
      return updated;
    });
    return this.dto(p);
  }

  // ─────────────────────────────────────────── access (VIEW for supervisors)

  async listAccess(id: string, viewer: Viewer): Promise<ProjectAccessDto[]> {
    await this.store.visibleProject(id, viewer);
    const rows = await this.prisma.projectAccess.findMany({
      where: { projectId: id },
      select: { level: true, createdAt: true, user: { select: { id: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ user: r.user, level: r.level, grantedAt: r.createdAt.toISOString() }));
  }

  async grantAccess(id: string, input: GrantAccess, viewer: Viewer, ctx: RequestContext): Promise<ProjectAccessDto> {
    await this.store.visibleProject(id, viewer);
    const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, fullName: true, role: true, status: true } });
    if (!user || user.role !== 'SUPERVISOR' || user.status !== 'ACTIVE') {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: { userId: ['تُمنح صلاحية عرض المشروع للمشرفين النشطين فقط'] } });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.projectAccess.findUnique({ where: { projectId_userId: { projectId: id, userId: user.id } } });
      if (existing) return existing;
      const created = await tx.projectAccess.create({
        data: { projectId: id, userId: user.id, level: input.level, createdById: viewer.id },
      });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.PROJECT_ACCESS_GRANTED, entityType: 'project', entityId: id, after: { userId: user.id, level: input.level } },
        tx,
      );
      return created;
    });
    return { user: { id: user.id, fullName: user.fullName, role: user.role }, level: row.level, grantedAt: row.createdAt.toISOString() };
  }

  async revokeAccess(id: string, userId: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.store.visibleProject(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.projectAccess.deleteMany({ where: { projectId: id, userId } });
      if (!res.count) throw new AppError('NOT_FOUND');
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.PROJECT_ACCESS_REVOKED, entityType: 'project', entityId: id, before: { userId } },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── Gantt (one call for the whole chart)

  async gantt(id: string, viewer: Viewer): Promise<GanttDto> {
    const p = await this.store.visibleProject(id, viewer);
    const [rows, deps, calendar] = await Promise.all([
      this.prisma.task.findMany({ where: { projectId: id, archivedAt: null }, select: TASK_DTO_SELECT }),
      this.prisma.taskDependency.findMany({ where: { projectId: id }, select: DEPENDENCY_SELECT, orderBy: { createdAt: 'asc' } }),
      this.prisma.calendar.findUnique({ where: { id: p.calendarId }, select: CALENDAR_SELECT }),
    ]);
    if (!calendar) throw new AppError('NOT_FOUND');
    const ids = new Set(rows.map((r) => r.id));
    const counts = await this.store.attachmentCounts([...ids]);
    const stored = rows.map(toStored);
    const wbs = computeWbs(stored);
    const tasks = rows
      .map((r) => toTaskDto(r, counts, wbs.get(r.id)))
      .sort((a, b) => compareWbs(a.wbs, b.wbs));
    const roots = stored.filter((t) => !t.parentId || !ids.has(t.parentId));
    const endDate = stored.reduce<string | null>((m, t) => (m === null || t.endDate > m ? t.endDate : m), null);
    const project = toProjectDto(p, { roots, endDate, taskCount: stored.length });
    return { project, tasks, dependencies: deps.map(toDependencyDto), calendar: toCalendarDto(calendar) };
  }

  // ─────────────────────────────────────────── Excel (ADR-019)

  async exportXlsx(id: string, viewer: Viewer, ctx: RequestContext): Promise<{ filename: string; buffer: Buffer }> {
    const g = await this.gantt(id, viewer);
    const generatedAt = new Date();
    const buffer = await buildTasksWorkbook(
      {
        name: g.project.name,
        status: g.project.status,
        startDate: g.project.startDate,
        endDate: g.project.endDate,
        progress: projectProgress(g.tasks.filter((t) => !t.parentId)),
        calendarName: g.calendar.name,
        autoSchedule: g.project.autoSchedule,
        generatedAt,
      },
      g.tasks.map((t) => ({
        wbs: t.wbs,
        name: t.name,
        type: t.type,
        startDate: t.startDate,
        endDate: t.endDate,
        durationDays: t.durationDays,
        progress: t.progress,
        status: t.status,
        priority: t.priority,
        assigneeName: t.assignee?.fullName ?? null,
        teamName: t.assignee?.teamName ?? null,
        description: t.description,
      })),
    );
    await this.audit.logCtx(ctx, {
      action: AuditAction.PROJECT_EXPORTED,
      entityType: 'project',
      entityId: id,
      after: { format: 'xlsx', tasks: g.tasks.length },
    });
    return { filename: `project-${id.slice(0, 8)}-${isoOf(generatedAt)}.xlsx`, buffer };
  }
}
