/**
 * A12 round 2 — what the signed-in user may do in ONE project and on ONE task (docs/a12-roles.md
 * §3–§4). The web hides what the API would refuse:
 *  - the account's own rights (`can()`: admins, assistants with tasks:edit…) always apply;
 *  - a project participant adds the rights of their level on THAT project only
 *    (VIEWER reads · CONTRIBUTOR works on every task · EDITOR also edits the structure);
 *  - a supervisor works on their own tasks, and on their team's tasks they comment and change
 *    status/progress only (checklist, attachments and time log stay the assignee's).
 * Participants never get project settings, the budget/costs or the participants list.
 */
import { can, type ParticipantLevel, type PermissionSubject } from '@nuzli/shared';
import { useAuthStore } from '../../stores/auth';
import { useParticipationLevel } from '../../api/a12Queries';
import type { ChecklistMode } from '../tasks/TaskChecklist';

export interface ProjectAccess {
  /** The caller's participant level here (undefined when not a participant). */
  level?: ParticipantLevel;
  /** True when the level is what grants access (the «مشارك بصفة …» pill is shown). */
  participantOnly: boolean;
  /** Project settings, cover, participants (admins; assistants with projects:edit). */
  manageProject: boolean;
  /** Create/edit/move/delete tasks, labels, custom values, dependencies. */
  editTasks: boolean;
  /** Status/progress, checklist ticks, attachments and time log on EVERY task of the project. */
  workAll: boolean;
  /** Writes in the task chats of this project. */
  comment: boolean;
  /** Money fields are sent (budget.read); editable with budget.manage. */
  budgetRead: boolean;
  budgetManage: boolean;
}

type Subject = (PermissionSubject & { id?: string }) | null | undefined;

export function projectAccess(user: Subject, level: ParticipantLevel | undefined): ProjectAccess {
  const manageTasks = can(user, 'tasks.manage');
  const editTasks = manageTasks || level === 'EDITOR';
  const workAll = editTasks || level === 'CONTRIBUTOR';
  // A VIEWER never comments here, even when another role of theirs could comment elsewhere.
  const comment = manageTasks || (level ? level !== 'VIEWER' : can(user, 'tasks.comment'));
  const manageProject = can(user, 'projects.manage');
  return {
    level,
    participantOnly: Boolean(level) && !manageProject && !can(user, 'projects.readAll'),
    manageProject,
    editTasks,
    workAll,
    comment,
    budgetRead: can(user, 'budget.read'),
    budgetManage: can(user, 'budget.manage'),
  };
}

export interface TaskAccess {
  /** Structural edits (name, dates, assignee, priority, description, links…). */
  edit: boolean;
  /** Status and progress. */
  status: boolean;
  comment: boolean;
  checklist: ChecklistMode;
  attach: boolean;
  logTime: boolean;
  /** Logs time for others and edits any entry (the account's own tasks.manage only). */
  timeAdmin: boolean;
  /** A co-supervisor's task in «مهامي» (status/progress and chat only). */
  team: boolean;
  /** The task is assigned to the caller. */
  mine: boolean;
}

export function taskAccess(
  user: Subject,
  level: ParticipantLevel | undefined,
  task: { assignee?: { id: string } | null },
  opts: { team?: boolean } = {},
): TaskAccess {
  const p = projectAccess(user, level);
  const mine = Boolean(user?.id) && task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned');
  // A supervisor reading a task that is not theirs can only be reading their team's (API scope).
  const team =
    opts.team ?? (!mine && !p.workAll && !level && can(user, 'tasks.updateAssigned') && !can(user, 'projects.readAll'));
  const work = p.workAll || mine;
  return {
    edit: p.editTasks,
    status: work || team,
    comment: p.comment || mine || (team && can(user, 'tasks.comment')),
    checklist: p.editTasks ? 'admin' : work ? 'assignee' : 'read',
    attach: work,
    logTime: work,
    timeAdmin: can(user, 'tasks.manage'),
    team: team && !work,
    mine,
  };
}

/** The access of the signed-in user on a project (participant level from `GET /me/participations`). */
export function useProjectAccess(projectId: string | undefined): ProjectAccess {
  const user = useAuthStore((s) => s.user);
  const level = useParticipationLevel(projectId);
  return projectAccess(user, level);
}

export function useTaskAccess(task: { projectId: string; assignee?: { id: string } | null }, opts: { team?: boolean } = {}): TaskAccess {
  const user = useAuthStore((s) => s.user);
  const level = useParticipationLevel(task.projectId);
  return taskAccess(user, level, task, opts);
}
