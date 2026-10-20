import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assistantGrants, assistantScopeOf, can, type ErrorCode, type Permission } from '@nuzli/shared';
import { unboundGrants } from '../access/access-context';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error';
import {
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_PUBLIC,
  ANY_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  WORKSPACE_OPTIONAL,
} from '../common/decorators';
import type { AuthRequest, AuthUser } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { workspaceStorage } from '../prisma/workspace-context';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AccessTokenService } from './access-token.service';
import { CSRF_COOKIE, CSRF_HEADER } from './cookies';

const STATUS_ERRORS: Record<string, ErrorCode> = {
  PENDING: 'ACCOUNT_PENDING',
  REJECTED: 'ACCOUNT_REJECTED',
  SUSPENDED: 'ACCOUNT_SUSPENDED',
};

/**
 * Loads the current user state; status, account role and workspace roles always come from the
 * database. A12: `workspaceId` is the token's `wid`; it is checked against the live memberships
 * (WORKSPACE_FORBIDDEN / WORKSPACE_ARCHIVED) before the request may use it.
 */
export interface UserLoader {
  load(id: string, workspaceId: string | null): Promise<AuthUser | null>;
  /**
   * A12 round 2: completes the user once the request runs inside its workspace — assistant
   * grants and scope, project participations, supervisor team peers (AccessExtras).
   */
  enrich?(user: AuthUser): Promise<void>;
}

@Injectable()
export class PrismaUserLoader implements UserLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
  ) {}

  /** The assistant membership seen by `load`, kept for `enrich` (same request). */
  private readonly assistants = new WeakMap<AuthUser, { permissions: unknown; scope: unknown }>();

  async load(id: string, workspaceId: string | null): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, status: true, fullName: true, mustChangePassword: true, accountRole: true },
    });
    if (!user) return null;
    if (user.status !== 'ACTIVE') return { ...user, role: null, roles: [], workspaceId: null };
    // A token without a workspace (issued before A12, or before the user chose one): bound to the
    // user's ONLY workspace when there is exactly one — never a guess between several.
    const target = workspaceId ?? (await this.access.pick(user.id, user.accountRole, null)).active?.id ?? null;
    if (!target) return { ...user, role: null, roles: [], workspaceId: null };
    const access = await this.access.resolve(user.id, user.accountRole, target);
    const out: AuthUser = { ...user, role: access.role, roles: access.roles, workspaceId: access.workspace.id };
    if (access.assistant) this.assistants.set(out, access.assistant);
    return out;
  }

  /**
   * Runs inside the request's workspace context (the participations and team tables are
   * workspace-scoped). Admins and owners hold the whole workspace: no limit, no extra grant.
   */
  async enrich(user: AuthUser): Promise<void> {
    if (!user.workspaceId) return;
    const full = user.accountRole === 'OWNER' || user.roles.includes('ADMIN');
    const assistant = this.assistants.get(user) ?? null;
    user.baseGrants = full ? [] : assistantGrants(assistant?.permissions);
    user.limits = !full && assistant ? assistantScopeOf(assistant.scope) : null;
    if (!full) {
      const rows = await this.prisma.projectParticipant.findMany({
        where: { userId: user.id, project: { archivedAt: null, isTemplate: false } },
        select: { projectId: true, level: true },
      });
      user.participations = Object.fromEntries(rows.map((r) => [r.projectId, r.level]));
    }
    if (user.roles.includes('SUPERVISOR')) {
      // Owner rule (A12): a supervisor shares the tasks of every supervisor of the same team(s).
      const peers = await this.prisma.teamSupervisor.findMany({
        where: { validTo: null, team: { status: { not: 'ARCHIVED' }, supervisors: { some: { userId: user.id, validTo: null } } } },
        select: { userId: true },
      });
      user.teamPeerIds = [...new Set([user.id, ...peers.map((p) => p.userId)])];
    }
    user.grants = unboundGrants(user);
  }
}

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 * The user is reloaded on each request, so a suspension or a role change applies at once.
 * While `mustChangePassword` is true only routes marked @AllowWhenPasswordChangeRequired() pass.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly users: PrismaUserLoader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const claims = match?.[1] ? this.tokens.verify(match[1]) : null;
    if (!claims) throw new AppError('UNAUTHENTICATED');

    const user = await this.users.load(claims.sub, claims.wid);
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (user.status !== 'ACTIVE') throw new AppError(STATUS_ERRORS[user.status] ?? 'UNAUTHENTICATED');

    if (
      user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)
    ) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED');
    }
    // A12 (ADR-143): every authenticated route runs inside the token's workspace; only the
    // session/account routes marked @WorkspaceOptional() may run without one (fail closed).
    if (!user.workspaceId && !this.reflector.getAllAndOverride<boolean>(WORKSPACE_OPTIONAL, targets)) {
      throw new AppError('WORKSPACE_REQUIRED');
    }
    const store = workspaceStorage.getStore();
    if (!store) throw new Error('workspace context middleware is not installed');
    store.workspaceId = user.workspaceId;
    store.userId = user.id;
    store.accountRole = user.accountRole;
    store.bypass = false;
    if (user.workspaceId) await this.users.enrich?.(user);
    req.user = user;
    return true;
  }
}

/** Global guard: `@RequirePermission(...)` → `can()` from the shared matrix (ADR-006). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndMerge<Permission[]>(REQUIRED_PERMISSIONS, targets);
    const any = this.reflector.getAllAndOverride<Permission[] | undefined>(ANY_PERMISSIONS, targets);
    if (!required?.length && !any?.length) return true;
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (required?.length && !required.every((p) => can(user, p))) throw new AppError('FORBIDDEN');
    if (any?.length && !any.some((p) => can(user, p))) throw new AppError('FORBIDDEN');
    return true;
  }
}

/** Double-submit CSRF check for the cookie-authenticated endpoints (refresh, logout). */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    if (!cookie || typeof header !== 'string') throw new AppError('CSRF_INVALID');
    const a = Buffer.from(cookie);
    const b = Buffer.from(header);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('CSRF_INVALID');
    return true;
  }
}
