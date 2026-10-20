import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  BudgetReportDto,
  PermissionSubject,
  ProjectCalendarDto,
  ProjectDashboardDto,
  ProjectPersonDto,
  ProjectReportRow,
  WorkloadDto,
} from '@nuzli/shared';
import { progressWeight } from '@nuzli/scheduling';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  ASSIGNEE_SELECT,
  CALENDAR_SELECT,
  PROJECT_SELECT,
  STORED_TASK_SELECT,
  projectScopeWhere,
  toCalendarDto,
  toProjectDto,
  toStored,
} from './project-dto';
import { ProjectStore } from './project-store';
import { buildBudgetReport, buildDashboard, buildPeople, computeWorkload, leavesOf, rangeProblem } from './reports';
import { LABEL_SELECT, toLabelDto } from './task-details.service';
import { dateOf, deadlinePassed, dueFlags, isoOf, localOf, riyadhToday, workCalendarOf } from './task-engine';
import { compareWbs } from './tasks-export';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { memberOf, supervisorsOf } from '../users/user-dto';

type Viewer = PermissionSubject & { id: string };

const toPerson = (u: Prisma.UserGetPayload<{ select: typeof ASSIGNEE_SELECT }>) => {
  const team = u.teamSupervisions[0]?.team;
  return { id: u.id, fullName: u.fullName, teamColor: team?.color.hex ?? null, teamName: team?.name ?? null };
};

/**
 * A9 read models (admin): budget report, people, dashboard, cross-project report, workload
 * and the calendar tab. The arithmetic lives in `reports.ts`.
 */
@Injectable()
export class ProjectReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
  ) {}

  private async load(projectId: string, viewer: Viewer) {
    const p = await this.store.visibleProject(projectId, viewer);
    const [rows, calendar] = await Promise.all([
      this.prisma.task.findMany({ where: { projectId, archivedAt: null }, select: STORED_TASK_SELECT }),
      this.prisma.calendar.findUnique({ where: { id: p.calendarId }, select: CALENDAR_SELECT }),
    ]);
    if (!calendar) throw new AppError('NOT_FOUND');
    const tasks = rows.map(toStored);
    const cal = workCalendarOf({ weekendDays: calendar.weekendDays, workingHours: calendar.workingHours, exceptions: calendar.exceptions });
    return { p, tasks, calendar, cal };
  }

  private async people(ids: string[]) {
    if (!ids.length) return new Map<string, ReturnType<typeof toPerson>>();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: ASSIGNEE_SELECT });
    return new Map(users.map((u) => [u.id, toPerson(u)]));
  }

  /** Logged minutes per user on a project's live tasks. */
  private async loggedByUser(projectId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.timeEntry.groupBy({
      by: ['userId'],
      where: { task: { projectId, archivedAt: null } },
      _sum: { minutes: true },
    });
    return new Map(rows.map((r) => [r.userId, r._sum.minutes ?? 0]));
  }

  async budget(projectId: string, viewer: Viewer): Promise<BudgetReportDto> {
    const { p, tasks } = await this.load(projectId, viewer);
    const [labels, logged] = await Promise.all([
      this.prisma.projectLabel.findMany({ where: { projectId }, select: LABEL_SELECT }),
      this.loggedByUser(projectId),
    ]);
    const ids = [...new Set([...tasks.map((t) => t.assigneeId).filter((a): a is string => !!a), ...logged.keys()])];
    const users = await this.people(ids);
    return buildBudgetReport({
      projectId,
      currency: p.currency,
      budget: p.budget === null ? null : Number(p.budget),
      tasks,
      labels: labels.map(toLabelDto),
      users: new Map([...users].map(([k, v]) => [k, { id: v.id, fullName: v.fullName }])),
      loggedByUser: logged,
    });
  }

  async projectPeople(projectId: string, viewer: Viewer, now = new Date()): Promise<ProjectPersonDto[]> {
    const { tasks, cal } = await this.load(projectId, viewer);
    const logged = await this.loggedByUser(projectId);
    const people = await this.people([...new Set(tasks.map((t) => t.assigneeId).filter((a): a is string => !!a))]);
    return buildPeople({ tasks, cal, today: riyadhToday(now), people, loggedByUser: logged });
  }

  async dashboard(projectId: string, viewer: Viewer, now = new Date()): Promise<ProjectDashboardDto> {
    const { p, tasks, cal } = await this.load(projectId, viewer);
    const [logged, stats] = await Promise.all([this.loggedByUser(projectId), this.store.projectStats([projectId])]);
    const people = await this.people([...new Set(tasks.map((t) => t.assigneeId).filter((a): a is string => !!a))]);
    let loggedMinutes = 0;
    for (const m of logged.values()) loggedMinutes += m;
    return {
      project: toProjectDto(p, stats.get(projectId)!),
      ...buildDashboard({
        tasks,
        cal,
        today: riyadhToday(now),
        budget: p.budget === null ? null : Number(p.budget),
        people: new Map([...people].map(([k, v]) => [k, { id: v.id, fullName: v.fullName }])),
        loggedMinutes,
      }),
    };
  }

  /** `GET /reports/projects` — every visible non-template project with its counts. */
  async projectsReport(status: string | undefined, viewer: Viewer, now = new Date()): Promise<ProjectReportRow[]> {
    const statusWhere: Prisma.ProjectWhereInput =
      status === 'ALL'
        ? {}
        : status === 'ARCHIVED'
          ? { OR: [{ archivedAt: { not: null } }, { status: 'ARCHIVED' }] }
          : { archivedAt: null, ...(status ? { status: status as Prisma.EnumProjectStatusFilter['equals'] } : {}) };
    const projects = await this.prisma.project.findMany({
      where: { AND: [projectScopeWhere(viewer), { isTemplate: false }, statusWhere] },
      select: PROJECT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return this.rowsFor(projects, now);
  }

  /** Report rows (counts per project) for already-scoped project rows. */
  async rowsFor(projects: Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>[], now = new Date()): Promise<ProjectReportRow[]> {
    if (!projects.length) return [];
    const ids = projects.map((x) => x.id);
    const [stats, rows, calendars] = await Promise.all([
      this.store.projectStats(ids),
      this.prisma.task.findMany({
        where: { projectId: { in: ids }, archivedAt: null },
        select: { id: true, projectId: true, parentId: true, type: true, status: true, startDate: true, endDate: true, deadline: true },
      }),
      this.prisma.calendar.findMany({
        where: { id: { in: [...new Set(projects.map((x) => x.calendarId))] } },
        select: { id: true, weekendDays: true, workingHours: true, exceptions: { select: { date: true, isWorking: true, workingHours: true } } },
      }),
    ]);
    const cals = new Map(calendars.map((c) => [c.id, workCalendarOf(c)]));
    const today = riyadhToday(now);
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byProject.get(r.projectId);
      if (list) list.push(r);
      else byProject.set(r.projectId, [r]);
    }
    return projects.map((p) => {
      const cal = cals.get(p.calendarId) ?? workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
      const leaves = leavesOf(byProject.get(p.id) ?? []).filter((t) => t.type !== 'GROUP');
      // DATE columns: for HOUR tasks end_date is already the day of the last working minute (L6).
      const simple = leaves.map((t) => ({ ...t, startDate: isoOf(t.startDate), endDate: isoOf(t.endDate), deadline: t.deadline ? isoOf(t.deadline) : null }));
      const st = stats.get(p.id)!;
      // Portfolio weight (calculations audit): the project's duration in working days, like a
      // project weighs its roots — HOUR projects convert working minutes with the standard day.
      const w = st.roots.reduce((sum, r) => sum + progressWeight(r, p.durationUnit), 0);
      const progressWeightDays = p.durationUnit === 'HOUR' ? Math.round((w / cal.standardMinutesPerDay) * 100) / 100 : w;
      return {
        project: toProjectDto(p, st),
        progressWeightDays,
        leafCount: simple.filter((t) => t.type !== 'MILESTONE').length,
        doneCount: simple.filter((t) => t.type !== 'MILESTONE' && t.status === 'DONE').length,
        overdueCount: simple.filter((t) => dueFlags(t, today, cal).overdue).length,
        deadlinePassedCount: simple.filter((t) => deadlinePassed(t, today)).length,
        milestoneCount: simple.filter((t) => t.type === 'MILESTONE').length,
      };
    });
  }

  /** `GET /workload` — supervisors (or `userIds`) per day, assigned vs logged minutes. */
  async workload(q: { from: string; to: string; userIds?: string[] }): Promise<WorkloadDto> {
    const problem = rangeProblem(q.from, q.to, 92);
    if (problem) throw new AppError('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
    const users = await this.prisma.user.findMany({
      // A12: users of this workspace only.
      where: q.userIds ? { id: { in: q.userIds }, status: 'ACTIVE', ...memberOf(activeWorkspaceId()) } : supervisorsOf(activeWorkspaceId()),
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
    const userIds = users.map((u) => u.id);
    if (!userIds.length) return computeWorkload({ from: q.from, to: q.to, users: [], tasks: [], entries: [] });
    const [tasks, entries] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          assigneeId: { in: userIds },
          archivedAt: null,
          type: 'TASK',
          startDate: { lte: dateOf(q.to) },
          endDate: { gte: dateOf(q.from) },
          project: { archivedAt: null, isTemplate: false },
        },
        select: { assigneeId: true, type: true, startDate: true, endDate: true, startAt: true, endAt: true, project: { select: { calendarId: true } } },
      }),
      this.prisma.timeEntry.findMany({
        // Calculations audit L12: logged time counts only live tasks of live, non-template projects,
        // exactly like the assigned minutes.
        where: {
          userId: { in: userIds },
          date: { gte: dateOf(q.from), lte: dateOf(q.to) },
          task: { archivedAt: null, project: { archivedAt: null, isTemplate: false } },
        },
        select: { userId: true, date: true, minutes: true },
      }),
    ]);
    const calendarSelect = { id: true, isDefault: true, weekendDays: true, workingHours: true, exceptions: { select: { date: true, isWorking: true, workingHours: true } } } as const;
    const [calendars, defaultCal] = await Promise.all([
      this.prisma.calendar.findMany({ where: { id: { in: [...new Set(tasks.map((t) => t.project.calendarId))] } }, select: calendarSelect }),
      this.prisma.calendar.findFirst({ where: { isDefault: true }, select: calendarSelect }),
    ]);
    const cals = new Map(calendars.map((c) => [c.id, workCalendarOf(c)]));
    const fallback = defaultCal ? workCalendarOf(defaultCal) : workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
    return computeWorkload({
      from: q.from,
      to: q.to,
      users,
      capacity: fallback,
      tasks: tasks.map((t) => ({
        assigneeId: t.assigneeId!,
        type: t.type,
        startDate: isoOf(t.startDate),
        endDate: isoOf(t.endDate),
        startAt: t.startAt ? localOf(t.startAt) : null,
        endAt: t.endAt ? localOf(t.endAt) : null,
        cal: cals.get(t.project.calendarId) ?? fallback,
      })),
      entries: entries.map((e) => ({ userId: e.userId, date: isoOf(e.date), minutes: e.minutes })),
    });
  }

  /** `GET /projects/:id/calendar?from&to` — what the calendar tab draws. */
  async calendar(projectId: string, q: { from: string; to: string }, viewer: Viewer, now = new Date()): Promise<ProjectCalendarDto> {
    const problem = rangeProblem(q.from, q.to);
    if (problem) throw new AppError('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
    const { p, tasks, calendar } = await this.load(projectId, viewer);
    const today = riyadhToday(now);
    const items = tasks.filter(
      (t) => (t.startDate.slice(0, 10) <= q.to && t.endDate.slice(0, 10) >= q.from) || (t.deadline !== null && t.deadline >= q.from && t.deadline <= q.to),
    );
    const people = await this.people([...new Set(items.map((t) => t.assigneeId).filter((a): a is string => !!a))]);
    return {
      project: { id: p.id, name: p.name },
      calendar: toCalendarDto(calendar),
      from: q.from,
      to: q.to,
      items: items
        .map((t) => {
          const a = t.assigneeId ? people.get(t.assigneeId) : undefined;
          return {
            taskId: t.id,
            wbs: t.wbsCache,
            name: t.name,
            type: t.type,
            startDate: t.startDate,
            endDate: t.endDate,
            deadline: t.deadline,
            deadlinePassed: deadlinePassed(t, today),
            status: t.status,
            progress: t.progress,
            barColor: t.barColor,
            assignee: a ? { id: a.id, fullName: a.fullName, teamColor: a.teamColor } : null,
          };
        })
        .sort((a, b) => compareWbs(a.wbs, b.wbs)),
    };
  }
}
