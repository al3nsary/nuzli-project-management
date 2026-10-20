import { Controller, Get, HttpCode, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  switchWorkspaceSchema,
  updateProfileSchema,
  type WorkspaceSummaryDto,
  type AuthSession,
  type UserDto,
} from '@nuzli/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  AllowWhenPasswordChangeRequired,
  CurrentUser,
  Public,
  ReqCtx,
  RequirePermission,
  WorkspaceOptional,
} from '../common/decorators';
import type { AuthRequest, AuthUser, RequestContext } from '../common/request';
import { ZodBody } from '../common/zod-openapi';
import { AppConfig } from '../config/app-config';
import { AuthService, type IssuedSession } from './auth.service';
import { clearSessionCookies, REFRESH_COOKIE, setSessionCookies } from './cookies';
import { CsrfGuard } from './guards';
import { RefreshTokenService } from './refresh-tokens';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

/** Auth endpoints get a tighter per-IP limit (brief §13). Read lazily so tests can relax it. */
const authLimit = () => Number(process.env.THROTTLE_AUTH_LIMIT ?? 10);
const AuthThrottle = () => Throttle({ default: { limit: authLimit, ttl: 60_000 } });

function refreshCookie(req: AuthRequest): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfig,
    private readonly refreshTokens: RefreshTokenService,
    private readonly workspaces: WorkspaceAccessService,
  ) {}

  private respond(res: Response, issued: IssuedSession): AuthSession {
    setSessionCookies(res, issued.refreshToken, {
      secure: this.cfg.COOKIE_SECURE,
      maxAgeMs: this.refreshTokens.ttlMs,
    });
    res.setHeader('Cache-Control', 'no-store');
    return issued.session;
  }

  @Public()
  @AuthThrottle()
  @Post('register')
  @ApiOperation({ summary: 'طلب تسجيل (مشرف أو مشرف مراقبة) — بانتظار الاعتماد' })
  register(@ZodBody(registerSchema) body: z.output<typeof registerSchema>, @ReqCtx() ctx: RequestContext) {
    return this.auth.register(body, ctx);
  }

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'تسجيل الدخول بالبريد أو الجوال' })
  async login(
    @ZodBody(loginSchema) body: z.output<typeof loginSchema>,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(res, await this.auth.login(body.identifier, body.password, ctx));
  }

  @Public()
  @AuthThrottle()
  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'تجديد الجلسة (كعكة nz_rt + ترويسة X-CSRF-Token)' })
  async refresh(
    @Req() req: AuthRequest,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    try {
      return this.respond(res, await this.auth.refresh(refreshCookie(req), ctx));
    } catch (err) {
      clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
      throw err;
    }
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'تسجيل الخروج وإنهاء سلسلة الجلسة' })
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(refreshCookie(req));
    clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
  }

  @Public()
  @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'إرسال رابط إعادة تعيين كلمة المرور' })
  forgotPassword(@ZodBody(forgotPasswordSchema) body: z.output<typeof forgotPasswordSchema>): void {
    this.auth.forgotPassword(body.email);
  }

  @Public()
  @AuthThrottle()
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'تعيين كلمة مرور برابط لمرة واحدة (إعادة التعيين أو الإنشاء)' })
  async resetPassword(
    @ZodBody(resetPasswordSchema) body: z.output<typeof resetPasswordSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, ctx);
  }

  @AllowWhenPasswordChangeRequired()
  @WorkspaceOptional()
  @AuthThrottle()
  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'تغيير كلمة المرور' })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @ZodBody(changePasswordSchema) body: z.output<typeof changePasswordSchema>,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(
      res,
      await this.auth.changePassword(user.id, body.currentPassword, body.newPassword, ctx),
    );
  }

  @AllowWhenPasswordChangeRequired()
  @WorkspaceOptional()
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'المستخدم الحالي' })
  me(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return this.auth.me(user.id);
  }

  /** A12: the workspaces the caller can enter (owners: every active workspace). */
  @WorkspaceOptional()
  @Get('workspaces')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'الأقسام التي يمكنني الدخول إليها' })
  workspacesList(@CurrentUser() user: AuthUser): Promise<WorkspaceSummaryDto[]> {
    return this.workspaces.accessible(user.id, user.accountRole);
  }

  /**
   * A12: re-issues the session (access token + refresh cookie) bound to another workspace after
   * the membership check; the previous refresh family is revoked. Audited in the target workspace.
   */
  @WorkspaceOptional()
  @AuthThrottle()
  @Post('switch-workspace')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'التبديل إلى قسم آخر (جلسة جديدة لذلك القسم)' })
  async switchWorkspace(
    @CurrentUser() user: AuthUser,
    @ZodBody(switchWorkspaceSchema) body: z.output<typeof switchWorkspaceSchema>,
    @Req() req: AuthRequest,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(
      res,
      await this.auth.switchWorkspace(user.id, body.workspaceId, refreshCookie(req), ctx, user.workspaceId),
    );
  }
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Patch()
  @WorkspaceOptional()
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'تعديل ملفي الشخصي وتفضيلاتي' })
  update(
    @CurrentUser() user: AuthUser,
    @ZodBody(updateProfileSchema) body: z.output<typeof updateProfileSchema>,
  ): Promise<UserDto> {
    return this.auth.updateProfile(user.id, body);
  }
}
