/**
 * DemoApi Phase 4 + A9 — projects, tasks, dependencies, calendars (docs/API.md "Phase 4" and
 * "A9 — projects", ADR-056..060, ADR-092..097). Same rules as apps/api: every write loads the
 * project, checks all versions first (409 CONFLICT_VERSION with `{ refresh: 'tasks', conflicts }`,
 * nothing written), applies the edit, re-runs `@nuzli/scheduling` through `recompute()` (which
 * also rolls costs up) and stores only what changed with `version + 1` (a WBS-only change keeps
 * its version). Writes that change existing tasks answer the undo contract's `previous` map
 * (ADR-095). IndexedDB has no row locks; a Dexie read-write transaction over all tables
 * serialises writers inside one browser.
 *
 * A9 scope (ADR-092): only admins reach projects (403 for anyone without `projects.readAll` /
 * `projects.readGranted`); a supervisor reaches only the live tasks assigned to them (any other
 * task → 404). HOUR projects (ADR-105) schedule in working minutes with the same engine.
 */
import { detectCycle, tasksToDays, tasksToHours, wouldCreateCycle, type WorkCalendar } from '@nuzli/scheduling';
import { ensureProjectCalendar, weekendFromWorkingDays } from './calendars';
import {
  ENABLED_DEPENDENCY_TYPES,
  calendarExceptionSchema,
  convertProjectSchema,
  can,
  canAny,
  createDependencySchema,
  grantProjectAccessSchema,
  projectListQuerySchema,
  taskCommentSchema,
  type ActivityDto,
  type CalendarDto,
  type CommentReadDto,
  type DependencyDto,
  type MyTaskDto,
  type ProjectAccessDto,
  type TaskAttachmentDto,
  type TaskCommentDto,
  type TaskDto,
  type TaskPreviousMap,
  type TaskVersionConflictDetails,
} from '@nuzli/shared';
import type { ApiClient, CalendarListView } from '../client';
import {
  calendarSchemaH,
  createProjectSchemaH,
  createTaskSchemaH,
  taskBatchSchemaH,
  unitOf,
  updateCalendarSchemaH,
  updateProjectSchemaH,
  updateTaskSchemaH,
  DEFAULT_WORKING_HOURS,
  type DurationUnit,
  type ProjectView,
} from '../hoursWire';
import {
  applyScheduleEdit,
  assertValidParent,
  compareWbs,
  deadlinePassed,
  diffTasks,
  dueFlags,
  needsRenumber,
  normalizeLeaf,
  previousOf,
  projectProgress,
  recompute,
  riyadhToday,
  siblingsOf,
  sortOrderBetween,
  subtreeIds,
  toCents,
  fromCents,
  withA9,
  minutesToHours,
  workCalendarOf,
  type StoredTask,
  type VersionedField,
} from '../../features/projects/engine';
import { notificationPreview, preview } from '../../features/projects/reports';
import { buildTasksCsv, buildTasksWorkbook, type TaskExportRow } from '../../features/projects/excel';
import { writeMspdi } from '../../features/imports/mspdi';
import { workbookToBlob } from '../../features/violations/excel';
import type { DemoCalendar, DemoDependency, DemoFile, DemoProject, DemoTask, DemoUser } from './db';
import type { DemoInternals } from './phase2';
import { fail, newId, validate } from './util';
import { drawPlaceholder, placeholderPdf } from './placeholderImage';

export type Phase4Api = Pick<ApiClient, 'projects' | 'tasks' | 'dependencies' | 'calendars'>;

export interface Phase4Hooks {
  beforeTaskPresign(input: { entityId?: string; kind?: string }, actor: DemoUser): Promise<void>;
  afterTaskConfirm(file: DemoFile, actor: DemoUser): Promise<void>;
  /** The daily 07:00 reminder job (TASK_DUE_SOON / TASK_OVERDUE / TASK_DEADLINE_PASSED once each), run lazily. */
  sweepReminders(now?: Date): Promise<number>;
}

/** Fields a supervisor may change on a task assigned to them (ADR-007/058). */
const SUPERVISOR_FIELDS = new Set(['version', 'progress', 'status']);

export interface WriteState {
  project: DemoProject;
  calendar: DemoCalendar;
  cal: WorkCalendar;
  unit: DurationUnit;
  tasks: DemoTask[];
  deps: DemoDependency[];
  before: Map<string, DemoTask>;
}

export interface PersistOptions {
  actorId: string;
  inserted?: DemoTask;
  /** A9: several tasks to insert (duplicate, templates), parents first. */
  insertedMany?: DemoTask[];
  explicit: Set<string>;
  explicitAction: string;
  auditExtra?: Record<string, unknown>;
}

export interface AssigneeInfo {
  id: string;
  fullName: string;
  teamColor: string | null;
  teamName: string | null;
}

const descriptionLabel = (d: string | null | undefined) => (d ? `${d.length} حرفًا` : null);

function pick(t: StoredTask, fields: readonly VersionedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = f === 'description' ? descriptionLabel(t.description) : (t[f] ?? null);
  return out;
}

const READ_PROJECTS = ['projects.readAll', 'projects.readGranted'] as const;
const TASK_READ = ['projects.readAll', 'tasks.readAssigned'] as const;

/** A demo task row with the A9 columns filled (rows stored before A9 lack them). */
export const rowOf = (t: DemoTask): DemoTask => withA9(t);

/** HOUR projects schedule links with their working-minute lag (`lagHours` for the engine). */
export function withLagHours(deps: readonly DemoDependency[], unit: DurationUnit): DemoDependency[] {
  if (unit !== 'HOUR') return [...deps];
  return deps.map((d) => (d.lagMinutes != null ? { ...d, lagHours: minutesToHours(d.lagMinutes) } : d));
}

/**
 * The shared plumbing of the projects modules (phase4 + phaseA9): scope, the one write path,
 * DTO assembly. Exposed so the A9 module applies exactly the same rules.
 */
export interface ProjectsCore {
  tx<T>(fn: () => Promise<T>): Promise<T>;
  assignees(): Promise<Map<string, AssigneeInfo>>;
  taskDtos(rows: DemoTask[]): Promise<TaskDto[]>;
  taskDtosById(ids: string[]): Promise<TaskDto[]>;
  liveTasks(projectId: string): Promise<DemoTask[]>;
  projectDto(p: DemoProject, tasks?: DemoTask[]): Promise<ProjectView>;
  calendarDto(c: DemoCalendar): CalendarListView;
  dependencyDto(d: DemoDependency): DependencyDto;
  /** 403 without a project read permission, 404 outside the scope. */
  readProjects(viewer: DemoUser): void;
  canSeeProject(viewer: DemoUser, p: DemoProject): Promise<boolean>;
  visibleProject(id: string, viewer: DemoUser): Promise<DemoProject>;
  visibleTask(id: string, viewer: DemoUser): Promise<{ task: DemoTask; project: DemoProject }>;
  writableTask(id: string, viewer: DemoUser): Promise<{ task: DemoTask; project: DemoProject }>;
  assertAssignee(userId: string): Promise<void>;
  assertLabels(projectId: string, labelIds: readonly string[]): Promise<void>;
  load(projectId: string): Promise<WriteState>;
  checkVersions(s: WriteState, expected: ReadonlyArray<{ id: string; version: number }>): void;
  persist(s: WriteState, finals: DemoTask[], o: PersistOptions): Promise<{ ids: string[]; previous: TaskPreviousMap }>;
  recomputeState(s: WriteState, tasks: DemoTask[], changed?: string[], deps?: DemoDependency[]): DemoTask[];
  defaultCalendar(): Promise<DemoCalendar>;
  notifyReassigned(tasks: TaskDto[], before: ReadonlyMap<string, StoredTask>, project: DemoProject, viewer: DemoUser): Promise<void>;
  /** Live, non-template project ids → project rows (the supervisor scope). */
  liveProjects(): Promise<Map<string, DemoProject>>;
  archiveIn(s: WriteState, rootIds: string[], actorId: string): Promise<{ archivedIds: string[]; ids: string[]; previous: TaskPreviousMap; deletedDependencies: DependencyDto[] }>;
}

/**
 * Inserting a project from a template is implemented in the A9 module (`copyContent`); phase4's
 * `projects.create` calls it through this hook.
 */
export interface TemplateHook {
  copyContent(sourceId: string, targetId: string, actorId: string): Promise<number>;
}

export function createPhase4(
  api: DemoInternals,
  hooks: { templates?: () => TemplateHook } = {},
): Phase4Api & Phase4Hooks & { core: ProjectsCore } {
  const db = api.db;
  const tx = <T>(fn: () => Promise<T>) => db.transaction('rw', db.tables, fn);

  // ------------------------------------------------------------ lookups

  /** Assignee with the first ACTIVE team they lead (by creation) — like ASSIGNEE_SELECT. */
  async function assignees(): Promise<Map<string, AssigneeInfo>> {
    const [users, teams, colors] = await Promise.all([db.users.toArray(), db.teams.toArray(), db.colors.toArray()]);
    const colorHex = new Map(colors.map((c) => [c.id, c.hex]));
    const led = new Map<string, { name: string; hex: string | null; createdAt: string }>();
    for (const tm of teams) {
      if (tm.status !== 'ACTIVE') continue;
      const cur = led.get(tm.supervisorId);
      if (!cur || tm.createdAt < cur.createdAt) {
        led.set(tm.supervisorId, { name: tm.name, hex: colorHex.get(tm.colorId) ?? null, createdAt: tm.createdAt });
      }
    }
    return new Map(
      users.map((u) => {
        const team = led.get(u.id);
        return [u.id, { id: u.id, fullName: u.fullName, teamColor: team?.hex ?? null, teamName: team?.name ?? null }];
      }),
    );
  }

  async function counts(taskIds: string[]) {
    const ids = new Set(taskIds);
    const any = taskIds.length ? taskIds : ['-'];
    const [comments, files, items] = await Promise.all([
      db.taskComments.toArray(),
      db.files.where('entityId').anyOf(any).toArray(),
      db.checklist.where('taskId').anyOf(any).toArray(),
    ]);
    const c = new Map<string, number>();
    for (const x of comments) if (ids.has(x.taskId)) c.set(x.taskId, (c.get(x.taskId) ?? 0) + 1);
    const a = new Map<string, number>();
    for (const f of files) {
      if (f.entityType === 'task' && f.status === 'READY' && !f.deletedAt && f.entityId) {
        a.set(f.entityId, (a.get(f.entityId) ?? 0) + 1);
      }
    }
    const cl = new Map<string, { total: number; done: number }>();
    for (const i of items) {
      const cur = cl.get(i.taskId) ?? { total: 0, done: 0 };
      cur.total++;
      if (i.done) cur.done++;
      cl.set(i.taskId, cur);
    }
    return { comments: c, attachments: a, checklist: cl };
  }

  async function taskDtos(rows: DemoTask[]): Promise<TaskDto[]> {
    const [who, n] = await Promise.all([assignees(), counts(rows.map((r) => r.id))]);
    const today = riyadhToday();
    return rows.map((raw) => {
      const r = rowOf(raw);
      return {
        id: r.id,
        projectId: r.projectId,
        parentId: r.parentId,
        sortOrder: r.sortOrder,
        wbs: r.wbsCache,
        name: r.name,
        type: r.type,
        startDate: r.startDate,
        endDate: r.endDate,
        durationDays: r.durationDays,
        progress: r.progress,
        status: r.status,
        priority: r.priority,
        assignee: r.assigneeId ? (who.get(r.assigneeId) ?? null) : null,
        description: r.description,
        version: r.version,
        commentCount: n.comments.get(r.id) ?? 0,
        attachmentCount: n.attachments.get(r.id) ?? 0,
        plannedCost: r.plannedCost,
        actualCost: r.actualCost,
        overBudget: toCents(r.actualCost) > toCents(r.plannedCost),
        deadline: r.deadline,
        deadlinePassed: deadlinePassed(r, today),
        barColor: r.barColor,
        labelIds: [...r.labelIds],
        checklist: n.checklist.get(r.id) ?? { total: 0, done: 0 },
        customValues: { ...(r.customValues ?? {}) },
        ...(r.durationHours != null ? { durationHours: r.durationHours } : {}),
      };
    });
  }

  async function taskDtosById(ids: string[]): Promise<TaskDto[]> {
    const rows = (await db.tasks.bulkGet(ids)).filter((t): t is DemoTask => Boolean(t));
    return taskDtos(rows);
  }

  async function liveTasks(projectId: string): Promise<DemoTask[]> {
    return (await db.tasks.where('projectId').equals(projectId).toArray()).filter((t) => !t.archivedAt).map(rowOf);
  }

  async function projectDto(p: DemoProject, tasks?: DemoTask[]): Promise<ProjectView> {
    const live = tasks ?? (await liveTasks(p.id));
    const ids = new Set(live.map((t) => t.id));
    const owner = await db.users.get(p.ownerId);
    const endDate = live.reduce<string | null>((m, t) => (m === null || t.endDate > m ? t.endDate : m), null);
    const roots = live.filter((t) => !t.parentId || !ids.has(t.parentId));
    let planned = 0;
    let actual = 0;
    for (const r of roots) {
      planned += toCents(r.plannedCost ?? 0);
      actual += toCents(r.actualCost ?? 0);
    }
    const budget = p.budget ?? null;
    const budgetCents = budget === null ? null : toCents(budget);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      startDate: p.startDate,
      endDate,
      status: p.status,
      calendarId: p.calendarId,
      autoSchedule: p.autoSchedule,
      owner: { id: p.ownerId, fullName: owner?.fullName ?? '' },
      progress: projectProgress(roots),
      taskCount: live.length,
      createdAt: p.createdAt,
      budget,
      currency: p.currency ?? 'SAR',
      plannedCost: fromCents(planned),
      actualCost: fromCents(actual),
      costVariance: fromCents(planned - actual),
      budgetVariance: budgetCents === null ? null : fromCents(budgetCents - actual),
      budgetUsedPct: budgetCents ? Math.round((actual / budgetCents) * 10000) / 100 : null,
      isTemplate: Boolean(p.isTemplate),
      durationUnit: unitOf(p),
    };
  }

  const calendarDto = (c: DemoCalendar): CalendarListView => ({
    id: c.id,
    name: c.name,
    weekendDays: [...c.weekendDays],
    isDefault: c.isDefault,
    exceptions: [...c.exceptions].sort((a, b) => a.date.localeCompare(b.date)),
    ...(c.workingHours?.length ? { workingHours: c.workingHours.map((w) => ({ ...w })) } : {}),
  });

  const dependencyDto = (d: DemoDependency): DependencyDto => ({
    id: d.id,
    predecessorId: d.predecessorId,
    successorId: d.successorId,
    type: d.type,
    lagDays: d.lagDays,
    ...(d.lagMinutes != null ? { lagHours: minutesToHours(d.lagMinutes) } : {}),
  });

  // ------------------------------------------------------------ scope (ADR-092)

  function readProjects(viewer: DemoUser) {
    if (!canAny(viewer, [...READ_PROJECTS])) fail('FORBIDDEN');
  }

  async function canSeeProject(viewer: DemoUser, p: DemoProject): Promise<boolean> {
    if (can(viewer, 'projects.readAll')) return true;
    // Kept for `project_access` (no role holds `projects.readGranted` since A9).
    if (!can(viewer, 'projects.readGranted') || p.archivedAt || p.isTemplate) return false;
    return (await db.projectAccess.where('projectId').equals(p.id).filter((a) => a.userId === viewer.id).count()) > 0;
  }

  async function visibleProject(id: string, viewer: DemoUser): Promise<DemoProject> {
    const p = await db.projects.get(id);
    if (!p || !(await canSeeProject(viewer, p))) fail('NOT_FOUND');
    return p;
  }

  /** Admins: any live task. Supervisors: a live task assigned to them in a live, non-template project. */
  async function visibleTask(id: string, viewer: DemoUser): Promise<{ task: DemoTask; project: DemoProject }> {
    const raw = await db.tasks.get(id);
    if (!raw || raw.archivedAt) fail('NOT_FOUND');
    const project = await db.projects.get(raw.projectId);
    if (!project) fail('NOT_FOUND');
    const task = rowOf(raw);
    if (can(viewer, 'projects.readAll')) return { task, project };
    if (can(viewer, 'tasks.readAssigned') && task.assigneeId === viewer.id && !project.archivedAt && !project.isTemplate) {
      return { task, project };
    }
    fail('NOT_FOUND');
  }

  async function writableTask(id: string, viewer: DemoUser) {
    const r = await visibleTask(id, viewer);
    if (r.project.archivedAt) fail('PROJECT_ARCHIVED');
    return r;
  }

  async function liveProjects(): Promise<Map<string, DemoProject>> {
    return new Map((await db.projects.toArray()).filter((p) => !p.archivedAt && !p.isTemplate).map((p) => [p.id, p]));
  }

  async function assertAssignee(userId: string) {
    const u = await db.users.get(userId);
    if (!u || u.role !== 'SUPERVISOR' || u.status !== 'ACTIVE') fail('ASSIGNEE_NOT_SUPERVISOR');
  }

  async function assertLabels(projectId: string, labelIds: readonly string[]) {
    const unique = [...new Set(labelIds)];
    if (!unique.length) return;
    const rows = await db.labels.bulkGet(unique);
    const bad = unique.filter((id, i) => !rows[i] || rows[i]!.projectId !== projectId);
    if (bad.length) fail('LABEL_NOT_IN_PROJECT', { labelIds: bad });
  }

  // ------------------------------------------------------------ the one write path

  async function load(projectId: string): Promise<WriteState> {
    const project = await db.projects.get(projectId);
    if (!project) fail('NOT_FOUND');
    if (project.archivedAt) fail('PROJECT_ARCHIVED');
    const calendar = (await db.calendars.get(project.calendarId)) ?? (await defaultCalendar());
    const tasks = await liveTasks(projectId);
    const deps = await db.dependencies.where('projectId').equals(projectId).toArray();
    return {
      project,
      calendar,
      cal: workCalendarOf(calendar),
      unit: unitOf(project),
      tasks,
      deps,
      before: new Map(tasks.map((t) => [t.id, t])),
    };
  }

  const recomputeState = (s: WriteState, tasks: DemoTask[], changed?: string[], deps?: DemoDependency[]) =>
    recompute({
      tasks,
      dependencies: withLagHours(deps ?? s.deps, s.unit),
      calendar: s.cal,
      autoSchedule: s.project.autoSchedule,
      durationUnit: s.unit,
      ...(changed ? { changed } : {}),
    });

  /** ADR-017: every expected version first; any mismatch → 409 and nothing is written. */
  function checkVersions(s: WriteState, expected: ReadonlyArray<{ id: string; version: number }>) {
    const conflicts: TaskVersionConflictDetails['conflicts'] = [];
    for (const e of expected) {
      const cur = s.before.get(e.id);
      if (!cur || cur.version !== e.version) conflicts.push({ id: e.id, currentVersion: cur ? cur.version : null });
    }
    if (conflicts.length) {
      const details: TaskVersionConflictDetails = { refresh: 'tasks', conflicts };
      fail('CONFLICT_VERSION', details);
    }
  }

  /**
   * Writes what changed (`version + 1`), refreshes WBS-only rows, audits; answers the ids written
   * and the undo contract's `previous` (before-values of exactly the changed fields, ADR-095).
   */
  async function persist(s: WriteState, finals: DemoTask[], o: PersistOptions): Promise<{ ids: string[]; previous: TaskPreviousMap }> {
    const { versioned, wbsOnly } = diffTasks(s.before, finals);
    const ids: string[] = [];
    const previous: TaskPreviousMap = {};
    const inserts = [...(o.inserted ? [o.inserted] : []), ...(o.insertedMany ?? [])];
    const finalById = new Map(finals.map((f) => [f.id, f]));
    for (const draft of inserts) {
      const row = finalById.get(draft.id) ?? draft;
      await db.tasks.add({ ...row, version: 0 });
      ids.push(row.id);
      await api.writeAudit({
        actorId: o.actorId,
        action: 'task.created',
        entityType: 'task',
        entityId: row.id,
        before: null,
        after: {
          ...pick(row, ['name', 'type', 'parentId', 'startDate', 'endDate', 'durationDays', 'assigneeId']),
          ...(row.plannedCost ? { plannedCost: row.plannedCost } : {}),
          wbs: row.wbsCache,
          ...(o.auditExtra ?? {}),
        },
      });
    }
    for (const v of versioned) {
      const endMoved = v.fields.includes('endDate');
      const deadlineMoved = v.fields.includes('deadline');
      await db.tasks.put({
        ...v.after,
        version: v.before.version + 1,
        ...(endMoved ? { dueSoonNotifiedAt: null, overdueNotifiedAt: null } : {}),
        ...(deadlineMoved ? { deadlineNotifiedAt: null } : {}),
      });
      previous[v.after.id] = previousOf(v.before, v.fields);
      ids.push(v.after.id);
      const explicit = o.explicit.has(v.after.id);
      await api.writeAudit({
        actorId: o.actorId,
        action: explicit ? o.explicitAction : 'task.moved',
        entityType: 'task',
        entityId: v.after.id,
        before: pick(v.before, v.fields),
        after: { ...pick(v.after, v.fields), ...(explicit ? {} : { auto: true }), ...(o.auditExtra ?? {}) },
      });
    }
    for (const w of wbsOnly) {
      await db.tasks.update(w.id, { wbsCache: w.wbsCache });
      ids.push(w.id);
    }
    return { ids, previous };
  }

  /** Re-derives a whole project (calendar change, auto-schedule on): ends from durations, then the pass. */
  async function rescheduleProject(projectId: string, actorId: string, cause: string): Promise<number> {
    const s = await load(projectId);
    const parents = new Set(s.tasks.map((t) => t.parentId).filter((p): p is string => !!p));
    const derived = s.tasks.map((t) => (parents.has(t.id) ? t : normalizeLeaf(t, s.cal, false, s.unit)));
    const finals = recomputeState(s, derived);
    return (await persist(s, finals, { actorId, explicit: new Set(), explicitAction: 'task.moved', auditExtra: { cause } })).ids.length;
  }

  /**
   * DAY ↔ HOUR (ProjectStore.convertUnit, ADR-109): the project row already holds the new unit.
   * Each task keeps its working days (engine `tasksToHours` / `tasksToDays`), lags × / ÷ the
   * standard day, then the full forward pass. Audited `project.converted`; tasks `task.moved`.
   */
  async function convertIn(projectId: string, from: DurationUnit, actorId: string): Promise<number> {
    const s = await load(projectId);
    const std = s.cal.standardMinutesPerDay;
    const leaves = s.unit === 'HOUR' ? tasksToHours(s.tasks, s.cal) : tasksToDays(s.tasks, s.cal).map((t) => ({ ...t, durationHours: undefined }));
    const deps: DemoDependency[] = s.deps.map((d) => {
      if (s.unit === 'HOUR') return { ...d, lagMinutes: (Math.trunc(d.lagDays) || 0) * std };
      const { lagMinutes, ...rest } = d;
      return lagMinutes == null ? rest : { ...rest, lagDays: Math.round(lagMinutes / std) || 0 };
    });
    for (const d of deps) await db.dependencies.put(d);
    s.deps = deps;
    const finals = recomputeState(s, leaves as DemoTask[]);
    const n = (await persist(s, finals, { actorId, explicit: new Set(), explicitAction: 'task.moved', auditExtra: { cause: 'project.converted' } })).ids.length;
    await api.writeAudit({
      actorId,
      action: 'project.converted',
      entityType: 'project',
      entityId: projectId,
      before: { durationUnit: from },
      after: { durationUnit: s.unit, tasks: s.tasks.length },
    });
    return n;
  }

  async function defaultCalendar(): Promise<DemoCalendar> {
    const all = await db.calendars.toArray();
    const c = all.find((x) => x.isDefault) ?? all[0];
    if (!c) fail('NOT_FOUND');
    return c;
  }

  async function notifyAssigned(task: Pick<DemoTask, 'id' | 'name' | 'assigneeId' | 'startDate' | 'endDate'>, project: DemoProject, viewer: DemoUser) {
    if (!task.assigneeId || task.assigneeId === viewer.id) return;
    await api.notify(task.assigneeId, 'TASK_ASSIGNED', {
      taskId: task.id,
      taskName: task.name,
      projectId: project.id,
      projectName: project.name,
      startDate: task.startDate,
      endDate: task.endDate,
      assignedBy: viewer.fullName,
    });
  }

  async function notifyReassigned(tasks: TaskDto[], before: ReadonlyMap<string, StoredTask>, project: DemoProject, viewer: DemoUser) {
    for (const t of tasks) {
      const prev = before.get(t.id);
      if (prev && t.assignee && t.assignee.id !== prev.assigneeId) {
        await notifyAssigned({ id: t.id, name: t.name, assigneeId: t.assignee.id, startDate: t.startDate, endDate: t.endDate }, project, viewer);
      }
    }
  }

  const core: ProjectsCore = {
    tx,
    assignees,
    taskDtos,
    taskDtosById,
    liveTasks,
    projectDto,
    calendarDto,
    dependencyDto,
    readProjects,
    canSeeProject,
    visibleProject,
    visibleTask,
    writableTask,
    assertAssignee,
    assertLabels,
    load,
    checkVersions,
    persist,
    recomputeState,
    defaultCalendar,
    notifyReassigned,
    liveProjects,
    archiveIn: (s, rootIds, actorId) => archiveIn(s, rootIds, actorId),
  };

  // ------------------------------------------------------------ projects

  const projects: Phase4Api['projects'] = {
    list: async (query = {}) => {
      const viewer = await api.actor();
      readProjects(viewer);
      const q = validate(projectListQuerySchema, query);
      await maybeSweep();
      const rows = (await db.projects.toArray())
        .filter((p) => !p.isTemplate)
        .filter((p) =>
          q.status === 'ALL'
            ? true
            : q.status === 'ARCHIVED'
              ? Boolean(p.archivedAt) || p.status === 'ARCHIVED'
              : !p.archivedAt && (!q.status || p.status === q.status),
        )
        .filter((p) => !q.q || p.name.toLowerCase().includes(q.q.toLowerCase()))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const out: ProjectView[] = [];
      for (const p of rows) if (await canSeeProject(viewer, p)) out.push(await projectDto(p));
      return out;
    },

    get: async (id) => {
      const viewer = await api.actor();
      readProjects(viewer);
      return projectDto(await visibleProject(id, viewer));
    },

    create: async (input) => {
      const viewer = await api.actor('projects.create');
      const data = validate(createProjectSchemaH, input);
      let created!: DemoProject;
      let tpl: DemoProject | undefined;
      if (data.fromTemplateId) {
        tpl = await db.projects.get(data.fromTemplateId);
        if (!tpl || !(await canSeeProject(viewer, tpl))) fail('NOT_FOUND');
        if (!tpl.isTemplate || tpl.archivedAt) fail('NOT_A_TEMPLATE');
      }
      // A9 create form (ADR-109): working days / hours different from the base calendar create one.
      const customCalendar = !!data.workingDays || !!data.workingHours;
      await tx(async () => {
        const calendarId = customCalendar
          ? (
              await ensureProjectCalendar(api, viewer.id, {
                baseId: data.calendarId ?? tpl?.calendarId,
                weekendDays: data.workingDays ? weekendFromWorkingDays(data.workingDays) : undefined,
                workingHours: data.workingHours,
                name: `تقويم ${data.name}`,
              })
            ).id
          : (data.calendarId ?? tpl?.calendarId ?? (await defaultCalendar()).id);
        if (!(await db.calendars.get(calendarId))) {
          fail('VALIDATION_FAILED', { fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] } });
        }
        created = {
          id: newId(),
          name: data.name,
          description: data.description ?? tpl?.description ?? null,
          startDate: data.startDate,
          status: data.status,
          calendarId,
          autoSchedule: data.autoSchedule,
          ownerId: viewer.id,
          createdAt: new Date().toISOString(),
          archivedAt: data.status === 'ARCHIVED' ? new Date().toISOString() : null,
          budget: data.budget !== undefined ? data.budget : (tpl?.budget ?? null),
          currency: data.currency ?? tpl?.currency ?? 'SAR',
          isTemplate: false,
          templateOfId: tpl?.id ?? null,
          durationUnit: data.durationUnit ?? (tpl ? unitOf(tpl) : 'DAY'),
        };
        await db.projects.add(created);
        let copied = 0;
        if (tpl) {
          const hook = hooks.templates?.();
          if (hook) copied = await hook.copyContent(tpl.id, created.id, viewer.id);
        }
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.created',
          entityType: 'project',
          entityId: created.id,
          before: null,
          after: {
            ...data,
            calendarId,
            description: descriptionLabel(data.description),
            ...(tpl ? { fromTemplateId: tpl.id, tasks: copied } : {}),
          },
        });
      });
      return projectDto(created);
    },

    update: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(updateProjectSchemaH, input);
      const cur = await visibleProject(id, viewer);
      const FIELDS = ['name', 'description', 'startDate', 'status', 'calendarId', 'autoSchedule', 'budget', 'currency', 'durationUnit'] as const;
      const curValue = (f: (typeof FIELDS)[number]) =>
        f === 'budget' ? (cur.budget ?? null) : f === 'currency' ? (cur.currency ?? 'SAR') : f === 'durationUnit' ? unitOf(cur) : cur[f];
      const changed = FIELDS.filter((f) => data[f] !== undefined && data[f] !== curValue(f));
      if (!changed.length) return projectDto(cur);
      // A different unit alone is the conversion (= POST /projects/:id/convert).
      if (changed.length === 1 && changed[0] === 'durationUnit') return projects.convert(id, data.durationUnit!);
      if (cur.archivedAt && !(data.status && data.status !== 'ARCHIVED')) fail('PROJECT_ARCHIVED');
      if (data.calendarId !== undefined && !(await db.calendars.get(data.calendarId))) {
        fail('VALIDATION_FAILED', { fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] } });
      }
      let next!: DemoProject;
      await tx(async () => {
        next = { ...cur };
        for (const f of changed) (next as unknown as Record<string, unknown>)[f] = data[f];
        if (data.status === 'ARCHIVED') next.archivedAt = new Date().toISOString();
        else if (data.status && cur.archivedAt) next.archivedAt = null;
        await db.projects.put(next);
        let rescheduled = 0;
        if (changed.includes('durationUnit') && !next.archivedAt) {
          rescheduled = await convertIn(id, unitOf(cur), viewer.id);
        }
        const reschedule =
          !next.archivedAt && (changed.includes('calendarId') || (changed.includes('autoSchedule') && data.autoSchedule === true));
        if (reschedule) rescheduled += await rescheduleProject(id, viewer.id, 'project.updated');
        await api.writeAudit({
          actorId: viewer.id,
          action: data.status === 'ARCHIVED' ? 'project.archived' : 'project.updated',
          entityType: 'project',
          entityId: id,
          before: Object.fromEntries(changed.map((f) => [f, f === 'description' ? null : curValue(f)])),
          after: {
            ...Object.fromEntries(changed.map((f) => [f, f === 'description' ? descriptionLabel(data.description) : data[f]])),
            ...(rescheduled ? { rescheduledTasks: rescheduled } : {}),
          },
        });
      });
      return projectDto(next);
    },

    archive: async (id) => {
      const viewer = await api.actor('projects.manage');
      const cur = await visibleProject(id, viewer);
      if (cur.archivedAt) return projectDto(cur);
      const next: DemoProject = { ...cur, archivedAt: new Date().toISOString(), status: 'ARCHIVED' };
      await tx(async () => {
        await db.projects.put(next);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.archived',
          entityType: 'project',
          entityId: id,
          before: { status: cur.status },
          after: { status: 'ARCHIVED' },
        });
      });
      return projectDto(next);
    },

    access: async (id) => {
      const viewer = await api.actor('projects.manage');
      await visibleProject(id, viewer);
      const rows = (await db.projectAccess.where('projectId').equals(id).toArray()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const out: ProjectAccessDto[] = [];
      for (const r of rows) {
        const u = await db.users.get(r.userId);
        if (u) out.push({ user: { id: u.id, fullName: u.fullName, role: u.role }, level: r.level, grantedAt: r.createdAt });
      }
      return out;
    },

    grantAccess: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(grantProjectAccessSchema, input);
      await visibleProject(id, viewer);
      const u = await db.users.get(data.userId);
      if (!u || u.role !== 'SUPERVISOR' || u.status !== 'ACTIVE') {
        fail('VALIDATION_FAILED', { fieldErrors: { userId: ['تُمنح صلاحية عرض المشروع للمشرفين النشطين فقط'] } });
      }
      let row = await db.projectAccess.where('projectId').equals(id).filter((a) => a.userId === u.id).first();
      if (!row) {
        row = { id: newId(), projectId: id, userId: u.id, level: 'VIEW', createdAt: new Date().toISOString() };
        await tx(async () => {
          await db.projectAccess.add(row!);
          await api.writeAudit({
            actorId: viewer.id,
            action: 'project.access_granted',
            entityType: 'project',
            entityId: id,
            before: null,
            after: { userId: u.id, level: 'VIEW' },
          });
        });
      }
      return { user: { id: u.id, fullName: u.fullName, role: u.role }, level: 'VIEW', grantedAt: row.createdAt };
    },

    revokeAccess: async (id, userId) => {
      const viewer = await api.actor('projects.manage');
      await visibleProject(id, viewer);
      await tx(async () => {
        const n = await db.projectAccess.where('projectId').equals(id).filter((a) => a.userId === userId).delete();
        if (!n) fail('NOT_FOUND');
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.access_revoked',
          entityType: 'project',
          entityId: id,
          before: { userId },
          after: null,
        });
      });
    },

    gantt: async (id) => {
      const viewer = await api.actor();
      readProjects(viewer);
      const p = await visibleProject(id, viewer);
      const tasks = await liveTasks(id);
      const calendar = (await db.calendars.get(p.calendarId)) ?? (await defaultCalendar());
      const deps = await db.dependencies.where('projectId').equals(id).toArray();
      const dtos = (await taskDtos(tasks)).sort((a, b) => compareWbs(a.wbs, b.wbs));
      const cal: CalendarDto = calendarDto(calendar);
      const [labels, fields] = await Promise.all([
        db.labels.where('projectId').equals(id).toArray(),
        db.customFields.where('projectId').equals(id).toArray(),
      ]);
      return {
        project: await projectDto(p, tasks),
        tasks: dtos,
        dependencies: deps.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(dependencyDto),
        calendar: cal,
        labels: labels
          .map((l) => ({ id: l.id, projectId: l.projectId, name: l.name, color: l.color.toUpperCase() }))
          .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
        customFields: fields
          .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ar'))
          .map((f) => ({ id: f.id, projectId: f.projectId, name: f.name, type: f.type, options: [...f.options], sort: f.sort })),
      };
    },

    exportXlsx: (id) => projects.export(id, 'xlsx'),

    export: async (id, format) => {
      const viewer = await api.actor();
      const g = await projects.gantt(id);
      const generatedAt = new Date();
      const unit = unitOf(g.project);
      const labelName = new Map((g.labels ?? []).map((l) => [l.id, l.name]));
      const customFields = (g.customFields ?? []).map((cf) => ({ id: cf.id, name: cf.name, type: cf.type }));
      const rows: TaskExportRow[] = g.tasks.map((t) => ({
        wbs: t.wbs,
        name: t.name,
        type: t.type,
        startDate: t.startDate,
        endDate: t.endDate,
        durationDays: t.durationDays,
        ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
        progress: t.progress,
        status: t.status,
        priority: t.priority,
        assigneeName: t.assignee?.fullName ?? null,
        teamName: t.assignee?.teamName ?? null,
        description: t.description,
        plannedCost: t.plannedCost ?? 0,
        actualCost: t.actualCost ?? 0,
        deadline: t.deadline ?? null,
        labels: (t.labelIds ?? []).map((l) => labelName.get(l)).filter((n): n is string => !!n),
        customValues: t.customValues ?? {},
      }));
      let blob: Blob;
      if (format === 'csv') {
        blob = new Blob([buildTasksCsv({ durationUnit: unit, customFields }, rows)], { type: 'text/csv;charset=utf-8' });
      } else if (format === 'xml') {
        const xml = writeMspdi({
          name: g.project.name,
          startDate: g.project.startDate,
          unit,
          currencyCode: g.project.currency,
          createdAt: new Date(g.project.createdAt),
          calendar: {
            name: g.calendar.name,
            weekendDays: g.calendar.weekendDays,
            workingHours: g.calendar.workingHours ?? DEFAULT_WORKING_HOURS,
            exceptions: g.calendar.exceptions.map((e) => ({ date: e.date, isWorking: e.isWorking, name: e.name, workingHours: e.workingHours ?? null })),
          },
          tasks: g.tasks.map((t) => ({
            id: t.id,
            parentId: t.parentId,
            wbs: t.wbs,
            name: t.name,
            type: t.type,
            startDate: t.startDate,
            endDate: t.endDate,
            durationDays: t.durationDays,
            ...(t.durationHours !== undefined ? { durationHours: t.durationHours } : {}),
            progress: t.progress,
            plannedCost: t.plannedCost ?? 0,
            actualCost: t.actualCost ?? 0,
            deadline: t.deadline ?? null,
            notes: t.description,
            assigneeName: t.assignee?.fullName ?? null,
          })),
          deps: g.dependencies.map((d) => ({
            predecessorId: d.predecessorId,
            successorId: d.successorId,
            type: d.type,
            lagDays: d.lagDays,
            lagMinutes: d.lagHours !== undefined ? Math.round(d.lagHours * 60) : 0,
          })),
        });
        blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      } else {
        const wb = await buildTasksWorkbook(
          {
            name: g.project.name,
            status: g.project.status,
            startDate: g.project.startDate,
            endDate: g.project.endDate,
            progress: g.project.progress,
            calendarName: g.calendar.name,
            autoSchedule: g.project.autoSchedule,
            generatedAt,
            durationUnit: unit,
            currency: g.project.currency,
            budget: g.project.budget ?? null,
            customFields,
          },
          rows,
        );
        blob = await workbookToBlob(wb);
      }
      await api.writeAudit({
        actorId: viewer.id,
        action: 'project.exported',
        entityType: 'project',
        entityId: id,
        before: null,
        after: { format, tasks: g.tasks.length },
      });
      return blob;
    },

    convert: async (id, durationUnit) => {
      const viewer = await api.actor('projects.manage');
      const unit = validate(convertProjectSchema, { durationUnit }).durationUnit;
      const cur = await visibleProject(id, viewer);
      if (unitOf(cur) === unit) return projectDto(cur);
      if (cur.archivedAt) fail('PROJECT_ARCHIVED');
      let next!: DemoProject;
      await tx(async () => {
        next = { ...cur, durationUnit: unit };
        await db.projects.put(next);
        await convertIn(id, unitOf(cur), viewer.id);
      });
      return projectDto(next);
    },

    // The A9 read models are implemented in phaseA9.ts and assigned over these.
    budget: () => fail('NOT_FOUND'),
    people: () => fail('NOT_FOUND'),
    dashboard: () => fail('NOT_FOUND'),
    calendar: () => fail('NOT_FOUND'),
    saveAsTemplate: () => fail('NOT_FOUND'),
    templates: () => fail('NOT_FOUND'),
    report: () => fail('NOT_FOUND'),
  };

  // ------------------------------------------------------------ tasks

  const tasks: Phase4Api['tasks'] = {
    create: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(createTaskSchemaH, input);
      await visibleProject(projectId, viewer);
      if (data.assigneeId) await assertAssignee(data.assigneeId);
      const id = newId();
      let ids: string[] = [];
      let project!: DemoProject;
      await tx(async () => {
        const s = await load(projectId);
        project = s.project;
        const parentId = data.parentId ?? null;
        assertValidParent(s.before, null, parentId);
        let all = s.tasks;
        let siblings = siblingsOf(all, parentId);
        const locate = () => {
          if (!data.afterId) return { prev: siblings.at(-1)?.sortOrder ?? null, next: null };
          const i = siblings.findIndex((t) => t.id === data.afterId);
          if (i < 0) fail('VALIDATION_FAILED', { fieldErrors: { afterId: ['المهمة المرجعية ليست في المستوى نفسه'] } });
          return { prev: siblings[i]!.sortOrder, next: siblings[i + 1]?.sortOrder ?? null };
        };
        let { prev, next } = locate();
        if (needsRenumber(prev, next)) {
          const order = new Map(siblings.map((t, i) => [t.id, i + 1]));
          all = all.map((t) => (order.has(t.id) ? { ...t, sortOrder: order.get(t.id)! } : t));
          siblings = siblingsOf(all, parentId);
          ({ prev, next } = locate());
        }
        const startDate = s.unit === 'HOUR' ? data.startDate : data.startDate.slice(0, 10);
        const draft = normalizeLeaf<DemoTask>(
          {
            id,
            projectId,
            parentId,
            sortOrder: sortOrderBetween(prev, next),
            wbsCache: '',
            name: data.name,
            type: data.type,
            startDate,
            endDate: startDate,
            durationDays: data.durationDays,
            ...(s.unit === 'HOUR' && data.durationHours !== undefined ? { durationHours: data.durationHours } : {}),
            progress: data.progress,
            status: data.status,
            priority: data.priority,
            assigneeId: data.assigneeId ?? null,
            description: data.description ?? null,
            version: 0,
            plannedCost: data.plannedCost ?? 0,
            actualCost: data.actualCost ?? 0,
            deadline: data.deadline ?? null,
            barColor: data.barColor ?? null,
            labelIds: [],
            archivedAt: null,
            dueSoonNotifiedAt: null,
            overdueNotifiedAt: null,
            createdAt: new Date().toISOString(),
            createdById: viewer.id,
          },
          s.cal,
          true,
          s.unit,
        );
        const finals = recomputeState(s, [...all, draft], [id]);
        ids = (await persist(s, finals, { actorId: viewer.id, inserted: draft, explicit: new Set([id]), explicitAction: 'task.created' })).ids;
        const stored = await db.tasks.get(id);
        if (stored) await notifyAssigned(stored, project, viewer);
      });
      const dtos = await taskDtosById(ids);
      const task = dtos.find((d) => d.id === id)!;
      return { ...task, affected: dtos.filter((d) => d.id !== id) };
    },

    get: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      const { task } = await visibleTask(id, viewer);
      return (await taskDtos([task]))[0]!;
    },

    update: async (id, input) => {
      const viewer = await api.actor();
      if (!canAny(viewer, ['tasks.manage', 'tasks.updateAssigned'])) fail('FORBIDDEN');
      const data = validate(updateTaskSchemaH, input);
      const { task: visible } = await visibleTask(id, viewer);
      if (!can(viewer, 'tasks.manage')) {
        // ADR-007: progress/status only, on tasks assigned to the supervisor.
        if (!can(viewer, 'tasks.updateAssigned') || visible.assigneeId !== viewer.id) fail('FORBIDDEN');
        const extra = Object.entries(input as Record<string, unknown>)
          .filter(([k, v]) => v !== undefined && !SUPERVISOR_FIELDS.has(k))
          .map(([k]) => k);
        if (extra.length) fail('FORBIDDEN', { fields: extra });
      }
      if (data.assigneeId) await assertAssignee(data.assigneeId);
      let ids: string[] = [];
      let previous: TaskPreviousMap = {};
      let previousAssignee: string | null = null;
      await tx(async () => {
        const s = await load(visible.projectId);
        checkVersions(s, [{ id, version: data.version }]);
        const cur = s.before.get(id)!;
        previousAssignee = cur.assigneeId;
        let next: DemoTask = { ...cur };
        if (data.name !== undefined) next.name = data.name;
        if (data.priority !== undefined) next.priority = data.priority;
        if (data.description !== undefined) next.description = data.description;
        if (data.status !== undefined) next.status = data.status;
        if (data.progress !== undefined) next.progress = data.progress;
        if (data.assigneeId !== undefined) next.assigneeId = data.assigneeId;
        if (data.plannedCost !== undefined) next.plannedCost = data.plannedCost;
        if (data.actualCost !== undefined) next.actualCost = data.actualCost;
        if (data.deadline !== undefined) next.deadline = data.deadline;
        if (data.barColor !== undefined) next.barColor = data.barColor ? data.barColor.toUpperCase() : null;
        const hasChildren = s.tasks.some((t) => t.parentId === id);
        if (data.type !== undefined && data.type !== cur.type) {
          if (data.type === 'MILESTONE' && hasChildren) fail('TASK_PARENT_INVALID', { taskId: id });
          next.type = data.type;
        }
        if (data.parentId !== undefined && data.parentId !== cur.parentId) {
          assertValidParent(s.before, id, data.parentId);
          next.parentId = data.parentId;
          next.sortOrder = sortOrderBetween(siblingsOf(s.tasks, data.parentId, id).at(-1)?.sortOrder ?? null, null);
        }
        const scheduleTouched =
          data.startDate !== undefined || data.durationDays !== undefined || data.durationHours !== undefined || next.type !== cur.type;
        if (scheduleTouched && !hasChildren) {
          next = applyScheduleEdit(
            next,
            {
              startDate: data.startDate === undefined ? undefined : s.unit === 'HOUR' ? data.startDate : data.startDate.slice(0, 10),
              durationDays: data.durationDays,
              durationHours: data.durationHours,
            },
            s.cal,
            s.unit,
          );
        }
        const finals = recomputeState(
          s,
          s.tasks.map((t) => (t.id === id ? next : t)),
          [id],
        );
        ({ ids, previous } = await persist(s, finals, { actorId: viewer.id, explicit: new Set([id]), explicitAction: 'task.updated' }));
        const after = await db.tasks.get(id);
        if (after?.assigneeId && after.assigneeId !== previousAssignee) await notifyAssigned(after, s.project, viewer);
      });
      // A9 security review (ADR-117): a caller without projects.readAll (a supervisor) gets only
      // their own task — the rolled-up parents are not theirs to see.
      if (!can(viewer, 'projects.readAll')) {
        const [own] = await taskDtosById([id]);
        return { task: own!, affected: [], previous: previous[id] ? { [id]: previous[id]! } : {} };
      }
      const dtos = await taskDtosById([id, ...ids.filter((x) => x !== id)]);
      return { task: dtos[0]!, affected: dtos.slice(1), previous };
    },

    batch: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(taskBatchSchemaH, input);
      await visibleProject(projectId, viewer);
      const seen = new Set<string>();
      for (const c of data.changes) {
        if (seen.has(c.id)) fail('VALIDATION_FAILED', { fieldErrors: { changes: ['مهمة مكرّرة في الدفعة نفسها'] }, id: c.id });
        seen.add(c.id);
      }
      for (const a of new Set(data.changes.map((c) => c.assigneeId).filter((x): x is string => !!x))) await assertAssignee(a);
      let ids: string[] = [];
      let previous: TaskPreviousMap = {};
      let s!: WriteState;
      await tx(async () => {
        s = await load(projectId);
        checkVersions(s, data.changes);
        await assertLabels(projectId, data.changes.flatMap((c) => c.labelIds ?? []));
        const work = new Map(s.before);
        for (const c of data.changes) {
          const cur = work.get(c.id)!;
          const next = { ...cur };
          if (c.parentId !== undefined) next.parentId = c.parentId;
          if (c.sortOrder !== undefined) next.sortOrder = c.sortOrder;
          else if (c.parentId !== undefined && c.parentId !== cur.parentId) {
            next.sortOrder = sortOrderBetween(siblingsOf([...work.values()], c.parentId, c.id).at(-1)?.sortOrder ?? null, null);
          }
          work.set(c.id, next);
        }
        for (const c of data.changes) {
          if (c.parentId !== undefined && c.parentId !== s.before.get(c.id)!.parentId) assertValidParent(work, c.id, c.parentId);
        }
        const hasChildren = new Set([...work.values()].map((t) => t.parentId).filter((p): p is string => !!p));
        const day = (v: string | undefined) => (v === undefined ? undefined : s.unit === 'HOUR' ? v : v.slice(0, 10));
        for (const c of data.changes) {
          let next = { ...work.get(c.id)! };
          if (c.progress !== undefined) next.progress = c.progress;
          if (c.status !== undefined) next.status = c.status;
          if (c.name !== undefined) next.name = c.name;
          if (c.priority !== undefined) next.priority = c.priority;
          if (c.assigneeId !== undefined) next.assigneeId = c.assigneeId;
          if (c.plannedCost !== undefined) next.plannedCost = c.plannedCost;
          if (c.actualCost !== undefined) next.actualCost = c.actualCost;
          if (c.deadline !== undefined) next.deadline = c.deadline;
          if (c.barColor !== undefined) next.barColor = c.barColor ? c.barColor.toUpperCase() : null;
          if (c.labelIds !== undefined) next.labelIds = [...new Set(c.labelIds)].sort();
          const dated = c.startDate !== undefined || c.endDate !== undefined || c.durationDays !== undefined || c.durationHours !== undefined;
          if (dated && !hasChildren.has(c.id)) {
            next = applyScheduleEdit(
              next,
              { startDate: day(c.startDate), endDate: day(c.endDate), durationDays: c.durationDays, durationHours: c.durationHours },
              s.cal,
              s.unit,
            );
          }
          work.set(c.id, next);
        }
        // The engine runs again here: shifted successors are recomputed, not trusted.
        const finals = recomputeState(
          s,
          s.tasks.map((t) => work.get(t.id)!),
          data.changes.map((c) => c.id),
        );
        ({ ids, previous } = await persist(s, finals, {
          actorId: viewer.id,
          explicit: new Set(data.changes.map((c) => c.id)),
          explicitAction: 'task.moved',
          auditExtra: { batch: true },
        }));
      });
      const out = await taskDtosById(ids);
      await notifyReassigned(out, s.before, s.project, viewer);
      return { tasks: out, previous };
    },

    archive: async (id) => {
      const viewer = await api.actor('tasks.manage');
      const { task } = await visibleTask(id, viewer);
      let r!: Awaited<ReturnType<typeof archiveIn>>;
      await tx(async () => {
        const s = await load(task.projectId);
        r = await archiveIn(s, [id], viewer.id);
      });
      return { archivedIds: r.archivedIds, affected: await taskDtosById(r.ids), previous: r.previous, deletedDependencies: r.deletedDependencies };
    },

    mine: async () => {
      const viewer = await api.actor('tasks.readAssigned');
      await maybeSweep();
      const rows = (await db.tasks.where('assigneeId').equals(viewer.id).toArray()).filter((t) => !t.archivedAt);
      const projectsById = await liveProjects();
      const live = rows.filter((t) => projectsById.has(t.projectId)).map(rowOf);
      live.sort((a, b) => a.endDate.localeCompare(b.endDate) || a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name, 'ar'));
      const dtos = await taskDtos(live);
      const cals = new Map((await db.calendars.toArray()).map((c) => [c.id, workCalendarOf(c)]));
      const today = riyadhToday();
      return dtos.map((d): MyTaskDto => {
        const p = projectsById.get(d.projectId)!;
        const cal = cals.get(p.calendarId) ?? workCalendarOf({ weekendDays: [5, 6], exceptions: [] });
        return { ...d, project: { id: p.id, name: p.name }, ...dueFlags(d, today, cal) };
      });
    },

    comments: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      await visibleTask(id, viewer);
      const rows = (await db.taskComments.where('taskId').equals(id).toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      return rows.map((r): TaskCommentDto => {
        const q = r.replyToId ? byId.get(r.replyToId) : undefined;
        return {
          id: r.id,
          author: { id: r.authorId, fullName: users.get(r.authorId)?.fullName ?? '' },
          body: r.body,
          mentions: r.mentions,
          createdAt: r.createdAt,
          replyTo: q ? { id: q.id, authorName: users.get(q.authorId)?.fullName ?? '', bodyPreview: preview(q.body, 120) } : null,
        };
      });
    },

    addComment: async (id, input) => {
      const viewer = await api.actor('tasks.comment');
      const data = validate(taskCommentSchema, input);
      const { task, project } = await visibleTask(id, viewer);
      if (project.archivedAt) fail('PROJECT_ARCHIVED');
      const mentions = [...new Set(data.mentions)];
      const allowed = await mentionable(task, mentions);
      const invalid = mentions.filter((m) => !allowed.has(m));
      if (invalid.length) {
        fail('VALIDATION_FAILED', {
          fieldErrors: { mentions: ['يمكن الإشارة فقط إلى من يستطيع فتح هذه المهمة'] },
          userIds: invalid,
        });
      }
      const replyToId = data.replyToId ?? null;
      let quoted: { id: string; authorId: string; body: string } | undefined;
      if (replyToId) {
        const q = await db.taskComments.get(replyToId);
        if (!q || q.taskId !== id) fail('COMMENT_REPLY_INVALID');
        quoted = q;
      }
      // Comments are ordered by createdAt: never two with the same instant in one thread.
      const last = (await db.taskComments.where('taskId').equals(id).toArray()).reduce((m, c) => (c.createdAt > m ? c.createdAt : m), '');
      let at = new Date().toISOString();
      if (at <= last) at = new Date(Date.parse(last) + 1).toISOString();
      const row = { id: newId(), taskId: id, authorId: viewer.id, body: data.body, mentions, createdAt: at, replyToId };
      const followers = (await followersOf(task, viewer.id)).filter((u) => !mentions.includes(u));
      await tx(async () => {
        await db.taskComments.add(row);
        // The author has read the thread up to their own comment.
        await db.commentReads.put({ id: `${viewer.id}|${id}`, userId: viewer.id, taskId: id, lastReadAt: row.createdAt });
        await api.writeAudit({
          actorId: viewer.id,
          action: 'task.comment_added',
          entityType: 'task',
          entityId: id,
          before: null,
          after: { commentId: row.id, length: data.body.length, mentions: mentions.length, ...(replyToId ? { replyToId } : {}) },
        });
        const payload = {
          taskId: id,
          taskName: task.name,
          projectId: project.id,
          projectName: project.name,
          commentId: row.id,
          authorName: viewer.fullName,
          preview: notificationPreview(row.body),
        };
        for (const m of mentions.filter((x) => x !== viewer.id)) await api.notify(m, 'TASK_MENTIONED', payload);
        for (const f of followers) await api.notify(f, 'TASK_COMMENTED', payload);
      });
      const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));
      return {
        id: row.id,
        author: { id: viewer.id, fullName: viewer.fullName },
        body: row.body,
        mentions,
        createdAt: row.createdAt,
        replyTo: quoted ? { id: quoted.id, authorName: users.get(quoted.authorId)?.fullName ?? '', bodyPreview: preview(quoted.body, 120) } : null,
      };
    },

    markRead: async (id) => {
      const viewer = await api.actor('tasks.comment');
      await visibleTask(id, viewer);
      const lastReadAt = new Date().toISOString();
      await db.commentReads.put({ id: `${viewer.id}|${id}`, userId: viewer.id, taskId: id, lastReadAt });
      const out: CommentReadDto = { taskId: id, lastReadAt };
      return out;
    },

    activity: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      await visibleTask(id, viewer);
      const names = (v: unknown) => {
        const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        return o.predecessorId === id || o.successorId === id;
      };
      const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));
      const rows = (await db.audit.toArray())
        .filter(
          (a) =>
            (a.entityType === 'task' && a.entityId === id) ||
            (a.entityType === 'dependency' && (names(a.after) || names(a.before))),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 200);
      return rows.map((r): ActivityDto => {
        const u = r.actorId ? users.get(r.actorId) : undefined;
        return { id: r.id, actor: u ? { id: u.id, fullName: u.fullName } : null, action: r.action, at: r.at, before: r.before, after: r.after };
      });
    },

    attachments: async (id) => {
      const viewer = await api.actor();
      if (!canAny(viewer, [...TASK_READ])) fail('FORBIDDEN');
      await visibleTask(id, viewer);
      const files = (await db.files.where('entityId').equals(id).toArray())
        .filter((f) => f.entityType === 'task' && f.status === 'READY' && !f.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));
      return files.map((f): TaskAttachmentDto => {
        const u = users.get(f.createdById);
        return { id: f.id, mimeType: f.mimeType, sizeBytes: f.sizeBytes, uploadedBy: u ? { id: u.id, fullName: u.fullName } : null, createdAt: f.createdAt };
      });
    },

    attach: async (id, fileId) => {
      const viewer = await api.actor();
      await uploadableTask(id, viewer);
      const file = await db.files.get(fileId);
      if (!file || file.deletedAt || file.createdById !== viewer.id || file.entityType !== 'task') fail('NOT_FOUND');
      if (file.status !== 'READY') fail('FILE_NOT_UPLOADED');
      if (file.entityId && file.entityId !== id) fail('NOT_FOUND');
      if (!file.entityId) await db.files.update(fileId, { entityId: id, kind: 'ATTACHMENT' });
      await recordAttachment(id, file, viewer.id);
      return { id: file.id, mimeType: file.mimeType, sizeBytes: file.sizeBytes, uploadedBy: { id: viewer.id, fullName: viewer.fullName }, createdAt: file.createdAt };
    },

    attachmentUrl: async (id, fileId) => {
      const viewer = await api.actor();
      await visibleTask(id, viewer);
      const file = await taskFile(id, fileId);
      let obj = await db.objects.get(file.id);
      // A9 demo seed: placeholder attachments are drawn (or written) on first use, never real files.
      if (!obj && file.placeholder) {
        const img =
          file.mimeType === 'application/pdf'
            ? placeholderPdf()
            : await drawPlaceholder({ title: 'مرفق تجريبي', subtitle: file.placeholder.label, hue: file.placeholder.hue });
        obj = { key: file.id, data: img.data, type: img.type };
        await db.objects.put(obj);
      }
      if (!obj) fail('NOT_FOUND');
      const blob = new Blob([obj.data], { type: obj.type });
      const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : `demo-storage://${file.id}`;
      const settings = await api.readSettings();
      return { url, expiresAt: new Date(Date.now() + settings.PRESIGNED_URL_TTL_SECONDS * 1000).toISOString() };
    },

    removeAttachment: async (id, fileId) => {
      const viewer = await api.actor();
      await visibleTask(id, viewer);
      const file = await taskFile(id, fileId);
      if (!can(viewer, 'tasks.manage') && file.createdById !== viewer.id) fail('FORBIDDEN');
      await tx(async () => {
        await db.objects.delete(fileId);
        await db.files.update(fileId, { deletedAt: new Date().toISOString() });
        await api.writeAudit({
          actorId: viewer.id,
          action: 'task.attachment_removed',
          entityType: 'task',
          entityId: id,
          before: { fileId, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
          after: null,
        });
      });
    },

    // The A9 task routes are implemented in phaseA9.ts and assigned over these.
    duplicate: () => fail('NOT_FOUND'),
    bulk: () => fail('NOT_FOUND'),
    bulkArchive: () => fail('NOT_FOUND'),
    restore: () => fail('NOT_FOUND'),
    labels: () => fail('NOT_FOUND'),
    addLabel: () => fail('NOT_FOUND'),
    removeLabel: () => fail('NOT_FOUND'),
    customFields: () => fail('NOT_FOUND'),
    setCustomValue: () => fail('NOT_FOUND'),
    checklist: () => fail('NOT_FOUND'),
    addChecklistItem: () => fail('NOT_FOUND'),
    updateChecklistItem: () => fail('NOT_FOUND'),
    removeChecklistItem: () => fail('NOT_FOUND'),
    reorderChecklist: () => fail('NOT_FOUND'),
    timeEntries: () => fail('NOT_FOUND'),
    addTimeEntry: () => fail('NOT_FOUND'),
  };

  /** Archives the subtrees of `rootIds`, removes their dependencies, re-runs the engine (ADR-094). */
  async function archiveIn(s: WriteState, rootIds: string[], actorId: string) {
    const archived: string[] = [];
    const gone = new Set<string>();
    for (const root of rootIds) {
      if (gone.has(root) || !s.before.has(root)) continue;
      for (const sub of subtreeIds(s.tasks, root)) {
        if (!gone.has(sub)) {
          gone.add(sub);
          archived.push(sub);
        }
      }
    }
    const removed = s.deps.filter((d) => gone.has(d.predecessorId) || gone.has(d.successorId));
    const now = new Date().toISOString();
    for (const tid of archived) {
      const row = s.before.get(tid)!;
      await db.tasks.put({ ...row, archivedAt: now, version: row.version + 1 });
    }
    await db.dependencies.bulkDelete(removed.map((d) => d.id));
    const remaining: WriteState = {
      ...s,
      tasks: s.tasks.filter((t) => !gone.has(t.id)),
      deps: s.deps.filter((d) => !gone.has(d.predecessorId) && !gone.has(d.successorId)),
    };
    const finals = recomputeState(remaining, remaining.tasks, []);
    const out = await persist(remaining, finals, {
      actorId,
      explicit: new Set(),
      explicitAction: 'task.moved',
      auditExtra: { cause: 'archive', archivedTaskIds: rootIds },
    });
    for (const r of rootIds) {
      const root = s.before.get(r);
      if (!root) continue;
      const sub = subtreeIds(s.tasks, r);
      await api.writeAudit({
        actorId,
        action: 'task.archived',
        entityType: 'task',
        entityId: r,
        before: { name: root.name, wbs: root.wbsCache, parentId: root.parentId },
        after: {
          archivedIds: sub,
          deletedDependencies: removed
            .filter((d) => sub.includes(d.predecessorId) || sub.includes(d.successorId))
            .map((d) => ({ id: d.id, predecessorId: d.predecessorId, successorId: d.successorId })),
        },
      });
    }
    return { archivedIds: archived, ids: out.ids, previous: out.previous, deletedDependencies: removed.map(dependencyDto) };
  }

  /** Users who can open the task and so may be mentioned (ADR-092): active admins and the assignee. */
  async function mentionable(task: { assigneeId: string | null }, ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of ids) {
      const u = await db.users.get(id);
      if (!u || u.status !== 'ACTIVE') continue;
      if (u.role === 'ADMIN' || (u.role === 'SUPERVISOR' && u.id === task.assigneeId)) out.add(u.id);
    }
    return out;
  }

  /** TASK_COMMENTED recipients: the assignee and earlier commenters who can still open the task, minus the author. */
  async function followersOf(task: { id: string; assigneeId: string | null }, authorId: string): Promise<string[]> {
    const earlier = (await db.taskComments.where('taskId').equals(task.id).toArray()).map((c) => c.authorId);
    const candidates = [...new Set([...(task.assigneeId ? [task.assigneeId] : []), ...earlier])].filter((u) => u !== authorId);
    return [...(await mentionable(task, candidates))];
  }

  async function uploadableTask(taskId: string, viewer: DemoUser) {
    const { task, project } = await visibleTask(taskId, viewer);
    if (project.archivedAt) fail('PROJECT_ARCHIVED');
    if (!can(viewer, 'tasks.manage') && task.assigneeId !== viewer.id) fail('FORBIDDEN');
    return task;
  }

  async function taskFile(taskId: string, fileId: string): Promise<DemoFile> {
    const file = await db.files.get(fileId);
    if (!file || file.entityType !== 'task' || file.entityId !== taskId || file.status !== 'READY' || file.deletedAt) fail('NOT_FOUND');
    return file;
  }

  async function recordAttachment(taskId: string, file: DemoFile, actorId: string) {
    const already = (await db.audit.where('action').equals('task.attachment_added').toArray()).some(
      (a) => a.entityId === taskId && (a.after as { fileId?: string } | null)?.fileId === file.id,
    );
    if (already) return;
    await api.writeAudit({
      actorId,
      action: 'task.attachment_added',
      entityType: 'task',
      entityId: taskId,
      before: null,
      after: { fileId: file.id, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
    });
  }

  // ------------------------------------------------------------ dependencies

  const dependencies: Phase4Api['dependencies'] = {
    create: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(createDependencySchema, input);
      await visibleProject(projectId, viewer);
      if (!ENABLED_DEPENDENCY_TYPES.includes(data.type)) fail('DEPENDENCY_TYPE_DISABLED', { type: data.type });
      if (data.predecessorId === data.successorId) {
        fail('DEPENDENCY_SELF', { path: [data.predecessorId, data.predecessorId] });
      }
      const dep: DemoDependency = {
        id: newId(),
        projectId,
        predecessorId: data.predecessorId,
        successorId: data.successorId,
        type: data.type,
        lagDays: data.lagDays,
        createdAt: new Date().toISOString(),
      };
      let ids: string[] = [];
      await tx(async () => {
        const s = await load(projectId);
        // A9 hours: an HOUR project stores the lag in working minutes (lagHours wins over lagDays).
        if (s.unit === 'HOUR') dep.lagMinutes = data.lagHours !== undefined ? Math.round(data.lagHours * 60) : Math.round(data.lagDays * s.cal.standardMinutesPerDay);
        const missing = [data.predecessorId, data.successorId].filter((x) => !s.before.has(x));
        if (missing.length) fail('NOT_FOUND', { taskIds: missing });
        if (s.deps.some((d) => d.predecessorId === data.predecessorId && d.successorId === data.successorId)) {
          fail('DEPENDENCY_EXISTS');
        }
        if (wouldCreateCycle(s.deps, data.predecessorId, data.successorId)) {
          const path = detectCycle(s.deps, dep) ?? [data.predecessorId, data.successorId, data.predecessorId];
          fail('DEPENDENCY_CYCLE', { path });
        }
        // A link between a task and its own ancestor is a cycle too: the engine throws it here.
        const finals = recomputeState(s, s.tasks, [data.predecessorId], [...s.deps, dep]);
        await db.dependencies.add(dep);
        ids = (
          await persist(s, finals, {
            actorId: viewer.id,
            explicit: new Set(),
            explicitAction: 'task.moved',
            auditExtra: { cause: 'dependency', dependencyId: dep.id },
          })
        ).ids;
        await api.writeAudit({
          actorId: viewer.id,
          action: 'dependency.created',
          entityType: 'dependency',
          entityId: dep.id,
          before: null,
          after: { ...dependencyDto(dep), shifted: ids.length },
        });
      });
      return { ...dependencyDto(dep), affected: await taskDtosById(ids) };
    },

    remove: async (id) => {
      const viewer = await api.actor('tasks.manage');
      const dep = await db.dependencies.get(id);
      if (!dep) fail('NOT_FOUND');
      await visibleProject(dep.projectId, viewer);
      await tx(async () => {
        await db.dependencies.delete(id);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'dependency.deleted',
          entityType: 'dependency',
          entityId: id,
          before: { predecessorId: dep.predecessorId, successorId: dep.successorId, type: dep.type, lagDays: dep.lagDays },
          after: null,
        });
      });
    },
  };

  // ------------------------------------------------------------ calendars (projects.manage)

  async function rescheduleUsers(calendarId: string, actorId: string, cause: string) {
    const users = (await db.projects.toArray()).filter((p) => p.calendarId === calendarId && !p.archivedAt);
    let total = 0;
    for (const p of users) total += await rescheduleProject(p.id, actorId, cause);
    return total;
  }

  async function getCalendar(id: string): Promise<DemoCalendar> {
    const c = await db.calendars.get(id);
    if (!c) fail('NOT_FOUND');
    return c;
  }

  const normalizeWeekend = (days: number[]) => [...new Set(days)].sort((a, b) => a - b);
  const sameHours = (a?: { start: string; end: string }[], b?: { start: string; end: string }[]) =>
    JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

  const calendars: Phase4Api['calendars'] = {
    list: async () => {
      await api.actor('projects.manage');
      const rows = await db.calendars.toArray();
      return rows
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt))
        .map(calendarDto);
    },

    get: async (id) => {
      await api.actor('projects.manage');
      return calendarDto(await getCalendar(id));
    },

    create: async (input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(calendarSchemaH, input);
      const weekendDays = normalizeWeekend(data.weekendDays);
      if (weekendDays.length >= 7) fail('VALIDATION_FAILED', { fieldErrors: { weekendDays: ['اترك يوم عمل واحدًا على الأقل'] } });
      const row: DemoCalendar = {
        id: newId(),
        name: data.name,
        weekendDays,
        isDefault: false,
        createdAt: new Date().toISOString(),
        exceptions: [],
        ...(data.workingHours ? { workingHours: data.workingHours } : {}),
      };
      await tx(async () => {
        await db.calendars.add(row);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar.created',
          entityType: 'calendar',
          entityId: row.id,
          before: null,
          after: { name: row.name, weekendDays: row.weekendDays, ...(row.workingHours ? { workingHours: row.workingHours } : {}) },
        });
      });
      return calendarDto(row);
    },

    update: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(updateCalendarSchemaH, input);
      const cur = await getCalendar(id);
      const weekendDays = data.weekendDays ? normalizeWeekend(data.weekendDays) : undefined;
      const weekendChanged = !!weekendDays && weekendDays.join(',') !== cur.weekendDays.join(',');
      const nameChanged = data.name !== undefined && data.name !== cur.name;
      const hoursChanged = data.workingHours !== undefined && !sameHours(data.workingHours, cur.workingHours);
      if (!weekendChanged && !nameChanged && !hoursChanged) return calendarDto(cur);
      if (weekendDays && weekendDays.length >= 7) fail('VALIDATION_FAILED', { fieldErrors: { weekendDays: ['اترك يوم عمل واحدًا على الأقل'] } });
      await tx(async () => {
        await db.calendars.put({
          ...cur,
          ...(nameChanged ? { name: data.name! } : {}),
          ...(weekendChanged ? { weekendDays } : {}),
          ...(hoursChanged ? { workingHours: data.workingHours } : {}),
        });
        const rescheduled = weekendChanged || hoursChanged ? await rescheduleUsers(id, viewer.id, 'calendar.updated') : 0;
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar.updated',
          entityType: 'calendar',
          entityId: id,
          before: {
            ...(nameChanged ? { name: cur.name } : {}),
            ...(weekendChanged ? { weekendDays: cur.weekendDays } : {}),
            ...(hoursChanged ? { workingHours: cur.workingHours ?? null } : {}),
          },
          after: {
            ...(nameChanged ? { name: data.name } : {}),
            ...(weekendChanged ? { weekendDays } : {}),
            ...(hoursChanged ? { workingHours: data.workingHours } : {}),
            ...(weekendChanged || hoursChanged ? { rescheduledTasks: rescheduled } : {}),
          },
        });
      });
      return calendarDto(await getCalendar(id));
    },

    addException: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(calendarExceptionSchema, input);
      await tx(async () => {
        const cur = await getCalendar(id);
        if (cur.exceptions.some((e) => e.date === data.date)) fail('CALENDAR_DATE_EXISTS');
        const ex = { id: newId(), date: data.date, isWorking: data.isWorking, name: data.name };
        await db.calendars.put({ ...cur, exceptions: [...cur.exceptions, ex] });
        const rescheduled = await rescheduleUsers(id, viewer.id, 'calendar_exception.created');
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar_exception.created',
          entityType: 'calendar',
          entityId: id,
          before: null,
          after: { exceptionId: ex.id, date: ex.date, isWorking: ex.isWorking, name: ex.name, rescheduledTasks: rescheduled },
        });
      });
      return calendarDto(await getCalendar(id));
    },

    removeException: async (id, exceptionId) => {
      const viewer = await api.actor('projects.manage');
      await tx(async () => {
        const cur = await getCalendar(id);
        const ex = cur.exceptions.find((e) => e.id === exceptionId);
        if (!ex) fail('NOT_FOUND');
        await db.calendars.put({ ...cur, exceptions: cur.exceptions.filter((e) => e.id !== exceptionId) });
        const rescheduled = await rescheduleUsers(id, viewer.id, 'calendar_exception.deleted');
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar_exception.deleted',
          entityType: 'calendar',
          entityId: id,
          before: { exceptionId, date: ex.date, isWorking: ex.isWorking, name: ex.name },
          after: { rescheduledTasks: rescheduled },
        });
      });
    },
  };

  // ------------------------------------------------------------ hooks

  async function beforeTaskPresign(input: { entityId?: string; kind?: string }, actor: DemoUser) {
    if (!input.entityId) fail('VALIDATION_FAILED', { fieldErrors: { entityId: ['حدّد المهمة التي يتبع لها المرفق'] } });
    if (input.kind && input.kind !== 'ATTACHMENT') fail('VALIDATION_FAILED', { fieldErrors: { kind: ['نوع الملف للمهمة: مرفق'] } });
    await uploadableTask(input.entityId, actor);
  }

  async function afterTaskConfirm(file: DemoFile, actor: DemoUser) {
    if (file.entityId) await recordAttachment(file.entityId, file, actor.id);
  }

  /** Once per Riyadh day, like the 07:00 job (the demo has no cron). */
  async function maybeSweep() {
    const today = riyadhToday();
    if ((await db.kv.get('taskRemindersDay'))?.value === today) return;
    await sweepReminders();
    await db.kv.put({ key: 'taskRemindersDay', value: today });
  }

  /**
   * ADR-059 reminders + A9 deadlines: overdue and due-soon tasks notify their assignee once each;
   * a passed deadline notifies the assignee and the project owner once per deadline (ADR-093).
   * The column is claimed before notifying, and a date move clears it.
   */
  async function sweepReminders(now: Date = new Date()): Promise<number> {
    const today = riyadhToday(now);
    let sent = 0;
    await tx(async () => {
      const projectsById = await liveProjects();
      const cals = new Map((await db.calendars.toArray()).map((c) => [c.id, workCalendarOf(c)]));
      const rows = (await db.tasks.toArray()).filter((t) => !t.archivedAt && projectsById.has(t.projectId)).map(rowOf);
      const parents = new Set(rows.map((x) => x.parentId).filter((x): x is string => !!x));
      for (const t of rows) {
        const p = projectsById.get(t.projectId)!;
        const cal = cals.get(p.calendarId);
        if (!cal) continue;
        const payload = { taskId: t.id, taskName: t.name, projectId: p.id, projectName: p.name, endDate: t.endDate };
        if (t.assigneeId) {
          const { overdue, dueSoon } = dueFlags(t, today, cal);
          if (overdue && !t.overdueNotifiedAt) {
            await db.tasks.update(t.id, { overdueNotifiedAt: now.toISOString() });
            await api.notify(t.assigneeId, 'TASK_OVERDUE', payload);
            sent++;
          } else if (dueSoon && !t.dueSoonNotifiedAt) {
            await db.tasks.update(t.id, { dueSoonNotifiedAt: now.toISOString() });
            await api.notify(t.assigneeId, 'TASK_DUE_SOON', payload);
            sent++;
          }
        }
        const leaf = !parents.has(t.id);
        if (leaf && deadlinePassed(t, today) && !t.deadlineNotifiedAt) {
          await db.tasks.update(t.id, { deadlineNotifiedAt: now.toISOString() });
          for (const to of new Set([t.assigneeId, p.ownerId].filter((u): u is string => !!u))) {
            await api.notify(to, 'TASK_DEADLINE_PASSED', { ...payload, deadline: t.deadline });
          }
          sent++;
        }
      }
    });
    return sent;
  }

  return { projects, tasks, dependencies, calendars, beforeTaskPresign, afterTaskConfirm, sweepReminders, core };
}
