/**
 * The import preview as a read-only Gantt (ADR-117): `ImportPreviewDto` → the `GanttView` the
 * project page draws, so the admin sees the imported hierarchy, bars, milestones, links and — for
 * HOUR projects — the working hours (lunch break shaded) exactly as the project will look.
 * Assignee names show as the supervisor they are mapped to (or the raw name, dimmed by no team).
 */
import type { ImportPreviewDto, TaskDto } from '@nuzli/shared';
import type { GanttView } from '../../api/hoursWire';

export const PREVIEW_ID = 'import-preview';

export interface MappedAssignee {
  id: string;
  fullName: string;
}

export function previewGantt(
  pv: ImportPreviewDto,
  mapped: ReadonlyMap<string, MappedAssignee | null> = new Map(),
): GanttView {
  const end = pv.tasks.reduce<string | null>(
    (m, t) => (m === null || t.endDate > m ? t.endDate : m),
    null,
  );
  const hours = pv.project.durationUnit === 'HOUR';
  const order = new Map<string | null, number>();
  const tasks: TaskDto[] = pv.tasks.map((t) => {
    const sortOrder = (order.get(t.parentRef) ?? 0) + 1;
    order.set(t.parentRef, sortOrder);
    const who = t.assigneeName ? mapped.get(t.assigneeName) : undefined;
    return {
      id: t.ref,
      projectId: PREVIEW_ID,
      parentId: t.parentRef,
      sortOrder,
      wbs: t.wbs,
      name: t.name,
      type: t.type,
      startDate: t.startDate,
      endDate: t.endDate,
      durationDays: t.durationDays,
      ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
      ...(hours ? { startAt: t.startDate, endAt: t.endDate } : {}),
      progress: t.progress,
      status: t.status,
      priority: t.priority ?? 'MEDIUM',
      assignee:
        t.type === 'GROUP' || !t.assigneeName || who === null
          ? null
          : who
            ? { id: who.id, fullName: who.fullName, teamColor: null, teamName: null }
            : {
                id: `name:${t.assigneeName}`,
                fullName: t.assigneeName,
                teamColor: null,
                teamName: null,
              },
      description: t.notes,
      version: 0,
      commentCount: 0,
      attachmentCount: 0,
      plannedCost: t.plannedCost,
      actualCost: t.actualCost,
      overBudget: t.actualCost > t.plannedCost,
      deadline: t.deadline,
      deadlinePassed: false,
      // A10: GanttPRO colours show on the preview bars as they will in the project.
      barColor: t.barColor ?? null,
      labelIds: [],
      checklist: { total: 0, done: 0 },
      customValues: {},
    };
  });
  const root = tasks.filter((t) => !t.parentId);
  const weight = (t: TaskDto) => (t.type === 'MILESTONE' ? 0 : Math.max(1, t.durationDays));
  const total = root.reduce((s, t) => s + weight(t), 0);
  const progress = total
    ? Math.round((root.reduce((s, t) => s + weight(t) * t.progress, 0) / total) * 100) / 100
    : 0;
  return {
    project: {
      id: PREVIEW_ID,
      name: pv.project.name,
      description: null,
      startDate: pv.project.startDate,
      endDate: end,
      status: 'PLANNING',
      calendarId: PREVIEW_ID,
      autoSchedule: true,
      owner: { id: '', fullName: '' },
      progress,
      taskCount: tasks.length,
      createdAt: new Date(0).toISOString(),
      durationUnit: pv.project.durationUnit,
    },
    tasks,
    dependencies: pv.dependencies.map((d, i) => ({
      id: `${PREVIEW_ID}-d${i}`,
      predecessorId: d.predecessorRef,
      successorId: d.successorRef,
      type: d.type,
      lagDays: d.lagDays,
      ...(d.lagHours !== undefined ? { lagHours: d.lagHours } : {}),
    })),
    calendar: {
      id: PREVIEW_ID,
      name: pv.project.calendar.name,
      weekendDays: pv.project.calendar.weekendDays,
      exceptions: pv.project.calendar.exceptions.map((e, i) => ({
        id: `${PREVIEW_ID}-x${i}`,
        date: e.date,
        isWorking: e.isWorking,
        name: e.name,
        ...(e.workingHours ? { workingHours: e.workingHours } : {}),
      })),
      workingHours: pv.project.calendar.workingHours,
    },
    labels: [],
    customFields: [],
  };
}

/** Working days 0 = Sunday … 6 from the weekend. */
export const workingDaysOf = (weekendDays: readonly number[]): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => !weekendDays.includes(d));
