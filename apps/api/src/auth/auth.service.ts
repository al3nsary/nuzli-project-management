import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  normalizeSaudiMobile,
  type AuthSession,
  type ErrorCode,
  type UserDto,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { CryptoService, randomToken, sha256Hex } from '../crypto/crypto.service';
import { emails } from '../notifications/email-templates';
import { MailService } from '../notifications/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { USER_DTO_SELECT, auditUser, toUserDto, type UserRow } from '../users/user-dto';
import { AccessTokenService } from './access-token.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-tokens';

export const ActionPurpose = { SET_PASSWORD: 'SET_PASSWORD', RESET_PASSWORD: 'RESET_PASSWORD' } as const;
export type ActionPurpose = (typeof ActionPurpose)[keyof typeof ActionPurpose];

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 h
export const SET_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000; // 72 h

const STATUS_ERRORS: Record<string, ErrorCode> = {
  PENDING: 'ACCOUNT_PENDING',
  REJECTED: 'ACCOUNT_REJECTED',
  SUSPENDED: 'ACCOUNT_SUSPENDED',
};

export interface RegisterData {
  accountType: 'SUPERVISOR' | 'MONITOR';
  fullName: string;
  email: string;
  mobile: string;
  nationalId: string;
  password: string;
  requestedTeamName?: string;
}

/** Result of starting or rotating a session: the body plus what the controller puts in cookies. */
export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly crypto: CryptoService,
    private readonly passwords: PasswordService,
    private readonly access: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  // ─────────────────────────────────────────── sessions

  /**
   * The single entry point that starts a session (ADR-010). Password login uses it today;
   * an SSO callback (e.g. Entra ID) will resolve its user and call the same method.
   */
  async issueSession(user: UserRow, ctx: RequestContext, familyId?: string): Promise<IssuedSession> {
    const { token } = await this.refreshTokens.issue(
      user.id,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      familyId,
    );
    return { session: this.sessionBody(user), refreshToken: token };
  }

  private sessionBody(user: UserRow): AuthSession {
    return {
      accessToken: this.access.sign(user),
      expiresIn: this.access.ttlSeconds,
      user: this.dto(user),
    };
  }

  dto(user: UserRow, viewer?: { role: UserRow['role']; status: UserRow['status'] }): UserDto {
    const subject = viewer ?? user;
    return toUserDto(user, { fullNationalId: can(subject, 'nationalIds.readFull'), crypto: this.crypto });
  }

  async login(identifier: string, password: string, ctx: RequestContext): Promise<IssuedSession> {
    const where = identifierToWhere(identifier);
    const user = where
      ? await this.prisma.user.findUnique({
          where,
          select: { ...USER_DTO_SELECT, passwordHash: true, lockedUntil: true, failedLoginCount: true },
        })
      : null;

    if (!user) {
      await this.passwords.verify(null, password);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) throw new AppError('ACCOUNT_LOCKED');

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (updated.failedLoginCount >= this.cfg.LOGIN_MAX_FAILURES) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: new Date(now.getTime() + this.cfg.LOGIN_LOCK_MINUTES * 60_000),
          },
        });
        throw new AppError('ACCOUNT_LOCKED');
      }
      throw new AppError('INVALID_CREDENTIALS');
    }

    // Status is revealed only to someone who knows the password.
    const statusError = STATUS_ERRORS[user.status];
    if (statusError) throw new AppError(statusError);

    const fresh = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      select: USER_DTO_SELECT,
    });
    return this.issueSession(fresh, ctx);
  }

  async refresh(presented: string | undefined, ctx: RequestContext): Promise<IssuedSession> {
    const result = await this.refreshTokens.rotate(presented, {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (!result.ok) {
      if (result.reason === 'reused') {
        await this.audit.log({
          actorId: result.userId,
          action: AuditAction.REFRESH_REUSE_DETECTED,
          entityType: 'user',
          entityId: result.userId,
          after: { familyId: result.familyId },
          ip: ctx.ip,
          requestId: ctx.requestId,
        });
        throw new AppError('REFRESH_REUSED');
      }
      throw new AppError('UNAUTHENTICATED');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
      select: USER_DTO_SELECT,
    });
    const statusError = user ? STATUS_ERRORS[user.status] : 'UNAUTHENTICATED';
    if (!user || statusError) {
      await this.refreshTokens.revokeByToken(result.token);
      throw new AppError(statusError ?? 'UNAUTHENTICATED');
    }
    return { session: this.sessionBody(user), refreshToken: result.token };
  }

  logout(presented: string | undefined): Promise<void> {
    return this.refreshTokens.revokeByToken(presented);
  }

  // ─────────────────────────────────────────── registration

  async register(input: RegisterData, ctx: RequestContext): Promise<{ status: 'PENDING' }> {
    const nid = this.crypto.protectNationalId(input.nationalId);
    const passwordHash = await this.passwords.hash(input.password);
    const user = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            fullName: input.fullName,
            email: input.email,
            mobile: input.mobile,
            nationalIdEnc: nid.enc,
            nationalIdHash: nid.hash,
            nationalIdFirst: nid.first,
            nationalIdLast2: nid.last2,
            passwordHash,
            role: input.accountType,
            requestedRole: input.accountType,
            requestedTeamName: input.requestedTeamName ?? null,
            status: 'PENDING',
          },
          select: USER_DTO_SELECT,
        });
        await this.audit.log(
          {
            actorId: null,
            action: AuditAction.REGISTRATION_REQUESTED,
            entityType: 'user',
            entityId: created.id,
            after: { ...auditUser(created), requestedTeamName: created.requestedTeamName },
            ip: ctx.ip,
            requestId: ctx.requestId,
          },
          tx,
        );
        return created;
      }),
    );
    await this.notifications
      .notifyAdmins('REGISTRATION_REQUESTED', {
        applicantId: user.id,
        fullName: user.fullName,
        requestedRole: user.requestedRole,
      })
      .catch((err) => this.logger.warn(`Admin notification failed: ${(err as Error).message}`));
    return { status: 'PENDING' };
  }

  // ─────────────────────────────────────────── passwords

  /** Creates a one-time token (stored as SHA-256) and returns the raw value for the e-mail link. */
  async createActionToken(
    userId: string,
    purpose: ActionPurpose,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    const now = new Date();
    await db.actionToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: now },
    });
    const token = randomToken(32);
    await db.actionToken.create({
      data: {
        userId,
        purpose,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(
          now.getTime() + (purpose === ActionPurpose.SET_PASSWORD ? SET_PASSWORD_TTL_MS : RESET_TOKEN_TTL_MS),
        ),
      },
    });
    return token;
  }

  passwordLink(token: string, purpose: ActionPurpose): string {
    const web = this.cfg.PUBLIC_WEB_URL.replace(/\/$/, '');
    const page = purpose === ActionPurpose.SET_PASSWORD ? 'set-password' : 'reset-password';
    return `${web}/${page}?token=${encodeURIComponent(token)}`;
  }

  async sendSetPasswordEmail(user: { email: string; fullName: string }, token: string): Promise<void> {
    await this.mail.send({
      to: user.email,
      ...emails.setPassword({
        name: user.fullName,
        url: this.passwordLink(token, ActionPurpose.SET_PASSWORD),
        hours: SET_PASSWORD_TTL_MS / 3_600_000,
      }),
    });
  }

  /**
   * Always answers the same way and at the same speed, whether or not the e-mail exists
   * (no account enumeration): the lookup and the e-mail happen after the response.
   */
  forgotPassword(email: string): void {
    this.sendResetLink(email).catch((err: unknown) =>
      this.logger.warn(`Reset e-mail failed: ${(err as Error).message}`),
    );
  }

  private async sendResetLink(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, fullName: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') return;
    const token = await this.createActionToken(user.id, ActionPurpose.RESET_PASSWORD);
    await this.mail.send({
      to: user.email,
      ...emails.resetPassword({
        name: user.fullName,
        url: this.passwordLink(token, ActionPurpose.RESET_PASSWORD),
        minutes: RESET_TOKEN_TTL_MS / 60_000,
      }),
    });
  }

  /** Consumes a set-password or reset-password token. Ends every existing session. */
  async resetPassword(token: string, password: string, ctx: RequestContext): Promise<void> {
    const now = new Date();
    const found = await this.prisma.actionToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!found || found.usedAt || found.expiresAt <= now) throw new AppError('TOKEN_INVALID');
    const passwordHash = await this.passwords.hash(password);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.actionToken.updateMany({
        where: { id: found.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new AppError('TOKEN_INVALID');
      await tx.actionToken.updateMany({
        where: { userId: found.userId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.user.update({
        where: { id: found.userId },
        data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
      });
      await this.audit.log(
        {
          actorId: found.userId,
          action: AuditAction.PASSWORD_RESET,
          entityType: 'user',
          entityId: found.userId,
          after: { purpose: found.purpose },
          ip: ctx.ip,
          requestId: ctx.requestId,
        },
        tx,
      );
    });
    await this.refreshTokens.revokeAllForUser(found.userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { currentPassword: ['كلمة المرور الحالية غير صحيحة'] },
      });
    }
    if (currentPassword === newPassword) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { newPassword: ['اختر كلمة مرور مختلفة عن الحالية'] },
      });
    }
    const passwordHash = await this.passwords.hash(newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
        select: USER_DTO_SELECT,
      });
      await this.audit.log(
        {
          actorId: userId,
          action: AuditAction.PASSWORD_CHANGED,
          entityType: 'user',
          entityId: userId,
          ip: ctx.ip,
          requestId: ctx.requestId,
        },
        tx,
      );
      return row;
    });
    await this.refreshTokens.revokeAllForUser(userId);
    return this.issueSession(updated, ctx);
  }

  // ─────────────────────────────────────────── profile

  async me(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER_DTO_SELECT });
    if (!user) throw new AppError('UNAUTHENTICATED');
    return this.dto(user);
  }

  async updateProfile(
    userId: string,
    input: { fullName?: string; preferences?: Record<string, unknown> },
  ): Promise<UserDto> {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    if (!current) throw new AppError('UNAUTHENTICATED');
    const prev = (current.preferences ?? {}) as Record<string, unknown>;
    const next = input.preferences
      ? {
          ...prev,
          ...Object.fromEntries(Object.entries(input.preferences).filter(([, v]) => v !== undefined)),
          emailNotifications: {
            ...((prev.emailNotifications as Record<string, boolean> | undefined) ?? {}),
            ...((input.preferences.emailNotifications as Record<string, boolean> | undefined) ?? {}),
          },
        }
      : prev;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.fullName ? { fullName: input.fullName } : {}),
        preferences: next as Prisma.InputJsonValue,
      },
      select: USER_DTO_SELECT,
    });
    return this.dto(user);
  }
}

/** Email (contains @) or Saudi mobile in any accepted format (normalised to E.164). */
export function identifierToWhere(identifier: string): Prisma.UserWhereUniqueInput | null {
  const value = identifier.trim();
  if (value.includes('@')) return { email: value.toLowerCase() };
  const mobile = normalizeSaudiMobile(value);
  return mobile ? { mobile } : null;
}
