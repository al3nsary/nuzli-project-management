import { z } from 'zod';
import { hexColor, isoDate, optionalText, uuid } from './common';
import type { DependencyType, Priority, ProjectStatus, TaskStatus, TaskType } from '../enums';
import type { CustomFieldDto, LabelDto, TaskPreviousMap } from './projects-a9';

/** A9: money in the project currency, rounded to 2 decimals, up to numeric(14,2). */
export const money = z
  .number({ invalid_type_error: 'مبلغ غير صالح' })
  .min(0, { message: 'المبلغ لا يكون سالبًا' })
  .max(999_999_999_999.99, { message: 'المبلغ أكبر من المسموح' })
  .transform((v) => Math.round(v * 100) / 100);

/** ISO 4217 code (A9). The API defaults to SAR. */
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, { message: 'رمز عملة غير صالح' });

// ───────────────────────────── A9 hours (docs/API.md "A9 — imports, exports, hours", ADR-109)

/** Scheduling unit of a project: DAY (dates, working days) or HOUR (local date-times, working hours). */
export const DURATION_UNITS = ['DAY', 'HOUR'] as const;
export type ProjectDurationUnit = (typeof DURATION_UNITS)[number];
export const durationUnitSchema = z.enum(DURATION_UNITS);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, { message: 'وقت غير صالح' });
/** One working interval of a day, local wall clock `HH:MM` (end may be `24:00`). */
export const workingIntervalSchema = z
  .object({ start: hhmm, end: hhmm })
  .refine((w) => w.start < w.end, { message: 'نهاية الفترة قبل بدايتها' });
export const workingHoursSchema = z
  .array(workingIntervalSchema)
  .min(1, { message: 'أضف فترة عمل واحدة على الأقل' })
  .max(6)
  .refine(
    (list) => {
      const sorted = [...list].sort((a, b) => (a.start < b.start ? -1 : 1));
      return sorted.every((w, i) => i === 0 || sorted[i - 1]!.end <= w.start);
    },
    { message: 'فترات العمل متداخلة' },
  );
export type WorkingInterval = z.infer<typeof workingIntervalSchema>;
/** The A9 default working day: 09:00–13:00 and 14:00–18:00 (8 hours with a lunch break). */
export const DEFAULT_WORKING_INTERVALS: readonly WorkingInterval[] = [
  { start: '09:00', end: '13:00' },
  { start: '14:00', end: '18:00' },
];

/**
 * `YYYY-MM-DD` (DAY projects) or a local Riyadh date-time `YYYY-MM-DDTHH:MM` (HOUR projects;
 * seconds and an explicit `+03:00` are tolerated). A date sent to an HOUR project means the
 * first working minute of that day; a date-time sent to a DAY project keeps its date.
 */
export const dateOrLocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\+03:00)?)?$/, { message: 'تاريخ غير صالح' });

/** Working hours (HOUR projects), minute resolution. */
export const workingHoursAmount = z.number().min(0).max(87_600);

const projectFields = z.object({
  name: z.string().trim().min(2, { message: 'اكتب اسم المشروع' }).max(160),
  description: optionalText(4000),
  startDate: isoDate,
  calendarId: uuid.optional(),
  autoSchedule: z.boolean().default(true),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).default('PLANNING'),
  /** A9: the project budget cap (null = none). */
  budget: money.nullable().optional(),
  /** A9: defaults to SAR. */
  currency: currencyCode.optional(),
  /** A9 hours: DAY (default) or HOUR. On PATCH a different unit converts the project (= POST /projects/:id/convert). */
  durationUnit: durationUnitSchema.optional(),
});

export const createProjectSchema = projectFields.extend({
  /** A9: copy a template (structure, durations, dependencies, labels, custom fields, checklists); dates re-based to `startDate`. */
  fromTemplateId: uuid.optional(),
  /**
   * A9 create form: working days (0 = Sunday … 6 = Saturday) and working-hour intervals. When
   * they differ from the base calendar (`calendarId` or the default) a calendar is created for
   * the project, copying the base calendar's holidays.
   */
  workingDays: z.array(z.number().int().min(0).max(6)).min(1, { message: 'اختر يوم عمل واحدًا على الأقل' }).max(7).optional(),
  workingHours: workingHoursSchema.optional(),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export const updateProjectSchema = projectFields.partial();

export const grantProjectAccessSchema = z.object({ userId: uuid, level: z.enum(['VIEW']).default('VIEW') });

export const createTaskSchema = z.object({
  parentId: uuid.nullable().optional(),
  /** Insert after this sibling; omitted = append. */
  afterId: uuid.nullable().optional(),
  name: z.string().trim().min(1, { message: 'اكتب اسم المهمة' }).max(300),
  type: z.enum(['TASK', 'GROUP', 'MILESTONE']).default('TASK'),
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` in HOUR projects. */
  startDate: dateOrLocalDateTime,
  durationDays: z.number().int().min(0).max(3650).default(1),
  /** A9 hours: duration in working hours (HOUR projects; wins over durationDays there). */
  durationHours: workingHoursAmount.optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']).default('NOT_STARTED'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  progress: z.number().min(0).max(100).default(0),
  assigneeId: uuid.nullable().optional(),
  description: optionalText(8000),
  /** A9 budget. Groups ignore these: their costs are the sum of their children. */
  plannedCost: money.optional(),
  actualCost: money.optional(),
  /** A9: a deadline separate from the end date (null clears it). */
  deadline: isoDate.nullable().optional(),
  /** A9: custom bar colour `#RRGGBB` (null = the default colour). */
  barColor: hexColor.nullable().optional(),
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
        startDate: dateOrLocalDateTime.optional(),
        endDate: dateOrLocalDateTime.optional(),
        durationDays: z.number().int().min(0).optional(),
        /** A9 hours (HOUR projects). */
        durationHours: workingHoursAmount.optional(),
        progress: z.number().min(0).max(100).optional(),
        status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']).optional(),
        parentId: uuid.nullable().optional(),
        sortOrder: z.number().optional(),
        // A9: inverse (undo/redo) operations go through this same endpoint (ADR-095).
        name: z.string().trim().min(1).max(300).optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        assigneeId: uuid.nullable().optional(),
        plannedCost: money.optional(),
        actualCost: money.optional(),
        deadline: isoDate.nullable().optional(),
        barColor: hexColor.nullable().optional(),
        /** The full label set of the task (replaces it). */
        labelIds: z.array(uuid).max(50).optional(),
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
  /** A9 hours: lag (lead when negative) in working hours, HOUR projects (wins over lagDays there). */
  lagHours: z.number().min(-8760).max(8760).optional(),
});

export const taskCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  mentions: z.array(uuid).max(50).default([]),
  /** A9: quote an earlier comment of the same task (the thread stays a flat chat). */
  replyToId: uuid.nullable().optional(),
});

export const calendarSchema = z.object({
  name: z.string().trim().min(2).max(80),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6).default([5, 6]),
  /** A9 hours: working intervals of a normal working day (default 09:00–13:00, 14:00–18:00). */
  workingHours: workingHoursSchema.optional(),
});
export const calendarExceptionSchema = z.object({
  date: isoDate,
  isWorking: z.boolean().default(false),
  name: z.string().trim().min(1).max(120),
  /** A9 hours: the intervals of a special working day (null/absent = the calendar's hours). */
  workingHours: workingHoursSchema.nullable().optional(),
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
  // A9 — optional in the type for older clients; always sent by the API.
  /** Budget cap, null = none. */
  budget?: number | null;
  currency?: string;
  /** Sums over the root tasks (= over every leaf). */
  plannedCost?: number;
  actualCost?: number;
  /** plannedCost − actualCost. */
  costVariance?: number;
  /** budget − actualCost (null without a budget). */
  budgetVariance?: number | null;
  /** actualCost / budget × 100, 2 decimals (null without a budget or with a zero budget). */
  budgetUsedPct?: number | null;
  isTemplate?: boolean;
  /** A9 hours — always sent by the API. */
  durationUnit?: ProjectDurationUnit;
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
  // A9 — optional in the type; always sent by the API.
  plannedCost?: number;
  actualCost?: number;
  /** actualCost > plannedCost. */
  overBudget?: boolean;
  deadline?: string | null;
  /** Deadline before today (Riyadh) and not DONE. */
  deadlinePassed?: boolean;
  barColor?: string | null;
  labelIds?: string[];
  checklist?: { total: number; done: number };
  /** Custom field id → value (only fields that have a value). */
  customValues?: Record<string, unknown>;
  /**
   * A9 hours — HOUR projects only (absent in DAY projects): local Riyadh date-times
   * `YYYY-MM-DDTHH:MM`. `startAt` = the first working minute, `endAt` = the end of the last
   * working minute (exclusive). In HOUR projects `startDate`/`endDate` carry the same values
   * (the engine's representation) and `durationDays` = working days the task touches.
   */
  startAt?: string;
  endAt?: string;
  /** Working hours (HOUR projects). */
  durationHours?: number;
}

export interface DependencyDto {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  /** A9 hours: lag in working hours (HOUR projects only). */
  lagHours?: number;
}

export interface CalendarDto {
  id: string;
  name: string;
  weekendDays: number[];
  exceptions: { id: string; date: string; isWorking: boolean; name: string; workingHours?: WorkingInterval[] | null }[];
  /** A9 hours — always sent by the API. */
  workingHours?: WorkingInterval[];
}

export interface TaskCommentDto {
  id: string;
  author: { id: string; fullName: string };
  body: string;
  mentions: string[];
  createdAt: string;
  /** A9: the quoted comment (null when none, or when it was removed). */
  replyTo?: { id: string; authorName: string; bodyPreview: string } | null;
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
  /** A9: the project labels and custom fields (columns, filters, grouping). */
  labels?: LabelDto[];
  customFields?: CustomFieldDto[];
}

/** `POST /projects/:id/tasks` → the new task plus the rolled-up parents that changed. */
export type CreatedTaskDto = TaskDto & { affected: TaskDto[] };

/** `PATCH /tasks/:id`. `affected` = every other task the server changed (roll-ups, shifted successors). */
export interface TaskUpdateResult {
  task: TaskDto;
  affected: TaskDto[];
  /** A9 undo contract (ADR-095): the before-values of every changed field, per task id. */
  previous?: TaskPreviousMap;
}

/** `POST /projects/:id/tasks/batch` → every task the server persisted (edited + shifted + rolled up). */
export interface TaskBatchResult {
  tasks: TaskDto[];
  /** A9 undo contract (ADR-095). */
  previous?: TaskPreviousMap;
}

/** `DELETE /tasks/:id`. */
export interface TaskArchiveResult {
  archivedIds: string[];
  affected: TaskDto[];
  /** A9 undo contract: before-values of the tasks the archive shifted or rolled up. */
  previous?: TaskPreviousMap;
  /** A9: links removed with the archived tasks (re-create them after a restore). */
  deletedDependencies?: DependencyDto[];
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
