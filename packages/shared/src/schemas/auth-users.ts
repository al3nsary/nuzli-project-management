import { z } from 'zod';
import { email, fullName, nationalId, optionalText, paginationQuery, password, reason, saudiMobile } from './common';
import type { AccountRole, DisplayRole, Role, UserStatus, WorkspaceRole } from '../enums';
import type { UserRoleEntryDto } from './a12-admin';

export const roleSchema = z.enum(['ADMIN', 'SUPERVISOR', 'MONITOR']);
export const selfRegistrableRole = z.enum(['SUPERVISOR', 'MONITOR']);

export const loginSchema = z.object({
  /** Username, email or Saudi mobile (A12: username added). */
  identifier: z.string().trim().min(3, { message: 'اكتب اسم المستخدم أو البريد أو رقم الجوال' }),
  password: z.string().min(1, { message: 'اكتب كلمة المرور' }),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * A12: a username — lower-case Latin letters, digits, dot, dash or underscore; starts with a
 * letter; 3–32 characters. Case-insensitive: the API stores it in lower case.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._-]{2,31}$/, {
    message: 'اسم المستخدم: ٣–٣٢ حرفًا لاتينيًّا صغيرًا أو رقمًا أو (. _ -) ويبدأ بحرف',
  });

export const registerSchema = z.object({
  accountType: selfRegistrableRole,
  /** A12: the workspace (قسم) applied to; optional while only one workspace exists. */
  workspaceId: z.string().uuid().optional(),
  username: usernameSchema.optional(),
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
  password,
  requestedTeamName: optionalText(80),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20), password });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: 'اكتب كلمة المرور الحالية' }),
  newPassword: password,
});

export const createUserSchema = z.object({
  /** A12: generated from the e-mail when omitted. */
  username: usernameSchema.optional(),
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
  role: roleSchema,
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const approveRegistrationSchema = z.object({ role: selfRegistrableRole.optional() });
export const rejectRegistrationSchema = z.object({ reason });
export const changeRoleSchema = z.object({ role: roleSchema });
/**
 * A12 round 2: 'workspace' (default) suspends the memberships in the caller's workspace;
 * 'global' (owners only) suspends the account everywhere.
 */
export const suspendUserSchema = z.object({ reason: optionalText(500), scope: z.enum(['workspace', 'global']).optional() });

export const updateProfileSchema = z.object({
  fullName: fullName.optional(),
  preferences: z
    .object({
      digits: z.enum(['latn', 'arab']).optional(),
      showHijri: z.boolean().optional(),
      emailNotifications: z.record(z.string(), z.boolean()).optional(),
      theme: z.enum(['light', 'dark', 'auto']).optional(),
    })
    .optional(),
});

export interface UserPreferences {
  digits: 'latn' | 'arab';
  showHijri: boolean;
  emailNotifications: Record<string, boolean>;
  theme: 'light' | 'dark' | 'auto';
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  digits: 'latn',
  showHijri: false,
  emailNotifications: {},
  theme: 'auto',
};

export interface UserDto {
  id: string;
  fullName: string;
  email: string;
  mobile: string;
  /** Always present, masked. */
  nationalIdMasked: string;
  /** Only for admins and flows that need the full value. */
  nationalId?: string;
  /**
   * A12 round 3: the person's role in the caller's ACTIVE workspace, truthfully — `OWNER` for an
   * owner; else ADMIN | SUPERVISOR | MONITOR | ASSISTANT | MEMBER (the strongest, matrix roles first,
   * `DISPLAY_ROLE_ORDER`); a registration shows the role it asked for; null = no role there (an
   * account of another workspace in an owner's list, or a session before a workspace is chosen).
   * Display only — rights come from `workspaceRoles` and `grants`. (Before round 3: ADMIN for owners
   * and a MONITOR fallback for assistants and members.)
   */
  role: DisplayRole | null;
  /** Role requested at registration (for pending requests). */
  requestedRole?: Role | null;
  requestedTeamName?: string | null;
  status: UserStatus;
  rejectionReason?: string | null;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  preferences: UserPreferences;
  /** Owner request A8: profile photo (`GET /users/:id/photo-url`, `GET /me/photo-url`). Always sent by the API. */
  photoFileId?: string | null;
  hasPhoto?: boolean;
  /** A12: login name (case-insensitive, unique). Always sent by the API. */
  username?: string;
  /** A12: OWNER (مالك) or USER. Always sent by the API. */
  accountRole?: AccountRole;
  /** A12: every role the user holds in the caller's active workspace. `role` is the strongest one. */
  workspaceRoles?: WorkspaceRole[];
  /**
   * A12 round 2: true when the person holds more than one live role — two in one workspace, or
   * roles in several workspaces (the UI shows the «صلاحية مزدوجة» badge). Always sent by the API.
   */
  dualRole?: boolean;
  /**
   * A12 round 2: every live role. For a non-owner caller, roles in OTHER workspaces are listed
   * without the workspace (`workspaceId: null`). Always sent by the API. Named `allRoles` (not
   * `roles`) because a UserDto is also passed to `can()`, whose `roles` are role names.
   */
  allRoles?: UserRoleEntryDto[];
  /**
   * A12 round 2 — the caller's OWN session only (`/auth/me`, login, refresh, switch): the
   * permissions an assistant's modules grant in the active workspace, so `can(user, …)` in the web
   * gives the same answers as the API. Project participants: `GET /me/participations`.
   */
  grants?: string[];
}

/** A12: a workspace (قسم) the user can enter. */
export interface WorkspaceSummaryDto {
  id: string;
  name: string;
  code: string;
  /** The caller's roles there (owners: [] — they hold everything). */
  roles: WorkspaceRole[];
}

export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserDto;
  /** A12: the workspaces the user can enter (owners: every active workspace). */
  workspaces?: WorkspaceSummaryDto[];
  /** A12: the workspace the access token is bound to; null until one is chosen. */
  activeWorkspace?: WorkspaceSummaryDto | null;
  /** A12: true while the system has a single active workspace (no picker, no switcher). */
  singleWorkspace?: boolean;
}

/** A12: `POST /auth/switch-workspace`. */
export const switchWorkspaceSchema = z.object({ workspaceId: z.string().uuid() });
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceSchema>;

/** A12: `GET /system/info`. `workspaces` is sent to owners only. */
export interface SystemInfoDto {
  workspaceCount: number;
  singleWorkspace: boolean;
  workspaces?: Array<{ id: string; name: string; code: string }>;
}

/** A12: `GET /public/workspaces` (registration) — names of active workspaces only. */
export interface PublicWorkspaceDto {
  id: string;
  name: string;
}

/** `POST /users/search` — `GET /users` filters in the body (full national IDs stay out of URLs). */
export const userSearchSchema = paginationQuery.extend({
  role: roleSchema.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
});
export type UserSearchInput = z.input<typeof userSearchSchema>;
