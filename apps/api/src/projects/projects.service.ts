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
  ProjectExportFormat,
  ProjectListQuery,
  updateProjectSchema,
} from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId, activeWorkspaceIdOrNull } from '../prisma/workspace-context';
import { displayRole, ROLE_VIEW_SELECT } from '../users/user-dto';
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
import { FIELD_SELECT, LABEL_SELECT, toFieldDto, toLabelDto } from './task-details.service';
import { ensureProjectCalendar, weekendFromWorkingDays } from './calendars.service';
import { TemplatesService } from './templates.service';
import { dateOf, DEFAULT_WORKING_HOURS, dueDayOf, isoOf, rootsForProgress } from './task-engine';
import { buildTasksCsv, buildTasksWorkbook, compareWbs, type TaskExportRow } from './tasks-export';
import { writeMspdi } from '../imports/mspdi';
import { writeGanttpro } from '../imports/ganttpro';

type Viewer = PermissionSubject & { id: string };
type CreateProject = z.output<typeof createProjectSchema>;
type UpdateProject = z.output<typeof updateProjectSchema>;
type GrantAccess = z.output<typeof grantProjectAccessSchema>;

const PROJECT_FIELDS = ['name', 'description', 'startDate', 'status', 'calendarId', 'autoSchedule', 'budget', 'currency'] as const;

/** Projects, access grants, the Gantt payload and the Excel export (brief §6.1). */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly templates: TemplatesService,
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
        // A9: templates are listed by GET /project-templates only.
        AND: [projectScopeWhere(viewer), { isTemplate: false }, status, q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}],
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

  /**
   * A9 create form: `workingDays` / `workingHours` different from the base calendar create a
   * calendar for the project (ensureProjectCalendar); `durationUnit` sets DAY or HOUR.
   */
  async create(input: CreateProject, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const customCalendar = !!input.workingDays || !!input.workingHours;
    const calendarFor = (tx: Prisma.TransactionClient) =>
      ensureProjectCalendar(tx, this.audit, ctx, {
        baseId: input.calendarId,
        weekendDays: input.workingDays ? weekendFromWorkingDays(input.workingDays) : undefined,
        workingHours: input.workingHours,
        name: `تقويم ${input.name}`,
      });
    if (input.fromTemplateId) {
      const cal = customCalendar
        ? (await this.prisma.$transaction((tx) => calendarFor(tx))).id
        : input.calendarId
          ? await this.calendarIdOrDefault(input.calendarId)
          : null;
      return this.templates.createFromTemplate({ ...input, fromTemplateId: input.fromTemplateId }, cal, viewer, ctx);
    }
    const baseCalendarId = customCalendar ? null : await this.calendarIdOrDefault(input.calendarId);
    const p = await this.prisma.$transaction(async (tx) => {
      const calendarId = baseCalendarId ?? (await calendarFor(tx)).id;
      const created = await tx.project.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          startDate: dateOf(input.startDate),
          status: input.status,
          calendarId,
          autoSchedule: input.autoSchedule,
          durationUnit: input.durationUnit ?? 'DAY',
          ownerId: viewer.id,
          createdById: viewer.id,
          budget: input.budget ?? null,
          currency: input.currency ?? 'SAR',
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
          after: { ...input, calendarId, durationUnit: input.durationUnit ?? 'DAY', description: input.description ? `${input.description.length} حرفًا` : null },
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
      budget: cur.budget === null ? null : Number(cur.budget),
      currency: cur.currency,
    };
    const changed = PROJECT_FIELDS.filter((f) => input[f] !== undefined && input[f] !== before[f]);
    // A9 hours: a different durationUnit converts the project (same as POST /projects/:id/convert).
    const unitChange = input.durationUnit !== undefined && input.durationUnit !== cur.durationUnit;
    if (!changed.length && !unitChange) return this.dto(cur);
    if (!changed.length && unitChange) return this.convert(id, input.durationUnit!, viewer, ctx);
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
        if (unitChange && !updated.archivedAt) {
          await this.convertIn(tx, id, input.durationUnit!, cur.durationUnit, ctx);
          return tx.project.findUniqueOrThrow({ where: { id }, select: PROJECT_SELECT });
        }
        return updated;
      }, WRITE_TX_OPTIONS)
      .catch((err: unknown) => {
        throw mapTaskDbError(err);
      });
    return this.dto(p);
  }

  /**
   * `POST /projects/:id/convert { durationUnit }` (A9 hours, ADR-109): DAY ↔ HOUR with the
   * engine's conversions, every task rewritten in one transaction (see ProjectStore.convertUnit
   * for the milestone caveat). Audited `project.converted`. Same unit → the project unchanged.
   */
  async convert(id: string, unit: 'DAY' | 'HOUR', viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const cur = await this.store.visibleProject(id, viewer);
    if (cur.durationUnit === unit) return this.dto(cur);
    if (cur.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    const p = await this.prisma
      .$transaction(async (tx) => {
        await this.convertIn(tx, id, unit, cur.durationUnit, ctx);
        return tx.project.findUniqueOrThrow({ where: { id }, select: PROJECT_SELECT });
      }, WRITE_TX_OPTIONS)
      .catch((err: unknown) => {
        throw mapTaskDbError(err);
      });
    return this.dto(p);
  }

  private async convertIn(tx: Prisma.TransactionClient, id: string, unit: 'DAY' | 'HOUR', from: 'DAY' | 'HOUR', ctx: RequestContext): Promise<void> {
    const r = await this.store.convertUnit(tx, id, unit, ctx);
    await this.audit.logCtx(
      ctx,
      { action: AuditAction.PROJECT_CONVERTED, entityType: 'project', entityId: id, before: { durationUnit: from }, after: { durationUnit: unit, tasks: r.tasks } },
      tx,
    );
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
      select: { level: true, createdAt: true, user: { select: { id: true, fullName: true, ...ROLE_VIEW_SELECT } } },
      orderBy: { createdAt: 'asc' },
    });
    const ws = activeWorkspaceIdOrNull();
    return rows.map((r) => ({
      user: { id: r.user.id, fullName: r.user.fullName, role: displayRole(r.user, ws) },
      level: r.level,
      grantedAt: r.createdAt.toISOString(),
    }));
  }

  async grantAccess(id: string, input: GrantAccess, viewer: Viewer, ctx: RequestContext): Promise<ProjectAccessDto> {
    await this.store.visibleProject(id, viewer);
    // A12: a SUPERVISOR of this workspace only.
    const user = await this.prisma.user.findFirst({
      where: { id: input.userId, status: 'ACTIVE', memberships: { some: { workspaceId: activeWorkspaceId(), role: 'SUPERVISOR', status: 'ACTIVE', archivedAt: null } } },
      select: { id: true, fullName: true },
    });
    if (!user) {
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
    return { user: { id: user.id, fullName: user.fullName, role: 'SUPERVISOR' }, level: row.level, grantedAt: row.createdAt.toISOString() };
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

  /**
   * The whole chart in one call; since A9 also the labels, custom fields and per-task extras
   * (costs, deadline flag, bar colour, labels, checklist counts, custom values). The calendar
   * tab can use this payload or `GET /projects/:id/calendar`.
   */
  async gantt(id: string, viewer: Viewer): Promise<GanttDto> {
    const p = await this.store.visibleProject(id, viewer);
    const [rows, deps, calendar, labels, fields] = await Promise.all([
      this.prisma.task.findMany({ where: { projectId: id, archivedAt: null }, select: TASK_DTO_SELECT }),
      this.prisma.taskDependency.findMany({ where: { projectId: id }, select: DEPENDENCY_SELECT, orderBy: { createdAt: 'asc' } }),
      this.prisma.calendar.findUnique({ where: { id: p.calendarId }, select: CALENDAR_SELECT }),
      this.prisma.projectLabel.findMany({ where: { projectId: id }, select: LABEL_SELECT, orderBy: { name: 'asc' } }),
      this.prisma.customField.findMany({ where: { projectId: id }, select: FIELD_SELECT, orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
    ]);
    if (!calendar) throw new AppError('NOT_FOUND');
    const ids = new Set(rows.map((r) => r.id));
    const [counts, extras, unread] = await Promise.all([
      this.store.attachmentCounts([...ids]),
      this.store.taskExtras([...ids]),
      // A10: the chat icon of each row (one grouped query for the project).
      this.store.unreadCounts(viewer.id, { projectId: id }),
    ]);
    const stored = rows.map(toStored);
    const wbs = computeWbs(stored);
    const tasks = rows
      .map((r) => ({ ...toTaskDto(r, counts, wbs.get(r.id), extras), unreadCount: unread.get(r.id) ?? 0 }))
      .sort((a, b) => compareWbs(a.wbs, b.wbs));
    const roots = rootsForProgress(stored);
    // HOUR projects: the project's end date is the day of the last working minute (an end at
    // 24:00 belongs to the day before — the shared due-day rule, calculations audit L6).
    const endDate = stored.reduce<string | null>((m, t) => {
      const day = dueDayOf(t);
      return m === null || day > m ? day : m;
    }, null);
    const project = toProjectDto(p, { roots, endDate, taskCount: stored.length });
    return {
      project,
      tasks,
      dependencies: deps.map((d) => toDependencyDto(d, p.durationUnit)),
      calendar: toCalendarDto(calendar),
      labels: labels.map(toLabelDto),
      customFields: fields.map(toFieldDto),
    };
  }

  // ─────────────────────────────────────────── exports (ADR-019, A9 ADR-110)

  /** Kept for `GET /projects/:id/export.xlsx` (older clients). */
  exportXlsx(id: string, viewer: Viewer, ctx: RequestContext): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
    return this.exportProject(id, 'xlsx', viewer, ctx);
  }

  /**
   * `GET /projects/:id/export?format=xlsx|csv|xml|ganttpro`: Excel (RTL, no frozen panes, with costs,
   * deadline, labels and custom fields), CSV (same columns, UTF-8 BOM) or MS Project XML (MSPDI:
   * calendar, hours, summary tasks, links with lags, assignees as resources) or GanttPRO's Excel layout
   * (A10, ADR-125: `writeGanttpro`, re-imported identically). Audited
   * `project.exported` with the format. PDF/PNG of the Gantt are rendered in the browser.
   */
  async exportProject(
    id: string,
    format: ProjectExportFormat,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
    const g = await this.gantt(id, viewer);
    const generatedAt = new Date();
    const unit = g.project.durationUnit ?? 'DAY';
    const labelName = new Map((g.labels ?? []).map((l) => [l.id, l.name]));
    const customFields = (g.customFields ?? []).map((cf) => ({ id: cf.id, name: cf.name, type: cf.type }));
    const rows: TaskExportRow[] = g.tasks.map((t) => ({
      wbs: t.wbs,
      name: t.name,
      type: t.type,
      startDate: t.startDate,
      endDate: t.endDate,
      durationDays: t.durationDays,
      ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
      progress: t.progress,
      status: t.status,
      priority: t.priority,
      assigneeName: t.assignee?.fullName ?? null,
      teamName: t.assignee?.teamName ?? null,
      description: t.description,
      plannedCost: t.plannedCost ?? 0,
      actualCost: t.actualCost ?? 0,
      deadline: t.deadline ?? null,
      labels: (t.labelIds ?? []).map((l) => labelName.get(l)).filter((n): n is string => !!n),
      customValues: t.customValues ?? {},
    }));
    const base = `project-${id.slice(0, 8)}-${isoOf(generatedAt)}`;
    let out: { filename: string; buffer: Buffer; contentType: string };
    if (format === 'csv') {
      out = { filename: `${base}.csv`, buffer: buildTasksCsv({ durationUnit: unit, customFields }, rows), contentType: 'text/csv; charset=utf-8' };
    } else if (format === 'xml') {
      const xml = writeMspdi({
        name: g.project.name,
        startDate: g.project.startDate,
        unit,
        currencyCode: g.project.currency,
        createdAt: new Date(g.project.createdAt),
        calendar: {
          name: g.calendar.name,
          weekendDays: g.calendar.weekendDays,
          workingHours: g.calendar.workingHours ?? DEFAULT_WORKING_HOURS,
          exceptions: g.calendar.exceptions.map((e) => ({ date: e.date, isWorking: e.isWorking, name: e.name, workingHours: e.workingHours ?? null })),
        },
        tasks: g.tasks.map((t) => ({
          id: t.id,
          parentId: t.parentId,
          wbs: t.wbs,
          name: t.name,
          type: t.type,
          startDate: t.startDate,
          endDate: t.endDate,
          durationDays: t.durationDays,
          ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
          progress: t.progress,
          plannedCost: t.plannedCost ?? 0,
          actualCost: t.actualCost ?? 0,
          deadline: t.deadline ?? null,
          notes: t.description,
          assigneeName: t.assignee?.fullName ?? null,
        })),
        deps: g.dependencies.map((d) => ({
          predecessorId: d.predecessorId,
          successorId: d.successorId,
          type: d.type,
          lagDays: d.lagDays,
          lagMinutes: d.lagHours !== undefined ? Math.round(d.lagHours * 60) : 0,
        })),
      });
      out = { filename: `${base}.xml`, buffer: Buffer.from(xml, 'utf8'), contentType: 'application/xml; charset=utf-8' };
    } else if (format === 'ganttpro') {
      // A10 (ADR-125): GanttPRO's Excel layout; our GanttPRO importer reads it back identically.
      const buffer = await writeGanttpro({
        name: g.project.name,
        unit,
        generatedAt,
        calendar: {
          name: g.calendar.name,
          weekendDays: g.calendar.weekendDays,
          workingHours: g.calendar.workingHours ?? DEFAULT_WORKING_HOURS,
          exceptions: g.calendar.exceptions.map((e) => ({ date: e.date, isWorking: e.isWorking, name: e.name, workingHours: e.workingHours ?? null })),
        },
        tasks: g.tasks.map((t) => ({
          id: t.id,
          parentId: t.parentId,
          wbs: t.wbs,
          name: t.name,
          type: t.type,
          startDate: t.startDate,
          endDate: t.endDate,
          durationDays: t.durationDays,
          ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
          progress: t.progress,
          status: t.status,
          priority: t.priority,
          assigneeName: t.assignee?.fullName ?? null,
          description: t.description,
          plannedCost: t.plannedCost ?? 0,
          actualCost: t.actualCost ?? 0,
          deadline: t.deadline ?? null,
          barColor: t.barColor ?? null,
        })),
        deps: g.dependencies.map((d) => ({
          predecessorId: d.predecessorId,
          successorId: d.successorId,
          type: d.type,
          lagDays: d.lagDays,
          lagMinutes: d.lagHours !== undefined ? Math.round(d.lagHours * 60) : 0,
        })),
      });
      out = { filename: `${base}-ganttpro.xlsx`, buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    } else {
      const buffer = await buildTasksWorkbook(
        {
          name: g.project.name,
          status: g.project.status,
          startDate: g.project.startDate,
          endDate: g.project.endDate,
          progress: g.project.progress,
          calendarName: g.calendar.name,
          autoSchedule: g.project.autoSchedule,
          generatedAt,
          durationUnit: unit,
          currency: g.project.currency,
          budget: g.project.budget ?? null,
          customFields,
        },
        rows,
      );
      out = { filename: `${base}.xlsx`, buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    await this.audit.logCtx(ctx, {
      action: AuditAction.PROJECT_EXPORTED,
      entityType: 'project',
      entityId: id,
      after: { format, tasks: g.tasks.length },
    });
    return out;
  }
}
