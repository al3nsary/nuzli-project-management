import { z } from 'zod';
import { assistantPermissionsSchema, assistantScopeSchema, PARTICIPANT_LEVELS, type AssistantPermissions, type AssistantScope, type ParticipantLevel } from '../a12-access';
import type { AccountRole, UserStatus, WorkspaceMembershipStatus, WorkspaceRole, WorkspaceStatus } from '../enums';
import { email, fullName, nationalId, optionalText, password, reason, saudiMobile, uuid } from './common';
import { usernameSchema } from './auth-users';

/**
 * A12 round 2 — owners, workspace administration, user management, memberships, project
 * participants and workers' add/remove requests. Exact routes in docs/API.md «A12 — round 2».
 */

export const workspaceRoleSchema = z.enum(['ADMIN', 'ASSISTANT', 'SUPERVISOR', 'MONITOR', 'MEMBER']);

/** Free-text position (منصب) of a membership or a project participant. */
export const positionTitle = z.string().trim().min(1, { message: 'اكتب المنصب' }).max(120, { message: 'المنصب أطول من المسموح' });

// ───────────────────────────────────────────── owners

/** `POST /owners` — promote an existing user (`userId` or `identifier`) or create a new owner account. */
export const addOwnerSchema = z.union([
  z.object({ userId: uuid }).strict(),
  z.object({ identifier: z.string().trim().min(3).max(200) }).strict(),
  z
    .object({
      username: usernameSchema,
      fullName,
      email,
      mobile: saudiMobile,
      nationalId,
      password,
      mustChangePassword: z.boolean().default(true),
    })
    .strict(),
]);
export type AddOwnerInput = z.input<typeof addOwnerSchema>;

export interface OwnerDto {
  id: string;
  username: string;
  fullName: string;
  email: string;
  status: UserStatus;
  hasPhoto: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

// ───────────────────────────────────────────── workspaces (owners)

/** A machine code: lower-case Latin letter first, then letters, digits or dashes (2–40). */
export const workspaceCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, { message: 'رمز القسم: حروف لاتينية صغيرة وأرقام وشرطة، يبدأ بحرف (٢–٤٠)' });

export const workspaceNameSchema = z.string().trim().min(2, { message: 'اكتب اسم القسم' }).max(80, { message: 'الاسم أطول من المسموح' });

export const createWorkspaceSchema = z.object({ name: workspaceNameSchema, code: workspaceCodeSchema.optional() });
export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;
export const renameWorkspaceSchema = z.object({ name: workspaceNameSchema });
export const workspaceListQuery = z.object({ status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ALL') });

export interface WorkspaceAdminDto {
  id: string;
  name: string;
  code: string;
  status: WorkspaceStatus;
  createdAt: string;
  archivedAt: string | null;
  /** Live ADMIN memberships. */
  adminCount: number;
  /** Users with at least one live membership. */
  memberCount: number;
}

/** `GET /workspaces/:id/summary` — counts only (no business rows). */
export interface WorkspaceCountsDto {
  workspace: { id: string; name: string; code: string; status: WorkspaceStatus };
  users: { total: number; byRole: Record<WorkspaceRole, number>; pendingRegistrations: number };
  projects: number;
  tasks: number;
  teams: number;
  members: number;
  violations: number;
  pendingMemberRequests: number;
}

// ───────────────────────────────────────────── memberships (owners anywhere; admins in their workspace)

const membershipFields = {
  role: workspaceRoleSchema,
  title: positionTitle.optional(),
  /** ASSISTANT only: per-module level. */
  permissions: assistantPermissionsSchema.optional(),
  /** ASSISTANT only: limit to projects / teams. */
  scope: assistantScopeSchema.optional(),
};

function assistantOnly(v: { role: string; permissions?: unknown; scope?: unknown }, ctx: z.RefinementCtx): void {
  if (v.role !== 'ASSISTANT' && (v.permissions !== undefined || v.scope !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permissions'], message: 'الصلاحيات التفصيلية للمساعد فقط' });
  }
}

/**
 * `POST /workspaces/:id/members` — gives an EXISTING account (by id, or by username / e-mail /
 * mobile / national ID) a role in the workspace. A second live role needs `confirmDualRole: true`
 * (else 409 DUAL_ROLE_CONFIRM_REQUIRED).
 */
export const addWorkspaceMemberSchema = z
  .object({
    userId: uuid.optional(),
    identifier: z.string().trim().min(3).max(200).optional(),
    ...membershipFields,
    confirmDualRole: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.userId === !v.identifier) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'حدّد المستخدم بالمعرّف أو باسم المستخدم أو البريد أو الجوال' });
    }
    assistantOnly(v, ctx);
  });
export type AddWorkspaceMemberInput = z.input<typeof addWorkspaceMemberSchema>;

/** `PATCH /workspaces/:id/members/:membershipId` — position, assistant modules and scope. */
export const updateMembershipSchema = z
  .object({
    title: positionTitle.nullable().optional(),
    permissions: assistantPermissionsSchema.optional(),
    scope: assistantScopeSchema.optional(),
  })
  .strict();

/** `POST /workspaces/:id/admins` (owners). */
export const addWorkspaceAdminSchema = z
  .object({
    userId: uuid.optional(),
    identifier: z.string().trim().min(3).max(200).optional(),
    title: positionTitle.optional(),
    confirmDualRole: z.boolean().optional(),
  })
  .refine((v) => !v.userId !== !v.identifier, { path: ['userId'], message: 'حدّد المستخدم' });

export interface WorkspaceMemberDto {
  /** The membership id. */
  id: string;
  workspaceId: string;
  role: WorkspaceRole;
  title: string | null;
  permissions: AssistantPermissions;
  scope: AssistantScope;
  status: WorkspaceMembershipStatus;
  createdAt: string;
  user: { id: string; username: string; fullName: string; email: string; status: UserStatus; accountRole: AccountRole; hasPhoto: boolean };
  /** The person holds more than one live role (here or in other workspaces). */
  dualRole: boolean;
}

// ───────────────────────────────────────────── users

/** A role entry of a user. Outside the caller's workspace the workspace is hidden from non-owners. */
export interface UserRoleEntryDto {
  workspaceId: string | null;
  workspaceName: string | null;
  role: WorkspaceRole;
  title: string | null;
  status: WorkspaceMembershipStatus;
}

export const initialMembershipSchema = z
  .object({ workspaceId: uuid.optional(), ...membershipFields })
  .superRefine(assistantOnly);

/**
 * `POST /users` (A12 round 2): `password` sets the first password directly (with
 * `mustChangePassword`, default true); without it the account gets the one-time set-password
 * e-mail as before. `memberships` (owners: any workspace; admins: theirs) replaces `role`.
 */
export const createUserFieldsSchema = z.object({
  username: usernameSchema.optional(),
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
  role: z.enum(['ADMIN', 'SUPERVISOR', 'MONITOR']).optional(),
  password: password.optional(),
  mustChangePassword: z.boolean().optional(),
  memberships: z.array(initialMembershipSchema).max(20).optional(),
  confirmDualRole: z.boolean().optional(),
});

/** `PATCH /users/:id` — account data (owners: anyone; admins: users who belong only to their workspaces). */
export const updateUserSchema = z
  .object({
    username: usernameSchema.optional(),
    fullName: fullName.optional(),
    email: email.optional(),
    mobile: saudiMobile.optional(),
    nationalId: nationalId.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'لا يوجد ما يُحدَّث' });
export type UpdateUserInput = z.input<typeof updateUserSchema>;

/** `POST /users/:id/username`. */
export const changeUsernameSchema = z.object({ username: usernameSchema });

/** `POST /users/:id/password` — nobody can read a password; this sets a new one and ends the user's sessions. */
export const setUserPasswordSchema = z.object({ password, mustChangePassword: z.boolean().default(true) });

/** `GET /users/all` (owners) — every account of the system. */
export const allUsersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
  accountRole: z.enum(['OWNER', 'USER']).optional(),
});

// ───────────────────────────────────────────── project participants

export const participantLevelSchema = z.enum(PARTICIPANT_LEVELS as [ParticipantLevel, ...ParticipantLevel[]]);

export const addParticipantSchema = z.object({ userId: uuid, title: positionTitle, level: participantLevelSchema });
export const updateParticipantSchema = z
  .object({ title: positionTitle.optional(), level: participantLevelSchema.optional() })
  .refine((v) => v.title !== undefined || v.level !== undefined, { message: 'لا يوجد ما يُحدَّث' });

export interface ParticipantDto {
  projectId: string;
  user: { id: string; username: string; fullName: string; hasPhoto: boolean };
  title: string;
  level: ParticipantLevel;
  addedBy: { id: string; fullName: string } | null;
  createdAt: string;
}

/** `GET /me/participations` — the caller's own project grants. */
export interface MyParticipationDto {
  projectId: string;
  projectName: string;
  title: string;
  level: ParticipantLevel;
}

// ───────────────────────────────────────────── workers' add / remove requests

export const MemberRequestKind = { ADD: 'ADD', REMOVE: 'REMOVE' } as const;
export type MemberRequestKind = (typeof MemberRequestKind)[keyof typeof MemberRequestKind];
export const MemberRequestStatus = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' } as const;
export type MemberRequestStatus = (typeof MemberRequestStatus)[keyof typeof MemberRequestStatus];

/** `POST /members/:id/archive` — admins archive directly; a supervisor's call becomes a REMOVE request. */
export const archiveMemberSchema = z.object({ reason });
export const rejectMemberRequestSchema = z.object({ reason });
export const memberRequestListQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
  teamId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export interface MemberRequestDto {
  id: string;
  kind: MemberRequestKind;
  status: MemberRequestStatus;
  team: { id: string; name: string } | null;
  /** REMOVE: the member; ADD (approved): the member created. */
  member: { id: string; fullName: string } | null;
  /** ADD: what the supervisor entered (the national ID masked). */
  payload: {
    fullName?: string;
    nationalIdMasked?: string;
    jobTitle?: string | null;
    department?: string | null;
  };
  reason: string | null;
  decisionReason: string | null;
  requestedBy: { id: string; fullName: string } | null;
  decidedBy: { id: string; fullName: string } | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Body of a 202 answer: the change waits for an admin's approval. */
export interface MemberRequestAcceptedDto {
  status: 'PENDING_APPROVAL';
  request: MemberRequestDto;
}

// ───────────────────────────────────────────── project cover

/** Images only, at most 3 MB (`POST /files/presign { entityType: 'project_cover', entityId: projectId }`). */
export const PROJECT_COVER_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The 12 colours of the generated default cover; a project's colour is stable (hash of its id),
 * so the same project always gets the same cover.
 */
export const PROJECT_COVER_COLORS = [
  '#5030E5', '#0F9D58', '#D9480F', '#1971C2', '#AE3EC9', '#E8590C',
  '#2B8A3E', '#C2255C', '#1098AD', '#5F3DC4', '#F08C00', '#364FC7',
] as const;

export function projectColor(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return PROJECT_COVER_COLORS[h % PROJECT_COVER_COLORS.length]!;
}

/** Optional reason text reused by owner/workspace actions. */
export const optionalReason = z.object({ reason: optionalText(500) });

/**
 * `POST /users` body (A12 round 2). Either `role` (in the caller's workspace, as before) or
 * `memberships` (owners: any workspace; admins: theirs). Two live roles need `confirmDualRole`.
 */
export const createAccountSchema = createUserFieldsSchema.superRefine((v, ctx) => {
  if (!v.role && !v.memberships?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'اختر صفة المستخدم' });
  }
  if (v.mustChangePassword !== undefined && !v.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'اكتب كلمة المرور الأولى' });
  }
});
export type CreateAccountInput = z.input<typeof createAccountSchema>;
