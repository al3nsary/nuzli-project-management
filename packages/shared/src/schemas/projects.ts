import { z } from 'zod';
import { isoDate, optionalText, uuid } from './common';
import type { DependencyType, Priority, ProjectStatus, TaskStatus, TaskType } from '../enums';

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, { message: 'اكتب اسم المشروع' }).max(160),
  description: optionalText(4000),
  startDate: isoDate,
  calendarId: uuid.optional(),
  autoSchedule: z.boolean().default(true),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).default('PLANNING'),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export const updateProjectSchema = createProjectSchema.partial();

export const grantProjectAccessSchema = z.object({ userId: uuid, level: z.enum(['VIEW']).default('VIEW') });

export const createTaskSchema = z.object({
  parentId: uuid.nullable().optional(),
  /** Insert after this sibling; omitted = append. */
  afterId: uuid.nullable().optional(),
  name: z.string().trim().min(1, { message: 'اكتب اسم المهمة' }).max(300),
  type: z.enum(['TASK', 'GROUP', 'MILESTONE']).default('TASK'),
  startDate: isoDate,
  durationDays: z.number().int().min(0).max(3650).default(1),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']).default('NOT_STARTED'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  progress: z.number().min(0).max(100).default(0),
  assigneeId: uuid.nullable().optional(),
  description: optionalText(8000),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema
  .omit({ afterId: true })
  .partial()
  .extend({ version: z.number().int().min(0) });

/** One drag-end = one request with every task the engine shifted (brief §6.4). */
export const taskBatchSchema = z.object({
  changes: z
    .array(
      z.object({
        id: uuid,
        version: z.number().int().min(0),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        durationDays: z.number().int().min(0).optional(),
        progress: z.number().min(0).max(100).optional(),
        status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']).optional(),
        parentId: uuid.nullable().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .min(1)
    .max(5000),
});
export type TaskBatchInput = z.infer<typeof taskBatchSchema>;

export const createDependencySchema = z.object({
  predecessorId: uuid,
  successorId: uuid,
  type: z.enum(['FS', 'SS', 'FF', 'SF']).default('FS'),
  lagDays: z.number().int().min(-365).max(365).default(0),
});

export const taskCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  mentions: z.array(uuid).max(50).default([]),
});

export const calendarSchema = z.object({
  name: z.string().trim().min(2).max(80),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6).default([5, 6]),
});
export const calendarExceptionSchema = z.object({
  date: isoDate,
  isWorking: z.boolean().default(false),
  name: z.string().trim().min(1).max(120),
});

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  status: ProjectStatus;
  calendarId: string;
  autoSchedule: boolean;
  owner: { id: string; fullName: string };
  progress: number;
  taskCount: number;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  parentId: string | null;
  sortOrder: number;
  wbs: string;
  name: string;
  type: TaskType;
  startDate: string;
  endDate: string;
  durationDays: number;
  progress: number;
  status: TaskStatus;
  priority: Priority;
  assignee: { id: string; fullName: string; teamColor: string | null; teamName: string | null } | null;
  description: string | null;
  version: number;
  commentCount: number;
  attachmentCount: number;
}

export interface DependencyDto {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export interface CalendarDto {
  id: string;
  name: string;
  weekendDays: number[];
  exceptions: { id: string; date: string; isWorking: boolean; name: string }[];
}

export interface TaskCommentDto {
  id: string;
  author: { id: string; fullName: string };
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface ActivityDto {
  id: string;
  actor: { id: string; fullName: string } | null;
  action: string;
  at: string;
  before: unknown;
  after: unknown;
}

// ───────────────────────────── Phase 4 as built (additive; see docs/phase-4-backend.md)

/** `GET /projects?status=&q=` — without `status`: every non-archived project. */
export const projectListQuerySchema = z.object({
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED', 'ALL']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

/** `PATCH /calendars/:id`. */
export const updateCalendarSchema = calendarSchema.partial();

/** `POST /tasks/:id/attachments` — links a READY file uploaded with `entityType: 'task'`. */
export const taskAttachmentSchema = z.object({ fileId: uuid });

export interface ProjectAccessDto {
  user: { id: string; fullName: string; role: string };
  level: 'VIEW';
  grantedAt: string;
}

/** `GET /projects/:id/gantt` — the whole chart in one call. */
export interface GanttDto {
  project: ProjectDto;
  tasks: TaskDto[];
  dependencies: DependencyDto[];
  calendar: CalendarDto;
}

/** `POST /projects/:id/tasks` → the new task plus the rolled-up parents that changed. */
export type CreatedTaskDto = TaskDto & { affected: TaskDto[] };

/** `PATCH /tasks/:id`. `affected` = every other task the server changed (roll-ups, shifted successors). */
export interface TaskUpdateResult {
  task: TaskDto;
  affected: TaskDto[];
}

/** `POST /projects/:id/tasks/batch` → every task the server persisted (edited + shifted + rolled up). */
export interface TaskBatchResult {
  tasks: TaskDto[];
}

/** `DELETE /tasks/:id`. */
export interface TaskArchiveResult {
  archivedIds: string[];
  affected: TaskDto[];
}

/** `POST /projects/:id/dependencies` → the dependency plus the tasks it shifted. */
export type CreatedDependencyDto = DependencyDto & { affected: TaskDto[] };

/** `409 CONFLICT_VERSION` details for task writes: nothing was written. */
export interface TaskVersionConflictDetails {
  refresh: 'tasks';
  conflicts: { id: string; currentVersion: number | null }[];
}

/** `GET /tasks/mine` — sorted by end date. */
export interface MyTaskDto extends TaskDto {
  project: { id: string; name: string };
  /** End date before today (Riyadh) and not DONE. */
  overdue: boolean;
  /** Not overdue, not DONE, and ends within 2 working days (project calendar). */
  dueSoon: boolean;
}

export interface TaskAttachmentDto {
  id: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; fullName: string } | null;
  createdAt: string;
}
