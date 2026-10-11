import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AllowWhenPasswordChangeRequired,
  Public,
  RequireAnyPermission,
  RequirePermission,
} from '../common/decorators';
import type { AuthUser } from '../common/request';
import { AccessTokenService } from './access-token.service';
import { CsrfGuard, JwtAuthGuard, PermissionsGuard, type UserLoader } from './guards';

@Controller()
class Fixture {
  @Get() @RequirePermission('users.manageRoles') manageRoles() {}
  @Get() @RequirePermission('notifications.read', 'violations.create') monitorOnly() {}
  @Get() open() {}
  @Get() @RequireAnyPermission('teams.readAll', 'teams.readOwn') teams() {}
  @Public() @Get() publicRoute() {}
  @AllowWhenPasswordChangeRequired() @Get() me() {}
}

@RequirePermission('audit.read')
@Controller()
class ClassLevel {
  @Get() list() {}
}

function ctx(handler: keyof Fixture | 'list', req: Record<string, unknown>, cls: object = Fixture): ExecutionContext {
  const proto = (cls as { prototype: Record<string, unknown> }).prototype;
  return {
    getHandler: () => proto[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const user = (role: AuthUser['role'], extra: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u1',
  role,
  status: 'ACTIVE',
  fullName: 'x',
  mustChangePassword: false,
  ...extra,
});

describe('PermissionsGuard (ADR-006)', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('passes routes without @RequirePermission', () => {
    expect(guard.canActivate(ctx('open', { user: user('MONITOR') }))).toBe(true);
  });

  it('allows a role that holds the permission in the shared matrix', () => {
    expect(guard.canActivate(ctx('manageRoles', { user: user('ADMIN') }))).toBe(true);
  });

  it('forbids a role without it', () => {
    expect(() => guard.canActivate(ctx('manageRoles', { user: user('SUPERVISOR') }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('requires every listed permission', () => {
    expect(guard.canActivate(ctx('monitorOnly', { user: user('MONITOR') }))).toBe(true);
    expect(() => guard.canActivate(ctx('monitorOnly', { user: user('SUPERVISOR') }))).toThrow();
  });

  it('reads class-level permissions', () => {
    expect(() => guard.canActivate(ctx('list', { user: user('MONITOR') }, ClassLevel))).toThrow();
    expect(guard.canActivate(ctx('list', { user: user('ADMIN') }, ClassLevel))).toBe(true);
  });

  it('@RequireAnyPermission passes with any one listed permission (data scope is in the service)', () => {
    expect(guard.canActivate(ctx('teams', { user: user('ADMIN') }))).toBe(true);
    expect(guard.canActivate(ctx('teams', { user: user('SUPERVISOR') }))).toBe(true);
    expect(() => guard.canActivate(ctx('teams', { user: user('MONITOR') }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('non-active users hold no permission', () => {
    expect(() =>
      guard.canActivate(ctx('manageRoles', { user: user('ADMIN', { status: 'SUSPENDED' }) })),
    ).toThrow();
  });
});

describe('JwtAuthGuard', () => {
  const tokens = new AccessTokenService({
    JWT_ACCESS_SECRET: 'x'.repeat(40),
    JWT_ACCESS_TTL_SECONDS: 900,
  } as never);
  const loaderFor = (u: AuthUser | null): UserLoader => ({ load: jest.fn().mockResolvedValue(u) });
  const guardFor = (u: AuthUser | null) => new JwtAuthGuard(new Reflector(), tokens, loaderFor(u) as never);
  const bearer = (u: AuthUser) => ({ headers: { authorization: `Bearer ${tokens.sign(u)}` } });

  it('lets @Public() routes through without a token', async () => {
    await expect(guardFor(null).canActivate(ctx('publicRoute', { headers: {} }))).resolves.toBe(true);
  });

  it('rejects a missing or forged token', async () => {
    await expect(guardFor(user('ADMIN')).canActivate(ctx('open', { headers: {} }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const forged = new AccessTokenService({ JWT_ACCESS_SECRET: 'y'.repeat(40), JWT_ACCESS_TTL_SECONDS: 900 } as never);
    const req = { headers: { authorization: `Bearer ${forged.sign(user('ADMIN'))}` } };
    await expect(guardFor(user('ADMIN')).canActivate(ctx('open', req))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('attaches the user reloaded from the database', async () => {
    const req: Record<string, unknown> = bearer(user('MONITOR'));
    await expect(guardFor(user('MONITOR')).canActivate(ctx('open', req))).resolves.toBe(true);
    expect((req.user as AuthUser).role).toBe('MONITOR');
  });

  it('refuses a suspended user even with a valid token', async () => {
    const u = user('ADMIN', { status: 'SUSPENDED' });
    await expect(guardFor(u).canActivate(ctx('open', bearer(u)))).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it('while mustChangePassword is true, only allowed routes pass', async () => {
    const u = user('ADMIN', { mustChangePassword: true });
    await expect(guardFor(u).canActivate(ctx('open', bearer(u)))).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    await expect(guardFor(u).canActivate(ctx('me', bearer(u)))).resolves.toBe(true);
  });
});

describe('CsrfGuard (double submit)', () => {
  const guard = new CsrfGuard();
  const req = (cookie?: string, header?: string) => ({
    cookies: cookie ? { nz_csrf: cookie } : {},
    headers: header ? { 'x-csrf-token': header } : {},
  });

  it('passes when header equals cookie', () => {
    expect(guard.canActivate(ctx('open', req('abc123', 'abc123')))).toBe(true);
  });

  it('fails when missing or different', () => {
    expect(() => guard.canActivate(ctx('open', req('abc123')))).toThrow(expect.objectContaining({ code: 'CSRF_INVALID' }));
    expect(() => guard.canActivate(ctx('open', req(undefined, 'abc123')))).toThrow();
    expect(() => guard.canActivate(ctx('open', req('abc123', 'abc124')))).toThrow();
  });
});
