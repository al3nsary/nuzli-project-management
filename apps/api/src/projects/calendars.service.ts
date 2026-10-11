import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { calendarExceptionSchema, calendarSchema, CalendarDto, updateCalendarSchema } from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { CALENDAR_SELECT, toCalendarDto } from './project-dto';
import { ProjectStore, WRITE_TX_OPTIONS } from './project-store';
import { dateOf } from './task-engine';

type CreateCalendar = z.output<typeof calendarSchema>;
type UpdateCalendar = z.output<typeof updateCalendarSchema>;
type CreateException = z.output<typeof calendarExceptionSchema>;
export type CalendarWithDefault = CalendarDto & { isDefault: boolean };

const normalizeWeekend = (days: number[]): number[] => [...new Set(days)].sort((a, b) => a - b);

/**
 * Working calendars and their exceptions (brief §6.1, §10), ADMIN only. No holiday data is
 * invented: the bootstrap seed creates one default calendar with the Friday/Saturday weekend.
 * Any change that alters working days re-derives every non-archived project on the calendar
 * (durations stay in working days, so ends and successors move) in the same transaction.
 */
@Injectable()
export class CalendarsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CalendarWithDefault[]> {
    const rows = await this.prisma.calendar.findMany({ select: CALENDAR_SELECT, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    return rows.map(toCalendarDto);
  }

  async get(id: string): Promise<CalendarWithDefault> {
    const c = await this.prisma.calendar.findUnique({ where: { id }, select: CALENDAR_SELECT });
    if (!c) throw new AppError('NOT_FOUND');
    return toCalendarDto(c);
  }

  async create(input: CreateCalendar, ctx: RequestContext): Promise<CalendarWithDefault> {
    const weekendDays = normalizeWeekend(input.weekendDays);
    const c = await this.prisma.$transaction(async (tx) => {
      const created = await tx.calendar.create({
        data: { name: input.name, weekendDays, createdById: ctx.actorId },
        select: CALENDAR_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.CALENDAR_CREATED, entityType: 'calendar', entityId: created.id, after: { name: input.name, weekendDays } },
        tx,
      );
      return created;
    });
    return toCalendarDto(c);
  }

  /** Re-derives every non-archived project that uses the calendar. Returns tasks written. */
  private async rescheduleUsers(tx: Db, calendarId: string, ctx: RequestContext, cause: string): Promise<number> {
    const projects = await tx.project.findMany({ where: { calendarId, archivedAt: null }, select: { id: true } });
    let total = 0;
    for (const p of projects) total += await this.store.rescheduleProject(tx, p.id, ctx, cause);
    return total;
  }

  async update(id: string, input: UpdateCalendar, ctx: RequestContext): Promise<CalendarWithDefault> {
    const cur = await this.get(id);
    const weekendDays = input.weekendDays ? normalizeWeekend(input.weekendDays) : undefined;
    const weekendChanged = !!weekendDays && weekendDays.join(',') !== cur.weekendDays.join(',');
    const nameChanged = input.name !== undefined && input.name !== cur.name;
    if (!weekendChanged && !nameChanged) return cur;
    await this.prisma.$transaction(async (tx) => {
      await tx.calendar.update({
        where: { id },
        data: { ...(nameChanged ? { name: input.name } : {}), ...(weekendChanged ? { weekendDays } : {}) },
      });
      const rescheduled = weekendChanged ? await this.rescheduleUsers(tx, id, ctx, 'calendar.updated') : 0;
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.CALENDAR_UPDATED,
          entityType: 'calendar',
          entityId: id,
          before: { ...(nameChanged ? { name: cur.name } : {}), ...(weekendChanged ? { weekendDays: cur.weekendDays } : {}) },
          after: {
            ...(nameChanged ? { name: input.name } : {}),
            ...(weekendChanged ? { weekendDays, rescheduledTasks: rescheduled } : {}),
          },
        },
        tx,
      );
    }, WRITE_TX_OPTIONS);
    return this.get(id);
  }

  async addException(id: string, input: CreateException, ctx: RequestContext): Promise<CalendarWithDefault> {
    await this.get(id);
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.calendarException.create({
          data: { calendarId: id, date: dateOf(input.date), isWorking: input.isWorking, name: input.name, createdById: ctx.actorId },
        });
        const rescheduled = await this.rescheduleUsers(tx, id, ctx, 'calendar_exception.created');
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.CALENDAR_EXCEPTION_CREATED,
            entityType: 'calendar',
            entityId: id,
            after: { exceptionId: created.id, date: input.date, isWorking: input.isWorking, name: input.name, rescheduledTasks: rescheduled },
          },
          tx,
        );
      }, WRITE_TX_OPTIONS);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError('CALENDAR_DATE_EXISTS');
      throw err;
    }
    return this.get(id);
  }

  async deleteException(id: string, exceptionId: string, ctx: RequestContext): Promise<void> {
    const ex = await this.prisma.calendarException.findFirst({ where: { id: exceptionId, calendarId: id } });
    if (!ex) throw new AppError('NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      await tx.calendarException.delete({ where: { id: exceptionId } });
      const rescheduled = await this.rescheduleUsers(tx, id, ctx, 'calendar_exception.deleted');
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.CALENDAR_EXCEPTION_DELETED,
          entityType: 'calendar',
          entityId: id,
          before: { exceptionId, date: ex.date.toISOString().slice(0, 10), isWorking: ex.isWorking, name: ex.name },
          after: { rescheduledTasks: rescheduled },
        },
        tx,
      );
    }, WRITE_TX_OPTIONS);
  }
}
