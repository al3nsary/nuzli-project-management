import {
  can,
  PARTICIPANT_GRANTS,
  PARTICIPANT_RANK,
  type ParticipantLevel,
  type Permission,
  type PermissionSubject,
} from '@nuzli/shared';

/**
 * A12 round 2 — what a request may reach beyond the role matrix, computed once per request by
 * JwtAuthGuard (AccessContextService.enrich) and read by the data-scope helpers of each module.
 *
 *  - `limits`: an assistant's scope (projects / teams); null lists = no limit. Never set for
 *    admins or owners (their role already gives the whole workspace).
 *  - `participations`: projectId → level (محرّر / مساهم / مطّلع) — explicit project grants.
 *  - `teamPeerIds`: the supervisors this supervisor shares tasks with (owner rule: own tasks AND
 *    the tasks of every supervisor of the same team(s)) — always includes the user.
 *  - `baseGrants`: the assistant modules' permissions (the request's `grants` start from them;
 *    ProjectGrantGuard adds a participant's level for the project a request is about).
 *
 * Every field is optional: a viewer without them (unit tests, background jobs) behaves exactly as
 * before round 2 — no limit, no participation, peers = self.
 */
export interface AccessExtras {
  limits?: { projectIds: string[] | null; teamIds: string[] | null } | null;
  participations?: Readonly<Record<string, ParticipantLevel>>;
  teamPeerIds?: readonly string[];
  baseGrants?: readonly Permission[];
}

export type ScopedViewer = PermissionSubject & { id: string } & AccessExtras;

export function extras(viewer: PermissionSubject & { id?: string }): AccessExtras {
  return viewer as AccessExtras;
}

/** An assistant's project scope, or null (no limit). */
export function projectLimit(viewer: PermissionSubject): string[] | null {
  return extras(viewer).limits?.projectIds ?? null;
}

/** An assistant's team scope, or null (no limit). */
export function teamLimit(viewer: PermissionSubject): string[] | null {
  return extras(viewer).limits?.teamIds ?? null;
}

/** The viewer's participant level on a project, or null. */
export function participationIn(viewer: PermissionSubject, projectId: string | null | undefined): ParticipantLevel | null {
  if (!projectId) return null;
  return extras(viewer).participations?.[projectId] ?? null;
}

/** Projects the viewer participates in (any level). */
export function participantProjectIds(viewer: PermissionSubject, minLevel: ParticipantLevel = 'VIEWER'): string[] {
  const p = extras(viewer).participations ?? {};
  return Object.keys(p).filter((id) => PARTICIPANT_RANK[p[id]!] >= PARTICIPANT_RANK[minLevel]);
}

/** Supervisors whose tasks this viewer shares (self included). */
export function peerIds(viewer: PermissionSubject & { id: string }): string[] {
  const peers = extras(viewer).teamPeerIds;
  return peers?.length ? [...new Set([viewer.id, ...peers])] : [viewer.id];
}

/**
 * The permissions of a request bound to one project: the assistant modules plus the participant
 * level on THAT project (none when the viewer does not participate in it).
 */
export function projectBoundGrants(viewer: PermissionSubject, projectId: string | null): Permission[] {
  const base = [...(extras(viewer).baseGrants ?? [])];
  const level = participationIn(viewer, projectId);
  if (level) return [...new Set([...base, ...PARTICIPANT_GRANTS[level]])];
  // Not a participant of THIS project: reading stays open so the service answers 404 (its
  // existence is not revealed), but nothing more.
  return participantProjectIds(viewer).length ? [...new Set([...base, 'projects.readGranted' as Permission])] : base;
}

/** The grants of a request NOT bound to a project (lists, hub): reading + commenting where allowed. */
export function unboundGrants(viewer: PermissionSubject): Permission[] {
  const base = [...(extras(viewer).baseGrants ?? [])];
  const ids = participantProjectIds(viewer);
  if (!ids.length) return base;
  const extra: Permission[] = ['projects.readGranted'];
  if (participantProjectIds(viewer, 'CONTRIBUTOR').length) extra.push('tasks.comment');
  return [...new Set([...base, ...extra])];
}

/**
 * What the viewer may do on ONE task (the services' check after the task was found in scope):
 *  - 'manage'    — admins, assistants with tasks:edit, editors of the task's project (project-bound
 *                  request), i.e. `tasks.manage`;
 *  - 'work'      — the assignee, or a contributor/editor of the project: status/progress, comments,
 *                  checklist ticks, attachments, time log;
 *  - 'team'      — a supervisor of the same team as the assignee (owner rule): status/progress and
 *                  comments only;
 *  - 'read'      — sees it (viewer participant, assistant with view) — nothing else.
 */
export type TaskRelation = 'manage' | 'work' | 'team' | 'read';

export function taskRelation(
  viewer: PermissionSubject & { id: string },
  task: { projectId: string; assigneeId: string | null },
): TaskRelation {
  if (can(viewer, 'tasks.manage')) return 'manage';
  if (task.assigneeId && task.assigneeId === viewer.id && can(viewer, 'tasks.updateAssigned')) return 'work';
  const level = participationIn(viewer, task.projectId);
  if (level === 'EDITOR' || level === 'CONTRIBUTOR') return 'work';
  if (task.assigneeId && can(viewer, 'tasks.updateAssigned') && peerIds(viewer).includes(task.assigneeId)) return 'team';
  return 'read';
}

/** May change status/progress and comment (manage, work, team). */
export function mayActOnTask(viewer: PermissionSubject & { id: string }, task: { projectId: string; assigneeId: string | null }): boolean {
  return taskRelation(viewer, task) !== 'read';
}

/** May tick the checklist, attach files, log time (manage, work). */
export function mayWorkOnTask(viewer: PermissionSubject & { id: string }, task: { projectId: string; assigneeId: string | null }): boolean {
  const r = taskRelation(viewer, task);
  return r === 'manage' || r === 'work';
}
