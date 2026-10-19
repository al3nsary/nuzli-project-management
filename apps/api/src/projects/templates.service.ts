import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { WorkCalendar } from '@nuzli/scheduling';
import type {
  createProjectSchema,
  PermissionSubject,
  portfolioSchema,
  PortfolioDto,
  PortfolioSummaryDto,
  ProjectDto,
  saveAsTemplateSchema,
  updatePortfolioSchema,
} from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { PROJECT_SELECT, STORED_TASK_SELECT, projectScopeWhere, toProjectDto, toStored } from './project-dto';
import { mapTaskDbError, ProjectStore, WRITE_TX_OPTIONS } from './project-store';
import { ProjectReportsService } from './project-reports.service';
import {
  addCalendarDaysIso,
  dateOf,
  isoOf,
  minutesToHours,
  normalizeLeaf,
  recompute,
  workCalendarOf,
  type StoredTask,
  type Unit,
} from './task-engine';
import { TasksService } from './tasks.service';
import { daysBetween } from './reports';

type Viewer = PermissionSubject & { id: string };
type CreateProject = z.output<typeof createProjectSchema>;

/** Signed working-day distance from `from` to `to` (both snapped forward to a working day). */
export function workingOffset(cal: WorkCalendar, from: string, to: string): number {
  const a = cal.addWorkingDays(from, 0);
  const b = cal.addWorkingDays(to, 0);
  if (b >= a) return cal.workingDaysBetween(a, b) - 1;
  return -(cal.workingDaysBetween(b, a) - 1);
}

/**
 * Re-bases tasks from one project start to another (templates): every leaf keeps its offset in
 * working days from the project start (source calendar) and its duration (target calendar);
 * deadlines keep their offset in calendar days. Groups are rolled up afterwards by the engine.
 */
export function rebaseTasks<T extends StoredTask>(
  tasks: readonly T[],
  from: { start: string; cal: WorkCalendar },
  to: { start: string; cal: WorkCalendar },
  unit: Unit = 'DAY',
): T[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  const shiftDays = daysBetween(from.start, to.start);
  if (unit === 'HOUR') {
    // A9 hours: the offset is kept in working minutes from the first working minute of the start day.
    const fromStart = from.cal.nextWorkingMinute(`${from.start.slice(0, 10)}T00:00`);
    const toStartAt = to.cal.nextWorkingMinute(`${to.start.slice(0, 10)}T00:00`);
    return tasks.map((t) => {
      const deadline = t.deadline ? addCalendarDaysIso(t.deadline, shiftDays) : null;
      if (parents.has(t.id)) return { ...t, deadline };
      const offset =
        t.startDate >= fromStart ? from.cal.workingMinutesBetween(fromStart, t.startDate) : -from.cal.workingMinutesBetween(t.startDate, fromStart);
      const start = to.cal.addWorkingMinutes(toStartAt, offset);
      return normalizeLeaf({ ...t, startDate: start, deadline }, to.cal, false, 'HOUR');
    });
  }
  const toStart = to.cal.addWorkingDays(to.start, 0);
  return tasks.map((t) => {
    const deadline = t.deadline ? addCalendarDaysIso(t.deadline, shiftDays) : null;
    if (parents.has(t.id)) return { ...t, deadline };
    const start = to.cal.addWorkingDays(toStart, workingOffset(from.cal, from.start, t.startDate));
    return normalizeLeaf({ ...t, startDate: start, deadline }, to.cal, false, 'DAY');
  });
}

/** Parents before children (insert order for the FK on parent_id). */
export function topoOrder<T extends { id: string; parentId: string | null }>(tasks: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const k = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  const out: T[] = [];
  const queue = [...(byParent.get(null) ?? [])];
  while (queue.length) {
    const t = queue.shift()!;
    out.push(t);
    queue.push(...(byParent.get(t.id) ?? []));
  }
  return out;
}

const PORTFOLIO_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  projects: { select: { projectId: true }, orderBy: { createdAt: 'asc' } },
} as const;

type PortfolioRow = Prisma.PortfolioGetPayload<{ select: typeof PORTFOLIO_SELECT }>;

function toPortfolioDto(p: PortfolioRow): PortfolioDto {
  return { id: p.id, name: p.name, description: p.description, projectIds: p.projects.map((x) => x.projectId), createdAt: p.createdAt.toISOString() };
}

/**
 * A9 templates (projects with `is_template`) and portfolios (named groups of projects).
 * Copies go through the same write path as every task write (lock, recompute, persist).
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly reports: ProjectReportsService,
  ) {}

  private async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, WRITE_TX_OPTIONS);
    } catch (err) {
      throw mapTaskDbError(err);
    }
  }

  private async calendarOf(db: Db, id: string): Promise<WorkCalendar> {
    const c = await db.calendar.findUnique({
      where: { id },
      select: { weekendDays: true, workingHours: true, exceptions: { select: { date: true, isWorking: true, workingHours: true } } },
    });
    if (!c) throw new AppError('NOT_FOUND');
    return workCalendarOf(c);
  }

  /**
   * Copies labels, custom fields, live tasks (structure, durations, planned costs, deadlines,
   * bar colours, labels), dependencies and checklists from `sourceId` into the empty project
   * `targetId`. Progress, status, assignees and actual costs are reset; dates are re-based.
   */
  async copyContent(tx: Db, sourceId: string, targetId: string, ctx: RequestContext): Promise<number> {
    const [source, target] = await Promise.all([
      tx.project.findUnique({ where: { id: sourceId }, select: { startDate: true, calendarId: true, durationUnit: true } }),
      tx.project.findUnique({ where: { id: targetId }, select: { startDate: true, calendarId: true, durationUnit: true } }),
    ]);
    if (!source || !target) throw new AppError('NOT_FOUND');
    // A9 hours: a copy keeps the source's unit (templates are created with it).
    const unit: Unit = source.durationUnit ?? 'DAY';
    if ((target.durationUnit ?? 'DAY') !== unit) await tx.project.update({ where: { id: targetId }, data: { durationUnit: unit } });
    const [labels, fields, rows, deps, fromCal, toCal] = await Promise.all([
      tx.projectLabel.findMany({ where: { projectId: sourceId }, select: { id: true, name: true, color: true } }),
      tx.customField.findMany({ where: { projectId: sourceId }, select: { name: true, type: true, options: true, sort: true } }),
      tx.task.findMany({ where: { projectId: sourceId, archivedAt: null }, select: STORED_TASK_SELECT }),
      tx.taskDependency.findMany({ where: { projectId: sourceId }, select: { predecessorId: true, successorId: true, type: true, lagDays: true, lagMinutes: true } }),
      this.calendarOf(tx, source.calendarId),
      this.calendarOf(tx, target.calendarId),
    ]);
    const labelMap = new Map(labels.map((l) => [l.id, randomUUID() as string]));
    if (labels.length) {
      await tx.projectLabel.createMany({
        data: labels.map((l) => ({ id: labelMap.get(l.id)!, projectId: targetId, name: l.name, color: l.color, createdById: ctx.actorId })),
      });
    }
    if (fields.length) {
      await tx.customField.createMany({
        data: fields.map((f) => ({ projectId: targetId, name: f.name, type: f.type, options: f.options as Prisma.InputJsonValue, sort: f.sort, createdById: ctx.actorId })),
      });
    }
    const sourceTasks = rows.map(toStored);
    const idMap = new Map(sourceTasks.map((t) => [t.id, randomUUID() as string]));
    const copies = rebaseTasks(
      sourceTasks.map((t) => ({
        ...t,
        id: idMap.get(t.id)!,
        projectId: targetId,
        parentId: t.parentId && idMap.has(t.parentId) ? idMap.get(t.parentId)! : null,
        progress: 0,
        status: 'NOT_STARTED' as const,
        assigneeId: null,
        actualCost: 0,
        version: 0,
        labelIds: t.labelIds.filter((l) => labelMap.has(l)).map((l) => labelMap.get(l)!).sort(),
      })),
      { start: isoOf(source.startDate), cal: fromCal },
      { start: isoOf(target.startDate), cal: toCal },
      unit,
    );
    const newDeps = deps
      .filter((d) => idMap.has(d.predecessorId) && idMap.has(d.successorId))
      .map((d) => ({
        id: randomUUID() as string,
        predecessorId: idMap.get(d.predecessorId)!,
        successorId: idMap.get(d.successorId)!,
        type: d.type,
        lagDays: d.lagDays,
        lagMinutes: d.lagMinutes ?? 0,
        ...(unit === 'HOUR' ? { lagHours: minutesToHours(d.lagMinutes ?? 0) } : {}),
      }));
    const s = await this.store.lockAndLoad(tx, targetId);
    const finals = recompute({
      tasks: [...s.tasks, ...copies],
      dependencies: [...s.deps, ...newDeps],
      calendar: s.cal,
      autoSchedule: s.project.autoSchedule,
      durationUnit: s.project.durationUnit,
    });
    await this.store.persistDetailed(tx, s, finals, {
      ctx,
      insertedMany: topoOrder(copies),
      explicit: new Set(copies.map((c) => c.id)),
      explicitAction: AuditAction.TASK_CREATED,
      auditExtra: { copiedFromProject: sourceId },
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
          projectId: targetId,
          createdById: ctx.actorId,
        })),
      });
    }
    await this.tasks.copyTaskDetails(tx, idMap, ctx.actorId, { resetChecklist: true, values: false });
    return copies.length;
  }

  // ─────────────────────────────────────────── templates

  async saveAsTemplate(projectId: string, input: z.output<typeof saveAsTemplateSchema>, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const p = await this.store.visibleProject(projectId, viewer);
    const created = await this.tx(async (tx) => {
      const t = await tx.project.create({
        data: {
          name: input.name ?? `${p.name} (قالب)`.slice(0, 160),
          description: input.description ?? p.description,
          startDate: p.startDate,
          status: 'PLANNING',
          calendarId: p.calendarId,
          autoSchedule: p.autoSchedule,
          ownerId: viewer.id,
          createdById: viewer.id,
          isTemplate: true,
          durationUnit: p.durationUnit,
          budget: p.budget,
          currency: p.currency,
        },
        select: PROJECT_SELECT,
      });
      const count = await this.copyContent(tx, projectId, t.id, ctx);
      await this.audit.logCtx(ctx, { action: AuditAction.PROJECT_SAVED_AS_TEMPLATE, entityType: 'project', entityId: t.id, after: { sourceProjectId: projectId, name: t.name, tasks: count } }, tx);
      return t;
    });
    return toProjectDto(created, (await this.store.projectStats([created.id])).get(created.id)!);
  }

  async listTemplates(viewer: Viewer): Promise<ProjectDto[]> {
    const rows = await this.prisma.project.findMany({
      where: { AND: [projectScopeWhere(viewer), { isTemplate: true, archivedAt: null }] },
      select: PROJECT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const stats = await this.store.projectStats(rows.map((r) => r.id));
    return rows.map((r) => toProjectDto(r, stats.get(r.id)!));
  }

  /** `POST /projects { fromTemplateId }` — a new project with the template's content, re-based to `startDate`. */
  async createFromTemplate(input: CreateProject & { fromTemplateId: string }, calendarId: string | null, viewer: Viewer, ctx: RequestContext): Promise<ProjectDto> {
    const tpl = await this.store.visibleProject(input.fromTemplateId, viewer);
    if (!tpl.isTemplate || tpl.archivedAt) throw new AppError('NOT_A_TEMPLATE');
    const created = await this.tx(async (tx) => {
      const p = await tx.project.create({
        data: {
          name: input.name,
          description: input.description ?? tpl.description,
          startDate: dateOf(input.startDate),
          status: input.status,
          calendarId: calendarId ?? tpl.calendarId,
          autoSchedule: input.autoSchedule,
          ownerId: viewer.id,
          createdById: viewer.id,
          templateOfId: tpl.id,
          durationUnit: tpl.durationUnit,
          budget: input.budget !== undefined ? input.budget : tpl.budget,
          currency: input.currency ?? tpl.currency,
          ...(input.status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
        },
        select: PROJECT_SELECT,
      });
      const count = await this.copyContent(tx, tpl.id, p.id, ctx);
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.PROJECT_CREATED,
          entityType: 'project',
          entityId: p.id,
          after: { name: p.name, startDate: input.startDate, calendarId: p.calendarId, fromTemplateId: tpl.id, tasks: count, budget: p.budget === null ? null : Number(p.budget), currency: p.currency },
        },
        tx,
      );
      return p;
    });
    return toProjectDto(created, (await this.store.projectStats([created.id])).get(created.id)!);
  }

  // ─────────────────────────────────────────── portfolios

  private async assertProjects(db: Db, ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const rows = await db.project.findMany({ where: { id: { in: unique }, isTemplate: false }, select: { id: true } });
    if (rows.length !== unique.length) {
      const ok = new Set(rows.map((r) => r.id));
      throw new AppError('NOT_FOUND', { projectIds: unique.filter((i) => !ok.has(i)) });
    }
  }

  async listPortfolios(): Promise<PortfolioDto[]> {
    const rows = await this.prisma.portfolio.findMany({ select: PORTFOLIO_SELECT, orderBy: { name: 'asc' } });
    return rows.map(toPortfolioDto);
  }

  async createPortfolio(input: z.output<typeof portfolioSchema>, ctx: RequestContext): Promise<PortfolioDto> {
    const projectIds = [...new Set(input.projectIds ?? [])];
    await this.assertProjects(this.prisma, projectIds);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const p = await tx.portfolio.create({ data: { name: input.name, description: input.description ?? null, createdById: ctx.actorId }, select: { id: true } });
        if (projectIds.length) await tx.portfolioProject.createMany({ data: projectIds.map((projectId) => ({ portfolioId: p.id, projectId })) });
        await this.audit.logCtx(ctx, { action: AuditAction.PORTFOLIO_CREATED, entityType: 'portfolio', entityId: p.id, after: { name: input.name, projectIds } }, tx);
        return tx.portfolio.findUniqueOrThrow({ where: { id: p.id }, select: PORTFOLIO_SELECT });
      }),
    );
    return toPortfolioDto(row);
  }

  async updatePortfolio(id: string, input: z.output<typeof updatePortfolioSchema>, ctx: RequestContext): Promise<PortfolioDto> {
    const cur = await this.prisma.portfolio.findUnique({ where: { id }, select: PORTFOLIO_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    if (input.projectIds) await this.assertProjects(this.prisma, input.projectIds);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const data: Prisma.PortfolioUpdateInput = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.description !== undefined) data.description = input.description ?? null;
        if (Object.keys(data).length) await tx.portfolio.update({ where: { id }, data });
        if (input.projectIds) {
          const next = [...new Set(input.projectIds)];
          await tx.portfolioProject.deleteMany({ where: { portfolioId: id, projectId: { notIn: next } } });
          await tx.portfolioProject.createMany({ data: next.map((projectId) => ({ portfolioId: id, projectId })), skipDuplicates: true });
        }
        await this.audit.logCtx(ctx, { action: AuditAction.PORTFOLIO_UPDATED, entityType: 'portfolio', entityId: id, before: { name: cur.name, projectIds: cur.projects.map((x) => x.projectId) }, after: { ...input } }, tx);
        return tx.portfolio.findUniqueOrThrow({ where: { id }, select: PORTFOLIO_SELECT });
      }),
    );
    return toPortfolioDto(row);
  }

  async setPortfolioProject(id: string, projectId: string, on: boolean, ctx: RequestContext): Promise<PortfolioDto> {
    const cur = await this.prisma.portfolio.findUnique({ where: { id }, select: PORTFOLIO_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    const ids = cur.projects.map((x) => x.projectId);
    if (on === ids.includes(projectId)) return toPortfolioDto(cur);
    return this.updatePortfolio(id, { projectIds: on ? [...ids, projectId] : ids.filter((x) => x !== projectId) }, ctx);
  }

  async deletePortfolio(id: string, ctx: RequestContext): Promise<void> {
    const cur = await this.prisma.portfolio.findUnique({ where: { id }, select: PORTFOLIO_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      await tx.portfolio.delete({ where: { id } });
      await this.audit.logCtx(ctx, { action: AuditAction.PORTFOLIO_DELETED, entityType: 'portfolio', entityId: id, before: { name: cur.name, projectIds: cur.projects.map((x) => x.projectId) } }, tx);
    });
  }

  /** `GET /portfolios/:id` — every project with its counts, plus totals. */
  async portfolioSummary(id: string, viewer: Viewer, now = new Date()): Promise<PortfolioSummaryDto> {
    const cur = await this.prisma.portfolio.findUnique({ where: { id }, select: PORTFOLIO_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    const projects = await this.prisma.project.findMany({
      where: { AND: [projectScopeWhere(viewer), { id: { in: cur.projects.map((x) => x.projectId) } }] },
      select: PROJECT_SELECT,
      orderBy: { startDate: 'asc' },
    });
    const rows = await this.reports.rowsFor(projects, now);
    return { ...toPortfolioDto(cur), projects: rows.map((r) => ({ project: r.project, overdueCount: r.overdueCount, leafCount: r.leafCount, doneCount: r.doneCount })), totals: portfolioTotals(rows) };
  }
}

/** Portfolio totals (pure; unit-tested). */
export function portfolioTotals(rows: ReadonlyArray<{ project: ProjectDto; leafCount: number; overdueCount: number }>): PortfolioSummaryDto['totals'] {
  let weighted = 0;
  let weights = 0;
  let plain = 0;
  let budgetCents: number | null = null;
  let planned = 0;
  let actual = 0;
  let start: string | null = null;
  let end: string | null = null;
  let overdue = 0;
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const p = r.project;
    weighted += p.progress * r.leafCount;
    weights += r.leafCount;
    plain += p.progress;
    if (p.budget !== null && p.budget !== undefined) budgetCents = (budgetCents ?? 0) + Math.round(p.budget * 100);
    planned += Math.round((p.plannedCost ?? 0) * 100);
    actual += Math.round((p.actualCost ?? 0) * 100);
    if (start === null || p.startDate < start) start = p.startDate;
    if (p.endDate && (end === null || p.endDate > end)) end = p.endDate;
    overdue += r.overdueCount;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }
  const progress = rows.length ? (weights ? weighted / weights : plain / rows.length) : 0;
  return {
    projectCount: rows.length,
    progress: Math.round(progress * 100) / 100,
    budget: budgetCents === null ? null : budgetCents / 100,
    plannedCost: planned / 100,
    actualCost: actual / 100,
    startDate: start,
    endDate: end,
    overdueCount: overdue,
    byStatus,
  };
}
