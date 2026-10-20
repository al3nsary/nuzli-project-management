// Enumerations shared by the API (Prisma enums mirror these) and the web app.

export const Role = { ADMIN: 'ADMIN', SUPERVISOR: 'SUPERVISOR', MONITOR: 'MONITOR' } as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLES = Object.values(Role);

export const UserStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const TeamStatus = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type TeamStatus = (typeof TeamStatus)[keyof typeof TeamStatus];
/** Statuses that reserve a team colour (brief §5.2). */
export const COLOR_RESERVING_STATUSES: TeamStatus[] = ['ACTIVE', 'PENDING_APPROVAL'];

export const MemberStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];

export const ProjectStatus = {
  PLANNING: 'PLANNING',
  ACTIVE: 'ACTIVE',
  ON_HOLD: 'ON_HOLD',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const TaskType = { TASK: 'TASK', GROUP: 'GROUP', MILESTONE: 'MILESTONE' } as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const TaskStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  ON_HOLD: 'ON_HOLD',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const TASK_STATUSES = Object.values(TaskStatus);

export const Priority = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', URGENT: 'URGENT' } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const DependencyType = { FS: 'FS', SS: 'SS', FF: 'FF', SF: 'SF' } as const;
export type DependencyType = (typeof DependencyType)[keyof typeof DependencyType];
/** Only FS is exposed in the UI for now (brief §6.1). */
export const ENABLED_DEPENDENCY_TYPES: DependencyType[] = ['FS'];

export const ProjectAccessLevel = { VIEW: 'VIEW' } as const;
export type ProjectAccessLevel = (typeof ProjectAccessLevel)[keyof typeof ProjectAccessLevel];

export const ViolationStatus = {
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
} as const;
export type ViolationStatus = (typeof ViolationStatus)[keyof typeof ViolationStatus];

export const Severity = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' } as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** A9: PERSON — a photo of the person (required with the ID card and the evidence, owner decision 4). */
export const ViolationFileKind = { ID_CARD: 'ID_CARD', EVIDENCE: 'EVIDENCE', PERSON: 'PERSON' } as const;
export type ViolationFileKind = (typeof ViolationFileKind)[keyof typeof ViolationFileKind];

/** A9: a team member is a worker or the team's worker foreman (مشرف عمّال) — a record only, no account. */
export const MembershipRole = { WORKER: 'WORKER', FOREMAN: 'FOREMAN' } as const;
export type MembershipRole = (typeof MembershipRole)[keyof typeof MembershipRole];

/** A9 organisational structure: kinds of units in the tree. */
export const OrgUnitKind = { DEPARTMENT: 'DEPARTMENT', SECTION: 'SECTION', UNIT: 'UNIT', TEAM_GROUP: 'TEAM_GROUP' } as const;
export type OrgUnitKind = (typeof OrgUnitKind)[keyof typeof OrgUnitKind];
export const ORG_UNIT_KINDS = Object.values(OrgUnitKind);

/** A9: state of the ID-card OCR job of a violation. */
export const OcrStatus = { PENDING: 'PENDING', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED' } as const;
export type OcrStatus = (typeof OcrStatus)[keyof typeof OcrStatus];

export const VisibilityMode = { INHERIT: 'INHERIT', SHOW: 'SHOW', HIDE: 'HIDE' } as const;
export type VisibilityMode = (typeof VisibilityMode)[keyof typeof VisibilityMode];

export const FileStatus = { PENDING: 'PENDING', READY: 'READY' } as const;
export type FileStatus = (typeof FileStatus)[keyof typeof FileStatus];

export const CardOrientation = { LANDSCAPE: 'LANDSCAPE', PORTRAIT: 'PORTRAIT' } as const;
export type CardOrientation = (typeof CardOrientation)[keyof typeof CardOrientation];

export const CardLayoutKey = {
  CLASSIC_HORIZONTAL: 'CLASSIC_HORIZONTAL',
  VERTICAL_BADGE: 'VERTICAL_BADGE',
  COMPACT_LABEL: 'COMPACT_LABEL',
} as const;
export type CardLayoutKey = (typeof CardLayoutKey)[keyof typeof CardLayoutKey];

export const NotificationType = {
  REGISTRATION_REQUESTED: 'REGISTRATION_REQUESTED',
  REGISTRATION_APPROVED: 'REGISTRATION_APPROVED',
  REGISTRATION_REJECTED: 'REGISTRATION_REJECTED',
  TEAM_PENDING_APPROVAL: 'TEAM_PENDING_APPROVAL',
  TEAM_APPROVED: 'TEAM_APPROVED',
  TEAM_REJECTED: 'TEAM_REJECTED',
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_MENTIONED: 'TASK_MENTIONED',
  TASK_DUE_SOON: 'TASK_DUE_SOON',
  TASK_OVERDUE: 'TASK_OVERDUE',
  /** A9: a comment on a task (to the assignee and earlier commenters, not the author). */
  TASK_COMMENTED: 'TASK_COMMENTED',
  /** A9: the task deadline passed and the task is not DONE (once per deadline). */
  TASK_DEADLINE_PASSED: 'TASK_DEADLINE_PASSED',
  VIOLATION_OBJECTION: 'VIOLATION_OBJECTION',
  /** A12 round 2: a supervisor asked to add or remove a worker (to the approvers). */
  MEMBER_REQUEST_CREATED: 'MEMBER_REQUEST_CREATED',
  /** A12 round 2: the request was approved or rejected (to the supervisor who asked). */
  MEMBER_REQUEST_DECIDED: 'MEMBER_REQUEST_DECIDED',
  /** A12 round 2: you were added to a project as a participant. */
  PROJECT_PARTICIPANT_ADDED: 'PROJECT_PARTICIPANT_ADDED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPES = Object.values(NotificationType);

// ───────────────────────────────────────────── A12 — workspaces (أقسام)

/** A12: the account layer. OWNER (مالك) sees every workspace; USER rights come from memberships. */
export const AccountRole = { OWNER: 'OWNER', USER: 'USER' } as const;
export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

/**
 * A12: the role of a user inside one workspace. ADMIN/SUPERVISOR/MONITOR keep today's rights,
 * scoped to that workspace. ASSISTANT (مساعد): the modules an admin grants (a12-access.ts).
 * MEMBER (عضو): no workspace right of its own — a person added to projects as a participant.
 */
export const WorkspaceRole = {
  ADMIN: 'ADMIN',
  ASSISTANT: 'ASSISTANT',
  SUPERVISOR: 'SUPERVISOR',
  MONITOR: 'MONITOR',
  MEMBER: 'MEMBER',
} as const;
export type WorkspaceRole = (typeof WorkspaceRole)[keyof typeof WorkspaceRole];
export const WORKSPACE_ROLES = Object.values(WorkspaceRole);

export const WorkspaceStatus = { ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' } as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

export const WorkspaceMembershipStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED' } as const;
export type WorkspaceMembershipStatus = (typeof WorkspaceMembershipStatus)[keyof typeof WorkspaceMembershipStatus];

/**
 * A12: the matrix role (today's Role) a set of workspace roles maps to, strongest first.
 * ASSISTANT / MEMBER map to no matrix role: their rights are grants (assistant modules, project participation).
 */
export function effectiveRole(roles: readonly string[]): Role | null {
  if (roles.includes('ADMIN')) return 'ADMIN';
  if (roles.includes('SUPERVISOR')) return 'SUPERVISOR';
  if (roles.includes('MONITOR')) return 'MONITOR';
  return null;
}

/**
 * A12 round 3: the role SHOWN for a person — truthful, never a fallback. `OWNER` for an owner
 * account; otherwise the strongest role in the active workspace: the matrix roles first (ADMIN,
 * SUPERVISOR, MONITOR — so older clients keep their behaviour), then ASSISTANT, then MEMBER.
 * Rights never come from it (the API and `can()` read `workspaceRoles` / `roles` and `grants`).
 */
export type DisplayRole = WorkspaceRole | 'OWNER';
export const DISPLAY_ROLE_ORDER: readonly WorkspaceRole[] = ['ADMIN', 'SUPERVISOR', 'MONITOR', 'ASSISTANT', 'MEMBER'];

/** A12 round 3: the display role of a set of workspace roles (null = no role there). */
export function displayRoleOf(input: { accountRole?: AccountRole | null; roles: readonly string[] }): DisplayRole | null {
  if (input.accountRole === 'OWNER') return 'OWNER';
  return DISPLAY_ROLE_ORDER.find((r) => input.roles.includes(r)) ?? null;
}
