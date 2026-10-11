import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@nuzli/shared';
import type { AuthRequest, AuthUser, RequestContext } from './request';

export const IS_PUBLIC = 'nuzli:isPublic';
export const REQUIRED_PERMISSIONS = 'nuzli:permissions';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'nuzli:allowMustChangePassword';

/** Opt out of the global JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Every listed permission is required (checked with `can()` from @nuzli/shared). */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Reachable while `mustChangePassword` is true (change-password, me, logout). */
export const AllowWhenPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

/** The authenticated user (set by JwtAuthGuard). */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthRequest>().user as AuthUser,
);

export function requestContextOf(req: AuthRequest): RequestContext {
  const ua = req.headers['user-agent'];
  return {
    actorId: req.user?.id ?? null,
    ip: req.ip ?? null,
    requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
  };
}

/** Actor, IP and request id for audit entries. */
export const ReqCtx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestContext =>
    requestContextOf(ctx.switchToHttp().getRequest<AuthRequest>()),
);
