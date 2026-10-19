import { z } from 'zod';
import { isoDate, uuid } from './common';
import type { DependencyType, Priority, TaskStatus, TaskType } from '../enums';
import { durationUnitSchema, type ProjectDurationUnit, type WorkingInterval } from './projects';

/**
 * A9 project imports and exports (owner decision 3: Excel, CSV, MS Project .xml/.mpp, Jira;
 * every export; no AI). docs/API.md "A9 — imports, exports, hours", docs/imports.md, ADR-110..112.
 *
 * Flow: upload the file with `POST /files/presign { entityType: 'import' }` + PUT + confirm →
 * `POST /projects/import { fileId, format }` (or `POST /projects/import/jira`) returns a preview
 * kept server-side for one hour → `POST /projects/import/commit { previewId, assigneeMap }`
 * creates the project in one transaction.
 */

/** `xml` = MS Project XML (MSPDI); `mpp` = MS Project binary (converted to MSPDI by the converter service). */
export const IMPORT_FORMATS = ['xlsx', 'csv', 'xml', 'mpp', 'jira-csv'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * A10: every format `POST /projects/import` accepts — IMPORT_FORMATS plus `ganttpro` (the Excel
 * file GanttPRO writes with Export → Excel, ADR-124). Kept apart from IMPORT_FORMATS so code
 * keyed by ImportFormat keeps compiling; an .xlsx sent as `xlsx` is still recognised as GanttPRO
 * by its layout (`detectedFormat` in the preview).
 */
export const IMPORT_FILE_FORMATS = [...IMPORT_FORMATS, 'ganttpro'] as const;
export type ImportFileFormat = (typeof IMPORT_FILE_FORMATS)[number];

export const importOptionsSchema = z
  .object({
    /** Excel: the sheet to read (default: the first sheet that has a task-name column). */
    sheetName: z.string().trim().min(1).max(120).optional(),
    /** Forces the unit instead of the detection (sub-day times or an hours duration column → HOUR). */
    durationUnit: durationUnitSchema.optional(),
    /** Ambiguous `03/04/2026`: day first (default, Saudi usage) or month first. */
    dateOrder: z.enum(['DMY', 'MDY']).default('DMY'),
    /** The project name (default: the file's project title, else the file name hint). */
    projectName: z.string().trim().min(2).max(160).optional(),
  })
  .default({});

export const importProjectSchema = z.object({
  /** A READY file uploaded with `entityType: 'import'` by the caller. */
  fileId: uuid,
  format: z.enum(IMPORT_FILE_FORMATS),
  options: importOptionsSchema,
});
export type ImportProjectInput = z.input<typeof importProjectSchema>;

/**
 * Jira Cloud REST import. The API token is used for this one call and is never stored or
 * logged. `siteUrl` must be `https://<name>.atlassian.net` (or a host on the admin allowlist
 * `JIRA_ALLOWED_HOSTS`); private and loopback addresses are refused (SSRF guard).
 */
export const importJiraSchema = z
  .object({
    siteUrl: z.string().trim().url({ message: 'رابط موقع Jira غير صالح' }).max(200),
    email: z.string().trim().email({ message: 'بريد إلكتروني غير صالح' }).max(200),
    apiToken: z.string().min(8, { message: 'رمز Jira غير صالح' }).max(1000),
    jql: z.string().trim().min(1).max(2000).optional(),
    projectKey: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,19}$/, { message: 'مفتاح مشروع Jira غير صالح (مثل OPS)' })
      .optional(),
    options: importOptionsSchema,
  })
  .refine((v) => !!v.jql || !!v.projectKey, { message: 'اكتب مفتاح المشروع أو استعلام JQL', path: ['projectKey'] });
export type ImportJiraInput = z.input<typeof importJiraSchema>;

export const importCommitSchema = z.object({
  previewId: uuid,
  /** Imported assignee name → an ACTIVE supervisor's id, or null to leave the tasks unassigned. */
  assigneeMap: z.record(z.string().max(200), uuid.nullable()).default({}),
  name: z.string().trim().min(2).max(160).optional(),
  /** Re-bases every task by its working offset from the imported project start. */
  startDate: isoDate.optional(),
});
export type ImportCommitInput = z.input<typeof importCommitSchema>;

export interface ImportCalendarDto {
  name: string;
  weekendDays: number[];
  workingHours: WorkingInterval[];
  exceptions: Array<{ date: string; isWorking: boolean; name: string; workingHours?: WorkingInterval[] | null }>;
}

/** One task of a preview. `ref` links parents and dependencies inside the preview. */
export interface ImportPreviewTaskDto {
  ref: string;
  /** ID / UID / issue key in the source file (for the admin to recognise rows). */
  sourceId: string | null;
  wbs: string;
  parentRef: string | null;
  name: string;
  type: TaskType;
  /** `YYYY-MM-DD` (DAY) or `YYYY-MM-DDTHH:MM` (HOUR), after the engine ran on the preview. */
  startDate: string;
  endDate: string;
  durationDays: number;
  durationHours?: number;
  progress: number;
  status: TaskStatus;
  assigneeName: string | null;
  plannedCost: number;
  actualCost: number;
  deadline: string | null;
  notes: string | null;
  /** A10 (GanttPRO): the priority the file states (absent = MEDIUM). */
  priority?: Priority;
  /** A10 (GanttPRO): the bar colour `#RRGGBB` from the file, or null. */
  barColor?: string | null;
}

export interface ImportPreviewDependencyDto {
  predecessorRef: string;
  successorRef: string;
  type: DependencyType;
  lagDays: number;
  lagHours?: number;
}

/**
 * Codes: `ROW_SKIPPED`, `DATE_UNPARSED`, `DURATION_UNPARSED`, `PARENT_MISSING`,
 * `PREDECESSOR_MISSING`, `DEPENDENCY_TYPE_IGNORED`, `DEPENDENCY_CYCLE_DROPPED`,
 * `DEPENDENCY_DUPLICATE`, `TRUNCATED`, `CALENDAR_DEFAULTED`, `HOURS_DETECTED`, `SUMMARY_DATES_RECOMPUTED`,
 * `MILESTONE_DURATION`, `JIRA_LIMIT`, `NAME_TRUNCATED`; A10: `FORMAT_DETECTED`, `STATUS_UNKNOWN`, `DURATION_ROUNDED`,
 * `PRIORITY_UNKNOWN`, `TYPE_UNKNOWN`, `LEVEL_MISMATCH`, `ASSIGNEE_MULTIPLE`, `PROJECT_ROOT_USED`,
 * `ESTIMATES_NOT_IMPORTED`, `INACTIVE_SKIPPED`. `message_ar` is ready to show.
 */
export interface ImportWarningDto {
  code: string;
  message_ar: string;
  /** 1-based source row (tabular files) or the source id. */
  row?: number;
  sourceId?: string;
}

export interface ImportPreviewDto {
  previewId: string;
  expiresAt: string;
  format: ImportFileFormat | 'jira';
  /**
   * A10: the format recognised from the file content (a GanttPRO export sent as `xlsx` →
   * `ganttpro`; MS Project XML → `xml`). Equals `format` when nothing else was recognised.
   */
  detectedFormat?: ImportFileFormat | 'jira';
  project: { name: string; startDate: string; durationUnit: ProjectDurationUnit; calendar: ImportCalendarDto };
  tasks: ImportPreviewTaskDto[];
  dependencies: ImportPreviewDependencyDto[];
  warnings: ImportWarningDto[];
  /** Distinct assignee names, each with an exact-name match among ACTIVE supervisors when there is one. */
  unmappedAssignees: Array<{ name: string; taskCount: number; suggestedUserId: string | null }>;
  stats: {
    taskCount: number;
    groupCount: number;
    milestoneCount: number;
    dependencyCount: number;
    /** A10: deepest outline level (1 = top). */
    maxLevel?: number;
    /** A10: tasks with a bar colour from the file, and the distinct colours. */
    coloredCount?: number;
    colorCount?: number;
    /** A10: tasks with a deadline. */
    deadlineCount?: number;
    /** A10 (GanttPRO): row counts per source type (`project`, `tasks group`, `task`, `milestone`). */
    sourceTypes?: Record<string, number>;
    /** A10 (GanttPRO): «Estimated hours» and «Time log (minutes)» totals — reported, not imported. */
    estimatedHours?: number;
    timeLogMinutes?: number;
  };
}

export interface ImportCommitResultDto {
  projectId: string;
  taskCount: number;
  dependencyCount: number;
  calendarId: string;
  /** True when a calendar was created for the project (else an identical one was reused). */
  calendarCreated: boolean;
}

/** `POST /projects/:id/convert` — DAY ↔ HOUR with the engine's conversions (ADR-109). */
export const convertProjectSchema = z.object({ durationUnit: durationUnitSchema });

/** `GET /projects/:id/export?format=` — PDF/PNG of the Gantt are rendered in the browser. */
/** `ganttpro` (A10, ADR-125) = an .xlsx in the GanttPRO export layout that GanttPRO and our importer read. */
export const projectExportQuerySchema = z.object({ format: z.enum(['xlsx', 'csv', 'xml', 'ganttpro']).default('xlsx') });
export type ProjectExportFormat = z.infer<typeof projectExportQuerySchema>['format'];
