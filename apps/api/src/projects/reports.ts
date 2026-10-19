/**
 * A9 reports as pure functions (budget, people, dashboard, workload, portfolio totals), so
 * the arithmetic is unit-tested without a database. Money is summed in integer cents.
 */
import { WorkCalendar } from '@nuzli/scheduling';
import type {
  BudgetReportDto,
  CostLine,
  LabelDto,
  Priority,
  ProjectDashboardDto,
  ProjectPersonDto,
  TaskStatus,
  WorkloadDto,
} from '@nuzli/shared';
import { compareWbs } from './tasks-export';
import { addCalendarDaysIso, dateOf, deadlinePassed, dueDayOf, dueFlags, fromCents, projectProgress, toCents, type StoredTask } from './task-engine';

/** Calculations audit L11: shown under the «حسب الوسم» chart when a task carries several labels. */
export const BY_LABEL_OVERLAP_NOTE = 'المهمة ذات أكثر من وسم تُحسب تحت كلٍّ منها، لذا قد يزيد مجموع الأعمدة على الإجمالي.';

/** Minutes of one working day until the hours engine is integrated (A9: 09:00–13:00 + 14:00–18:00). */
export const WORKDAY_MINUTES = 480;

/** Longest range accepted by the workload and calendar endpoints. */
export const MAX_RANGE_DAYS = 366;

type Person = { id: string; fullName: string };

export function costLine(plannedCents: number, actualCents: number): CostLine {
  return { plannedCost: fromCents(plannedCents), actualCost: fromCents(actualCents), variance: fromCents(plannedCents - actualCents) };
}

/** Tasks without children (milestones included): the ones that carry their own cost. */
export function leavesOf<T extends Pick<StoredTask, 'id' | 'parentId'>>(tasks: readonly T[]): T[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  return tasks.filter((t) => !parents.has(t.id));
}

const byWbs = (a: { wbs: string }, b: { wbs: string }) => compareWbs(a.wbs, b.wbs);

export interface BudgetInput {
  projectId: string;
  currency: string;
  budget: number | null;
  tasks: readonly StoredTask[];
  labels: readonly LabelDto[];
  users: ReadonlyMap<string, Person>;
  /** Logged minutes per user on this project's tasks. */
  loggedByUser: ReadonlyMap<string, number>;
}

export function buildBudgetReport(input: BudgetInput): BudgetReportDto {
  // An empty GROUP (no live children) is not a leaf that carries work (calculations audit H2).
  const leaves = leavesOf(input.tasks).filter((t) => t.type !== 'GROUP');
  let planned = 0;
  let actual = 0;
  for (const t of leaves) {
    planned += toCents(t.plannedCost);
    actual += toCents(t.actualCost);
  }
  const budgetCents = input.budget === null ? null : toCents(input.budget);

  const byGroup = input.tasks
    .filter((t) => !t.parentId)
    .map((t) => ({ taskId: t.id, wbs: t.wbsCache, name: t.name, type: t.type, ...costLine(toCents(t.plannedCost), toCents(t.actualCost)) }))
    .sort(byWbs);

  const assignee = new Map<string | null, { p: number; a: number; n: number }>();
  for (const t of leaves) {
    const k = t.assigneeId;
    const cur = assignee.get(k) ?? { p: 0, a: 0, n: 0 };
    cur.p += toCents(t.plannedCost);
    cur.a += toCents(t.actualCost);
    cur.n++;
    assignee.set(k, cur);
  }
  for (const u of input.loggedByUser.keys()) if (!assignee.has(u)) assignee.set(u, { p: 0, a: 0, n: 0 });
  const byAssignee = [...assignee.entries()]
    .map(([id, v]) => ({
      assignee: id ? (input.users.get(id) ?? { id, fullName: '' }) : null,
      taskCount: v.n,
      loggedMinutes: id ? (input.loggedByUser.get(id) ?? 0) : 0,
      ...costLine(v.p, v.a),
    }))
    .sort((a, b) => b.plannedCost - a.plannedCost || (a.assignee?.fullName ?? '').localeCompare(b.assignee?.fullName ?? '', 'ar'));

  const labelById = new Map(input.labels.map((l) => [l.id, l]));
  const label = new Map<string | null, { p: number; a: number; n: number }>();
  let overlapping = false;
  for (const t of leaves) {
    const keys = t.labelIds.filter((l) => labelById.has(l));
    if (keys.length > 1) overlapping = true;
    for (const k of keys.length ? keys : [null]) {
      const cur = label.get(k) ?? { p: 0, a: 0, n: 0 };
      cur.p += toCents(t.plannedCost);
      cur.a += toCents(t.actualCost);
      cur.n++;
      label.set(k, cur);
    }
  }
  const byLabel = [...label.entries()]
    .map(([id, v]) => ({ label: id ? labelById.get(id)! : null, taskCount: v.n, ...costLine(v.p, v.a) }))
    .sort((a, b) => b.plannedCost - a.plannedCost || (a.label?.name ?? '').localeCompare(b.label?.name ?? '', 'ar'));

  const overBudgetTasks = leaves
    .filter((t) => toCents(t.actualCost) > toCents(t.plannedCost))
    .map((t) => ({
      taskId: t.id,
      wbs: t.wbsCache,
      name: t.name,
      plannedCost: t.plannedCost,
      actualCost: t.actualCost,
      overBy: fromCents(toCents(t.actualCost) - toCents(t.plannedCost)),
    }))
    .sort((a, b) => b.overBy - a.overBy || compareWbs(a.wbs, b.wbs));

  let logged = 0;
  for (const m of input.loggedByUser.values()) logged += m;

  return {
    projectId: input.projectId,
    currency: input.currency,
    budget: input.budget,
    ...costLine(planned, actual),
    budgetVariance: budgetCents === null ? null : fromCents(budgetCents - actual),
    budgetUsedPct: budgetCents ? Math.round((actual / budgetCents) * 10000) / 100 : null,
    loggedMinutes: logged,
    byGroup,
    byAssignee,
    byLabel,
    byLabelOverlapping: overlapping,
    byLabelNote: overlapping ? BY_LABEL_OVERLAP_NOTE : null,
    overBudgetTasks,
  };
}

export interface PeopleInput {
  tasks: readonly StoredTask[];
  cal: WorkCalendar;
  today: string;
  people: ReadonlyMap<string, ProjectPersonDto['assignee'] & object>;
  loggedByUser: ReadonlyMap<string, number>;
}

/** Per assignee of the project's leaves (non-group tasks); `assignee: null` = unassigned. */
export function buildPeople(input: PeopleInput): ProjectPersonDto[] {
  const leaves = leavesOf(input.tasks).filter((t) => t.type !== 'GROUP');
  let totalPlanned = 0;
  for (const t of leaves) totalPlanned += toCents(t.plannedCost);
  const groups = new Map<string | null, StoredTask[]>();
  for (const t of leaves) {
    const list = groups.get(t.assigneeId);
    if (list) list.push(t);
    else groups.set(t.assigneeId, [t]);
  }
  return [...groups.entries()]
    .map(([id, list]) => {
      let p = 0;
      let a = 0;
      for (const t of list) {
        p += toCents(t.plannedCost);
        a += toCents(t.actualCost);
      }
      return {
        assignee: id ? (input.people.get(id) ?? { id, fullName: '', teamColor: null, teamName: null }) : null,
        taskCount: list.length,
        doneCount: list.filter((t) => t.status === 'DONE').length,
        overdueCount: list.filter((t) => dueFlags(t, input.today, input.cal).overdue).length,
        progress: projectProgress(list),
        budgetShare: totalPlanned ? Math.round((p / totalPlanned) * 10000) / 100 : 0,
        loggedMinutes: id ? (input.loggedByUser.get(id) ?? 0) : 0,
        ...costLine(p, a),
      };
    })
    .sort((x, y) => (x.assignee === null ? 1 : y.assignee === null ? -1 : x.assignee.fullName.localeCompare(y.assignee.fullName, 'ar')));
}

const STATUSES: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD'];
const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** Calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86_400_000);
}

/** The Sunday on or before `iso`. */
export function weekStartOf(iso: string): string {
  return addCalendarDaysIso(iso, -dateOf(iso).getUTCDay());
}

/** Planned cost spread evenly over each leaf's working days, summed per week (Sunday start). */
export function plannedByWeek(tasks: readonly StoredTask[], cal: WorkCalendar): ProjectDashboardDto['budgetBurn']['plannedByWeek'] {
  const weeks = new Map<string, number>();
  for (const t of leavesOf(tasks)) {
    const cents = toCents(t.plannedCost);
    if (!cents) continue;
    const days: string[] = [];
    // HOUR tasks: by the days of their first and last working minute (an end at 24:00 belongs
    // to the day before — the shared due-day rule).
    const first = t.startDate.slice(0, 10);
    const last = dueDayOf(t);
    if (t.type === 'MILESTONE' || t.durationDays <= 0) days.push(first);
    else {
      for (let d = first; d <= last && days.length <= 3660; d = addCalendarDaysIso(d, 1)) if (cal.isWorkingDay(d)) days.push(d);
      if (!days.length) days.push(first);
    }
    // Spread the cents exactly: the first `rest` days get one cent more.
    const base = Math.floor(cents / days.length);
    let rest = cents - base * days.length;
    for (const d of days) {
      const w = weekStartOf(d);
      weeks.set(w, (weeks.get(w) ?? 0) + base + (rest > 0 ? 1 : 0));
      if (rest > 0) rest--;
    }
  }
  let cum = 0;
  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, c]) => {
      cum += c;
      return { weekStart, planned: fromCents(c), cumulative: fromCents(cum) };
    });
}

export interface DashboardInput {
  tasks: readonly StoredTask[];
  cal: WorkCalendar;
  today: string;
  budget: number | null;
  people: ReadonlyMap<string, Person>;
  loggedMinutes: number;
  /** Days ahead for the "upcoming" list (default 14). */
  horizonDays?: number;
}

export function buildDashboard(input: DashboardInput): Omit<ProjectDashboardDto, 'project'> {
  const leaves = leavesOf(input.tasks).filter((t) => t.type !== 'GROUP');
  const work = leaves.filter((t) => t.type !== 'MILESTONE');
  const statusDistribution = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const priorityDistribution = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  for (const t of work) {
    statusDistribution[t.status]++;
    priorityDistribution[t.priority]++;
  }
  const person = (id: string | null) => (id ? (input.people.get(id) ?? { id, fullName: '' }) : null);
  const overdueTasks = leaves.filter((t) => dueFlags(t, input.today, input.cal).overdue);
  const overdue = overdueTasks
    .map((t) => ({ taskId: t.id, wbs: t.wbsCache, name: t.name, endDate: t.endDate, daysOverdue: daysBetween(dueDayOf(t), input.today), assignee: person(t.assigneeId) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || compareWbs(a.wbs, b.wbs))
    .slice(0, 20);

  const horizon = addCalendarDaysIso(input.today, input.horizonDays ?? 14);
  const upcoming: ProjectDashboardDto['upcoming'] = [];
  for (const t of leaves) {
    if (t.status === 'DONE') continue;
    if (t.deadline && t.deadline >= input.today && t.deadline <= horizon) {
      upcoming.push({ taskId: t.id, wbs: t.wbsCache, name: t.name, date: t.deadline, kind: 'DEADLINE', assignee: person(t.assigneeId) });
    }
    const endDay = dueDayOf(t);
    if (endDay >= input.today && endDay <= horizon) {
      upcoming.push({ taskId: t.id, wbs: t.wbsCache, name: t.name, date: endDay, kind: t.type === 'MILESTONE' ? 'MILESTONE' : 'END', assignee: person(t.assigneeId) });
    }
  }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : compareWbs(a.wbs, b.wbs)));

  let planned = 0;
  let actual = 0;
  for (const t of leavesOf(input.tasks)) {
    planned += toCents(t.plannedCost);
    actual += toCents(t.actualCost);
  }
  const budgetCents = input.budget === null ? null : toCents(input.budget);
  const milestones = leaves.filter((t) => t.type === 'MILESTONE');
  return {
    kpis: {
      leafCount: work.length,
      done: statusDistribution.DONE,
      inProgress: statusDistribution.IN_PROGRESS,
      notStarted: statusDistribution.NOT_STARTED,
      onHold: statusDistribution.ON_HOLD,
      overdue: overdueTasks.length,
      deadlinePassed: leaves.filter((t) => deadlinePassed(t, input.today)).length,
      milestones: milestones.length,
      milestonesDone: milestones.filter((t) => t.status === 'DONE').length,
      loggedMinutes: input.loggedMinutes,
    },
    statusDistribution,
    priorityDistribution,
    overdue,
    budgetBurn: {
      budget: input.budget,
      plannedCost: fromCents(planned),
      actualCost: fromCents(actual),
      budgetUsedPct: budgetCents ? Math.round((actual / budgetCents) * 10000) / 100 : null,
      plannedByWeek: plannedByWeek(input.tasks, input.cal),
    },
    upcoming: upcoming.slice(0, 50),
  };
}

/** Calendar dates from..to inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addCalendarDaysIso(d, 1)) out.push(d);
  return out;
}

export interface WorkloadTask {
  assigneeId: string;
  type: StoredTask['type'];
  /** `YYYY-MM-DD` (the DATE columns, for both units). */
  startDate: string;
  endDate: string;
  /** A9 hours: HOUR tasks only — local date-times of the first working minute and of the end. */
  startAt?: string | null;
  endAt?: string | null;
  cal: WorkCalendar;
}

/**
 * Workload per person per day (A9 hours, ADR-109): a DAY task counts, on each of its working
 * days, the real working minutes of that day on its project calendar (480 on a default day, a
 * short day's own hours); an HOUR task counts only the working minutes it covers that day.
 * Two overlapping tasks add up (an overload). Milestones count 0. Logged minutes come from time
 * entries. `capacityMinutes` of a day = the working minutes of `capacity` (the default calendar)
 * that day. Days outside the range are ignored.
 */
export function computeWorkload(input: {
  from: string;
  to: string;
  users: readonly Person[];
  tasks: readonly WorkloadTask[];
  entries: ReadonlyArray<{ userId: string; date: string; minutes: number }>;
  /** The calendar that defines a person's capacity (default: Fri/Sat weekend, 09–13 / 14–18). */
  capacity?: WorkCalendar;
}): WorkloadDto {
  const capacity = input.capacity ?? new WorkCalendar({});
  const days = dateRange(input.from, input.to);
  const index = new Map(days.map((d, i) => [d, i]));
  const rows = new Map(
    input.users.map((u) => [
      u.id,
      { user: u, days: days.map((date) => ({ date, assignedMinutes: 0, loggedMinutes: 0, taskCount: 0, capacityMinutes: capacity.workingMinutesOfDay(date) })) },
    ]),
  );
  for (const t of input.tasks) {
    const row = rows.get(t.assigneeId);
    if (!row || t.type !== 'TASK') continue;
    const first = t.startDate.slice(0, 10);
    const last = t.endDate.slice(0, 10);
    const start = first > input.from ? first : input.from;
    const end = last < input.to ? last : input.to;
    for (let d = start; d <= end; d = addCalendarDaysIso(d, 1)) {
      let minutes: number;
      if (t.startAt && t.endAt) {
        const dayStart = `${d}T00:00`;
        const dayEnd = `${addCalendarDaysIso(d, 1)}T00:00`;
        minutes = t.cal.workingMinutesBetween(t.startAt > dayStart ? t.startAt : dayStart, t.endAt < dayEnd ? t.endAt : dayEnd);
      } else {
        minutes = t.cal.isWorkingDay(d) ? t.cal.workingMinutesOfDay(d) : 0;
      }
      if (minutes <= 0) continue;
      const cell = row.days[index.get(d)!]!;
      cell.assignedMinutes += minutes;
      cell.taskCount++;
    }
  }
  for (const e of input.entries) {
    const row = rows.get(e.userId);
    const i = index.get(e.date);
    if (row && i !== undefined) row.days[i]!.loggedMinutes += e.minutes;
  }
  return {
    from: input.from,
    to: input.to,
    days,
    capacityMinutesPerDay: capacity.standardMinutesPerDay,
    people: [...rows.values()].map((r) => ({
      user: r.user,
      days: r.days,
      totalAssignedMinutes: r.days.reduce((s, d) => s + d.assignedMinutes, 0),
      totalLoggedMinutes: r.days.reduce((s, d) => s + d.loggedMinutes, 0),
      // Calculations audit M4: the real capacity of the range (holidays 0, short days their minutes).
      totalCapacityMinutes: r.days.reduce((s, d) => s + d.capacityMinutes, 0),
    })),
  };
}

/** VALIDATION_FAILED details when `from > to` or the range is longer than `max` days. */
export function rangeProblem(from: string, to: string, max = MAX_RANGE_DAYS): string | null {
  if (from > to) return 'تاريخ البداية بعد تاريخ النهاية';
  if (daysBetween(from, to) + 1 > max) return `المدى أطول من ${max} يومًا`;
  return null;
}
