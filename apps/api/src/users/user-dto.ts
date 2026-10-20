import type { Prisma } from '@prisma/client';
import { assistantGrants, displayRoleOf, effectiveRole, maskNationalIdParts, type DisplayRole, type Role, type UserDto, type UserRoleEntryDto, type UserStatus, type WorkspaceRole } from '@nuzli/shared';
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
  memberships: {
    where: { archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true, role: true, status: true, title: true, permissions: true, workspace: { select: { name: true } } },
  },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof USER_DTO_SELECT }>;

/** The membership columns the role helpers read. */
export interface MembershipCore {
  workspaceId: string;
  role: WorkspaceRole;
  status: 'ACTIVE' | 'SUSPENDED';
}

/** A12: the user's live roles in `workspaceId` (suspended memberships excluded). */
export function rolesIn(u: { memberships: ReadonlyArray<MembershipCore> }, workspaceId: string | null): WorkspaceRole[] {
  if (!workspaceId) return [];
  return u.memberships.filter((m) => m.workspaceId === workspaceId && m.status === 'ACTIVE').map((m) => m.role);
}

/**
 * A12 round 3: the role SHOWN for a user in a workspace — truthful, never a fallback: OWNER for an
 * owner; else the strongest role held there (matrix roles first, then ASSISTANT, then MEMBER —
 * `DISPLAY_ROLE_ORDER`), the suspended memberships counting when nothing is active (the status
 * says SUSPENDED); a registration shows the role it asked for; null = no role there.
 * Display only: rights come from the guard (`matrixRole`, `rolesIn`, grants).
 */
export function displayRole(u: Pick<UserRow, 'accountRole' | 'requestedRole'> & { memberships: ReadonlyArray<MembershipCore> }, workspaceId: string | null): DisplayRole | null {
  if (u.accountRole === 'OWNER') return 'OWNER';
  const here = workspaceId ? u.memberships.filter((m) => m.workspaceId === workspaceId) : [];
  const active = here.filter((m) => m.status === 'ACTIVE').map((m) => m.role);
  return displayRoleOf({ roles: active.length ? active : here.map((m) => m.role) }) ?? u.requestedRole ?? null;
}

/**
 * A12: the MATRIX role of a user in a workspace (last-admin protection, the permission subject,
 * notifications): owners act as ADMIN; else the strongest live matrix role; a registration the
 * role it asked for; null for an assistant or a member (their rights are grants).
 */
export function matrixRole(u: Pick<UserRow, 'accountRole' | 'requestedRole'> & { memberships: ReadonlyArray<MembershipCore> }, workspaceId: string | null): Role | null {
  if (u.accountRole === 'OWNER') return 'ADMIN';
  return effectiveRole(rolesIn(u, workspaceId)) ?? u.requestedRole ?? null;
}

/** A12: SUSPENDED when the membership in this workspace is suspended, else the account status. */
export function displayStatus(u: Pick<UserRow, 'status'> & { memberships: ReadonlyArray<MembershipCore> }, workspaceId: string | null): UserStatus {
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
  opts: { fullNationalId?: boolean; crypto?: CryptoService; workspaceId?: string | null; viewerIsOwner?: boolean; self?: boolean } = {},
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
    // A12 round 2: the «صلاحية مزدوجة» badge and every live role (other workspaces hidden from non-owners).
    dualRole: isDualRole(u),
    allRoles: roleEntries(u, ws, !!opts.viewerIsOwner),
  };
  if (opts.self) {
    // The assistant's modules in the active workspace (an ADMIN or an owner holds everything anyway).
    const assistant = u.memberships.find((m) => m.workspaceId === ws && m.role === 'ASSISTANT' && m.status === 'ACTIVE');
    dto.grants = assistant ? assistantGrants(assistant.permissions) : [];
  }
  if (opts.fullNationalId && opts.crypto) {
    dto.nationalId = opts.crypto.decrypt(u.nationalIdEnc);
  }
  return dto;
}

type MembershipView = { workspaceId: string; role: WorkspaceRole; status: 'ACTIVE' | 'SUSPENDED'; title?: string | null; workspace?: { name: string } | null };

/** A12 round 2: more than one live role — two in one workspace, or roles in several workspaces. */
export function isDualRole(u: { memberships: ReadonlyArray<Pick<MembershipView, 'workspaceId' | 'role'>> }): boolean {
  return u.memberships.length > 1;
}

/** A12 round 2: the roles list of a UserDto. Non-owner callers never learn other workspaces' names or ids. */
export function roleEntries(u: { memberships: ReadonlyArray<MembershipView> }, workspaceId: string | null, viewerIsOwner: boolean): UserRoleEntryDto[] {
  return u.memberships.map((m) => {
    const visible = viewerIsOwner || m.workspaceId === workspaceId;
    return {
      workspaceId: visible ? m.workspaceId : null,
      workspaceName: visible ? (m.workspace?.name ?? null) : null,
      role: m.role,
      title: visible ? (m.title ?? null) : null,
      status: m.status,
    };
  });
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
 * A12 round 2: who decides a workspace's requests (registrations, workers' add/remove): its active
 * admins, every owner, and its assistants given registrations:edit.
 */
export function approversOf(workspaceId: string): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    OR: [
      { memberships: { some: { workspaceId, role: 'ADMIN', status: 'ACTIVE', archivedAt: null } } },
      { accountRole: 'OWNER' },
      {
        memberships: {
          some: { workspaceId, role: 'ASSISTANT', status: 'ACTIVE', archivedAt: null, permissions: { path: ['registrations'], equals: 'edit' } },
        },
      },
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
