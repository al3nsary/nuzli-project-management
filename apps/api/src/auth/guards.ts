import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type ErrorCode, type Permission } from '@nuzli/shared';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error';
import {
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../common/decorators';
import type { AuthRequest, AuthUser } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './access-token.service';
import { CSRF_COOKIE, CSRF_HEADER } from './cookies';

const STATUS_ERRORS: Record<string, ErrorCode> = {
  PENDING: 'ACCOUNT_PENDING',
  REJECTED: 'ACCOUNT_REJECTED',
  SUSPENDED: 'ACCOUNT_SUSPENDED',
};

/** Loads the current user state; role and status always come from the database. */
export interface UserLoader {
  load(id: string): Promise<AuthUser | null>;
}

@Injectable()
export class PrismaUserLoader implements UserLoader {
  constructor(private readonly prisma: PrismaService) {}

  load(id: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, status: true, fullName: true, mustChangePassword: true },
    });
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

    const user = await this.users.load(claims.sub);
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (user.status !== 'ACTIVE') throw new AppError(STATUS_ERRORS[user.status] ?? 'UNAUTHENTICATED');

    if (
      user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)
    ) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED');
    }
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
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (!required.every((p) => can(user, p))) throw new AppError('FORBIDDEN');
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
