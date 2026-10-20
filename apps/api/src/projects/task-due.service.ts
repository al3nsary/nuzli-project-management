import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { WorkCalendar } from '@nuzli/scheduling';
import type { NotificationType } from '@nuzli/shared';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { addCalendarDaysIso, dateOf, DUE_SOON_WORKING_DAYS, isoOf, riyadhToday, workCalendarOf } from './task-engine';

/** Candidates are read up to this many calendar days ahead, then filtered by working days. */
const DUE_SOON_LOOKAHEAD_DAYS = 31;

export interface DueRunResult {
  dueSoon: number;
  overdue: number;
  /** A9: TASK_DEADLINE_PASSED sent. */
  deadlinePassed: number;
}

/**
 * Daily reminders (brief §9): TASK_DUE_SOON (ends within 2 working days of the project
 * calendar, not DONE) and TASK_OVERDUE (ended before today, not DONE), each **once** per task.
 * The `*_notified_at` column is claimed with a conditional update before notifying, so a
 * second run — or two instances running at once — never sends twice. Date edits reset the
 * columns (ProjectStore.persist), so a moved task is reminded again.
 */
@Injectable()
export class TaskDueService {
  private readonly logger = new Logger(TaskDueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 0 7 * * *', { name: 'task-due-reminders', timeZone: 'Asia/Riyadh' })
  async cronRun(): Promise<void> {
    // A12: one pass per workspace (ADR-143); the notifications land in that workspace.
    await this.prisma.forEachWorkspace('task-due-reminders', async (ws) => {
      try {
        const r = await this.run();
        if (r.dueSoon || r.overdue || r.deadlinePassed) {
          this.logger.log(`Task reminders (${ws.id}): ${r.dueSoon} due soon, ${r.overdue} overdue, ${r.deadlinePassed} past deadline`);
        }
      } catch (err) {
        this.logger.error(`Task reminders failed (${ws.id}): ${(err as Error).message}`);
      }
    });
  }

  async run(now: Date = new Date()): Promise<DueRunResult> {
    const today = riyadhToday(now);
    // Calculations audit L10: groups are never reminded (a TASK promoted to GROUP keeps its
    // assignee); the demo sweeps leaves only too. The DATE column end_date is the due day (L6).
    const base = {
      archivedAt: null,
      type: { not: 'GROUP' as const },
      assigneeId: { not: null },
      status: { not: 'DONE' as const },
      project: { archivedAt: null },
    };
    const select = {
      id: true,
      name: true,
      endDate: true,
      assigneeId: true,
      projectId: true,
      project: { select: { name: true, calendarId: true } },
    } as const;

    const overdue = await this.prisma.task.findMany({
      where: { ...base, overdueNotifiedAt: null, endDate: { lt: dateOf(today) } },
      select,
    });
    let overdueSent = 0;
    for (const t of overdue) {
      if (await this.claim(t.id, 'overdueNotifiedAt', now)) {
        await this.send(t, 'TASK_OVERDUE');
        overdueSent++;
      }
    }

    const soon = await this.prisma.task.findMany({
      where: {
        ...base,
        dueSoonNotifiedAt: null,
        endDate: { gte: dateOf(today), lte: dateOf(addCalendarDaysIso(today, DUE_SOON_LOOKAHEAD_DAYS)) },
      },
      select,
    });
    const cals = await this.calendars([...new Set(soon.map((t) => t.project.calendarId))]);
    let soonSent = 0;
    for (const t of soon) {
      const cal = cals.get(t.project.calendarId);
      if (!cal || isoOf(t.endDate) > cal.addWorkingDays(today, DUE_SOON_WORKING_DAYS)) continue;
      if (await this.claim(t.id, 'dueSoonNotifiedAt', now)) {
        await this.send(t, 'TASK_DUE_SOON');
        soonSent++;
      }
    }
    // A9: the deadline (separate from the end date) passed — once per deadline, to the assignee
    // and the project owner. Changing the deadline resets the column (ProjectStore.persist).
    const late = await this.prisma.task.findMany({
      where: {
        archivedAt: null,
        type: { not: 'GROUP' },
        status: { not: 'DONE' },
        project: { archivedAt: null, isTemplate: false },
        deadlineNotifiedAt: null,
        deadline: { lt: dateOf(today) },
      },
      select: { ...select, deadline: true, project: { select: { name: true, calendarId: true, ownerId: true } } },
    });
    let deadlineSent = 0;
    for (const t of late) {
      if (!(await this.claim(t.id, 'deadlineNotifiedAt', now))) continue;
      const to = [...new Set([t.assigneeId, t.project.ownerId].filter((u): u is string => !!u))];
      await this.notifications
        .notify(to, 'TASK_DEADLINE_PASSED', {
          taskId: t.id,
          taskName: t.name,
          projectId: t.projectId,
          projectName: t.project.name,
          deadline: t.deadline ? isoOf(t.deadline) : null,
          endDate: isoOf(t.endDate),
        })
        .catch((err: unknown) => this.logger.warn(`Deadline reminder for task ${t.id} failed: ${(err as Error).message}`));
      deadlineSent++;
    }
    return { dueSoon: soonSent, overdue: overdueSent, deadlinePassed: deadlineSent };
  }

  private async calendars(ids: string[]): Promise<Map<string, WorkCalendar>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.calendar.findMany({
      where: { id: { in: ids } },
      select: { id: true, weekendDays: true, exceptions: { select: { date: true, isWorking: true } } },
    });
    return new Map(rows.map((c) => [c.id, workCalendarOf(c)]));
  }

  /** Conditional update: only the run that flips the column from NULL notifies. */
  private async claim(id: string, column: 'dueSoonNotifiedAt' | 'overdueNotifiedAt' | 'deadlineNotifiedAt', now: Date): Promise<boolean> {
    const res = await this.prisma.task.updateMany({ where: { id, [column]: null }, data: { [column]: now } });
    return res.count === 1;
  }

  private async send(
    t: { id: string; name: string; endDate: Date; assigneeId: string | null; projectId: string; project: { name: string } },
    type: NotificationType,
  ): Promise<void> {
    if (!t.assigneeId) return;
    await this.notifications
      .notify([t.assigneeId], type, {
        taskId: t.id,
        taskName: t.name,
        projectId: t.projectId,
        projectName: t.project.name,
        endDate: isoOf(t.endDate),
      })
      .catch((err: unknown) => this.logger.warn(`Reminder for task ${t.id} failed: ${(err as Error).message}`));
  }
}
