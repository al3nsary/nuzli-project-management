import type { NotificationDto } from '@nuzli/shared';
import { tKey } from '../i18n';
import { roleLabel } from '../components/ui';

/** The Arabic sentence for a notification, built from its type and payload. */
export function notificationText(n: NotificationDto): string {
  const p = n.payload ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  return tKey(`notif.type.${n.type}`, 'notif.type.other', {
    name: str('fullName') || str('name'),
    role: roleLabel(str('requestedRole') || str('role')),
    reason: str('reason'),
    supervisor: str('supervisorName'),
    member: str('memberName'),
    type: str('typeName'),
  });
}

/** Where clicking a notification takes the user. */
export function notificationLink(n: NotificationDto): string | null {
  switch (n.type) {
    case 'REGISTRATION_REQUESTED':
      return '/registrations';
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
    default:
      return null;
  }
}
