import type { Prisma } from '@prisma/client';
import {
  can,
  type CalendarDto,
  type DependencyDto,
  type PermissionSubject,
  type ProjectDto,
  type TaskDto,
} from '@nuzli/shared';
import { isoOf, projectProgress, type StoredTask } from './task-engine';

type Viewer = PermissionSubject & { id: string };

/**
 * Project data scope (ADR-007, docs/API.md "Phase 4"): ADMIN (`projects.readAll`) sees every
 * project; a SUPERVISOR (`projects.readGranted`) sees non-archived projects they were granted
 * or where a non-archived task is assigned to them. Anything else is invisible (→ 404).
 */
export function projectScopeWhere(viewer: Viewer): Prisma.ProjectWhereInput {
  if (can(viewer, 'projects.readAll')) return {};
  if (can(viewer, 'projects.readGranted')) {
    return {
      archivedAt: null,
      OR: [
        { access: { some: { userId: viewer.id } } },
        { tasks: { some: { assigneeId: viewer.id, archivedAt: null } } },
      ],
    };
  }
  return { id: { in: [] } };
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
} satisfies Prisma.TaskSelect;

export type StoredTaskRow = Prisma.TaskGetPayload<{ select: typeof STORED_TASK_SELECT }>;

export function toStored(r: StoredTaskRow): StoredTask {
  return {
    id: r.id,
    projectId: r.projectId,
    parentId: r.parentId,
    sortOrder: r.sortOrder,
    wbsCache: r.wbsCache,
    name: r.name,
    type: r.type,
    startDate: isoOf(r.startDate),
    endDate: isoOf(r.endDate),
    durationDays: r.durationDays,
    progress: Number(r.progress),
    status: r.status,
    priority: r.priority,
    assigneeId: r.assigneeId,
    description: r.description,
    version: r.version,
  };
}

/** Assignee with the colour and name of the first ACTIVE team they lead (brief §6.1 Gantt). */
export const ASSIGNEE_SELECT = {
  id: true,
  fullName: true,
  ledTeams: {
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    take: 1,
    select: { name: true, color: { select: { hex: true } } },
  },
} satisfies Prisma.UserSelect;

export const TASK_DTO_SELECT = {
  ...STORED_TASK_SELECT,
  assignee: { select: ASSIGNEE_SELECT },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskSelect;

export type TaskDtoRow = Prisma.TaskGetPayload<{ select: typeof TASK_DTO_SELECT }>;

export function toTaskDto(r: TaskDtoRow, attachments: ReadonlyMap<string, number>, wbs?: string): TaskDto {
  const team = r.assignee?.ledTeams[0];
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
  owner: { select: { id: true, fullName: true } },
} satisfies Prisma.ProjectSelect;

export type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

export interface ProjectStats {
  roots: Array<Pick<StoredTask, 'type' | 'durationDays' | 'progress'>>;
  endDate: string | null;
  taskCount: number;
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
    progress: projectProgress(stats.roots),
    taskCount: stats.taskCount,
    createdAt: p.createdAt.toISOString(),
  };
}

export const CALENDAR_SELECT = {
  id: true,
  name: true,
  weekendDays: true,
  isDefault: true,
  exceptions: { orderBy: { date: 'asc' }, select: { id: true, date: true, isWorking: true, name: true } },
} satisfies Prisma.CalendarSelect;

export type CalendarRow = Prisma.CalendarGetPayload<{ select: typeof CALENDAR_SELECT }>;

export function toCalendarDto(c: CalendarRow): CalendarDto & { isDefault: boolean } {
  return {
    id: c.id,
    name: c.name,
    weekendDays: [...c.weekendDays].sort((a, b) => a - b),
    isDefault: c.isDefault,
    exceptions: c.exceptions.map((e) => ({ id: e.id, date: isoOf(e.date), isWorking: e.isWorking, name: e.name })),
  };
}

export const DEPENDENCY_SELECT = {
  id: true,
  predecessorId: true,
  successorId: true,
  type: true,
  lagDays: true,
} satisfies Prisma.TaskDependencySelect;

export function toDependencyDto(d: Prisma.TaskDependencyGetPayload<{ select: typeof DEPENDENCY_SELECT }>): DependencyDto {
  return { id: d.id, predecessorId: d.predecessorId, successorId: d.successorId, type: d.type, lagDays: d.lagDays };
}
