import { can, type UserDto } from '@nuzli/shared';
import { useTeams } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';

/**
 * Owner request A8 (ADR-083), client side only — the API enforces the same rule:
 * a member's photo is changed by an admin (`members.manage`) or by the supervisor who leads
 * the member's current, non-archived team.
 */
export function canChangeMemberPhoto(
  user: Pick<UserDto, 'id' | 'role' | 'status'> | null | undefined,
  member: { team: { id: string } | null } | null | undefined,
  teams: { id: string; status: string; supervisor: { id: string } | null; supervisors?: { id: string }[] }[] | undefined,
): boolean {
  if (!user || !member) return false;
  if (can(user, 'members.manage')) return true;
  if (!can(user, 'members.manageOwn') || !member.team) return false;
  const team = teams?.find((x) => x.id === member.team!.id);
  return Boolean(team && (team.supervisors?.some((s) => s.id === user.id) ?? team.supervisor?.id === user.id) && team.status !== 'ARCHIVED');
}

/** `canChangeMemberPhoto` with the viewer's teams loaded when needed (supervisors). */
export function useCanChangeMemberPhoto(member: { team: { id: string } | null } | null | undefined): boolean {
  const user = useAuthStore((s) => s.user);
  const needTeams = Boolean(member?.team) && !can(user, 'members.manage') && can(user, 'members.manageOwn');
  const teams = useTeams({}, needTeams);
  return canChangeMemberPhoto(user, member, teams.data);
}

/** A user's photo: themselves, or an admin for anyone. */
export function canChangeUserPhoto(
  viewer: Pick<UserDto, 'id' | 'role' | 'status'> | null | undefined,
  targetUserId: string,
): boolean {
  if (!viewer) return false;
  return (viewer.id === targetUserId && can(viewer, 'profile.update')) || can(viewer, 'users.manageRoles');
}
