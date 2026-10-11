import type { Role } from './enums';

/**
 * The single RBAC matrix (brief §4.1). The API guard and the web UI both read it.
 * Scope rules that depend on data ("own team", "recorded by me", the supervisor
 * visibility setting) are applied in the service layer on top of these permissions.
 */
export const PERMISSIONS = [
  // users & registration
  'users.read',
  'users.create',
  'users.manageRoles',
  'users.suspend',
  'registrations.review',
  /** See full (unmasked) national IDs of users and members (brief §13). */
  'nationalIds.readFull',
  // teams & members
  'teams.readAll',
  'teams.readOwn',
  'teams.create',
  'teams.createOwn',
  'teams.approve',
  'teams.manageAll',
  'teams.manageOwn',
  'members.manage',
  'members.manageOwn',
  'members.move',
  'members.import',
  // reference data & settings
  'colors.manage',
  'reference.manage',
  'settings.manage',
  'audit.read',
  // projects & tasks
  'projects.create',
  'projects.manage',
  'projects.readAll',
  'projects.readGranted',
  'tasks.manage',
  'tasks.readAssigned',
  'tasks.updateAssigned',
  'tasks.comment',
  // violations
  'violations.create',
  'violations.readAll',
  'violations.readRecorded',
  'violations.readOwnTeams',
  'violations.respond',
  'violations.manage',
  'violations.export',
  'violations.stats',
  'violations.viewIdPhoto',
  // cards
  'cards.print',
  'cards.manageTemplates',
  'logos.manage',
  // self
  'notifications.read',
  'profile.update',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SELF: Permission[] = ['notifications.read', 'profile.update'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set<Permission>(PERMISSIONS),
  SUPERVISOR: new Set<Permission>([
    ...SELF,
    'teams.readOwn',
    'teams.createOwn',
    'teams.manageOwn',
    'members.manageOwn',
    'projects.readGranted',
    'tasks.readAssigned',
    'tasks.updateAssigned',
    'tasks.comment',
    // Effective only when the admin enables visibility (brief §7.6) — checked in the service.
    'violations.readOwnTeams',
    'violations.respond',
  ]),
  MONITOR: new Set<Permission>([
    ...SELF,
    'violations.create',
    'violations.readRecorded',
    'violations.viewIdPhoto',
  ]),
};

export interface PermissionSubject {
  role: Role;
  status?: string;
}

/** True when the user holds the permission. Non-active users hold nothing. */
export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.status && user.status !== 'ACTIVE') return false;
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

export function canAny(user: PermissionSubject | null | undefined, permissions: Permission[]) {
  return permissions.some((p) => can(user, p));
}

/** Roles that may be assigned a task (brief §1: tasks go to supervisors only). */
export const TASK_ASSIGNABLE_ROLES: Role[] = ['SUPERVISOR'];
