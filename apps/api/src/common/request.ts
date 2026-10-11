import type { Request } from 'express';
import type { Role, UserStatus } from '@nuzli/shared';

/** What JwtAuthGuard attaches to the request after loading the user from the database. */
export interface AuthUser {
  id: string;
  role: Role;
  status: UserStatus;
  fullName: string;
  mustChangePassword: boolean;
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
