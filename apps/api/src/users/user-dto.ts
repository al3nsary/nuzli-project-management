import type { Prisma } from '@prisma/client';
import { effectiveRole, maskNationalIdParts, type Role, type UserDto, type UserStatus, type WorkspaceRole } from '@nuzli/shared';
import type { CryptoService } from '../crypto/crypto.service';
import { preferencesOf } from '../notifications/notifications.service';
import { activeWorkspaceIdOrNull } from '../prisma/workspace-context';

/** Columns needed to build a UserDto (never the password hash). */
export const USER_DTO_SELECT = {
  id: true,
  username: true,
  accountRole: true,
  fullName: true,
  email: true,
  mobile: true,
  nationalIdEnc: true,
  nationalIdFirst: true,
  nationalIdLast2: true,
  requestedRole: true,
  requestedTeamName: true,
  requestedWorkspaceId: true,
  status: true,
  rejectionReason: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  preferences: true,
  photoFileId: true,
  /** A12: live memberships in every workspace; the DTO shows those of the active one only. */
  memberships: { where: { archivedAt: null }, select: { workspaceId: true, role: true, status: true } },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof USER_DTO_SELECT }>;

/** A12: the user's live roles in `workspaceId` (suspended memberships excluded). */
export function rolesIn(u: Pick<UserRow, 'memberships'>, workspaceId: string | null): WorkspaceRole[] {
  if (!workspaceId) return [];
  return u.memberships.filter((m) => m.workspaceId === workspaceId && m.status === 'ACTIVE').map((m) => m.role);
}

/**
 * A12: the `role` shown for a user in a workspace — the strongest live role there; owners show
 * ADMIN; a registration shows the role it asked for. Falls back to MONITOR (least privilege)
 * for a user with no role there (the field is display-only; rights come from the guard).
 */
export function displayRole(u: Pick<UserRow, 'memberships' | 'accountRole' | 'requestedRole'>, workspaceId: string | null): Role {
  if (u.accountRole === 'OWNER') return 'ADMIN';
  return effectiveRole(rolesIn(u, workspaceId)) ?? u.requestedRole ?? 'MONITOR';
}

/** A12: SUSPENDED when the membership in this workspace is suspended, else the account status. */
export function displayStatus(u: Pick<UserRow, 'memberships' | 'status'>, workspaceId: string | null): UserStatus {
  if (u.status === 'ACTIVE' && workspaceId) {
    const here = u.memberships.filter((m) => m.workspaceId === workspaceId);
    if (here.length && here.every((m) => m.status === 'SUSPENDED')) return 'SUSPENDED';
  }
  return u.status;
}

/**
 * Builds the wire shape. The national ID is always masked; the full value is added only
 * when the caller holds `nationalIds.readFull` (admins) — decided by the caller.
 * A12: role/status/workspaceRoles are those of `workspaceId` (default: the active workspace).
 */
export function toUserDto(
  u: UserRow,
  opts: { fullNationalId?: boolean; crypto?: CryptoService; workspaceId?: string | null } = {},
): UserDto {
  const ws = opts.workspaceId !== undefined ? opts.workspaceId : activeWorkspaceIdOrNull();
  const dto: UserDto = {
    id: u.id,
    username: u.username,
    accountRole: u.accountRole,
    fullName: u.fullName,
    email: u.email,
    mobile: u.mobile,
    nationalIdMasked: maskNationalIdParts(u.nationalIdFirst, u.nationalIdLast2),
    role: displayRole(u, ws),
    workspaceRoles: rolesIn(u, ws),
    requestedRole: u.requestedRole,
    requestedTeamName: u.requestedTeamName,
    status: displayStatus(u, ws),
    rejectionReason: u.rejectionReason,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    preferences: preferencesOf(u.preferences),
    photoFileId: u.photoFileId,
    hasPhoto: !!u.photoFileId,
  };
  if (opts.fullNationalId && opts.crypto) {
    dto.nationalId = opts.crypto.decrypt(u.nationalIdEnc);
  }
  return dto;
}

/** Audit snapshot of a user: no secrets, masked national ID only. */
export function auditUser(
  u: Pick<UserRow, 'id' | 'status' | 'email' | 'fullName'> & Partial<UserRow> & { role?: string | null },
) {
  const ws = activeWorkspaceIdOrNull();
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    ...(u.username ? { username: u.username } : {}),
    role: u.role ?? (u.memberships ? displayRole(u as UserRow, ws) : null),
    status: u.status,
    ...(u.nationalIdFirst && u.nationalIdLast2
      ? { nationalIdMasked: maskNationalIdParts(u.nationalIdFirst, u.nationalIdLast2) }
      : {}),
    ...(u.rejectionReason !== undefined ? { rejectionReason: u.rejectionReason } : {}),
  };
}

/** A12: a username from an e-mail local part (the same rule as the migration); not de-duplicated. */
export function usernameBase(email: string): string {
  let base = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!/^[a-z]/.test(base)) base = `u${base}`;
  base = base.slice(0, 28);
  if (base.length < 3) base = base.padEnd(3, '0');
  return base;
}

/** A12: the columns `displayRole` needs, for any query that shows a user's role. */
export const ROLE_VIEW_SELECT = {
  accountRole: true,
  requestedRole: true,
  memberships: { where: { archivedAt: null }, select: { workspaceId: true, role: true, status: true } },
} satisfies Prisma.UserSelect;

/** A12: a user is "in" a workspace when a live membership ties them to it. */
export function memberOf(workspaceId: string): Prisma.UserWhereInput {
  return { memberships: { some: { workspaceId, archivedAt: null } } };
}

/** A12: ACTIVE supervisors of a workspace (tasks, team leaders, imports). */
export function supervisorsOf(workspaceId: string): Prisma.UserWhereInput {
  return { status: 'ACTIVE', memberships: { some: { workspaceId, role: 'SUPERVISOR', status: 'ACTIVE', archivedAt: null } } };
}

/** A12: who receives a workspace's admin notifications — its active admins and every owner. */
export function adminsOf(workspaceId: string): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    OR: [
      { memberships: { some: { workspaceId, role: 'ADMIN', status: 'ACTIVE', archivedAt: null } } },
      { accountRole: 'OWNER' },
    ],
  };
}

/**
 * A12: the users of a workspace — accounts with a live membership there, plus the registrations
 * addressed to it. User identity is global (one row per person), but every user read, role change,
 * suspension and approval is limited to the caller's workspace (ADR-144).
 */
export function workspaceUsersWhere(workspaceId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { memberships: { some: { workspaceId, archivedAt: null } } },
      { requestedWorkspaceId: workspaceId, status: { in: ['PENDING', 'REJECTED'] } },
    ],
  };
}
