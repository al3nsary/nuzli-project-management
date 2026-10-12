/**
 * DemoApi Phase 4 — projects, tasks, dependencies, calendars (docs/API.md "Phase 4" as built,
 * ADR-056..060). Same rules as apps/api: every write loads the project, checks all versions
 * first (409 CONFLICT_VERSION with `{ refresh: 'tasks', conflicts }`, nothing written), applies
 * the edit, re-runs `@nuzli/scheduling` through `recompute()` and stores only what changed with
 * `version + 1` (a WBS-only change keeps its version). IndexedDB has no row locks; a Dexie
 * read-write transaction over all tables serialises writers inside one browser.
 */
import { detectCycle, wouldCreateCycle, type WorkCalendar } from '@nuzli/scheduling';
import {
  ENABLED_DEPENDENCY_TYPES,
  calendarExceptionSchema,
  calendarSchema,
  can,
  createDependencySchema,
  createProjectSchema,
  createTaskSchema,
  grantProjectAccessSchema,
  projectListQuerySchema,
  taskBatchSchema,
  taskCommentSchema,
  updateCalendarSchema,
  updateProjectSchema,
  updateTaskSchema,
  type ActivityDto,
  type CalendarDto,
  type DependencyDto,
  type MyTaskDto,
  type ProjectAccessDto,
  type ProjectDto,
  type TaskAttachmentDto,
  type TaskCommentDto,
  type TaskDto,
  type TaskVersionConflictDetails,
} from '@nuzli/shared';
import type { ApiClient, CalendarListDto } from '../client';
import { ApiError } from '../errors';
import {
  applyScheduleEdit,
  assertValidParent,
  compareWbs,
  diffTasks,
  dueFlags,
  needsRenumber,
  normalizeLeaf,
  projectProgress,
  recompute,
  riyadhToday,
  siblingsOf,
  sortOrderBetween,
  subtreeIds,
  workCalendarOf,
  type StoredTask,
  type VersionedField,
} from '../../features/projects/engine';
import { buildTasksWorkbook } from '../../features/projects/excel';
import { workbookToBlob } from '../../features/violations/excel';
import type {
  DemoCalendar,
  DemoDependency,
  DemoFile,
  DemoProject,
  DemoTask,
  DemoUser,
} from './db';
import type { DemoInternals } from './phase2';
import { fail, newId, validate } from './util';

export type Phase4Api = Pick<ApiClient, 'projects' | 'tasks' | 'dependencies' | 'calendars'>;

export interface Phase4Hooks {
  beforeTaskPresign(input: { entityId?: string; kind?: string }, actor: DemoUser): Promise<void>;
  afterTaskConfirm(file: DemoFile, actor: DemoUser): Promise<void>;
  /** The daily 07:00 reminder job (TASK_DUE_SOON / TASK_OVERDUE once per task), run lazily. */
  sweepReminders(now?: Date): Promise<number>;
}

/** Fields a supervisor may change on a task assigned to them (ADR-007/058). */
const SUPERVISOR_FIELDS = new Set(['version', 'progress', 'status']);

interface WriteState {
  project: DemoProject;
  calendar: DemoCalendar;
  cal: WorkCalendar;
  tasks: DemoTask[];
  deps: DemoDependency[];
  before: Map<string, DemoTask>;
}

interface PersistOptions {
  actorId: string;
  inserted?: DemoTask;
  explicit: Set<string>;
  explicitAction: string;
  auditExtra?: Record<string, unknown>;
}

interface AssigneeInfo {
  id: string;
  fullName: string;
  teamColor: string | null;
  teamName: string | null;
}

const descriptionLabel = (d: string | null | undefined) => (d ? `${d.length} حرفًا` : null);

function pick(t: StoredTask, fields: readonly VersionedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = f === 'description' ? descriptionLabel(t.description) : t[f];
  return out;
}

export function createPhase4(api: DemoInternals): Phase4Api & Phase4Hooks {
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
    const [comments, files] = await Promise.all([
      db.taskComments.toArray(),
      db.files.where('entityId').anyOf(taskIds.length ? taskIds : ['-']).toArray(),
    ]);
    const c = new Map<string, number>();
    for (const x of comments) if (ids.has(x.taskId)) c.set(x.taskId, (c.get(x.taskId) ?? 0) + 1);
    const a = new Map<string, number>();
    for (const f of files) {
      if (f.entityType === 'task' && f.status === 'READY' && !f.deletedAt && f.entityId) {
        a.set(f.entityId, (a.get(f.entityId) ?? 0) + 1);
      }
    }
    return { comments: c, attachments: a };
  }

  async function taskDtos(rows: DemoTask[]): Promise<TaskDto[]> {
    const [who, n] = await Promise.all([assignees(), counts(rows.map((r) => r.id))]);
    return rows.map((r) => ({
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
    }));
  }

  async function taskDtosById(ids: string[]): Promise<TaskDto[]> {
    const rows = (await db.tasks.bulkGet(ids)).filter((t): t is DemoTask => Boolean(t));
    return taskDtos(rows);
  }

  async function liveTasks(projectId: string): Promise<DemoTask[]> {
    return (await db.tasks.where('projectId').equals(projectId).toArray()).filter((t) => !t.archivedAt);
  }

  async function projectDto(p: DemoProject, tasks?: DemoTask[]): Promise<ProjectDto> {
    const live = tasks ?? (await liveTasks(p.id));
    const ids = new Set(live.map((t) => t.id));
    const owner = await db.users.get(p.ownerId);
    const endDate = live.reduce<string | null>((m, t) => (m === null || t.endDate > m ? t.endDate : m), null);
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
      progress: projectProgress(live.filter((t) => !t.parentId || !ids.has(t.parentId))),
      taskCount: live.length,
      createdAt: p.createdAt,
    };
  }

  const calendarDto = (c: DemoCalendar): CalendarListDto => ({
    id: c.id,
    name: c.name,
    weekendDays: [...c.weekendDays],
    isDefault: c.isDefault,
    exceptions: [...c.exceptions].sort((a, b) => a.date.localeCompare(b.date)),
  });

  const dependencyDto = (d: DemoDependency): DependencyDto => ({
    id: d.id,
    predecessorId: d.predecessorId,
    successorId: d.successorId,
    type: d.type,
    lagDays: d.lagDays,
  });

  // ------------------------------------------------------------ scope (ADR-058)

  async function canSeeProject(viewer: DemoUser, p: DemoProject): Promise<boolean> {
    if (can(viewer, 'projects.readAll')) return true;
    if (!can(viewer, 'projects.readGranted') || p.archivedAt) return false;
    const granted = await db.projectAccess.where('projectId').equals(p.id).filter((a) => a.userId === viewer.id).count();
    if (granted) return true;
    return (
      (await db.tasks
        .where('assigneeId')
        .equals(viewer.id)
        .filter((t) => t.projectId === p.id && !t.archivedAt)
        .count()) > 0
    );
  }

  async function visibleProject(id: string, viewer: DemoUser): Promise<DemoProject> {
    const p = await db.projects.get(id);
    if (!p || !(await canSeeProject(viewer, p))) fail('NOT_FOUND');
    return p;
  }

  async function visibleTask(id: string, viewer: DemoUser): Promise<{ task: DemoTask; project: DemoProject }> {
    const task = await db.tasks.get(id);
    if (!task || task.archivedAt) fail('NOT_FOUND');
    const project = await visibleProject(task.projectId, viewer);
    return { task, project };
  }

  async function assertAssignee(userId: string) {
    const u = await db.users.get(userId);
    if (!u || u.role !== 'SUPERVISOR' || u.status !== 'ACTIVE') fail('ASSIGNEE_NOT_SUPERVISOR');
  }

  // ------------------------------------------------------------ the one write path

  async function load(projectId: string): Promise<WriteState> {
    const project = await db.projects.get(projectId);
    if (!project) fail('NOT_FOUND');
    if (project.archivedAt) fail('PROJECT_ARCHIVED');
    const calendar = (await db.calendars.get(project.calendarId)) ?? (await defaultCalendar());
    const tasks = await liveTasks(projectId);
    const deps = await db.dependencies.where('projectId').equals(projectId).toArray();
    return { project, calendar, cal: workCalendarOf(calendar), tasks, deps, before: new Map(tasks.map((t) => [t.id, t])) };
  }

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

  /** Writes what changed (`version + 1`), refreshes WBS-only rows, audits; returns the ids written. */
  async function persist(s: WriteState, finals: DemoTask[], o: PersistOptions): Promise<string[]> {
    const { versioned, wbsOnly } = diffTasks(s.before, finals);
    const written: string[] = [];
    const now = new Date().toISOString();
    if (o.inserted) {
      const row = finals.find((t) => t.id === o.inserted!.id)!;
      await db.tasks.add({ ...row, version: 0 });
      written.push(row.id);
      await api.writeAudit({
        actorId: o.actorId,
        action: 'task.created',
        entityType: 'task',
        entityId: row.id,
        before: null,
        after: { name: row.name, type: row.type, parentId: row.parentId, startDate: row.startDate, endDate: row.endDate, assigneeId: row.assigneeId },
      });
    }
    for (const v of versioned) {
      const endMoved = v.before.endDate !== v.after.endDate;
      await db.tasks.put({
        ...v.after,
        version: v.before.version + 1,
        ...(endMoved ? { dueSoonNotifiedAt: null, overdueNotifiedAt: null } : {}),
      });
      written.push(v.after.id);
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
      written.push(w.id);
    }
    void now;
    return written;
  }

  /** Re-derives a whole project (calendar change, auto-schedule on): ends from durations, then the pass. */
  async function rescheduleProject(projectId: string, actorId: string, cause: string): Promise<number> {
    const s = await load(projectId);
    const leaves = new Set(s.tasks.map((t) => t.parentId).filter((p): p is string => !!p));
    const derived = s.tasks.map((t) => (leaves.has(t.id) ? t : normalizeLeaf(t, s.cal, false)));
    const finals = recompute({ tasks: derived, dependencies: s.deps, calendar: s.cal, autoSchedule: s.project.autoSchedule });
    return (await persist(s, finals, { actorId, explicit: new Set(), explicitAction: 'task.moved', auditExtra: { cause } })).length;
  }

  async function defaultCalendar(): Promise<DemoCalendar> {
    const all = await db.calendars.toArray();
    const c = all.find((x) => x.isDefault) ?? all[0];
    if (!c) fail('NOT_FOUND');
    return c;
  }

  async function notifyAssigned(task: DemoTask, project: DemoProject, viewer: DemoUser) {
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

  // ------------------------------------------------------------ projects

  const projects: Phase4Api['projects'] = {
    list: async (query = {}) => {
      const viewer = await api.actor();
      const q = validate(projectListQuerySchema, query);
      await maybeSweep();
      const rows = (await db.projects.toArray())
        .filter((p) =>
          q.status === 'ALL'
            ? true
            : q.status === 'ARCHIVED'
              ? Boolean(p.archivedAt) || p.status === 'ARCHIVED'
              : !p.archivedAt && (!q.status || p.status === q.status),
        )
        .filter((p) => !q.q || p.name.toLowerCase().includes(q.q.toLowerCase()))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const out: ProjectDto[] = [];
      for (const p of rows) if (await canSeeProject(viewer, p)) out.push(await projectDto(p));
      return out;
    },

    get: async (id) => projectDto(await visibleProject(id, await api.actor())),

    create: async (input) => {
      const viewer = await api.actor('projects.create');
      const data = validate(createProjectSchema, input);
      let created!: DemoProject;
      await tx(async () => {
        const calendarId = data.calendarId ?? (await defaultCalendar()).id;
        if (!(await db.calendars.get(calendarId))) {
          fail('VALIDATION_FAILED', { fieldErrors: { calendarId: ['التقويم غير موجود. أنشئ تقويمًا أو اختر تقويمًا آخر'] } });
        }
        created = {
          id: newId(),
          name: data.name,
          description: data.description ?? null,
          startDate: data.startDate,
          status: data.status,
          calendarId,
          autoSchedule: data.autoSchedule,
          ownerId: viewer.id,
          createdAt: new Date().toISOString(),
          archivedAt: data.status === 'ARCHIVED' ? new Date().toISOString() : null,
        };
        await db.projects.add(created);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.created',
          entityType: 'project',
          entityId: created.id,
          before: null,
          after: { ...data, calendarId, description: descriptionLabel(data.description) },
        });
      });
      return projectDto(created, []);
    },

    update: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(updateProjectSchema, input);
      const cur = await visibleProject(id, viewer);
      const FIELDS = ['name', 'description', 'startDate', 'status', 'calendarId', 'autoSchedule'] as const;
      const changed = FIELDS.filter((f) => data[f] !== undefined && data[f] !== cur[f]);
      if (!changed.length) return projectDto(cur);
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
        const reschedule =
          !next.archivedAt &&
          (changed.includes('calendarId') || (changed.includes('autoSchedule') && data.autoSchedule === true));
        const rescheduled = reschedule ? await rescheduleProject(id, viewer.id, 'project.updated') : 0;
        await api.writeAudit({
          actorId: viewer.id,
          action: data.status === 'ARCHIVED' ? 'project.archived' : 'project.updated',
          entityType: 'project',
          entityId: id,
          before: Object.fromEntries(changed.map((f) => [f, f === 'description' ? null : cur[f]])),
          after: {
            ...Object.fromEntries(changed.map((f) => [f, f === 'description' ? descriptionLabel(data.description) : data[f]])),
            ...(reschedule ? { rescheduledTasks: rescheduled } : {}),
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
      const p = await visibleProject(id, viewer);
      const tasks = await liveTasks(id);
      const calendar = (await db.calendars.get(p.calendarId)) ?? (await defaultCalendar());
      const deps = await db.dependencies.where('projectId').equals(id).toArray();
      const dtos = (await taskDtos(tasks)).sort((a, b) => compareWbs(a.wbs, b.wbs));
      const cal: CalendarDto = calendarDto(calendar);
      return {
        project: await projectDto(p, tasks),
        tasks: dtos,
        dependencies: deps.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(dependencyDto),
        calendar: cal,
      };
    },

    exportXlsx: async (id) => {
      const viewer = await api.actor();
      const g = await projects.gantt(id);
      const generatedAt = new Date();
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
        },
        g.tasks.map((t) => ({
          wbs: t.wbs,
          name: t.name,
          type: t.type,
          startDate: t.startDate,
          endDate: t.endDate,
          durationDays: t.durationDays,
          progress: t.progress,
          status: t.status,
          priority: t.priority,
          assigneeName: t.assignee?.fullName ?? null,
          teamName: t.assignee?.teamName ?? null,
          description: t.description,
        })),
      );
      await api.writeAudit({
        actorId: viewer.id,
        action: 'project.exported',
        entityType: 'project',
        entityId: id,
        before: null,
        after: { format: 'xlsx', tasks: g.tasks.length },
      });
      return workbookToBlob(wb);
    },
  };

  // ------------------------------------------------------------ tasks

  const tasks: Phase4Api['tasks'] = {
    create: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(createTaskSchema, input);
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
        const draft = normalizeLeaf<DemoTask>(
          {
            id,
            projectId,
            parentId,
            sortOrder: sortOrderBetween(prev, next),
            wbsCache: '',
            name: data.name,
            type: data.type,
            startDate: data.startDate,
            endDate: data.startDate,
            durationDays: data.durationDays,
            progress: data.progress,
            status: data.status,
            priority: data.priority,
            assigneeId: data.assigneeId ?? null,
            description: data.description ?? null,
            version: 0,
            archivedAt: null,
            dueSoonNotifiedAt: null,
            overdueNotifiedAt: null,
            createdAt: new Date().toISOString(),
          },
          s.cal,
        );
        const finals = recompute({
          tasks: [...all, draft],
          dependencies: s.deps,
          calendar: s.cal,
          autoSchedule: s.project.autoSchedule,
          changed: [id],
        });
        ids = await persist(s, finals, { actorId: viewer.id, inserted: draft, explicit: new Set([id]), explicitAction: 'task.created' });
        const stored = await db.tasks.get(id);
        if (stored) await notifyAssigned(stored, project, viewer);
      });
      const dtos = await taskDtosById(ids);
      const task = dtos.find((d) => d.id === id)!;
      return { ...task, affected: dtos.filter((d) => d.id !== id) };
    },

    get: async (id) => {
      const viewer = await api.actor();
      const { task } = await visibleTask(id, viewer);
      return (await taskDtos([task]))[0]!;
    },

    update: async (id, input) => {
      const viewer = await api.actor();
      const data = validate(updateTaskSchema, input);
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
        const scheduleTouched = data.startDate !== undefined || data.durationDays !== undefined || next.type !== cur.type;
        if (scheduleTouched && !hasChildren) {
          next = applyScheduleEdit(next, { startDate: data.startDate, durationDays: data.durationDays }, s.cal);
        }
        const finals = recompute({
          tasks: s.tasks.map((t) => (t.id === id ? next : t)),
          dependencies: s.deps,
          calendar: s.cal,
          autoSchedule: s.project.autoSchedule,
          changed: [id],
        });
        ids = await persist(s, finals, { actorId: viewer.id, explicit: new Set([id]), explicitAction: 'task.updated' });
        const after = await db.tasks.get(id);
        if (after?.assigneeId && after.assigneeId !== previousAssignee) await notifyAssigned(after, s.project, viewer);
      });
      const dtos = await taskDtosById([id, ...ids.filter((x) => x !== id)]);
      return { task: dtos[0]!, affected: dtos.slice(1) };
    },

    batch: async (projectId, input) => {
      const viewer = await api.actor('tasks.manage');
      const data = validate(taskBatchSchema, input);
      await visibleProject(projectId, viewer);
      const seen = new Set<string>();
      for (const c of data.changes) {
        if (seen.has(c.id)) fail('VALIDATION_FAILED', { fieldErrors: { changes: ['مهمة مكرّرة في الدفعة نفسها'] }, id: c.id });
        seen.add(c.id);
      }
      let ids: string[] = [];
      await tx(async () => {
        const s = await load(projectId);
        checkVersions(s, data.changes);
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
        for (const c of data.changes) {
          let next = work.get(c.id)!;
          if (c.progress !== undefined) next = { ...next, progress: c.progress };
          if (c.status !== undefined) next = { ...next, status: c.status };
          const dated = c.startDate !== undefined || c.endDate !== undefined || c.durationDays !== undefined;
          if (dated && !hasChildren.has(c.id)) {
            next = applyScheduleEdit(next, { startDate: c.startDate, endDate: c.endDate, durationDays: c.durationDays }, s.cal);
          }
          work.set(c.id, next);
        }
        // The engine runs again here: shifted successors are recomputed, not trusted.
        const finals = recompute({
          tasks: s.tasks.map((t) => work.get(t.id)!),
          dependencies: s.deps,
          calendar: s.cal,
          autoSchedule: s.project.autoSchedule,
          changed: data.changes.map((c) => c.id),
        });
        ids = await persist(s, finals, {
          actorId: viewer.id,
          explicit: new Set(data.changes.map((c) => c.id)),
          explicitAction: 'task.moved',
          auditExtra: { batch: true },
        });
      });
      return { tasks: await taskDtosById(ids) };
    },

    archive: async (id) => {
      const viewer = await api.actor('tasks.manage');
      const { task } = await visibleTask(id, viewer);
      let archivedIds: string[] = [];
      let ids: string[] = [];
      await tx(async () => {
        const s = await load(task.projectId);
        archivedIds = subtreeIds(s.tasks, id);
        const gone = new Set(archivedIds);
        const removed = s.deps.filter((d) => gone.has(d.predecessorId) || gone.has(d.successorId));
        const now = new Date().toISOString();
        for (const tid of archivedIds) {
          const row = s.before.get(tid)!;
          await db.tasks.put({ ...row, archivedAt: now, version: row.version + 1 });
        }
        await db.dependencies.bulkDelete(removed.map((d) => d.id));
        const remaining: WriteState = {
          ...s,
          tasks: s.tasks.filter((t) => !gone.has(t.id)),
          deps: s.deps.filter((d) => !gone.has(d.predecessorId) && !gone.has(d.successorId)),
        };
        const finals = recompute({
          tasks: remaining.tasks,
          dependencies: remaining.deps,
          calendar: s.cal,
          autoSchedule: s.project.autoSchedule,
          changed: [],
        });
        ids = await persist(remaining, finals, {
          actorId: viewer.id,
          explicit: new Set(),
          explicitAction: 'task.moved',
          auditExtra: { cause: 'archive', archivedTaskId: id },
        });
        const root = s.before.get(id)!;
        await api.writeAudit({
          actorId: viewer.id,
          action: 'task.archived',
          entityType: 'task',
          entityId: id,
          before: { name: root.name, wbs: root.wbsCache, parentId: root.parentId },
          after: {
            archivedIds,
            deletedDependencies: removed.map((d) => ({ id: d.id, predecessorId: d.predecessorId, successorId: d.successorId })),
          },
        });
      });
      return { archivedIds, affected: await taskDtosById(ids) };
    },

    mine: async () => {
      const viewer = await api.actor('tasks.readAssigned');
      await maybeSweep();
      const rows = (await db.tasks.where('assigneeId').equals(viewer.id).toArray()).filter((t) => !t.archivedAt);
      const projectsById = new Map((await db.projects.toArray()).map((p) => [p.id, p]));
      const live = rows.filter((t) => {
        const p = projectsById.get(t.projectId);
        return p && !p.archivedAt;
      });
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
      await visibleTask(id, viewer);
      const rows = (await db.taskComments.where('taskId').equals(id).toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));
      return rows.map((r): TaskCommentDto => ({
        id: r.id,
        author: { id: r.authorId, fullName: users.get(r.authorId)?.fullName ?? '' },
        body: r.body,
        mentions: r.mentions,
        createdAt: r.createdAt,
      }));
    },

    addComment: async (id, input) => {
      const viewer = await api.actor('tasks.comment');
      const data = validate(taskCommentSchema, input);
      const { task, project } = await visibleTask(id, viewer);
      if (project.archivedAt) fail('PROJECT_ARCHIVED');
      const mentions = [...new Set(data.mentions)];
      const invalid: string[] = [];
      for (const m of mentions) {
        const u = await db.users.get(m);
        const ok = u && u.status === 'ACTIVE' && (u.role === 'ADMIN' || (u.role === 'SUPERVISOR' && (await canSeeProject(u, project))));
        if (!ok) invalid.push(m);
      }
      if (invalid.length) {
        fail('VALIDATION_FAILED', {
          fieldErrors: { mentions: ['يمكن الإشارة فقط إلى من يملك صلاحية الوصول إلى المشروع'] },
          userIds: invalid,
        });
      }
      const row = { id: newId(), taskId: id, authorId: viewer.id, body: data.body, mentions, createdAt: new Date().toISOString() };
      await tx(async () => {
        await db.taskComments.add(row);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'task.comment_added',
          entityType: 'task',
          entityId: id,
          before: null,
          after: { commentId: row.id, length: data.body.length, mentions: mentions.length },
        });
        for (const m of mentions.filter((x) => x !== viewer.id)) {
          await api.notify(m, 'TASK_MENTIONED', {
            taskId: id,
            taskName: task.name,
            projectId: project.id,
            projectName: project.name,
            commentId: row.id,
            authorName: viewer.fullName,
          });
        }
      });
      return { id: row.id, author: { id: viewer.id, fullName: viewer.fullName }, body: row.body, mentions, createdAt: row.createdAt };
    },

    activity: async (id) => {
      const viewer = await api.actor();
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
      const obj = await db.objects.get(file.id);
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
  };

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
        const finals = recompute({
          tasks: s.tasks,
          dependencies: [...s.deps, dep],
          calendar: s.cal,
          autoSchedule: s.project.autoSchedule,
          changed: [data.predecessorId],
        });
        await db.dependencies.add(dep);
        ids = await persist(s, finals, {
          actorId: viewer.id,
          explicit: new Set(),
          explicitAction: 'task.moved',
          auditExtra: { cause: 'dependency', dependencyId: dep.id },
        });
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
      const data = validate(calendarSchema, input);
      const row: DemoCalendar = {
        id: newId(),
        name: data.name,
        weekendDays: normalizeWeekend(data.weekendDays),
        isDefault: false,
        createdAt: new Date().toISOString(),
        exceptions: [],
      };
      await tx(async () => {
        await db.calendars.add(row);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar.created',
          entityType: 'calendar',
          entityId: row.id,
          before: null,
          after: { name: row.name, weekendDays: row.weekendDays },
        });
      });
      return calendarDto(row);
    },

    update: async (id, input) => {
      const viewer = await api.actor('projects.manage');
      const data = validate(updateCalendarSchema, input);
      const cur = await getCalendar(id);
      const weekendDays = data.weekendDays ? normalizeWeekend(data.weekendDays) : undefined;
      const weekendChanged = !!weekendDays && weekendDays.join(',') !== cur.weekendDays.join(',');
      const nameChanged = data.name !== undefined && data.name !== cur.name;
      if (!weekendChanged && !nameChanged) return calendarDto(cur);
      if (weekendDays && weekendDays.length >= 7) fail('VALIDATION_FAILED', { fieldErrors: { weekendDays: ['اترك يوم عمل واحدًا على الأقل'] } });
      await tx(async () => {
        await db.calendars.put({ ...cur, ...(nameChanged ? { name: data.name! } : {}), ...(weekendChanged ? { weekendDays } : {}) });
        const rescheduled = weekendChanged ? await rescheduleUsers(id, viewer.id, 'calendar.updated') : 0;
        await api.writeAudit({
          actorId: viewer.id,
          action: 'calendar.updated',
          entityType: 'calendar',
          entityId: id,
          before: { ...(nameChanged ? { name: cur.name } : {}), ...(weekendChanged ? { weekendDays: cur.weekendDays } : {}) },
          after: { ...(nameChanged ? { name: data.name } : {}), ...(weekendChanged ? { weekendDays, rescheduledTasks: rescheduled } : {}) },
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

  /**
   * ADR-059 reminders, run lazily (the demo has no cron): overdue and due-soon tasks notify their
   * assignee once each; the column is claimed before notifying, and any end-date move clears it.
   */
  /** Once per Riyadh day, like the 07:00 job. */
  async function maybeSweep() {
    const today = riyadhToday();
    if ((await db.kv.get('taskRemindersDay'))?.value === today) return;
    await sweepReminders();
    await db.kv.put({ key: 'taskRemindersDay', value: today });
  }

  async function sweepReminders(now: Date = new Date()): Promise<number> {
    const today = riyadhToday(now);
    let sent = 0;
    await tx(async () => {
      const projectsById = new Map((await db.projects.toArray()).filter((p) => !p.archivedAt).map((p) => [p.id, p]));
      const cals = new Map((await db.calendars.toArray()).map((c) => [c.id, workCalendarOf(c)]));
      const rows = (await db.tasks.toArray()).filter((t) => t.assigneeId && !t.archivedAt && projectsById.has(t.projectId));
      for (const t of rows) {
        const p = projectsById.get(t.projectId)!;
        const cal = cals.get(p.calendarId);
        if (!cal) continue;
        const { overdue, dueSoon } = dueFlags(t, today, cal);
        const payload = { taskId: t.id, taskName: t.name, projectId: p.id, projectName: p.name, endDate: t.endDate };
        if (overdue && !t.overdueNotifiedAt) {
          await db.tasks.update(t.id, { overdueNotifiedAt: now.toISOString() });
          await api.notify(t.assigneeId!, 'TASK_OVERDUE', payload);
          sent++;
        } else if (dueSoon && !t.dueSoonNotifiedAt) {
          await db.tasks.update(t.id, { dueSoonNotifiedAt: now.toISOString() });
          await api.notify(t.assigneeId!, 'TASK_DUE_SOON', payload);
          sent++;
        }
      }
    });
    return sent;
  }

  return { projects, tasks, dependencies, calendars, beforeTaskPresign, afterTaskConfirm, sweepReminders };
}
