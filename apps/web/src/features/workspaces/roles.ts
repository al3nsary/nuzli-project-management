import { effectiveRole, type Role, type UserDto } from '@nuzli/shared';
import { roleLabel } from '../../components/ui';
import { t } from '../../i18n';

/**
 * A12: how a person's standing reads in the active workspace — «مالك النظام», or every role
 * there («مدير النظام · مشرف» for a dual role), or the display role of older payloads.
 */
export function workspaceRoleText(user: Pick<UserDto, 'role' | 'accountRole' | 'workspaceRoles'> | null | undefined): string {
  if (!user) return '';
  const roles = user.workspaceRoles ?? [];
  const parts = roles.map((r) => roleLabel(r));
  if (user.accountRole === 'OWNER') return [t('accountRole.OWNER'), ...parts.filter((p) => p !== roleLabel('ADMIN'))].join(' · ');
  if (parts.length) return parts.join(' · ');
  return roleLabel(user.role);
}

/**
 * A12: the role the UI is shaped by (bottom bar, home page, «مهامي» first) — the strongest matrix
 * role in the active workspace; owners act as admins. Null for an assistant or a member (their
 * screens follow their grants and participations, never the API's display fallback).
 */
export function uiRoleOf(user: Pick<UserDto, 'role' | 'accountRole' | 'workspaceRoles'> | null | undefined): Role | null {
  if (!user) return null;
  if (user.accountRole === 'OWNER') return 'ADMIN';
  if (user.workspaceRoles) return effectiveRole(user.workspaceRoles);
  return user.role;
}
