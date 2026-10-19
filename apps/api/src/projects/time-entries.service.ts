import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { can, type PermissionSubject, type TimeEntryDto, type timeEntrySchema, type updateTimeEntrySchema } from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectStore } from './project-store';
import { rangeProblem } from './reports';
import { addCalendarDaysIso, dateOf, isoOf, riyadhToday } from './task-engine';

type Viewer = PermissionSubject & { id: string; fullName?: string };

const ENTRY_SELECT = {
  id: true,
  date: true,
  minutes: true,
  note: true,
  createdAt: true,
  userId: true,
  user: { select: { id: true, fullName: true } },
  task: { select: { id: true, name: true, projectId: true, project: { select: { name: true } } } },
} as const;

type EntryRow = Prisma.TimeEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

function toEntryDto(e: EntryRow): TimeEntryDto {
  return {
    id: e.id,
    task: { id: e.task.id, name: e.task.name, projectId: e.task.projectId, projectName: e.task.project.name },
    user: e.user,
    date: isoOf(e.date),
    minutes: e.minutes,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Security review A9 L3: an entry date lies within a year back and a week ahead (Riyadh days). */
export const TIME_ENTRY_PAST_DAYS = 366;
export const TIME_ENTRY_FUTURE_DAYS = 7;

export function assertEntryDate(date: string, now = new Date()): void {
  const today = riyadhToday(now);
  if (date < addCalendarDaysIso(today, -TIME_ENTRY_PAST_DAYS) || date > addCalendarDaysIso(today, TIME_ENTRY_FUTURE_DAYS)) {
    throw new AppError('VALIDATION_FAILED', { fieldErrors: { date: ['التاريخ خارج المدى المسموح: من سنة مضت إلى أسبوع قادم.'] } });
  }
}

/**
 * A9 time log (ADR-096). A supervisor logs time on tasks assigned to them and edits or deletes
 * only their own entries; an admin logs on any task (also for another active user) and edits
 * any entry. Entries feed the workload, people, budget and dashboard reports as hours —
 * actual cost stays a manual amount.
 */
@Injectable()
export class TimeEntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
  ) {}

  async forTask(taskId: string, viewer: Viewer): Promise<TimeEntryDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.timeEntry.findMany({ where: { taskId }, select: ENTRY_SELECT, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(toEntryDto);
  }

  async create(taskId: string, input: z.output<typeof timeEntrySchema>, viewer: Viewer, ctx: RequestContext): Promise<TimeEntryDto> {
    assertEntryDate(input.date);
    const task = await this.store.visibleTask(taskId, viewer);
    if (task.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    const admin = can(viewer, 'tasks.manage');
    if (!admin && task.assigneeId !== viewer.id) throw new AppError('TIME_ENTRY_NOT_ALLOWED');
    let userId = viewer.id;
    if (input.userId && input.userId !== viewer.id) {
      if (!admin) throw new AppError('FORBIDDEN', { fields: ['userId'] });
      const u = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { status: true } });
      if (!u || u.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', { fieldErrors: { userId: ['المستخدم غير نشط أو غير موجود'] } });
      userId = input.userId;
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.timeEntry.create({
        data: { taskId, userId, date: dateOf(input.date), minutes: input.minutes, note: input.note ?? null },
        select: ENTRY_SELECT,
      });
      await this.audit.logCtx(ctx, { action: AuditAction.TIME_ENTRY_CREATED, entityType: 'task', entityId: taskId, after: { entryId: created.id, userId, date: input.date, minutes: input.minutes } }, tx);
      return created;
    });
    return toEntryDto(row);
  }

  private async own(id: string, viewer: Viewer) {
    const e = await this.prisma.timeEntry.findUnique({
      where: { id },
      select: { ...ENTRY_SELECT, task: { select: { ...ENTRY_SELECT.task.select, assigneeId: true, archivedAt: true, project: { select: { name: true, archivedAt: true } } } } },
    });
    if (!e) throw new AppError('NOT_FOUND');
    if (!can(viewer, 'tasks.manage')) {
      // Someone else's entry is not revealed to a supervisor (404). Security review A9 L3: nor is
      // their own entry once the task is no longer assigned to them or is archived (ADR-092).
      if (e.userId !== viewer.id || e.task.assigneeId !== viewer.id || e.task.archivedAt) throw new AppError('NOT_FOUND');
    }
    if (e.task.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    return e;
  }

  async update(id: string, input: z.output<typeof updateTimeEntrySchema>, viewer: Viewer, ctx: RequestContext): Promise<TimeEntryDto> {
    if (input.date !== undefined) assertEntryDate(input.date);
    const cur = await this.own(id, viewer);
    const data: Prisma.TimeEntryUpdateInput = {};
    if (input.date !== undefined) data.date = dateOf(input.date);
    if (input.minutes !== undefined) data.minutes = input.minutes;
    if (input.note !== undefined) data.note = input.note ?? null;
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.timeEntry.update({ where: { id }, data, select: ENTRY_SELECT });
      await this.audit.logCtx(ctx, { action: AuditAction.TIME_ENTRY_UPDATED, entityType: 'task', entityId: cur.task.id, before: { entryId: id, date: isoOf(cur.date), minutes: cur.minutes }, after: { entryId: id, ...(input.date ? { date: input.date } : {}), ...(input.minutes ? { minutes: input.minutes } : {}) } }, tx);
      return updated;
    });
    return toEntryDto(row);
  }

  async remove(id: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    const cur = await this.own(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      await tx.timeEntry.delete({ where: { id } });
      await this.audit.logCtx(ctx, { action: AuditAction.TIME_ENTRY_DELETED, entityType: 'task', entityId: cur.task.id, before: { entryId: id, userId: cur.userId, date: isoOf(cur.date), minutes: cur.minutes } }, tx);
    });
  }

  /** `GET /me/time-entries?from&to` — own entries; default: the last 31 days (Riyadh). */
  async mine(viewer: Viewer, q: { from?: string; to?: string }, now = new Date()): Promise<TimeEntryDto[]> {
    const to = q.to ?? riyadhToday(now);
    const from = q.from ?? addCalendarDaysIso(to, -30);
    const problem = rangeProblem(from, to);
    if (problem) throw new AppError('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
    const rows = await this.prisma.timeEntry.findMany({
      where: { userId: viewer.id, date: { gte: dateOf(from), lte: dateOf(to) } },
      select: ENTRY_SELECT,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toEntryDto);
  }
}
