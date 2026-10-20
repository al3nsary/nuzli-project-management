import type { AccountRole, Role } from './enums';

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
  /** A9 organisational structure: read the tree (admins, supervisors) and manage it (admins). */
  'org.read',
  'org.manage',
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
    // A9 (ADR-102): supervisors read the organisational structure; only admins change it.
    'org.read',
    // A9 (ADR-092): no `projects.readGranted` — supervisors see only the tasks assigned to them
    // (my tasks, the task itself, its comments, attachments, checklist and time log), never a project.
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
  /** The matrix role in the active workspace (A12); null = no role there. */
  role: Role | null;
  status?: string;
  /** A12: OWNER holds every permission in every workspace. */
  accountRole?: AccountRole;
  /**
   * A12: every role the user holds in the active workspace (a dual role is allowed). When given,
   * the permission is granted if ANY of them grants it; `role` stays the strongest one.
   */
  roles?: readonly string[];
}

/** True when the user holds the permission. Non-active users hold nothing. */
export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.status && user.status !== 'ACTIVE') return false;
  if (user.accountRole === 'OWNER') return true;
  if (user.roles?.length) {
    return user.roles.some((r) => ROLE_PERMISSIONS[r as Role]?.has(permission) ?? false);
  }
  return (user.role && ROLE_PERMISSIONS[user.role]?.has(permission)) ?? false;
}

export function canAny(user: PermissionSubject | null | undefined, permissions: Permission[]) {
  return permissions.some((p) => can(user, p));
}

/** Roles that may be assigned a task (brief §1: tasks go to supervisors only). */
export const TASK_ASSIGNABLE_ROLES: Role[] = ['SUPERVISOR'];
