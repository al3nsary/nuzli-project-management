import { z } from 'zod';
import { hexColor, isoDate, optionalText, uuid } from './common';
import type { Priority, TaskStatus, TaskType } from '../enums';
import type { CalendarDto, DependencyDto, ProjectDto, TaskDto } from './projects';

/**
 * Owner request A9 (PROMPT §18): budget, labels, custom fields, checklists, deadlines, bar
 * colours, duplicate, bulk edit, undo contract, view preferences, templates, portfolios, time
 * log, workload, people, reports, dashboard, communication hub and the attachments browser.
 * Everything here is additive; docs/API.md "A9 — projects" is the index.
 */

// ───────────────────────────── undo contract (ADR-095)

/**
 * Before-values of a task, in wire format (`YYYY-MM-DD` dates). A response's `previous` map
 * holds, per changed task id, exactly the fields that changed (also on tasks the engine shifted
 * or rolled up). Sending `{ id, version: <new version>, ...previous[id] }` for every entry to
 * `POST /projects/:id/tasks/batch` is the inverse operation.
 */
export interface TaskPrevious {
  parentId?: string | null;
  sortOrder?: number;
  name?: string;
  type?: TaskType;
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  progress?: number;
  status?: TaskStatus;
  priority?: Priority;
  assigneeId?: string | null;
  description?: string | null;
  plannedCost?: number;
  actualCost?: number;
  deadline?: string | null;
  barColor?: string | null;
  labelIds?: string[];
}
export type TaskPreviousMap = Record<string, TaskPrevious>;

// ───────────────────────────── labels

export const labelSchema = z.object({
  name: z.string().trim().min(1, { message: 'اكتب اسم الوسم' }).max(60),
  color: hexColor,
});
export const updateLabelSchema = labelSchema.partial();
export const taskLabelSchema = z.object({ labelId: uuid });

export interface LabelDto {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

// ───────────────────────────── custom fields

export const CUSTOM_FIELD_TYPES = ['TEXT', 'NUMBER', 'DROPDOWN', 'DATE', 'CHECKBOX'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

const fieldOption = z.string().trim().min(1).max(80);

export const customFieldSchema = z.object({
  name: z.string().trim().min(1, { message: 'اكتب اسم الحقل' }).max(60),
  type: z.enum(CUSTOM_FIELD_TYPES),
  /** DROPDOWN only: the allowed values (unique). */
  options: z.array(fieldOption).max(100).optional(),
  sort: z.number().optional(),
});
/** The type cannot change after creation (stored values would no longer fit). */
export const updateCustomFieldSchema = customFieldSchema.omit({ type: true }).partial();
/** `PUT /tasks/:id/custom-values/:fieldId` — `null` clears the value. */
export const customValueSchema = z.object({ value: z.unknown() });

export interface CustomFieldDto {
  id: string;
  projectId: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  sort: number;
}

export interface CustomValueDto {
  taskId: string;
  fieldId: string;
  value: unknown;
}

export const CUSTOM_TEXT_MAX = 2000;

/**
 * Validates and normalises a custom value for its field (shared by the API and the web).
 * Returns `{ ok: true, value }` (value `null` = clear) or `{ ok: false, message }` in Arabic.
 */
export function normalizeCustomValue(
  field: { type: CustomFieldType; options: readonly string[] },
  raw: unknown,
): { ok: true; value: string | number | boolean | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  switch (field.type) {
    case 'TEXT': {
      if (typeof raw !== 'string') return { ok: false, message: 'اكتب نصًّا' };
      const v = raw.trim();
      if (v.length > CUSTOM_TEXT_MAX) return { ok: false, message: 'النص أطول من المسموح' };
      return { ok: true, value: v === '' ? null : v };
    }
    case 'NUMBER': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, message: 'اكتب رقمًا' };
      if (Math.abs(n) > 1e15) return { ok: false, message: 'الرقم أكبر من المسموح' };
      return { ok: true, value: n };
    }
    case 'DROPDOWN': {
      if (typeof raw !== 'string' || !field.options.includes(raw)) return { ok: false, message: 'اختر قيمة من القائمة' };
      return { ok: true, value: raw };
    }
    case 'DATE': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, message: 'تاريخ غير صالح' };
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return { ok: false, message: 'تاريخ غير صالح' };
      return { ok: true, value: raw };
    }
    case 'CHECKBOX': {
      if (typeof raw !== 'boolean') return { ok: false, message: 'القيمة نعم أو لا' };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, message: 'نوع حقل غير معروف' };
  }
}

// ───────────────────────────── checklist

export const checklistItemSchema = z.object({
  text: z.string().trim().min(1, { message: 'اكتب البند' }).max(500),
  /** Insert after this item; omitted = append. */
  afterId: uuid.nullable().optional(),
});
export const updateChecklistItemSchema = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  done: z.boolean().optional(),
});
export const checklistReorderSchema = z.object({ ids: z.array(uuid).min(1).max(500) });

export interface ChecklistItemDto {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  sort: number;
  doneBy: { id: string; fullName: string } | null;
  doneAt: string | null;
}

// ───────────────────────────── duplicate, bulk, restore

export const duplicateTaskSchema = z.object({ withSubtasks: z.boolean().default(true) });

export interface DuplicateTaskResult {
  /** The copies, the copy of the original first, in WBS order. */
  tasks: TaskDto[];
  /** Other tasks the server changed (parents rolled up, later siblings renumbered). */
  affected: TaskDto[];
  /** Original id → copy id. */
  idMap: Record<string, string>;
  dependencies: DependencyDto[];
  /** Before-values of the existing tasks that changed (undo = archive the copy). */
  previous: TaskPreviousMap;
}

export const BULK_MAX = 1000;

const versionsMap = z.record(uuid, z.number().int().min(0));

export const taskBulkSchema = z.object({
  ids: z.array(uuid).min(1).max(BULK_MAX),
  /** Task id → the version the client holds; every id needs one. */
  versions: versionsMap,
  patch: z
    .object({
      status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      assigneeId: uuid.nullable().optional(),
      labelIdsAdd: z.array(uuid).max(50).optional(),
      labelIdsRemove: z.array(uuid).max(50).optional(),
      progress: z.number().min(0).max(100).optional(),
      barColor: hexColor.nullable().optional(),
      /** Moves every selected leaf (and the leaves under selected groups) by N working days. */
      shiftWorkingDays: z.number().int().min(-3650).max(3650).optional(),
    })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'لا يوجد تعديل' }),
});

export const taskBulkArchiveSchema = z.object({
  ids: z.array(uuid).min(1).max(BULK_MAX),
  versions: versionsMap,
});

/** `POST /projects/:id/tasks/restore` — un-archives tasks archived together (undo of an archive). */
export const taskRestoreSchema = z.object({ ids: z.array(uuid).min(1).max(5000) });

export interface TaskBulkResult {
  /** Every task the server persisted (edited + shifted + rolled up). */
  tasks: TaskDto[];
  previous: TaskPreviousMap;
}

export interface TaskBulkArchiveResult {
  archivedIds: string[];
  affected: TaskDto[];
  previous: TaskPreviousMap;
  deletedDependencies: DependencyDto[];
}

export interface TaskRestoreResult {
  restored: TaskDto[];
  affected: TaskDto[];
  previous: TaskPreviousMap;
}

// ───────────────────────────── view preferences

export const VIEW_PREF_MAX_BYTES = 32 * 1024;
export const viewPrefKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+){0,4}$/, { message: 'مفتاح غير صالح' })
  .max(80);

export const viewPrefQuerySchema = z.object({
  projectId: uuid.optional(),
  key: viewPrefKey.optional(),
});
export const putViewPrefSchema = z.object({
  /** Omitted / null = a global preference of the user. */
  projectId: uuid.nullable().optional(),
  key: viewPrefKey,
  value: z.unknown(),
});
export const deleteViewPrefQuerySchema = z.object({ projectId: uuid.optional(), key: viewPrefKey });

export interface ViewPrefDto {
  projectId: string | null;
  key: string;
  value: unknown;
  updatedAt: string;
}

// ───────────────────────────── templates & portfolios

export const saveAsTemplateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: optionalText(4000),
});

export const portfolioSchema = z.object({
  name: z.string().trim().min(2, { message: 'اكتب اسم المحفظة' }).max(120),
  description: optionalText(2000),
  projectIds: z.array(uuid).max(500).optional(),
});
export const updatePortfolioSchema = portfolioSchema.partial();
export const portfolioProjectSchema = z.object({ projectId: uuid });

export interface PortfolioDto {
  id: string;
  name: string;
  description: string | null;
  projectIds: string[];
  createdAt: string;
}

export interface PortfolioProjectSummary {
  project: ProjectDto;
  overdueCount: number;
  leafCount: number;
  doneCount: number;
}

export interface PortfolioSummaryDto extends PortfolioDto {
  projects: PortfolioProjectSummary[];
  totals: {
    projectCount: number;
    /** Average of the project progress values weighted by their leaf counts. */
    progress: number;
    /** Sum of the project budgets that have one (null when none has). */
    budget: number | null;
    plannedCost: number;
    actualCost: number;
    startDate: string | null;
    endDate: string | null;
    overdueCount: number;
    byStatus: Record<string, number>;
  };
}

// ───────────────────────────── time log

export const timeEntrySchema = z.object({
  date: isoDate,
  minutes: z.number().int().min(1, { message: 'دقيقة واحدة على الأقل' }).max(1440, { message: '٢٤ ساعة كحد أعلى' }),
  note: optionalText(500),
  /** Admins may log for another active user. */
  userId: uuid.optional(),
});
export const updateTimeEntrySchema = timeEntrySchema.omit({ userId: true }).partial();
export const timeRangeQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export interface TimeEntryDto {
  id: string;
  task: { id: string; name: string; projectId: string; projectName: string };
  user: { id: string; fullName: string };
  date: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

// ───────────────────────────── budget, people, reports, dashboard, workload, calendar

export interface CostLine {
  plannedCost: number;
  actualCost: number;
  /** plannedCost − actualCost. */
  variance: number;
}

export interface BudgetReportDto extends CostLine {
  projectId: string;
  currency: string;
  budget: number | null;
  budgetVariance: number | null;
  budgetUsedPct: number | null;
  /** Logged time (time entries) on the project's tasks — reported apart from money. */
  loggedMinutes: number;
  byGroup: Array<CostLine & { taskId: string; wbs: string; name: string; type: TaskType }>;
  byAssignee: Array<CostLine & { assignee: { id: string; fullName: string } | null; taskCount: number; loggedMinutes: number }>;
  /** A task with two labels counts under both; `label: null` = tasks without a label. */
  byLabel: Array<CostLine & { label: LabelDto | null; taskCount: number }>;
  overBudgetTasks: Array<{ taskId: string; wbs: string; name: string; plannedCost: number; actualCost: number; overBy: number }>;
}

export interface ProjectPersonDto extends CostLine {
  assignee: { id: string; fullName: string; teamColor: string | null; teamName: string | null } | null;
  taskCount: number;
  doneCount: number;
  overdueCount: number;
  /** Duration-weighted progress of their tasks. */
  progress: number;
  /** Share of the project planned cost, %. */
  budgetShare: number;
  loggedMinutes: number;
}

export const projectReportQuerySchema = z.object({
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED', 'ALL']).optional(),
});

export interface ProjectReportRow {
  project: ProjectDto;
  leafCount: number;
  doneCount: number;
  overdueCount: number;
  deadlinePassedCount: number;
  milestoneCount: number;
}

export interface ProjectDashboardDto {
  project: ProjectDto;
  kpis: {
    leafCount: number;
    done: number;
    inProgress: number;
    notStarted: number;
    onHold: number;
    overdue: number;
    deadlinePassed: number;
    milestones: number;
    milestonesDone: number;
    loggedMinutes: number;
  };
  statusDistribution: Record<TaskStatus, number>;
  priorityDistribution: Record<Priority, number>;
  overdue: Array<{ taskId: string; wbs: string; name: string; endDate: string; daysOverdue: number; assignee: { id: string; fullName: string } | null }>;
  budgetBurn: {
    budget: number | null;
    plannedCost: number;
    actualCost: number;
    budgetUsedPct: number | null;
    /** Planned cost spread evenly over each leaf's working days, by week (Sunday start). */
    plannedByWeek: Array<{ weekStart: string; planned: number; cumulative: number }>;
  };
  upcoming: Array<{ taskId: string; wbs: string; name: string; date: string; kind: 'DEADLINE' | 'MILESTONE' | 'END'; assignee: { id: string; fullName: string } | null }>;
}

export const workloadQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  /** Comma-separated user ids (default: every active supervisor). */
  userIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(uuid).max(200).optional()),
});

export interface WorkloadDto {
  from: string;
  to: string;
  days: string[];
  /** Minutes of one working day (until the hours engine lands: 8 h). */
  capacityMinutesPerDay: number;
  people: Array<{
    user: { id: string; fullName: string };
    days: Array<{ date: string; assignedMinutes: number; loggedMinutes: number; taskCount: number }>;
    totalAssignedMinutes: number;
    totalLoggedMinutes: number;
  }>;
}

export const calendarRangeQuerySchema = z.object({ from: isoDate, to: isoDate });

export interface ProjectCalendarDto {
  project: { id: string; name: string };
  calendar: CalendarDto;
  from: string;
  to: string;
  /** Tasks overlapping [from, to], or whose deadline falls in it. */
  items: Array<{
    taskId: string;
    wbs: string;
    name: string;
    type: TaskType;
    startDate: string;
    endDate: string;
    deadline: string | null;
    deadlinePassed: boolean;
    status: TaskStatus;
    progress: number;
    barColor: string | null;
    assignee: { id: string; fullName: string; teamColor: string | null } | null;
  }>;
}

// ───────────────────────────── communication hub & attachments

export const HUB_FILTERS = ['all', 'new', 'mentioned', 'assigned', 'created'] as const;
export type HubFilter = (typeof HUB_FILTERS)[number];

export const hubQuerySchema = z.object({
  projectId: uuid.optional(),
  filter: z.enum(HUB_FILTERS).default('all'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface HubItemDto {
  task: { id: string; name: string; wbs: string; type: TaskType; status: TaskStatus; assignee: { id: string; fullName: string } | null };
  project: { id: string; name: string };
  /** Ancestor names, root first (empty for a root task). */
  path: string[];
  commentCount: number;
  /** Comments by others after the viewer's last read. */
  unreadCount: number;
  lastReadAt: string | null;
  lastComment: { id: string; author: { id: string; fullName: string }; bodyPreview: string; createdAt: string } | null;
}

export interface HubPageDto {
  items: HubItemDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Number of tasks per tab, with the same project filter and search. */
  counts: Record<HubFilter, number>;
  unreadTotal: number;
}

export interface CommentReadDto {
  taskId: string;
  lastReadAt: string;
}

export const ATTACHMENT_TYPES = ['image', 'pdf', 'other'] as const;
export type AttachmentKindGroup = (typeof ATTACHMENT_TYPES)[number];

export const attachmentBrowseQuerySchema = z.object({
  projectId: uuid.optional(),
  type: z.enum(ATTACHMENT_TYPES).optional(),
  uploadedBy: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Matches the task or project name. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface AttachmentBrowseDto {
  id: string;
  mimeType: string;
  type: AttachmentKindGroup;
  sizeBytes: number;
  uploadedBy: { id: string; fullName: string } | null;
  createdAt: string;
  task: { id: string; name: string; wbs: string };
  project: { id: string; name: string };
}
