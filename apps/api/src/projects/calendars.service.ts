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
import { dateOf, DEFAULT_WORKING_HOURS, isoOf, parseWorkingHours } from './task-engine';
import type { WorkingHours } from '@nuzli/scheduling';

type CreateCalendar = z.output<typeof calendarSchema>;
type UpdateCalendar = z.output<typeof updateCalendarSchema>;
type CreateException = z.output<typeof calendarExceptionSchema>;
export type CalendarWithDefault = CalendarDto & { isDefault: boolean };

const normalizeWeekend = (days: number[]): number[] => [...new Set(days)].sort((a, b) => a - b);

/** Sorted intervals as a stable string (equality of working days). */
export const hoursKey = (h: readonly WorkingHours[]): string =>
  [...h]
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map((w) => `${w.start}-${w.end}`)
    .join(',');

/** Weekend days from a list of working days (0 = Sunday … 6 = Saturday). */
export const weekendFromWorkingDays = (working: readonly number[]): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => !working.includes(d));

export interface CalendarSpec {
  /** The calendar to start from (its holidays are copied); default = the default calendar. */
  baseId?: string;
  weekendDays?: number[];
  workingHours?: WorkingHours[];
  /** Exceptions of the new calendar (imports); default = the base calendar's. */
  exceptions?: Array<{ date: string; isWorking: boolean; name: string; workingHours?: WorkingHours[] | null }>;
  /** Name of a created calendar. */
  name: string;
}

/**
 * A9 (create form, imports): returns a calendar matching `spec`. The base calendar is reused
 * when the requested working days and hours equal its own (and no exceptions are imposed);
 * otherwise a calendar is created — with the base calendar's holidays, or the given exceptions —
 * and audited as `calendar.created`.
 */
export async function ensureProjectCalendar(
  tx: Db,
  audit: AuditService,
  ctx: RequestContext,
  spec: CalendarSpec,
): Promise<{ id: string; created: boolean }> {
  const base = spec.baseId
    ? await tx.calendar.findUnique({ where: { id: spec.baseId }, select: CALENDAR_SELECT })
    : await tx.calendar.findFirst({ where: { isDefault: true }, select: CALENDAR_SELECT });
  if (spec.baseId && !base) {
    throw new AppError('VALIDATION_FAILED', { fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] } });
  }
  const baseWeekend = base ? normalizeWeekend(base.weekendDays) : [5, 6];
  const baseHours = base ? (parseWorkingHours(base.workingHours) ?? DEFAULT_WORKING_HOURS) : DEFAULT_WORKING_HOURS;
  const weekendDays = spec.weekendDays ? normalizeWeekend(spec.weekendDays) : baseWeekend;
  const workingHours = spec.workingHours ?? baseHours;
  if (base && !spec.exceptions && weekendDays.join(',') === baseWeekend.join(',') && hoursKey(workingHours) === hoursKey(baseHours)) {
    return { id: base.id, created: false };
  }
  if (weekendDays.length >= 7) {
    throw new AppError('VALIDATION_FAILED', { fieldErrors: { workingDays: ['اختر يوم عمل واحدًا على الأقل'] } });
  }
  const exceptions =
    spec.exceptions ??
    (base?.exceptions ?? []).map((e) => ({ date: isoOf(e.date), isWorking: e.isWorking, name: e.name, workingHours: parseWorkingHours(e.workingHours, null) }));
  const unique = new Map(exceptions.map((e) => [e.date, e]));
  const created = await tx.calendar.create({
    data: {
      name: spec.name.slice(0, 80),
      weekendDays,
      workingHours: workingHours.map((w) => ({ start: w.start, end: w.end })) as unknown as Prisma.InputJsonValue,
      createdById: ctx.actorId,
      ...(unique.size
        ? {
            exceptions: {
              createMany: {
                data: [...unique.values()].map((e) => ({
                  date: dateOf(e.date),
                  isWorking: e.isWorking,
                  name: e.name.slice(0, 120) || 'استثناء',
                  workingHours: e.isWorking && e.workingHours ? (e.workingHours as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                  createdById: ctx.actorId,
                })),
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  await audit.logCtx(
    ctx,
    {
      action: AuditAction.CALENDAR_CREATED,
      entityType: 'calendar',
      entityId: created.id,
      after: { name: spec.name, weekendDays, workingHours, exceptions: unique.size, baseCalendarId: base?.id ?? null },
    },
    tx,
  );
  return { id: created.id, created: true };
}

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
    const workingHours = input.workingHours ?? DEFAULT_WORKING_HOURS;
    const c = await this.prisma.$transaction(async (tx) => {
      const created = await tx.calendar.create({
        data: { name: input.name, weekendDays, workingHours: workingHours as unknown as Prisma.InputJsonValue, createdById: ctx.actorId },
        select: CALENDAR_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.CALENDAR_CREATED, entityType: 'calendar', entityId: created.id, after: { name: input.name, weekendDays, workingHours } },
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
    // A9 hours: changing the working hours re-derives the HOUR projects on this calendar.
    const hoursChanged = !!input.workingHours && hoursKey(input.workingHours) !== hoursKey(cur.workingHours ?? DEFAULT_WORKING_HOURS);
    if (!weekendChanged && !nameChanged && !hoursChanged) return cur;
    await this.prisma.$transaction(async (tx) => {
      await tx.calendar.update({
        where: { id },
        data: {
          ...(nameChanged ? { name: input.name } : {}),
          ...(weekendChanged ? { weekendDays } : {}),
          ...(hoursChanged ? { workingHours: input.workingHours as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      const rescheduled = weekendChanged || hoursChanged ? await this.rescheduleUsers(tx, id, ctx, 'calendar.updated') : 0;
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.CALENDAR_UPDATED,
          entityType: 'calendar',
          entityId: id,
          before: {
            ...(nameChanged ? { name: cur.name } : {}),
            ...(weekendChanged ? { weekendDays: cur.weekendDays } : {}),
            ...(hoursChanged ? { workingHours: cur.workingHours } : {}),
          },
          after: {
            ...(nameChanged ? { name: input.name } : {}),
            ...(weekendChanged ? { weekendDays } : {}),
            ...(hoursChanged ? { workingHours: input.workingHours } : {}),
            ...(weekendChanged || hoursChanged ? { rescheduledTasks: rescheduled } : {}),
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
          data: {
            calendarId: id,
            date: dateOf(input.date),
            isWorking: input.isWorking,
            name: input.name,
            workingHours: input.isWorking && input.workingHours ? (input.workingHours as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            createdById: ctx.actorId,
          },
        });
        const rescheduled = await this.rescheduleUsers(tx, id, ctx, 'calendar_exception.created');
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.CALENDAR_EXCEPTION_CREATED,
            entityType: 'calendar',
            entityId: id,
            after: {
              exceptionId: created.id,
              date: input.date,
              isWorking: input.isWorking,
              name: input.name,
              ...(input.isWorking && input.workingHours ? { workingHours: input.workingHours } : {}),
              rescheduledTasks: rescheduled,
            },
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
