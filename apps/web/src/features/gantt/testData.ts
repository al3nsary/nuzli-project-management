/** Test helpers: a project of `groups × leaves` tasks with FS chains, shaped like `GanttDto`. */
import { WorkCalendar, computeWbs, schedule } from '@nuzli/scheduling';
import type { DependencyDto, GanttDto, TaskDto } from '@nuzli/shared';

export function makeGantt(groups: number, leaves: number, start = '2026-11-01'): GanttDto {
  const cal = new WorkCalendar({ weekendDays: [5, 6] });
  const tasks: TaskDto[] = [];
  const deps: DependencyDto[] = [];
  let n = 0;
  const base = (id: string, name: string): TaskDto => ({
    id,
    projectId: 'p',
    parentId: null,
    sortOrder: 0,
    wbs: '',
    name,
    type: 'TASK',
    startDate: start,
    endDate: start,
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assignee: null,
    description: null,
    version: 1,
    commentCount: 0,
    attachmentCount: 0,
  });
  for (let g = 0; g < groups; g++) {
    const gid = `g${g}`;
    tasks.push({ ...base(gid, `مجموعة ${g + 1}`), type: 'GROUP', sortOrder: g + 1 });
    let s = cal.addWorkingDays(start, (g * 3) % 60);
    let prev: string | null = null;
    for (let l = 0; l < leaves; l++) {
      const id = `t${++n}`;
      const d = 1 + ((g + l) % 3);
      tasks.push({ ...base(id, `مهمة ${n}`), parentId: gid, sortOrder: l + 1, startDate: s, durationDays: d, endDate: cal.endFromDuration(s, d) });
      if (prev) deps.push({ id: `d${n}`, predecessorId: prev, successorId: id, type: 'FS', lagDays: 0 });
      prev = id;
      s = cal.addWorkingDays(s, d);
    }
  }
  const scheduled = schedule({ tasks, dependencies: deps, calendar: cal }).tasks;
  const wbs = computeWbs(scheduled);
  const withWbs = scheduled.map((t) => ({ ...t, wbs: wbs.get(t.id)! }));
  // WBS order, as the API sends it.
  const order = (w: string) => w.split('.').map((x) => x.padStart(5, '0')).join('.');
  withWbs.sort((a, b) => (order(a.wbs) < order(b.wbs) ? -1 : 1));
  return {
    project: {
      id: 'p',
      name: 'مشروع',
      description: null,
      startDate: start,
      endDate: null,
      status: 'ACTIVE',
      calendarId: 'c',
      autoSchedule: true,
      owner: { id: 'u', fullName: 'مدير' },
      progress: 0,
      taskCount: withWbs.length,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    tasks: withWbs,
    dependencies: deps,
    calendar: { id: 'c', name: 'تقويم', weekendDays: [5, 6], exceptions: [] },
  };
}
