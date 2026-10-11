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

export const ViolationFileKind = { ID_CARD: 'ID_CARD', EVIDENCE: 'EVIDENCE' } as const;
export type ViolationFileKind = (typeof ViolationFileKind)[keyof typeof ViolationFileKind];

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
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_MENTIONED: 'TASK_MENTIONED',
  TASK_DUE_SOON: 'TASK_DUE_SOON',
  TASK_OVERDUE: 'TASK_OVERDUE',
  VIOLATION_OBJECTION: 'VIOLATION_OBJECTION',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPES = Object.values(NotificationType);
