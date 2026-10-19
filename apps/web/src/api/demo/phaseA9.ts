/**
 * DemoApi — owner request A9 (docs/API.md "A9 — projects", ADR-092..097): labels, custom fields,
 * checklists, duplicate, bulk edit, bulk archive and restore, templates, portfolios, time log,
 * view preferences, the budget/people/dashboard/calendar read models, the cross-project report,
 * workload, the communication hub and the attachments browser — with the same rules as the
 * services in apps/api/src/projects (ported 1:1; the arithmetic is the shared port in
 * features/projects/reports.ts). Task writes go through phase4's single write path (`core`).
 */
import {
  BULK_MAX,
  HUB_FILTERS,
  VIEW_PREF_MAX_BYTES,
  VIEW_PREF_MAX_COUNT,
  attachmentBrowseQuerySchema,
  can,
  canAny,
  checklistItemSchema,
  checklistReorderSchema,
  customFieldSchema,
  duplicateTaskSchema,
  hubQuerySchema,
  labelSchema,
  normalizeCustomValue,
  portfolioSchema,
  putViewPrefSchema,
  saveAsTemplateSchema,
  taskBulkArchiveSchema,
  taskBulkSchema,
  timeEntrySchema,
  updateChecklistItemSchema,
  updateCustomFieldSchema,
  updateLabelSchema,
  updatePortfolioSchema,
  updateTimeEntrySchema,
  type AttachmentBrowseDto,
  type ChecklistItemDto,
  type CustomFieldDto,
  type CustomFieldType,
  type HubFilter,
  type HubItemDto,
  type LabelDto,
  type PortfolioDto,
  type ProjectReportRow,
  type TimeEntryDto,
  type ViewPrefDto,
} from '@nuzli/shared';
import type { WorkCalendar } from '@nuzli/scheduling';
import type { ApiClient } from '../client';
import { unitOf, type ProjectView } from '../hoursWire';
import {
  addCalendarDaysIso,
  compareWbs,
  deadlinePassed,
  dueFlags,
  normalizeLeaf,
  progressWeight,
  riyadhToday,
  rootsForProgress,
  syncStatusProgress,
  siblingsOf,
  sortOrderBetween,
  subtreeIds,
  workCalendarOf,
  type StoredTask,
} from '../../features/projects/engine';
import {
  buildBudgetReport,
  buildDashboard,
  buildPeople,
  computeWorkload,
  daysBetween,
  kindGroup,
  leavesOf,
  portfolioTotals,
  preview,
  rangeProblem,
  workingOffset,
} from '../../features/projects/reports';
import type {
  DemoChecklistItem,
  DemoCustomField,
  DemoDependency,
  DemoLabel,
  DemoPortfolio,
  DemoProject,
  DemoTask,
  DemoTimeEntry,
  DemoUser,
} from './db';
import type { DemoInternals } from './phase2';
import { rowOf, type ProjectsCore, type TemplateHook } from './phase4';
import { fail, newId, paginate, validate } from './util';

type A9Projects = Pick<ApiClient['projects'], 'budget' | 'people' | 'dashboard' | 'calendar' | 'saveAsTemplate' | 'templates' | 'report'>;
type A9Tasks = Pick<
  ApiClient['tasks'],
  | 'duplicate'
  | 'bulk'
  | 'bulkArchive'
  | 'restore'
  | 'labels'
  | 'addLabel'
  | 'removeLabel'
  | 'customFields'
  | 'setCustomValue'
  | 'checklist'
  | 'addChecklistItem'
  | 'updateChecklistItem'
  | 'removeChecklistItem'
  | 'reorderChecklist'
  | 'timeEntries'
  | 'addTimeEntry'
>;

export type A9Api = Pick<ApiClient, 'labels' | 'customFields' | 'timeEntries' | 'viewPrefs' | 'portfolios' | 'workload' | 'hub'> & {
  projectsA9: A9Projects;
  tasksA9: A9Tasks;
  templateHook: TemplateHook;
};

/** Suffix of a duplicated task's name (A9). */
export const COPY_SUFFIX = ' (نسخة)';
export const copyName = (name: string): string => name.slice(0, 300 - COPY_SUFFIX.length) + COPY_SUFFIX;

const TASK_READ = ['projects.readAll', 'tasks.readAssigned'] as const;
const TASK_WORK = ['tasks.manage', 'tasks.updateAssigned'] as const;

const byNameAr = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ar');
const toLabelDto = (l: DemoLabel): LabelDto => ({ id: l.id, projectId: l.projectId, name: l.name, color: l.color.toUpperCase() });
const toFieldDto = (f: DemoCustomField): CustomFieldDto => ({
  id: f.id,
  projectId: f.projectId,
  name: f.name,
  type: f.type,
  options: [...f.options],
  sort: f.sort,
});

/** DROPDOWN options: trimmed, unique, at least one. Other types store []. */
function cleanOptions(type: CustomFieldType, options: string[] | undefined): string[] {
  if (type !== 'DROPDOWN') return [];
  const unique = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (!unique.length) fail('CUSTOM_FIELD_OPTIONS_REQUIRED');
  return unique;
}

/** UTF-8 size of the JSON text of a value. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

/** Parents before children (insert order). */
export function topoOrder<T extends { id: string; parentId: string | null }>(tasks: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const k = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    const list = byParent.get(k);
    if (list) list.push(t);
    else byParent.set(k, [t]);
  }
  const out: T[] = [];
  const queue = [...(byParent.get(null) ?? [])];
  while (queue.length) {
    const t = queue.shift()!;
    out.push(t);
    queue.push(...(byParent.get(t.id) ?? []));
  }
  return out;
}

/**
 * Re-bases tasks from one project start to another (templates.service `rebaseTasks`): leaves keep
 * their working-day offset from the project start and their duration; deadlines keep their
 * calendar-day offset. HOUR tasks also keep their time of day.
 */
export function rebaseTasks<T extends StoredTask>(
  tasks: readonly T[],
  from: { start: string; cal: WorkCalendar },
  to: { start: string; cal: WorkCalendar; unit: 'DAY' | 'HOUR' },
): T[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  const toStart = to.cal.addWorkingDays(to.start, 0);
  const shiftDays = daysBetween(from.start, to.start);
  return tasks.map((t) => {
    const deadline = t.deadline ? addCalendarDaysIso(t.deadline, shiftDays) : null;
    if (parents.has(t.id)) return { ...t, deadline };
    const day = to.cal.addWorkingDays(toStart, workingOffset(from.cal, from.start, t.startDate));
    const start = to.unit === 'HOUR' && t.startDate.length > 10 ? `${day}${t.startDate.slice(10, 16)}` : day;
    return normalizeLeaf({ ...t, startDate: start, deadline }, to.cal, to.unit === 'HOUR', to.unit);
  });
}

/** Security review A9 L3 (time-entries.service `assertEntryDate`): a year back … a week ahead (Riyadh). */
export const TIME_ENTRY_PAST_DAYS = 366;
export const TIME_ENTRY_FUTURE_DAYS = 7;
export function assertEntryDate(date: string, now = new Date()): void {
  const today = riyadhToday(now);
  if (date < addCalendarDaysIso(today, -TIME_ENTRY_PAST_DAYS) || date > addCalendarDaysIso(today, TIME_ENTRY_FUTURE_DAYS)) {
    fail('VALIDATION_FAILED', { fieldErrors: { date: ['التاريخ خارج المدى المسموح: من سنة مضت إلى أسبوع قادم.'] } });
  }
}

export function createA9(api: DemoInternals, core: ProjectsCore): A9Api {
  const db = api.db;
  const { tx } = core;

  const users = async () => new Map((await db.users.toArray()).map((u) => [u.id, u]));

  async function writableProject(projectId: string, viewer: DemoUser): Promise<DemoProject> {
    const p = await core.visibleProject(projectId, viewer);
    if (p.archivedAt) fail('PROJECT_ARCHIVED');
    return p;
  }

  async function readableProject(projectId: string, viewer: DemoUser): Promise<DemoProject> {
    core.readProjects(viewer);
    return core.visibleProject(projectId, viewer);
  }

  function uniqueVersioned(ids: string[], versions: Record<string, number>): string[] {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => versions[id] === undefined);
    if (missing.length) fail('VALIDATION_FAILED', { fieldErrors: { versions: ['أرسل نسخة كل مهمة محدّدة'] }, ids: missing });
    return unique;
  }

  // ------------------------------------------------------------ labels

  const labels: ApiClient['labels'] = {
    list: async (projectId) => {
      const viewer = await api.actor();
      await readableProject(projectId, viewer);
      return (await db.labels.where('projectId').equals(projectId).toArray()).sort(byNameAr).map(toLabelDto);
    },
    create: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(labelSchema, input);
      await writableProject(projectId, viewer);
      const row: DemoLabel = { id: newId(), projectId, name: data.name, color: data.color.toUpperCase(), createdAt: new Date().toISOString() };
      await tx(async () => {
        if ((await db.labels.where('projectId').equals(projectId).toArray()).some((l) => l.name === data.name)) fail('NAME_TAKEN');
        await db.labels.add(row);
        await api.writeAudit({ actorId: viewer.id, action: 'label.created', entityType: 'project', entityId: projectId, before: null, after: { labelId: row.id, name: row.name, color: row.color } });
      });
      return toLabelDto(row);
    },
    update: async (id, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(updateLabelSchema, input);
      const cur = await db.labels.get(id);
      if (!cur) fail('NOT_FOUND');
      await writableProject(cur.projectId, viewer);
      const patch = { ...(data.name !== undefined ? { name: data.name } : {}), ...(data.color !== undefined ? { color: data.color.toUpperCase() } : {}) };
      if (!Object.keys(patch).length) return toLabelDto(cur);
      await tx(async () => {
        if (patch.name && (await db.labels.where('projectId').equals(cur.projectId).toArray()).some((l) => l.id !== id && l.name === patch.name)) fail('NAME_TAKEN');
        await db.labels.put({ ...cur, ...patch });
        await api.writeAudit({ actorId: viewer.id, action: 'label.updated', entityType: 'project', entityId: cur.projectId, before: { labelId: id, name: cur.name, color: cur.color }, after: { labelId: id, ...patch } });
      });
      return toLabelDto({ ...cur, ...patch });
    },
    remove: async (id) => {
      const viewer = await api.actor('tasks.manage');
      const cur = await db.labels.get(id);
      if (!cur) fail('NOT_FOUND');
      await writableProject(cur.projectId, viewer);
      let out!: Awaited<ReturnType<ProjectsCore['persist']>>;
      await tx(async () => {
        const s = await core.load(cur.projectId);
        const finals = s.tasks.map((t) => (t.labelIds.includes(id) ? { ...t, labelIds: t.labelIds.filter((l) => l !== id) } : t));
        const touched = finals.filter((t, i) => t !== s.tasks[i]).map((t) => t.id);
        out = await core.persist(s, finals, { actorId: viewer.id, explicit: new Set(touched), explicitAction: 'task.updated', auditExtra: { cause: 'label.deleted', labelId: id } });
        await db.labels.delete(id);
        await api.writeAudit({ actorId: viewer.id, action: 'label.deleted', entityType: 'project', entityId: cur.projectId, before: { labelId: id, name: cur.name, color: cur.color, tasks: touched.length }, after: null });
      });
      return { affected: await core.taskDtosById(out.ids), previous: out.previous };
    },
  };

  async function setTaskLabel(taskId: string, labelId: string, on: boolean) {
    const viewer = await api.actor('tasks.manage');
    const { task } = await core.writableTask(taskId, viewer);
    let previous = {};
    await tx(async () => {
      const s = await core.load(task.projectId);
      if (on) await core.assertLabels(task.projectId, [labelId]);
      const cur = s.before.get(taskId);
      if (!cur) fail('NOT_FOUND');
      const set = new Set(cur.labelIds);
      if (on) set.add(labelId);
      else set.delete(labelId);
      const next = { ...cur, labelIds: [...set].sort() };
      ({ previous } = await core.persist(s, s.tasks.map((t) => (t.id === taskId ? next : t)), { actorId: viewer.id, explicit: new Set([taskId]), explicitAction: 'task.updated' }));
    });
    const [dto] = await core.taskDtosById([taskId]);
    return { task: dto!, affected: [], previous };
  }

  // ------------------------------------------------------------ custom fields

  const customFields: ApiClient['customFields'] = {
    list: async (projectId) => {
      const viewer = await api.actor();
      await readableProject(projectId, viewer);
      return (await db.customFields.where('projectId').equals(projectId).toArray()).sort((a, b) => a.sort - b.sort || byNameAr(a, b)).map(toFieldDto);
    },
    create: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(customFieldSchema, input);
      await writableProject(projectId, viewer);
      const options = cleanOptions(data.type, data.options);
      const existing = await db.customFields.where('projectId').equals(projectId).toArray();
      if (existing.some((f) => f.name === data.name)) fail('NAME_TAKEN');
      const row: DemoCustomField = {
        id: newId(),
        projectId,
        name: data.name,
        type: data.type,
        options,
        sort: data.sort ?? existing.reduce((m, f) => Math.max(m, f.sort), 0) + 1,
        createdAt: new Date().toISOString(),
      };
      await tx(async () => {
        await db.customFields.add(row);
        await api.writeAudit({ actorId: viewer.id, action: 'custom_field.created', entityType: 'project', entityId: projectId, before: null, after: { fieldId: row.id, name: row.name, type: row.type, options: options.length } });
      });
      return toFieldDto(row);
    },
    update: async (id, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(updateCustomFieldSchema, input);
      const cur = await db.customFields.get(id);
      if (!cur) fail('NOT_FOUND');
      await writableProject(cur.projectId, viewer);
      const next: DemoCustomField = { ...cur };
      if (data.name !== undefined) next.name = data.name;
      if (data.sort !== undefined) next.sort = data.sort;
      if (data.options !== undefined) next.options = cleanOptions(cur.type, data.options);
      if (JSON.stringify(next) === JSON.stringify(cur)) return toFieldDto(cur);
      await tx(async () => {
        if (data.name && (await db.customFields.where('projectId').equals(cur.projectId).toArray()).some((f) => f.id !== id && f.name === data.name)) fail('NAME_TAKEN');
        await db.customFields.put(next);
        await api.writeAudit({ actorId: viewer.id, action: 'custom_field.updated', entityType: 'project', entityId: cur.projectId, before: { fieldId: id, name: cur.name, options: cur.options }, after: { fieldId: id, ...data } });
      });
      return toFieldDto(next);
    },
    remove: async (id) => {
      const viewer = await api.actor('tasks.manage');
      const cur = await db.customFields.get(id);
      if (!cur) fail('NOT_FOUND');
      await writableProject(cur.projectId, viewer);
      await tx(async () => {
        let values = 0;
        for (const t of await db.tasks.where('projectId').equals(cur.projectId).toArray()) {
          if (t.customValues && id in t.customValues) {
            const { [id]: _drop, ...rest } = t.customValues;
            void _drop;
            await db.tasks.update(t.id, { customValues: rest });
            values++;
          }
        }
        await db.customFields.delete(id);
        await api.writeAudit({ actorId: viewer.id, action: 'custom_field.deleted', entityType: 'project', entityId: cur.projectId, before: { fieldId: id, name: cur.name, type: cur.type, values }, after: null });
      });
    },
  };

  // ------------------------------------------------------------ checklist

  const itemDto = (i: DemoChecklistItem, byId: Map<string, DemoUser>): ChecklistItemDto => {
    const u = i.doneById ? byId.get(i.doneById) : undefined;
    return { id: i.id, taskId: i.taskId, text: i.text, done: i.done, sort: i.sort, doneBy: u ? { id: u.id, fullName: u.fullName } : null, doneAt: i.doneAt };
  };
  const items = async (taskId: string) =>
    (await db.checklist.where('taskId').equals(taskId).toArray()).sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));

  // ------------------------------------------------------------ templates (copyContent)

  async function calendarOf(id: string) {
    const c = (await db.calendars.get(id)) ?? (await core.defaultCalendar());
    return workCalendarOf(c);
  }

  /** templates.service `copyContent`: labels, fields, live tasks (reset), deps, checklists (unticked). */
  async function copyContent(sourceId: string, targetId: string, actorId: string): Promise<number> {
    const source = await db.projects.get(sourceId);
    const target = await db.projects.get(targetId);
    if (!source || !target) fail('NOT_FOUND');
    const [srcLabels, srcFields, rows, deps, fromCal, toCal] = await Promise.all([
      db.labels.where('projectId').equals(sourceId).toArray(),
      db.customFields.where('projectId').equals(sourceId).toArray(),
      core.liveTasks(sourceId),
      db.dependencies.where('projectId').equals(sourceId).toArray(),
      calendarOf(source.calendarId),
      calendarOf(target.calendarId),
    ]);
    const now = new Date().toISOString();
    const labelMap = new Map(srcLabels.map((l) => [l.id, newId()]));
    await db.labels.bulkAdd(srcLabels.map((l) => ({ ...l, id: labelMap.get(l.id)!, projectId: targetId, createdAt: now })));
    await db.customFields.bulkAdd(srcFields.map((f) => ({ ...f, id: newId(), projectId: targetId, createdAt: now })));
    const idMap = new Map(rows.map((t) => [t.id, newId()]));
    const toUnit = unitOf(target);
    const copies = rebaseTasks<DemoTask>(
      rows.map((t) => ({
        ...t,
        id: idMap.get(t.id)!,
        projectId: targetId,
        parentId: t.parentId && idMap.has(t.parentId) ? idMap.get(t.parentId)! : null,
        progress: 0,
        status: 'NOT_STARTED' as const,
        assigneeId: null,
        actualCost: 0,
        version: 0,
        labelIds: t.labelIds.filter((l) => labelMap.has(l)).map((l) => labelMap.get(l)!).sort(),
        customValues: {},
        archivedAt: null,
        dueSoonNotifiedAt: null,
        overdueNotifiedAt: null,
        deadlineNotifiedAt: null,
        createdAt: now,
        createdById: actorId,
      })),
      { start: source.startDate, cal: fromCal },
      { start: target.startDate, cal: toCal, unit: toUnit },
    );
    const newDeps: DemoDependency[] = deps
      .filter((d) => idMap.has(d.predecessorId) && idMap.has(d.successorId))
      .map((d) => ({ ...d, id: newId(), projectId: targetId, predecessorId: idMap.get(d.predecessorId)!, successorId: idMap.get(d.successorId)!, createdAt: now }));
    const s = await core.load(targetId);
    const finals = core.recomputeState(s, [...s.tasks, ...copies], undefined, [...s.deps, ...newDeps]);
    await core.persist(s, finals, {
      actorId,
      insertedMany: topoOrder(copies),
      explicit: new Set(copies.map((c) => c.id)),
      explicitAction: 'task.created',
      auditExtra: { copiedFromProject: sourceId },
    });
    await db.dependencies.bulkAdd(newDeps);
    const srcItems = await db.checklist.where('taskId').anyOf(rows.length ? rows.map((r) => r.id) : ['-']).toArray();
    await db.checklist.bulkAdd(srcItems.map((i) => ({ ...i, id: newId(), taskId: idMap.get(i.taskId)!, done: false, doneById: null, doneAt: null, createdAt: now })));
    return copies.length;
  }

  // ------------------------------------------------------------ report rows (project-reports.service rowsFor)

  async function rowsFor(projects: DemoProject[], now = new Date()): Promise<ProjectReportRow[]> {
    const today = riyadhToday(now);
    const out: ProjectReportRow[] = [];
    for (const p of projects) {
      const tasks = await core.liveTasks(p.id);
      const cal = await calendarOf(p.calendarId);
      const leaves = leavesOf(tasks).filter((t) => t.type !== 'GROUP');
      // Portfolio weight (calculations audit, as the API): the roots' working days; HOUR projects
      // convert working minutes with the calendar's standard day.
      const unit = p.durationUnit === 'HOUR' ? 'HOUR' : 'DAY';
      const w = rootsForProgress(tasks).reduce((sum, r) => sum + progressWeight(r, unit), 0);
      const progressWeightDays = unit === 'HOUR' ? Math.round((w / cal.standardMinutesPerDay) * 100) / 100 : w;
      out.push({
        project: await core.projectDto(p, tasks),
        progressWeightDays,
        leafCount: leaves.filter((t) => t.type !== 'MILESTONE').length,
        doneCount: leaves.filter((t) => t.type !== 'MILESTONE' && t.status === 'DONE').length,
        overdueCount: leaves.filter((t) => dueFlags(t, today, cal).overdue).length,
        deadlinePassedCount: leaves.filter((t) => deadlinePassed(t, today)).length,
        milestoneCount: leaves.filter((t) => t.type === 'MILESTONE').length,
      });
    }
    return out;
  }

  async function loggedByUser(projectId: string): Promise<Map<string, number>> {
    const live = new Set((await core.liveTasks(projectId)).map((t) => t.id));
    const out = new Map<string, number>();
    for (const e of await db.timeEntries.toArray()) if (live.has(e.taskId)) out.set(e.userId, (out.get(e.userId) ?? 0) + e.minutes);
    return out;
  }

  async function loadReport(projectId: string) {
    const viewer = await api.actor('projects.readAll');
    const p = await core.visibleProject(projectId, viewer);
    const tasks = await core.liveTasks(projectId);
    const calendar = (await db.calendars.get(p.calendarId)) ?? (await core.defaultCalendar());
    return { p, tasks, calendar, cal: workCalendarOf(calendar) };
  }

  // ------------------------------------------------------------ portfolios

  const portfolioDto = (p: DemoPortfolio): PortfolioDto => ({ id: p.id, name: p.name, description: p.description, projectIds: [...p.projectIds], createdAt: p.createdAt });

  async function assertProjects(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    const rows = await db.projects.bulkGet(unique);
    const bad = unique.filter((_, i) => !rows[i] || rows[i]!.isTemplate);
    if (bad.length) fail('NOT_FOUND', { projectIds: bad });
  }

  async function getPortfolio(id: string) {
    const p = await db.portfolios.get(id);
    if (!p) fail('NOT_FOUND');
    return p;
  }

  async function updatePortfolio(id: string, input: unknown, viewer: DemoUser): Promise<PortfolioDto> {
    const data = validate(updatePortfolioSchema, input);
    const cur = await getPortfolio(id);
    if (data.projectIds) await assertProjects(data.projectIds);
    const next: DemoPortfolio = {
      ...cur,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description ?? null } : {}),
      ...(data.projectIds ? { projectIds: [...new Set(data.projectIds)] } : {}),
    };
    await tx(async () => {
      if (data.name && (await db.portfolios.toArray()).some((x) => x.id !== id && x.name === data.name)) fail('NAME_TAKEN');
      await db.portfolios.put(next);
      await api.writeAudit({ actorId: viewer.id, action: 'portfolio.updated', entityType: 'portfolio', entityId: id, before: { name: cur.name, projectIds: cur.projectIds }, after: { ...data } });
    });
    return portfolioDto(next);
  }

  // ------------------------------------------------------------ time entries

  const entryDtos = async (rows: DemoTimeEntry[]): Promise<TimeEntryDto[]> => {
    const [byUser, tasks, projects] = await Promise.all([users(), db.tasks.bulkGet([...new Set(rows.map((r) => r.taskId))]), db.projects.toArray()]);
    const taskById = new Map(tasks.filter((t): t is DemoTask => !!t).map((t) => [t.id, t]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    return rows.map((e) => {
      const t = taskById.get(e.taskId);
      const u = byUser.get(e.userId);
      return {
        id: e.id,
        task: { id: e.taskId, name: t?.name ?? '', projectId: t?.projectId ?? '', projectName: t ? (projectById.get(t.projectId)?.name ?? '') : '' },
        user: { id: e.userId, fullName: u?.fullName ?? '' },
        date: e.date,
        minutes: e.minutes,
        note: e.note,
        createdAt: e.createdAt,
      };
    });
  };
  const byDateDesc = (a: DemoTimeEntry, b: DemoTimeEntry) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

  async function ownEntry(id: string, viewer: DemoUser) {
    const e = await db.timeEntries.get(id);
    // Someone else's entry is not revealed to a supervisor (404).
    if (!e || (!can(viewer, 'tasks.manage') && e.userId !== viewer.id)) fail('NOT_FOUND');
    const t = await db.tasks.get(e.taskId);
    // Security review A9 L3: nor their own entry once the task is reassigned or archived.
    if (!can(viewer, 'tasks.manage') && (!t || t.assigneeId !== viewer.id || t.archivedAt)) fail('NOT_FOUND');
    const p = t ? await db.projects.get(t.projectId) : undefined;
    if (p?.archivedAt) fail('PROJECT_ARCHIVED');
    return e;
  }

  // ------------------------------------------------------------ view prefs

  const prefId = (userId: string, projectId: string | null, key: string) => `${userId}|${projectId ?? ''}|${key}`;
  const prefDto = (r: { projectId: string | null; key: string; value: unknown; updatedAt: string }): ViewPrefDto => ({
    projectId: r.projectId,
    key: r.key,
    value: r.value,
    updatedAt: r.updatedAt,
  });

  // ------------------------------------------------------------ the A9 project read models

  const projectsA9: A9Projects = {
    budget: async (id) => {
      const { p, tasks } = await loadReport(id);
      const [lbls, logged, byUser] = await Promise.all([db.labels.where('projectId').equals(id).toArray(), loggedByUser(id), users()]);
      return buildBudgetReport({
        projectId: id,
        currency: p.currency ?? 'SAR',
        budget: p.budget ?? null,
        tasks,
        labels: lbls.map(toLabelDto),
        users: new Map([...byUser].map(([k, v]) => [k, { id: v.id, fullName: v.fullName }])),
        loggedByUser: logged,
      });
    },
    people: async (id) => {
      const { tasks, cal } = await loadReport(id);
      const [logged, who] = await Promise.all([loggedByUser(id), core.assignees()]);
      return buildPeople({ tasks, cal, today: riyadhToday(), people: who, loggedByUser: logged });
    },
    dashboard: async (id) => {
      const { p, tasks, cal } = await loadReport(id);
      const [logged, byUser] = await Promise.all([loggedByUser(id), users()]);
      let loggedMinutes = 0;
      for (const m of logged.values()) loggedMinutes += m;
      return {
        project: await core.projectDto(p, tasks),
        ...buildDashboard({
          tasks,
          cal,
          today: riyadhToday(),
          budget: p.budget ?? null,
          people: new Map([...byUser].map(([k, v]) => [k, { id: v.id, fullName: v.fullName }])),
          loggedMinutes,
        }),
      };
    },
    calendar: async (id, range) => {
      const from = String(range?.from ?? '');
      const to = String(range?.to ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail('VALIDATION_FAILED', { fieldErrors: { from: ['تاريخ غير صالح'] } });
      const problem = rangeProblem(from, to);
      if (problem) fail('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
      const { p, tasks, calendar } = await loadReport(id);
      const today = riyadhToday();
      const items = tasks.filter(
        (t) => (t.startDate.slice(0, 10) <= to && t.endDate.slice(0, 10) >= from) || (t.deadline !== null && t.deadline >= from && t.deadline <= to),
      );
      const who = await core.assignees();
      return {
        project: { id: p.id, name: p.name },
        calendar: core.calendarDto(calendar),
        from,
        to,
        items: items
          .map((t) => {
            const a = t.assigneeId ? who.get(t.assigneeId) : undefined;
            return {
              taskId: t.id,
              wbs: t.wbsCache,
              name: t.name,
              type: t.type,
              startDate: t.startDate,
              endDate: t.endDate,
              deadline: t.deadline,
              deadlinePassed: deadlinePassed(t, today),
              status: t.status,
              progress: t.progress,
              barColor: t.barColor,
              assignee: a ? { id: a.id, fullName: a.fullName, teamColor: a.teamColor } : null,
            };
          })
          .sort((a, b) => compareWbs(a.wbs, b.wbs)),
      };
    },
    saveAsTemplate: async (id, input) => {
      const viewer = await api.actor('projects.create');
      const data = validate(saveAsTemplateSchema, input ?? {});
      const p = await core.visibleProject(id, viewer);
      let created!: DemoProject;
      await tx(async () => {
        created = {
          id: newId(),
          name: data.name ?? `${p.name} (قالب)`.slice(0, 160),
          description: data.description ?? p.description,
          startDate: p.startDate,
          status: 'PLANNING',
          calendarId: p.calendarId,
          autoSchedule: p.autoSchedule,
          ownerId: viewer.id,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          isTemplate: true,
          budget: p.budget ?? null,
          currency: p.currency ?? 'SAR',
          durationUnit: unitOf(p),
        };
        await db.projects.add(created);
        const count = await copyContent(id, created.id, viewer.id);
        await api.writeAudit({ actorId: viewer.id, action: 'project.saved_as_template', entityType: 'project', entityId: created.id, before: null, after: { sourceProjectId: id, name: created.name, tasks: count } });
      });
      return core.projectDto(created);
    },
    templates: async () => {
      await api.actor('projects.readAll');
      const rows = (await db.projects.toArray()).filter((p) => p.isTemplate && !p.archivedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const out: ProjectView[] = [];
      for (const r of rows) out.push(await core.projectDto(r));
      return out;
    },
    report: async (q = {}) => {
      await api.actor('projects.readAll');
      const status = q.status;
      const rows = (await db.projects.toArray())
        .filter((p) => !p.isTemplate)
        .filter((p) =>
          status === 'ALL' ? true : status === 'ARCHIVED' ? Boolean(p.archivedAt) || p.status === 'ARCHIVED' : !p.archivedAt && (!status || p.status === status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return rowsFor(rows);
    },
  };

  // ------------------------------------------------------------ the A9 task routes

  const tasksA9: A9Tasks = {
    duplicate: async (id, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(duplicateTaskSchema, input ?? {});
      const { task: visible } = await core.visibleTask(id, viewer);
      let res!: Awaited<ReturnType<ProjectsCore['persist']>>;
      const idMap = new Map<string, string>();
      let newDeps: DemoDependency[] = [];
      await tx(async () => {
        const s = await core.load(visible.projectId);
        const root = s.before.get(id);
        if (!root) fail('NOT_FOUND');
        const sourceIds = data.withSubtasks ? subtreeIds(s.tasks, id) : [id];
        for (const src of sourceIds) idMap.set(src, newId());
        const siblings = siblingsOf(s.tasks, root.parentId);
        const at = siblings.findIndex((t) => t.id === id);
        const rootSort = sortOrderBetween(root.sortOrder, siblings[at + 1]?.sortOrder ?? null);
        const hasKids = s.tasks.some((t) => t.parentId === id);
        const now = new Date().toISOString();
        const copies: DemoTask[] = sourceIds.map((src) => {
          const t = s.before.get(src)!;
          const isRoot = src === id;
          return {
            ...t,
            id: idMap.get(src)!,
            parentId: isRoot ? t.parentId : idMap.get(t.parentId!)!,
            sortOrder: isRoot ? rootSort : t.sortOrder,
            wbsCache: '',
            name: copyName(t.name),
            // A group copied without its children becomes a plain task.
            type: isRoot && !data.withSubtasks && hasKids ? 'TASK' : t.type,
            version: 0,
            labelIds: [...t.labelIds],
            customValues: { ...(t.customValues ?? {}) },
            createdAt: now,
            createdById: viewer.id,
            dueSoonNotifiedAt: null,
            overdueNotifiedAt: null,
            deadlineNotifiedAt: null,
          };
        });
        const inside = new Set(sourceIds);
        newDeps = s.deps
          .filter((d) => inside.has(d.predecessorId) && inside.has(d.successorId))
          .map((d) => ({ ...d, id: newId(), predecessorId: idMap.get(d.predecessorId)!, successorId: idMap.get(d.successorId)!, createdAt: now }));
        const finals = core.recomputeState(s, [...s.tasks, ...copies], copies.map((c) => c.id), [...s.deps, ...newDeps]);
        res = await core.persist(s, finals, {
          actorId: viewer.id,
          insertedMany: copies,
          explicit: new Set(copies.map((c) => c.id)),
          explicitAction: 'task.created',
          auditExtra: { duplicatedFrom: id },
        });
        await db.dependencies.bulkAdd(newDeps);
        const srcItems = await db.checklist.where('taskId').anyOf(sourceIds).toArray();
        await db.checklist.bulkAdd(srcItems.map((i) => ({ ...i, id: newId(), taskId: idMap.get(i.taskId)!, createdAt: now })));
        await api.writeAudit({
          actorId: viewer.id,
          action: 'task.duplicated',
          entityType: 'task',
          entityId: idMap.get(id)!,
          before: null,
          after: { sourceId: id, withSubtasks: data.withSubtasks, copies: copies.length, dependencies: newDeps.length },
        });
      });
      const copyIds = [...idMap.values()];
      const copySet = new Set(copyIds);
      return {
        // The copy of the original first, then WBS order.
        tasks: (await core.taskDtosById(copyIds)).sort((x, y) => compareWbs(x.wbs, y.wbs)),
        affected: await core.taskDtosById(res.ids.filter((x) => !copySet.has(x))),
        idMap: Object.fromEntries(idMap),
        dependencies: newDeps.map(core.dependencyDto),
        previous: res.previous,
      };
    },

    bulk: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(taskBulkSchema, input);
      if (data.ids.length > BULK_MAX) fail('VALIDATION_FAILED', { fieldErrors: { ids: ['عدد كبير من المهام'] } });
      await core.visibleProject(projectId, viewer);
      const ids = uniqueVersioned(data.ids, data.versions);
      const p = data.patch;
      if (p.assigneeId) await core.assertAssignee(p.assigneeId);
      let res!: Awaited<ReturnType<ProjectsCore['persist']>>;
      let before!: Map<string, DemoTask>;
      let project!: DemoProject;
      await tx(async () => {
        const s = await core.load(projectId);
        before = s.before;
        project = s.project;
        core.checkVersions(s, ids.map((id) => ({ id, version: data.versions[id]! })));
        await core.assertLabels(projectId, [...(p.labelIdsAdd ?? []), ...(p.labelIdsRemove ?? [])]);
        const work = new Map(s.before);
        const parentIds = new Set(s.tasks.map((t) => t.parentId).filter((x): x is string => !!x));
        for (const id of ids) {
          const next = { ...work.get(id)! };
          // H1: a group in the selection keeps its derived status/progress; leaves are synced.
          if (!parentIds.has(id) && next.type !== 'GROUP' && (p.status !== undefined || p.progress !== undefined)) {
            Object.assign(next, syncStatusProgress(next, { status: p.status, progress: p.progress }));
          }
          if (p.priority !== undefined) next.priority = p.priority;
          if (p.assigneeId !== undefined) next.assigneeId = p.assigneeId;
          if (p.barColor !== undefined) next.barColor = p.barColor ? p.barColor.toUpperCase() : null;
          if (p.labelIdsAdd || p.labelIdsRemove) {
            const set = new Set(next.labelIds);
            for (const l of p.labelIdsAdd ?? []) set.add(l);
            for (const l of p.labelIdsRemove ?? []) set.delete(l);
            next.labelIds = [...set].sort();
          }
          work.set(id, next);
        }
        // Shift: every selected leaf and every leaf under a selected group, once.
        const shifted = new Set<string>();
        if (p.shiftWorkingDays) {
          const parents = new Set(s.tasks.map((t) => t.parentId).filter((x): x is string => !!x));
          for (const id of ids) for (const sub of subtreeIds(s.tasks, id)) if (!parents.has(sub)) shifted.add(sub);
          for (const leafId of shifted) {
            const t = work.get(leafId)!;
            const day = s.cal.addWorkingDays(t.startDate.slice(0, 10), p.shiftWorkingDays);
            const start = s.unit === 'HOUR' && t.startDate.length > 10 ? `${day}${t.startDate.slice(10, 16)}` : day;
            work.set(leafId, normalizeLeaf({ ...t, startDate: start }, s.cal, s.unit === 'HOUR', s.unit));
          }
        }
        const explicit = new Set([...ids, ...shifted]);
        const finals = core.recomputeState(s, s.tasks.map((t) => work.get(t.id)!), [...explicit]);
        res = await core.persist(s, finals, { actorId: viewer.id, explicit, explicitAction: 'task.updated', auditExtra: { bulk: true } });
      });
      const out = await core.taskDtosById(res.ids);
      await core.notifyReassigned(out, before, project, viewer);
      return { tasks: out, previous: res.previous };
    },

    bulkArchive: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(taskBulkArchiveSchema, input);
      await core.visibleProject(projectId, viewer);
      const ids = uniqueVersioned(data.ids, data.versions);
      let r!: Awaited<ReturnType<ProjectsCore['archiveIn']>>;
      await tx(async () => {
        const s = await core.load(projectId);
        core.checkVersions(s, ids.map((id) => ({ id, version: data.versions[id]! })));
        r = await core.archiveIn(s, ids, viewer.id);
      });
      return { archivedIds: r.archivedIds, affected: await core.taskDtosById(r.ids), previous: r.previous, deletedDependencies: r.deletedDependencies };
    },

    restore: async (projectId, idsIn) => {
      const viewer = await api.actor('tasks.manage');
      if (!Array.isArray(idsIn) || !idsIn.length) fail('VALIDATION_FAILED', { fieldErrors: { ids: ['حدّد المهام'] } });
      await core.visibleProject(projectId, viewer);
      const ids = [...new Set(idsIn)];
      let res!: Awaited<ReturnType<ProjectsCore['persist']>>;
      await tx(async () => {
        const s0 = await core.load(projectId);
        const rows = (await db.tasks.bulkGet(ids)).filter((t): t is DemoTask => !!t && t.projectId === projectId && !!t.archivedAt);
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((r) => r.id));
          fail('NOT_FOUND', { taskIds: ids.filter((i) => !found.has(i)) });
        }
        const restoring = new Set(ids);
        for (const r of rows) {
          if (r.parentId && !restoring.has(r.parentId) && !s0.before.has(r.parentId)) fail('TASK_PARENT_INVALID', { taskId: r.id, parentId: r.parentId });
        }
        for (const r of rows) await db.tasks.put({ ...r, archivedAt: null, version: r.version + 1 });
        const s = await core.load(projectId);
        const finals = core.recomputeState(s, s.tasks);
        res = await core.persist(s, finals, { actorId: viewer.id, explicit: new Set(), explicitAction: 'task.moved', auditExtra: { cause: 'restore' } });
        for (const r of rows) {
          await api.writeAudit({ actorId: viewer.id, action: 'task.restored', entityType: 'task', entityId: r.id, before: null, after: { name: r.name, parentId: r.parentId } });
        }
        for (const id of ids) delete res.previous[id];
      });
      return {
        restored: await core.taskDtosById(ids),
        affected: await core.taskDtosById(res.ids.filter((i) => !ids.includes(i))),
        previous: res.previous,
      };
    },

    labels: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      const { task } = await core.visibleTask(id, viewer);
      const rows = (await db.labels.bulkGet(task.labelIds)).filter((l): l is DemoLabel => !!l);
      return rows.map(toLabelDto).sort(byNameAr);
    },
    addLabel: (id, labelId) => setTaskLabel(id, labelId, true),
    removeLabel: (id, labelId) => setTaskLabel(id, labelId, false),

    customFields: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      const { task } = await core.visibleTask(id, viewer);
      const fields = (await db.customFields.where('projectId').equals(task.projectId).toArray()).sort((a, b) => a.sort - b.sort || byNameAr(a, b));
      return fields.map((f) => ({ ...toFieldDto(f), value: task.customValues?.[f.id] ?? null }));
    },
    setCustomValue: async (id, fieldId, raw) => {
      const viewer = await api.actor('tasks.manage');
      const { task } = await core.writableTask(id, viewer);
      const field = await db.customFields.get(fieldId);
      if (!field || field.projectId !== task.projectId) fail('NOT_FOUND');
      const norm = normalizeCustomValue(field, raw);
      if (!norm.ok) fail('CUSTOM_FIELD_VALUE_INVALID', { fieldErrors: { value: [norm.message] }, fieldId });
      const value = norm.value;
      const audited = (v: unknown) => (field.type === 'TEXT' && typeof v === 'string' ? `${v.length} حرفًا` : v);
      await tx(async () => {
        const cur = await db.tasks.get(id);
        const values = { ...(cur?.customValues ?? {}) };
        const before = values[fieldId] ?? null;
        if (value === null) delete values[fieldId];
        else values[fieldId] = value;
        await db.tasks.update(id, { customValues: values });
        await api.writeAudit({ actorId: viewer.id, action: 'task.custom_value_set', entityType: 'task', entityId: id, before: { fieldId, value: audited(before) }, after: { fieldId, value: audited(value) } });
      });
      return { taskId: id, fieldId, value };
    },

    checklist: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      await core.visibleTask(id, viewer);
      const byId = await users();
      return (await items(id)).map((i) => itemDto(i, byId));
    },
    addChecklistItem: async (id, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(checklistItemSchema, input);
      await core.writableTask(id, viewer);
      let row!: DemoChecklistItem;
      await tx(async () => {
        const list = await items(id);
        let sort: number;
        if (data.afterId) {
          const i = list.findIndex((x) => x.id === data.afterId);
          if (i < 0) fail('VALIDATION_FAILED', { fieldErrors: { afterId: ['البند المرجعي ليس في هذه المهمة'] } });
          sort = sortOrderBetween(list[i]!.sort, list[i + 1]?.sort ?? null);
        } else sort = sortOrderBetween(list.at(-1)?.sort ?? null, null);
        row = { id: newId(), taskId: id, text: data.text, done: false, sort, doneById: null, doneAt: null, createdAt: new Date().toISOString() };
        await db.checklist.add(row);
        await api.writeAudit({ actorId: viewer.id, action: 'checklist_item.created', entityType: 'task', entityId: id, before: null, after: { itemId: row.id, length: data.text.length } });
      });
      return itemDto(row, await users());
    },
    updateChecklistItem: async (id, itemId, input) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_WORK])) fail('FORBIDDEN');
      const data = validate(updateChecklistItemSchema, input);
      const { task } = await core.writableTask(id, viewer);
      if (!can(viewer, 'tasks.manage')) {
        if (task.assigneeId !== viewer.id || data.text !== undefined) fail('FORBIDDEN', data.text !== undefined ? { fields: ['text'] } : undefined);
      }
      const cur = await db.checklist.get(itemId);
      if (!cur || cur.taskId !== id) fail('NOT_FOUND');
      const next: DemoChecklistItem = { ...cur };
      if (data.text !== undefined && data.text !== cur.text) next.text = data.text;
      if (data.done !== undefined && data.done !== cur.done) {
        next.done = data.done;
        next.doneById = data.done ? viewer.id : null;
        next.doneAt = data.done ? new Date().toISOString() : null;
      }
      if (next.text === cur.text && next.done === cur.done) return itemDto(cur, await users());
      await tx(async () => {
        await db.checklist.put(next);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'checklist_item.updated',
          entityType: 'task',
          entityId: id,
          before: { itemId, ...(next.done !== cur.done ? { done: cur.done } : {}), ...(next.text !== cur.text ? { length: cur.text.length } : {}) },
          after: { itemId, ...(next.done !== cur.done ? { done: next.done } : {}), ...(next.text !== cur.text ? { length: next.text.length } : {}) },
        });
      });
      return itemDto(next, await users());
    },
    removeChecklistItem: async (id, itemId) => {
      const viewer = await api.actor('tasks.manage');
      await core.writableTask(id, viewer);
      const cur = await db.checklist.get(itemId);
      if (!cur || cur.taskId !== id) fail('NOT_FOUND');
      await tx(async () => {
        await db.checklist.delete(itemId);
        await api.writeAudit({ actorId: viewer.id, action: 'checklist_item.deleted', entityType: 'task', entityId: id, before: { itemId, done: cur.done, length: cur.text.length }, after: null });
      });
    },
    reorderChecklist: async (id, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(checklistReorderSchema, input);
      await core.writableTask(id, viewer);
      await tx(async () => {
        const list = await items(id);
        const have = new Set(list.map((i) => i.id));
        if (new Set(data.ids).size !== data.ids.length || data.ids.length !== have.size || data.ids.some((i) => !have.has(i))) {
          fail('VALIDATION_FAILED', { fieldErrors: { ids: ['أرسل كل بنود القائمة مرة واحدة بالترتيب الجديد'] } });
        }
        for (const [i, itemId] of data.ids.entries()) await db.checklist.update(itemId, { sort: i + 1 });
        await api.writeAudit({ actorId: viewer.id, action: 'task.checklist_reordered', entityType: 'task', entityId: id, before: null, after: { ids: data.ids } });
      });
      const byId = await users();
      return (await items(id)).map((i) => itemDto(i, byId));
    },

    timeEntries: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      await core.visibleTask(id, viewer);
      return entryDtos((await db.timeEntries.where('taskId').equals(id).toArray()).sort(byDateDesc));
    },
    addTimeEntry: async (id, input) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_WORK])) fail('FORBIDDEN');
      const data = validate(timeEntrySchema, input);
      assertEntryDate(data.date);
      const { task, project } = await core.visibleTask(id, viewer);
      if (project.archivedAt) fail('PROJECT_ARCHIVED');
      const admin = can(viewer, 'tasks.manage');
      if (!admin && task.assigneeId !== viewer.id) fail('TIME_ENTRY_NOT_ALLOWED');
      let userId = viewer.id;
      if (data.userId && data.userId !== viewer.id) {
        if (!admin) fail('FORBIDDEN', { fields: ['userId'] });
        const u = await db.users.get(data.userId);
        if (!u || u.status !== 'ACTIVE') fail('VALIDATION_FAILED', { fieldErrors: { userId: ['المستخدم غير نشط أو غير موجود'] } });
        userId = data.userId;
      }
      const row: DemoTimeEntry = { id: newId(), taskId: id, userId, date: data.date, minutes: data.minutes, note: data.note ?? null, createdAt: new Date().toISOString() };
      await tx(async () => {
        await db.timeEntries.add(row);
        await api.writeAudit({ actorId: viewer.id, action: 'time_entry.created', entityType: 'task', entityId: id, before: null, after: { entryId: row.id, userId, date: data.date, minutes: data.minutes } });
      });
      return (await entryDtos([row]))[0]!;
    },
  };

  // ------------------------------------------------------------ assemble

  return {
    labels,
    customFields,

    timeEntries: {
      mine: async (q = {}) => {
        const viewer = await api.actor();
        if (!canAny(viewer, [...TASK_WORK])) fail('FORBIDDEN');
        const to = q.to ?? riyadhToday();
        const from = q.from ?? addCalendarDaysIso(to, -30);
        const problem = rangeProblem(from, to);
        if (problem) fail('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
        const rows = (await db.timeEntries.where('userId').equals(viewer.id).toArray()).filter((e) => e.date >= from && e.date <= to).sort(byDateDesc);
        return entryDtos(rows);
      },
      update: async (id, input) => {
        const viewer = await api.actor();
        if (!canAny(viewer, [...TASK_WORK])) fail('FORBIDDEN');
        const data = validate(updateTimeEntrySchema, input);
        if (data.date !== undefined) assertEntryDate(data.date);
        const cur = await ownEntry(id, viewer);
        const next: DemoTimeEntry = {
          ...cur,
          ...(data.date !== undefined ? { date: data.date } : {}),
          ...(data.minutes !== undefined ? { minutes: data.minutes } : {}),
          ...(data.note !== undefined ? { note: data.note ?? null } : {}),
        };
        await tx(async () => {
          await db.timeEntries.put(next);
          await api.writeAudit({
            actorId: viewer.id,
            action: 'time_entry.updated',
            entityType: 'task',
            entityId: cur.taskId,
            before: { entryId: id, date: cur.date, minutes: cur.minutes },
            after: { entryId: id, ...(data.date ? { date: data.date } : {}), ...(data.minutes ? { minutes: data.minutes } : {}) },
          });
        });
        return (await entryDtos([next]))[0]!;
      },
      remove: async (id) => {
        const viewer = await api.actor();
        if (!canAny(viewer, [...TASK_WORK])) fail('FORBIDDEN');
        const cur = await ownEntry(id, viewer);
        await tx(async () => {
          await db.timeEntries.delete(id);
          await api.writeAudit({ actorId: viewer.id, action: 'time_entry.deleted', entityType: 'task', entityId: cur.taskId, before: { entryId: id, userId: cur.userId, date: cur.date, minutes: cur.minutes }, after: null });
        });
      },
    },

    viewPrefs: {
      list: async (q = {}) => {
        const viewer = await api.actor('profile.update');
        const rows = (await db.viewPrefs.where('userId').equals(viewer.id).toArray())
          .filter((r) => (q.projectId ? r.projectId === q.projectId : r.projectId === null) && (!q.key || r.key === q.key))
          .sort((a, b) => a.key.localeCompare(b.key));
        return rows.map(prefDto);
      },
      put: async (input) => {
        const viewer = await api.actor('profile.update');
        const data = validate(putViewPrefSchema, input);
        if (data.value === undefined) fail('VALIDATION_FAILED', { fieldErrors: { value: ['أرسل قيمة'] } });
        const bytes = jsonBytes(data.value);
        if (bytes > VIEW_PREF_MAX_BYTES) fail('VIEW_PREF_TOO_LARGE', { bytes, max: VIEW_PREF_MAX_BYTES });
        const projectId = data.projectId ?? null;
        if (projectId) await core.visibleProject(projectId, viewer);
        const row = { id: prefId(viewer.id, projectId, data.key), userId: viewer.id, projectId, key: data.key, value: structuredClone(data.value), updatedAt: new Date().toISOString() };
        // Security review A9 L1: at most VIEW_PREF_MAX_COUNT stored preferences per user (a new key beyond → 409).
        if (!(await db.viewPrefs.get(row.id))) {
          const count = await db.viewPrefs.where('userId').equals(viewer.id).count();
          if (count >= VIEW_PREF_MAX_COUNT) fail('VIEW_PREF_LIMIT', { max: VIEW_PREF_MAX_COUNT });
        }
        await db.viewPrefs.put(row);
        return prefDto(row);
      },
      remove: async (q) => {
        const viewer = await api.actor('profile.update');
        await db.viewPrefs.delete(prefId(viewer.id, q.projectId ?? null, q.key));
      },
    },

    portfolios: {
      list: async () => {
        await api.actor('projects.readAll');
        return (await db.portfolios.toArray()).sort(byNameAr).map(portfolioDto);
      },
      get: async (id) => {
        const viewer = await api.actor('projects.readAll');
        const cur = await getPortfolio(id);
        const projects: DemoProject[] = [];
        for (const pid of cur.projectIds) {
          const p = await db.projects.get(pid);
          if (p && (await core.canSeeProject(viewer, p))) projects.push(p);
        }
        projects.sort((a, b) => a.startDate.localeCompare(b.startDate));
        const rows = await rowsFor(projects);
        return {
          ...portfolioDto(cur),
          projects: rows.map((r) => ({ project: r.project, overdueCount: r.overdueCount, leafCount: r.leafCount, doneCount: r.doneCount })),
          totals: portfolioTotals(rows),
        };
      },
      create: async (input) => {
        const viewer = await api.actor('projects.manage');
        const data = validate(portfolioSchema, input);
        const projectIds = [...new Set(data.projectIds ?? [])];
        await assertProjects(projectIds);
        const row: DemoPortfolio = { id: newId(), name: data.name, description: data.description ?? null, projectIds, createdAt: new Date().toISOString() };
        await tx(async () => {
          if ((await db.portfolios.toArray()).some((x) => x.name === data.name)) fail('NAME_TAKEN');
          await db.portfolios.add(row);
          await api.writeAudit({ actorId: viewer.id, action: 'portfolio.created', entityType: 'portfolio', entityId: row.id, before: null, after: { name: row.name, projectIds } });
        });
        return portfolioDto(row);
      },
      update: async (id, input) => updatePortfolio(id, input, await api.actor('projects.manage')),
      remove: async (id) => {
        const viewer = await api.actor('projects.manage');
        const cur = await getPortfolio(id);
        await tx(async () => {
          await db.portfolios.delete(id);
          await api.writeAudit({ actorId: viewer.id, action: 'portfolio.deleted', entityType: 'portfolio', entityId: id, before: { name: cur.name, projectIds: cur.projectIds }, after: null });
        });
      },
      addProject: async (id, projectId) => {
        const viewer = await api.actor('projects.manage');
        const cur = await getPortfolio(id);
        if (cur.projectIds.includes(projectId)) return portfolioDto(cur);
        return updatePortfolio(id, { projectIds: [...cur.projectIds, projectId] }, viewer);
      },
      removeProject: async (id, projectId) => {
        const viewer = await api.actor('projects.manage');
        const cur = await getPortfolio(id);
        if (!cur.projectIds.includes(projectId)) return portfolioDto(cur);
        return updatePortfolio(id, { projectIds: cur.projectIds.filter((x) => x !== projectId) }, viewer);
      },
    },

    workload: async (q) => {
      await api.actor('projects.readAll');
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (!iso.test(q.from) || !iso.test(q.to)) fail('VALIDATION_FAILED', { fieldErrors: { from: ['تاريخ غير صالح'] } });
      const problem = rangeProblem(q.from, q.to, 92);
      if (problem) fail('VALIDATION_FAILED', { fieldErrors: { to: [problem] } });
      const people = (await db.users.toArray())
        .filter((u) => u.status === 'ACTIVE' && (q.userIds?.length ? q.userIds.includes(u.id) : u.role === 'SUPERVISOR'))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'))
        .map((u) => ({ id: u.id, fullName: u.fullName }));
      const ids = new Set(people.map((u) => u.id));
      const live = await core.liveProjects();
      const cals = new Map((await db.calendars.toArray()).map((c) => [c.id, workCalendarOf(c)]));
      const fallback = workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
      const rows = (await db.tasks.toArray()).filter(
        (t) =>
          !t.archivedAt &&
          t.type === 'TASK' &&
          t.assigneeId &&
          ids.has(t.assigneeId) &&
          live.has(t.projectId) &&
          t.startDate.slice(0, 10) <= q.to &&
          t.endDate.slice(0, 10) >= q.from,
      );
      // Calculations audit L12: logged time counts only live tasks of live, non-template projects.
      const liveTaskIds = new Set((await db.tasks.toArray()).filter((t) => !t.archivedAt && live.has(t.projectId)).map((t) => t.id));
      const entries = (await db.timeEntries.toArray()).filter((e) => ids.has(e.userId) && e.date >= q.from && e.date <= q.to && liveTaskIds.has(e.taskId));
      // M4: the default calendar defines a person's per-day capacity (holidays 0, short days their minutes).
      const capacityCal = (await db.calendars.toArray()).find((c) => c.isDefault);
      return computeWorkload({
        from: q.from,
        to: q.to,
        users: people,
        capacity: capacityCal ? workCalendarOf(capacityCal) : fallback,
        tasks: rows.map((t) => {
          const p = live.get(t.projectId)!;
          return { assigneeId: t.assigneeId!, type: t.type, startDate: t.startDate, endDate: t.endDate, cal: cals.get(p.calendarId) ?? fallback, unit: unitOf(p) };
        }),
        entries: entries.map((e) => ({ userId: e.userId, date: e.date, minutes: e.minutes })),
      });
    },

    hub: {
      list: async (input = {}) => {
        const viewer = await api.actor('tasks.comment');
        const q = validate(hubQuerySchema, input);
        const term = q.q?.trim().toLowerCase();
        const live = await core.liveProjects();
        const admin = can(viewer, 'projects.readAll');
        const all = (await db.tasks.toArray()).filter((t) => !t.archivedAt && live.has(t.projectId) && (admin || t.assigneeId === viewer.id));
        const comments = await db.taskComments.toArray();
        const byTask = new Map<string, typeof comments>();
        for (const c of comments) {
          const list = byTask.get(c.taskId);
          if (list) list.push(c);
          else byTask.set(c.taskId, [c]);
        }
        const reads = new Map((await db.commentReads.where('userId').equals(viewer.id).toArray()).map((r) => [r.taskId, r.lastReadAt]));
        const scoped = all.filter((t) => byTask.has(t.id) && (!q.projectId || t.projectId === q.projectId));
        const matches = scoped.filter((t) => !term || t.name.toLowerCase().includes(term) || byTask.get(t.id)!.some((c) => c.body.toLowerCase().includes(term)));
        const stats = matches.map((t) => {
          const list = byTask.get(t.id)!;
          const read = reads.get(t.id);
          let last = list[0]!;
          for (const c of list) if (c.createdAt >= last.createdAt) last = c;
          return {
            task: t,
            commentCount: list.length,
            unreadCount: list.filter((c) => c.authorId !== viewer.id && (!read || c.createdAt > read)).length,
            mentioned: list.some((c) => c.mentions.includes(viewer.id)),
            last,
          };
        });
        const match = (s: (typeof stats)[number], f: HubFilter) =>
          f === 'new' ? s.unreadCount > 0 : f === 'mentioned' ? s.mentioned : f === 'assigned' ? s.task.assigneeId === viewer.id : f === 'created' ? s.task.createdById === viewer.id : true;
        const counts = Object.fromEntries(HUB_FILTERS.map((f) => [f, stats.filter((s) => match(s, f)).length])) as Record<HubFilter, number>;
        const filtered = stats.filter((s) => match(s, q.filter)).sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt) || (a.task.id < b.task.id ? -1 : 1));
        const page = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
        const byUser = await users();
        const tasksById = new Map((await db.tasks.toArray()).map((t) => [t.id, t]));
        const pathOf = (parentId: string | null) => {
          const out: string[] = [];
          for (let cur = parentId, guard = 0; cur && guard < 100; guard++) {
            const n = tasksById.get(cur);
            if (!n) break;
            out.unshift(n.name);
            cur = n.parentId;
          }
          return out;
        };
        const items: HubItemDto[] = page.map((s) => {
          const t = rowOf(s.task);
          const a = t.assigneeId ? byUser.get(t.assigneeId) : undefined;
          const author = byUser.get(s.last.authorId);
          return {
            task: { id: t.id, name: t.name, wbs: t.wbsCache, type: t.type, status: t.status, assignee: a ? { id: a.id, fullName: a.fullName } : null },
            project: { id: t.projectId, name: live.get(t.projectId)?.name ?? '' },
            // A9 security review (ADR-117): parent group names are not a supervisor's to see.
            path: admin ? pathOf(t.parentId) : [],
            commentCount: s.commentCount,
            unreadCount: s.unreadCount,
            lastReadAt: reads.get(t.id) ?? null,
            lastComment: { id: s.last.id, author: { id: s.last.authorId, fullName: author?.fullName ?? '' }, bodyPreview: preview(s.last.body), createdAt: s.last.createdAt },
          };
        });
        return { items, total: filtered.length, page: q.page, pageSize: q.pageSize, counts, unreadTotal: stats.reduce((n, s) => n + s.unreadCount, 0) };
      },
      attachments: async (input = {}) => {
        const viewer = await api.actor();
        if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
        const q = validate(attachmentBrowseQuerySchema, input);
        const term = q.q?.trim().toLowerCase();
        const live = await core.liveProjects();
        const admin = can(viewer, 'projects.readAll');
        const tasks = (await db.tasks.toArray()).filter(
          (t) =>
            !t.archivedAt &&
            live.has(t.projectId) &&
            (admin || t.assigneeId === viewer.id) &&
            (!q.projectId || t.projectId === q.projectId) &&
            (!term || t.name.toLowerCase().includes(term) || (live.get(t.projectId)?.name ?? '').toLowerCase().includes(term)),
        );
        const taskById = new Map(tasks.map((t) => [t.id, t]));
        const dayOf = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);
        const files = (await db.files.toArray())
          .filter((f) => f.entityType === 'task' && f.status === 'READY' && !f.deletedAt && f.entityId && taskById.has(f.entityId))
          .filter((f) => !q.type || kindGroup(f.mimeType) === q.type)
          .filter((f) => !q.uploadedBy || f.createdById === q.uploadedBy)
          .filter((f) => (!q.from || dayOf(f.createdAt) >= q.from) && (!q.to || dayOf(f.createdAt) <= q.to))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        const byUser = await users();
        const rows: AttachmentBrowseDto[] = files.map((f) => {
          const t = taskById.get(f.entityId!)!;
          const u = byUser.get(f.createdById);
          return {
            id: f.id,
            mimeType: f.mimeType,
            type: kindGroup(f.mimeType),
            sizeBytes: f.sizeBytes,
            uploadedBy: u ? { id: u.id, fullName: u.fullName } : null,
            createdAt: f.createdAt,
            task: { id: t.id, name: t.name, wbs: t.wbsCache },
            project: { id: t.projectId, name: live.get(t.projectId)?.name ?? '' },
          };
        });
        return paginate(rows, q.page, q.pageSize);
      },
    },

    projectsA9,
    tasksA9,
    templateHook: { copyContent },
  };
}
