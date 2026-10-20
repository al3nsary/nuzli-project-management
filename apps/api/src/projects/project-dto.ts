import type { Prisma } from '@prisma/client';
import {
  projectColor,
  can,
  type CalendarDto,
  type DependencyDto,
  type PermissionSubject,
  type ProjectDto,
  type TaskDto,
} from '@nuzli/shared';
import {
  deadlinePassed,
  DEFAULT_WORKING_HOURS,
  fromCents,
  isoOf,
  localOf,
  minutesToHours,
  parseWorkingHours,
  projectProgress,
  riyadhToday,
  toCents,
  type StoredTask,
  type Unit,
} from './task-engine';
import { participantProjectIds, peerIds, projectLimit } from '../access/access-context';

type Viewer = PermissionSubject & { id: string };

/**
 * Project data scope.
 *  - `projects.readAll` (admins; assistants with projects/tasks): every project — an assistant
 *    limited to some projects (`scope.projectIds`) only those;
 *  - A12 round 2 — project participants (`project_participants`, any level): their non-archived,
 *    non-template projects;
 *  - `reports.read` (assistants with reports) reads projects for the reports routes only
 *    (`{ reports: true }`), within the same project limit.
 * Supervisors still see no project (ADR-092): they work through tasks (`taskScopeWhere`).
 * The legacy `project_access` table grants nothing (→ 404).
 */
export function projectScopeWhere(viewer: Viewer, opts: { reports?: boolean } = {}): Prisma.ProjectWhereInput {
  if (can(viewer, 'projects.readAll') || (opts.reports && can(viewer, 'reports.read'))) {
    const limit = projectLimit(viewer);
    return limit ? { id: { in: limit } } : {};
  }
  const part = participantProjectIds(viewer);
  if (part.length) return { id: { in: part }, archivedAt: null, isTemplate: false };
  return { id: { in: [] } };
}

/**
 * Task data scope (A9, ADR-092; A12 round 2):
 *  - `projects.readAll`: every task (an assistant limited to some projects: their tasks);
 *  - a SUPERVISOR (`tasks.readAssigned`): the live tasks assigned to them OR to any supervisor of
 *    the same team(s) (owner rule — `teamPeerIds`), in non-archived, non-template projects;
 *  - a project participant: every task of their projects.
 * Grants are OR-ed; none → nothing (404).
 */
export function taskScopeWhere(viewer: Viewer): Prisma.TaskWhereInput {
  if (can(viewer, 'projects.readAll')) {
    const limit = projectLimit(viewer);
    return limit ? { projectId: { in: limit } } : {};
  }
  const live = { archivedAt: null, isTemplate: false };
  const grants: Prisma.TaskWhereInput[] = [];
  if (can(viewer, 'tasks.readAssigned')) {
    const peers = peerIds(viewer);
    grants.push({ assigneeId: peers.length === 1 ? peers[0]! : { in: peers }, project: live });
  }
  const part = participantProjectIds(viewer);
  if (part.length) grants.push({ projectId: { in: part }, project: live });
  if (!grants.length) return { id: { in: [] } };
  return grants.length === 1 ? grants[0]! : { OR: grants };
}

/** Columns needed to recompute a project (`StoredTask`). */
export const STORED_TASK_SELECT = {
  id: true,
  projectId: true,
  parentId: true,
  sortOrder: true,
  wbsCache: true,
  name: true,
  type: true,
  startDate: true,
  endDate: true,
  durationDays: true,
  progress: true,
  status: true,
  priority: true,
  assigneeId: true,
  description: true,
  version: true,
  plannedCost: true,
  actualCost: true,
  deadline: true,
  barColor: true,
  startAt: true,
  endAt: true,
  durationMinutes: true,
  labels: { select: { labelId: true } },
} satisfies Prisma.TaskSelect;

export type StoredTaskRow = Prisma.TaskGetPayload<{ select: typeof STORED_TASK_SELECT }>;

/**
 * A9 hours (ADR-109): a row with `start_at` is a task of an HOUR project — its dates become local
 * Riyadh date-times and `durationHours` comes from `duration_minutes`; otherwise the DATE columns.
 */
export function toStored(r: StoredTaskRow): StoredTask {
  const hour = r.startAt != null && r.endAt != null;
  return {
    id: r.id,
    projectId: r.projectId,
    parentId: r.parentId,
    sortOrder: r.sortOrder,
    wbsCache: r.wbsCache,
    name: r.name,
    type: r.type,
    startDate: hour ? localOf(r.startAt!) : isoOf(r.startDate),
    endDate: hour ? localOf(r.endAt!) : isoOf(r.endDate),
    durationDays: r.durationDays,
    progress: Number(r.progress),
    status: r.status,
    priority: r.priority,
    assigneeId: r.assigneeId,
    description: r.description,
    version: r.version,
    plannedCost: Number(r.plannedCost),
    actualCost: Number(r.actualCost),
    deadline: r.deadline ? isoOf(r.deadline) : null,
    barColor: r.barColor,
    labelIds: r.labels.map((l) => l.labelId).sort(),
    ...(hour ? { durationHours: minutesToHours(r.durationMinutes ?? 0) } : {}),
  };
}

/**
 * Assignee with the colour and name of the first ACTIVE team they lead (brief §6.1 Gantt).
 * A9 (ADR-100): any open leadership row counts; a team they lead as primary comes first.
 */
export const ASSIGNEE_SELECT = {
  id: true,
  fullName: true,
  teamSupervisions: {
    where: { validTo: null, team: { status: 'ACTIVE' } },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
    take: 1,
    select: { team: { select: { name: true, color: { select: { hex: true } } } } },
  },
} satisfies Prisma.UserSelect;

export const TASK_DTO_SELECT = {
  ...STORED_TASK_SELECT,
  assignee: { select: ASSIGNEE_SELECT },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskSelect;

export type TaskDtoRow = Prisma.TaskGetPayload<{ select: typeof TASK_DTO_SELECT }>;

/** A9 extras loaded next to the task rows (ProjectStore.taskExtras). */
export interface TaskExtras {
  checklist: ReadonlyMap<string, { total: number; done: number }>;
  customValues: ReadonlyMap<string, Record<string, unknown>>;
  today: string;
}

export function toTaskDto(r: TaskDtoRow, attachments: ReadonlyMap<string, number>, wbs?: string, extras?: TaskExtras): TaskDto {
  const team = r.assignee?.teamSupervisions[0]?.team;
  const s = toStored(r);
  return {
    id: s.id,
    projectId: s.projectId,
    parentId: s.parentId,
    sortOrder: s.sortOrder,
    wbs: wbs ?? s.wbsCache,
    name: s.name,
    type: s.type,
    startDate: s.startDate,
    endDate: s.endDate,
    durationDays: s.durationDays,
    progress: s.progress,
    status: s.status,
    priority: s.priority,
    assignee: r.assignee
      ? { id: r.assignee.id, fullName: r.assignee.fullName, teamColor: team?.color.hex ?? null, teamName: team?.name ?? null }
      : null,
    description: s.description,
    version: s.version,
    commentCount: r._count.comments,
    attachmentCount: attachments.get(s.id) ?? 0,
    plannedCost: s.plannedCost,
    actualCost: s.actualCost,
    overBudget: toCents(s.actualCost) > toCents(s.plannedCost),
    deadline: s.deadline,
    deadlinePassed: deadlinePassed(s, extras?.today ?? riyadhToday()),
    barColor: s.barColor,
    labelIds: s.labelIds,
    checklist: extras?.checklist.get(s.id) ?? { total: 0, done: 0 },
    customValues: extras?.customValues.get(s.id) ?? {},
    ...(s.durationHours !== undefined ? { startAt: s.startDate, endAt: s.endDate, durationHours: s.durationHours } : {}),
  };
}

export const PROJECT_SELECT = {
  id: true,
  name: true,
  description: true,
  startDate: true,
  status: true,
  calendarId: true,
  autoSchedule: true,
  createdAt: true,
  archivedAt: true,
  budget: true,
  currency: true,
  isTemplate: true,
  durationUnit: true,
  coverFileId: true,
  owner: { select: { id: true, fullName: true } },
} satisfies Prisma.ProjectSelect;

export type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

export interface ProjectStats {
  /**
   * Root tasks. `durationHours` is set in HOUR projects (progress weighs by working minutes there,
   * calculations audit M1); `isEmptyGroup` marks a GROUP without live children (weighs 0, H2).
   */
  roots: Array<
    Pick<StoredTask, 'type' | 'durationDays' | 'progress'> &
      Partial<Pick<StoredTask, 'plannedCost' | 'actualCost' | 'durationHours'>> & { isEmptyGroup?: boolean }
  >;
  endDate: string | null;
  taskCount: number;
}

/** A9 project money: totals are the sums of the root tasks (each root already rolled up). */
export function projectMoney(budget: number | null, roots: ProjectStats['roots']) {
  let planned = 0;
  let actual = 0;
  for (const r of roots) {
    planned += toCents(r.plannedCost ?? 0);
    actual += toCents(r.actualCost ?? 0);
  }
  const budgetCents = budget === null ? null : toCents(budget);
  return {
    budget,
    plannedCost: fromCents(planned),
    actualCost: fromCents(actual),
    costVariance: fromCents(planned - actual),
    budgetVariance: budgetCents === null ? null : fromCents(budgetCents - actual),
    budgetUsedPct: budgetCents ? Math.round((actual / budgetCents) * 10000) / 100 : null,
  };
}

export function toProjectDto(p: ProjectRow, stats: ProjectStats): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    startDate: isoOf(p.startDate),
    endDate: stats.endDate,
    status: p.status,
    calendarId: p.calendarId,
    autoSchedule: p.autoSchedule,
    owner: { id: p.owner.id, fullName: p.owner.fullName },
    progress: projectProgress(stats.roots, p.durationUnit),
    taskCount: stats.taskCount,
    createdAt: p.createdAt.toISOString(),
    currency: p.currency,
    isTemplate: p.isTemplate,
    durationUnit: p.durationUnit,
    // A12 round 2: cover image (or the generated cover in the project's stable colour).
    hasCover: !!p.coverFileId,
    color: projectColor(p.id),
    ...projectMoney(p.budget === null ? null : Number(p.budget), stats.roots),
  };
}

export const CALENDAR_SELECT = {
  id: true,
  name: true,
  weekendDays: true,
  isDefault: true,
  workingHours: true,
  exceptions: { orderBy: { date: 'asc' }, select: { id: true, date: true, isWorking: true, name: true, workingHours: true } },
} satisfies Prisma.CalendarSelect;

export type CalendarRow = Prisma.CalendarGetPayload<{ select: typeof CALENDAR_SELECT }>;

export function toCalendarDto(c: CalendarRow): CalendarDto & { isDefault: boolean } {
  return {
    id: c.id,
    name: c.name,
    weekendDays: [...c.weekendDays].sort((a, b) => a - b),
    isDefault: c.isDefault,
    workingHours: parseWorkingHours(c.workingHours) ?? DEFAULT_WORKING_HOURS,
    exceptions: c.exceptions.map((e) => ({
      id: e.id,
      date: isoOf(e.date),
      isWorking: e.isWorking,
      name: e.name,
      workingHours: e.isWorking ? parseWorkingHours(e.workingHours, null) : null,
    })),
  };
}

export const DEPENDENCY_SELECT = {
  id: true,
  predecessorId: true,
  successorId: true,
  type: true,
  lagDays: true,
  lagMinutes: true,
} satisfies Prisma.TaskDependencySelect;

export type DependencyLike = Omit<Prisma.TaskDependencyGetPayload<{ select: typeof DEPENDENCY_SELECT }>, 'lagMinutes'> & { lagMinutes?: number };

/** `lagHours` is added for HOUR projects (A9 hours). */
export function toDependencyDto(d: DependencyLike, unit: Unit = 'DAY'): DependencyDto {
  return {
    id: d.id,
    predecessorId: d.predecessorId,
    successorId: d.successorId,
    type: d.type,
    lagDays: d.lagDays,
    ...(unit === 'HOUR' ? { lagHours: minutesToHours(d.lagMinutes ?? 0) } : {}),
  };
}
