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
  // A12 round 2 — finer rights so an assistant (مساعد) can be given one module at a time.
  // ADMIN holds every permission, so these change nothing for admins and owners.
  /** Budget and costs: read (project budget, task costs) and change them. */
  'budget.read',
  'budget.manage',
  /** Card print history, sizes, templates and logos (read only). */
  'cards.read',
  /** Pending registrations and worker add/remove requests (read only); deciding needs registrations.review. */
  'registrations.read',
  /** Project reports and workload. */
  'reports.read',
  /** Work calendars: read / manage. */
  'calendars.read',
  'calendars.manage',
  /** Edit another user's account data (username, e-mail, mobile, name, national ID, password). */
  'users.edit',
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

/**
 * A12 round 2: roles that grant nothing by themselves beyond the personal basics — an ASSISTANT
 * (مساعد) gets the modules chosen by an admin (`grants`), a MEMBER (عضو) is a project participant.
 */
export const BASE_WORKSPACE_ROLE_PERMISSIONS: Record<'ASSISTANT' | 'MEMBER', ReadonlySet<Permission>> = {
  ASSISTANT: new Set<Permission>(SELF),
  MEMBER: new Set<Permission>(SELF),
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
  /**
   * A12 round 2: permissions granted on top of the roles — an assistant's modules
   * (`assistantGrants`) and, for the request at hand, a project participant's level.
   */
  grants?: readonly string[];
}

function roleGrants(role: string, permission: Permission): boolean {
  return (
    ROLE_PERMISSIONS[role as Role]?.has(permission) ??
    BASE_WORKSPACE_ROLE_PERMISSIONS[role as 'ASSISTANT' | 'MEMBER']?.has(permission) ??
    false
  );
}

/** True when the user holds the permission. Non-active users hold nothing. */
export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.status && user.status !== 'ACTIVE') return false;
  if (user.accountRole === 'OWNER') return true;
  if (user.grants?.includes(permission)) return true;
  if (user.roles?.length) {
    return user.roles.some((r) => roleGrants(r, permission));
  }
  return (user.role && ROLE_PERMISSIONS[user.role]?.has(permission)) ?? false;
}

export function canAny(user: PermissionSubject | null | undefined, permissions: Permission[]) {
  return permissions.some((p) => can(user, p));
}

/** Roles that may be assigned a task (brief §1: tasks go to supervisors only). */
export const TASK_ASSIGNABLE_ROLES: Role[] = ['SUPERVISOR'];
