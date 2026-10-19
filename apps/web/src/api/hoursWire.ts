/**
 * HOUR projects on the wire (owner request A9: «وحدة المدة: أيام أو ساعات»).
 *
 * `@nuzli/scheduling` schedules HOUR projects in working minutes (commit 59f8f25,
 * docs/scheduling.md «الجدولة بالساعات»), but the shared request schemas still accept dates only.
 * Until the import/export agent integrates hours in the API, the web sends these supersets:
 * - projects: `durationUnit: 'DAY' | 'HOUR'` (default DAY);
 * - calendars: `workingHours: [{ start: 'HH:MM', end: 'HH:MM' }]`;
 * - tasks of HOUR projects: `startDate`/`endDate` as local Riyadh date-times
 *   `YYYY-MM-DDTHH:MM`, and `durationHours` (quarter-hour steps in the UI).
 * The API's zod objects strip unknown keys, so DAY projects behave exactly as before on the
 * server; DemoApi implements the hours rules with the engine exactly as the server will (ADR-105).
 */
import { z } from 'zod';
import {
  calendarSchema,
  createProjectSchema,
  createTaskSchema,
  taskBatchSchema,
  updateCalendarSchema,
  updateProjectSchema,
  updateTaskSchema,
  type CalendarDto,
  type GanttDto,
  type ProjectDto,
  type TaskDto,
} from '@nuzli/shared';

export type DurationUnit = 'DAY' | 'HOUR';

export interface WorkingInterval {
  start: string;
  end: string;
}

/** `09:00–13:00` and `14:00–18:00` — the A9 default (8 hours with a lunch break). */
export const DEFAULT_WORKING_HOURS: WorkingInterval[] = [
  { start: '09:00', end: '13:00' },
  { start: '14:00', end: '18:00' },
];

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, { message: 'وقت غير صالح' });
export const workingIntervalSchema = z
  .object({ start: hm, end: hm })
  .refine((w) => w.start < w.end, { message: 'نهاية الفترة قبل بدايتها' });
export const workingHoursSchema = z.array(workingIntervalSchema).min(1).max(6);

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (local Riyadh wall time, seconds and `+03:00` tolerated). */
export const dateOrLocal = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\+03:00)?)?$/, { message: 'تاريخ غير صالح' });

const hours = z.number().min(0).max(87_600);

export const createProjectSchemaH = createProjectSchema.extend({
  durationUnit: z.enum(['DAY', 'HOUR']).optional(),
});
export const updateProjectSchemaH = updateProjectSchema.extend({
  durationUnit: z.enum(['DAY', 'HOUR']).optional(),
});
export const calendarSchemaH = calendarSchema.extend({ workingHours: workingHoursSchema.optional() });
export const updateCalendarSchemaH = updateCalendarSchema.extend({ workingHours: workingHoursSchema.optional() });

export const createTaskSchemaH = createTaskSchema.extend({
  startDate: dateOrLocal,
  durationHours: hours.optional(),
});
export const updateTaskSchemaH = updateTaskSchema.extend({
  startDate: dateOrLocal.optional(),
  durationHours: hours.optional(),
});

const batchChange = taskBatchSchema.shape.changes.element.extend({
  startDate: dateOrLocal.optional(),
  endDate: dateOrLocal.optional(),
  durationHours: hours.optional(),
});
export const taskBatchSchemaH = z.object({ changes: z.array(batchChange).min(1).max(5000) });
export type TaskBatchInputH = z.infer<typeof taskBatchSchemaH>;

/** Project as the web reads it (the HOUR fields are optional: the API sends them later). */
export type ProjectView = ProjectDto & { durationUnit?: DurationUnit };
export type CalendarView = CalendarDto & { workingHours?: WorkingInterval[] };
export type TaskView = TaskDto & { durationHours?: number };
export type GanttView = Omit<GanttDto, 'project' | 'calendar' | 'tasks'> & {
  project: ProjectView;
  calendar: CalendarView;
  tasks: TaskView[];
};

export const unitOf = (p: { durationUnit?: DurationUnit } | null | undefined): DurationUnit =>
  p?.durationUnit === 'HOUR' ? 'HOUR' : 'DAY';
