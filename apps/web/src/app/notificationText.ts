import type { NotificationDto, Role } from '@nuzli/shared';
import { formatDate, t, tKey } from '../i18n';
import { roleLabel } from '../components/ui';

/** The Arabic sentence for a notification, built from its type and payload. */
export function notificationText(n: NotificationDto): string {
  const p = n.payload ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  // A12 round 2: worker requests and project participation.
  const kind = str('kind') === 'REMOVE' ? 'REMOVE' : 'ADD';
  const decided = str('status') === 'REJECTED' ? 'REJECTED' : 'APPROVED';
  const level = str('level');
  return tKey(`notif.type.${n.type}`, 'notif.type.other', {
    by: str('by'),
    team: str('teamName'),
    request: t(kind === 'REMOVE' ? 'notif.request.REMOVE' : 'notif.request.ADD', { name: str('fullName') }),
    decision:
      t(decided === 'REJECTED' ? 'notif.decision.REJECTED' : 'notif.decision.APPROVED') +
      (decided === 'REJECTED' && str('reason') ? ` — ${str('reason')}` : ''),
    level: level ? tKey(`participantLevel.${level}`, 'common.none') : '',
    name: str('fullName') || str('name'),
    role: roleLabel(str('requestedRole') || str('role')),
    reason: str('reason'),
    supervisor: str('supervisorName'),
    member: str('memberName'),
    type: str('typeName'),
    task: str('taskName'),
    project: str('projectName'),
    author: str('authorName'),
    date: str('endDate') ? formatDate(str('endDate')) : '',
    preview: str('preview'),
    deadline: str('deadline') ? formatDate(str('deadline')) : '',
  });
}

/**
 * Where clicking a notification takes the user. Task notifications: a supervisor goes to the task
 * page in «مهامي» (A9: supervisors never open projects), an admin to the task in its project
 * (comments open on the chat tab).
 */
export function notificationLink(n: NotificationDto, role?: Role): string | null {
  const taskId = typeof n.payload?.taskId === 'string' ? n.payload.taskId : null;
  const projectId = typeof n.payload?.projectId === 'string' ? n.payload.projectId : null;
  const isTask = n.type.startsWith('TASK_');
  if (isTask && role === 'SUPERVISOR') return taskId ? `/my-tasks/${encodeURIComponent(taskId)}` : '/my-tasks';
  if (isTask && projectId) {
    const chat = n.type === 'TASK_COMMENTED' || n.type === 'TASK_MENTIONED';
    return `/projects/${encodeURIComponent(projectId)}${taskId ? `?task=${encodeURIComponent(taskId)}${chat ? '&ttab=comments' : ''}` : ''}`;
  }
  switch (n.type) {
    case 'REGISTRATION_REQUESTED':
      return '/registrations';
    // A12 round 2
    case 'MEMBER_REQUEST_CREATED':
      return '/registrations?tab=workers';
    case 'MEMBER_REQUEST_DECIDED':
      return '/worker-requests';
    case 'PROJECT_PARTICIPANT_ADDED':
      return typeof n.payload?.projectId === 'string' ? `/projects/${encodeURIComponent(n.payload.projectId)}` : '/projects';
    case 'REGISTRATION_APPROVED':
      return '/';
    case 'TEAM_PENDING_APPROVAL':
    case 'TEAM_APPROVED':
    case 'TEAM_REJECTED':
      return typeof n.payload?.teamId === 'string' ? `/teams/${n.payload.teamId}` : '/teams';
    case 'VIOLATION_OBJECTION':
      return typeof n.payload?.violationId === 'string'
        ? `/violations?open=${encodeURIComponent(n.payload.violationId)}`
        : '/violations';
    case 'TASK_ASSIGNED':
    case 'TASK_MENTIONED':
    case 'TASK_DUE_SOON':
    case 'TASK_OVERDUE':
      return typeof n.payload?.projectId === 'string' ? `/projects/${encodeURIComponent(n.payload.projectId)}` : '/my-tasks';
    default:
      return null;
  }
}
