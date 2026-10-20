import type { Request } from 'express';
import type { AccountRole, Role, UserStatus, WorkspaceRole } from '@nuzli/shared';

/** What JwtAuthGuard attaches to the request after loading the user from the database. */
export interface AuthUser {
  id: string;
  /**
   * A12: the matrix role in the ACTIVE workspace (strongest of `roles`; ADMIN for owners);
   * null when no workspace is selected or the roles carry no permission yet.
   */
  role: Role | null;
  status: UserStatus;
  fullName: string;
  mustChangePassword: boolean;
  /** A12: OWNER or USER (account layer). */
  accountRole: AccountRole;
  /** A12: the workspace bound to the access token, checked against the memberships. */
  workspaceId: string | null;
  /** A12: every live role in the active workspace. */
  roles: WorkspaceRole[];
}

export type AuthRequest = Request & { user?: AuthUser; id?: unknown };

/** Who did what from where — passed to services for audit entries. */
export interface RequestContext {
  actorId: string | null;
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
}

export const SYSTEM_CONTEXT: RequestContext = {
  actorId: null,
  ip: null,
  requestId: null,
  userAgent: null,
};
