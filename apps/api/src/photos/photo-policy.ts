import { can, type PermissionSubject } from '@nuzli/shared';

/**
 * Who may change or see a personal photo (owner request A8, ADR-083). Pure functions so the
 * matrix is unit-tested on its own; PhotosService loads the rows and maps the decision to
 * an AppError. Error choice follows the member scope conventions (ADR-032): a member outside
 * the viewer's teams answers 404, a visible member without the right answers 403.
 */
export type Viewer = PermissionSubject & { id: string };
export type Decision = 'ALLOW' | 'FORBIDDEN' | 'NOT_FOUND';

/** The facts of a member that decide photo access: the open membership's team. */
export interface MemberPhotoScope {
  status: string;
  team: { supervisorId: string; status: string } | null;
}

/** Users: everyone for themselves; admins (`users.manageRoles`) for anyone. */
export function userPhotoWrite(viewer: Viewer, targetUserId: string): Decision {
  if (viewer.id === targetUserId && can(viewer, 'profile.update')) return 'ALLOW';
  if (can(viewer, 'users.manageRoles')) return 'ALLOW';
  return 'FORBIDDEN';
}

/**
 * Users: self and admins always; otherwise an active user may see an ACTIVE user's photo. Names
 * of active users are already visible to every role (assignees, team supervisors, recorders),
 * so the face adds no new person to anyone's view. Pending, rejected and suspended accounts
 * stay private to themselves and admins.
 */
export function userPhotoRead(viewer: Viewer, target: { id: string; status: string }): boolean {
  if (viewer.status && viewer.status !== 'ACTIVE') return false;
  if (viewer.id === target.id) return true;
  if (can(viewer, 'users.read')) return true;
  return target.status === 'ACTIVE';
}

/**
 * Members: `members.manage` (admin), or `members.manageOwn` when the viewer leads the member's
 * current team and that team is not archived. A monitor (no member rights) → 403. A supervisor
 * and a member of another team → 404; an unassigned member or an archived team → 403.
 */
export function memberPhotoWrite(viewer: Viewer, member: MemberPhotoScope): Decision {
  if (can(viewer, 'members.manage')) return 'ALLOW';
  if (!can(viewer, 'members.manageOwn')) return 'FORBIDDEN';
  if (!member.team) return 'FORBIDDEN';
  if (member.team.supervisorId !== viewer.id) return 'NOT_FOUND';
  if (member.team.status === 'ARCHIVED') return 'FORBIDDEN';
  return 'ALLOW';
}

/**
 * Members: admins; the supervisor leading the member's current team; and recorders
 * (`violations.create`, monitors) for members on the roster (active, open membership in a
 * non-archived team) so they can confirm a person's identity before recording a violation.
 */
export function memberPhotoRead(viewer: Viewer, member: MemberPhotoScope): boolean {
  if (can(viewer, 'teams.readAll') || can(viewer, 'members.manage')) return true;
  if (member.team && can(viewer, 'teams.readOwn') && member.team.supervisorId === viewer.id) return true;
  return (
    can(viewer, 'violations.create') &&
    member.status === 'ACTIVE' &&
    !!member.team &&
    member.team.status !== 'ARCHIVED'
  );
}
