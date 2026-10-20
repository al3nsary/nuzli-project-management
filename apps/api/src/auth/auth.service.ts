import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  normalizeSaudiMobile,
  type AuthSession,
  type ErrorCode,
  type PermissionSubject,
  type UserDto,
  type WorkspaceSummaryDto,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { mapPrismaError, withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { CryptoService, randomToken, sha256Hex, type ProtectedNationalId } from '../crypto/crypto.service';
import { emails } from '../notifications/email-templates';
import { MailService } from '../notifications/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceIdOrNull, runInWorkspace } from '../prisma/workspace-context';
import { USER_DTO_SELECT, auditUser, displayRole, rolesIn, toUserDto, type UserRow } from '../users/user-dto';
import { allocateUsername } from '../users/usernames';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AccessTokenService } from './access-token.service';
import { LoginThrottleService } from './login-throttle';
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

const DUPLICATE_CODES = new Set<ErrorCode>(['EMAIL_TAKEN', 'MOBILE_TAKEN', 'NATIONAL_ID_TAKEN']);

export interface RegisterData {
  accountType: 'SUPERVISOR' | 'MONITOR';
  /** A12: the workspace applied to (optional while only one exists). */
  workspaceId?: string;
  username?: string;
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
    private readonly throttle: LoginThrottleService,
    private readonly workspaces: WorkspaceAccessService,
  ) {}

  // ─────────────────────────────────────────── sessions

  /**
   * The single entry point that starts a session (ADR-010). Password login uses it today;
   * an SSO callback (e.g. Entra ID) will resolve its user and call the same method.
   */
  async issueSession(
    user: UserRow,
    ctx: RequestContext,
    familyId?: string,
    preferredWorkspaceId: string | null = null,
  ): Promise<IssuedSession> {
    // A12: bind the session to the preferred workspace when allowed, else the only one, else none.
    const { list, active } = await this.workspaces.pick(user.id, user.accountRole, preferredWorkspaceId);
    const { token } = await this.refreshTokens.issue(
      user.id,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      familyId,
      active?.id ?? null,
    );
    return { session: await this.sessionBody(user, list, active), refreshToken: token };
  }

  private async sessionBody(user: UserRow, list: WorkspaceSummaryDto[], active: WorkspaceSummaryDto | null): Promise<AuthSession> {
    return {
      accessToken: this.access.sign(user, active?.id ?? null),
      expiresIn: this.access.ttlSeconds,
      user: this.dto(user, undefined, active?.id ?? null),
      workspaces: list,
      activeWorkspace: active,
      singleWorkspace: await this.workspaces.singleWorkspace(),
    };
  }

  /** A12: the permission subject of `user` inside `workspaceId`. */
  subjectIn(user: UserRow, workspaceId: string | null): PermissionSubject {
    return {
      role: workspaceId ? displayRole(user, workspaceId) : null,
      roles: rolesIn(user, workspaceId),
      accountRole: user.accountRole,
      status: user.status,
    };
  }

  dto(user: UserRow, viewer?: PermissionSubject, workspaceId?: string | null): UserDto {
    const ws = workspaceId !== undefined ? workspaceId : activeWorkspaceIdOrNull();
    const subject = viewer ?? this.subjectIn(user, ws);
    return toUserDto(user, { fullNationalId: can(subject, 'nationalIds.readFull'), crypto: this.crypto, workspaceId: ws });
  }

  /**
   * Security review M5 (ADR-062): progressive per-IP / per-identifier delays (429 while cooling
   * down), then a short account lock. Unknown accounts, wrong passwords and locked accounts all
   * answer INVALID_CREDENTIALS, so neither the lock nor the existence of an account leaks.
   * A successful password reset lifts the lock.
   */
  async login(identifier: string, password: string, ctx: RequestContext): Promise<IssuedSession> {
    const where = identifierToWhere(identifier);
    // One bucket per account whatever the spelling (0551… / +966551…, upper/lower case e-mail).
    const tkey = where ? String(where.email ?? where.mobile ?? where.username) : identifier.trim().toLowerCase();
    this.throttle.assertAllowed(tkey, ctx.ip);
    const user = where
      ? await this.prisma.user.findUnique({
          where,
          select: { ...USER_DTO_SELECT, passwordHash: true, lockedUntil: true, failedLoginCount: true },
        })
      : null;

    if (!user) {
      await this.passwords.verify(null, password);
      this.throttle.recordFailure(tkey, ctx.ip);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const now = new Date();
    // The hash is always checked, so a locked account answers at the same speed as any other.
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (user.lockedUntil && user.lockedUntil > now) {
      this.throttle.recordFailure(tkey, ctx.ip);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (!ok) {
      this.throttle.recordFailure(tkey, ctx.ip);
      await this.registerFailure(user, now, ctx);
      throw new AppError('INVALID_CREDENTIALS');
    }
    this.throttle.recordSuccess(tkey, ctx.ip);

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

  /**
   * Counts one failed password check against the account; at LOGIN_MAX_FAILURES the account is
   * locked for LOGIN_LOCK_MINUTES, audited, and the owner gets an e-mail with a reset link.
   */
  private async registerFailure(
    user: { id: string; email: string; fullName: string },
    now: Date,
    ctx: RequestContext,
  ): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount < this.cfg.LOGIN_MAX_FAILURES) return;
    const lockedUntil = new Date(now.getTime() + this.cfg.LOGIN_LOCK_MINUTES * 60_000);
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil } });
    await this.audit
      .log({
        actorId: null,
        action: AuditAction.ACCOUNT_LOCKED,
        entityType: 'user',
        entityId: user.id,
        after: { lockedUntil: lockedUntil.toISOString(), failures: updated.failedLoginCount },
        ip: ctx.ip,
        requestId: ctx.requestId,
      })
      .catch((err: unknown) => this.logger.warn(`Lock audit failed: ${(err as Error).message}`));
    const web = this.cfg.PUBLIC_WEB_URL.replace(/\/$/, '');
    this.mail
      .send({
        to: user.email,
        ...emails.accountLocked({ name: user.fullName, minutes: this.cfg.LOGIN_LOCK_MINUTES, url: `${web}/forgot-password` }),
      })
      .catch((err: unknown) => this.logger.warn(`Lock e-mail failed: ${(err as Error).message}`));
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
    // A12: the refreshed session keeps its workspace while the user may still enter it.
    const { list, active } = await this.workspaces.pick(user.id, user.accountRole, result.workspaceId);
    if ((active?.id ?? null) !== result.workspaceId) {
      // The bound workspace was lost (membership removed, workspace archived): re-issue the
      // rotated token bound to the fallback so the cookie and the access token agree.
      await this.refreshTokens.revokeByToken(result.token);
      const next = await this.refreshTokens.issue(user.id, { ip: ctx.ip, userAgent: ctx.userAgent }, undefined, active?.id ?? null);
      return { session: await this.sessionBody(user, list, active), refreshToken: next.token };
    }
    return { session: await this.sessionBody(user, list, active), refreshToken: result.token };
  }

  /**
   * A12: `POST /auth/switch-workspace` — re-issues the session bound to another workspace after
   * the membership check (owners: any active workspace). The previous refresh family is revoked,
   * so the old workspace's session cannot be refreshed again. Audited in the target workspace.
   */
  async switchWorkspace(
    userId: string,
    workspaceId: string,
    presentedRefresh: string | undefined,
    ctx: RequestContext,
    fromWorkspaceId: string | null,
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER_DTO_SELECT });
    if (!user || user.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED');
    await this.workspaces.resolve(user.id, user.accountRole, workspaceId);
    await this.refreshTokens.revokeByToken(presentedRefresh);
    const issued = await this.issueSession(user, ctx, undefined, workspaceId);
    await runInWorkspace(workspaceId, () =>
      this.audit.log({
        actorId: user.id,
        action: AuditAction.WORKSPACE_SWITCHED,
        entityType: 'workspace',
        entityId: workspaceId,
        before: { workspaceId: fromWorkspaceId },
        after: { workspaceId },
        ip: ctx.ip,
        requestId: ctx.requestId,
      }),
    );
    return issued;
  }

  logout(presented: string | undefined): Promise<void> {
    return this.refreshTokens.revokeByToken(presented);
  }

  // ─────────────────────────────────────────── registration

  /**
   * Security review M4 (ADR-063): the anonymous caller always gets 201 `{ status: 'PENDING' }`.
   * When the e-mail, mobile or national ID already belongs to an account, nothing is created,
   * the existing owner(s) get an e-mail ("someone tried to register with your details") and the
   * attempt is audited without personal data. The unique indexes still guard the race; a P2002
   * there is answered the same way.
   */
  async register(input: RegisterData, ctx: RequestContext): Promise<{ status: 'PENDING' }> {
    // A12: the applicant picks the workspace by name (nothing to pick in single-workspace mode).
    // The request, its audit entry and the admins' notification live in that workspace.
    const workspaceId = await this.workspaces.registrationWorkspace(input.workspaceId);
    return runInWorkspace(workspaceId, () => this.registerIn(workspaceId, input, ctx), 'registration');
  }

  private async registerIn(workspaceId: string, input: RegisterData, ctx: RequestContext): Promise<{ status: 'PENDING' }> {
    const nid = this.crypto.protectNationalId(input.nationalId);
    const passwordHash = await this.passwords.hash(input.password);
    const owners = () =>
      this.prisma.user.findMany({
        where: { OR: [{ email: input.email }, { mobile: input.mobile }, { nationalIdHash: nid.hash }] },
        select: { id: true, email: true, fullName: true },
        take: 3,
      });
    const existing = await owners();
    if (existing.length) {
      this.duplicateRegistration(existing, ctx);
      return { status: 'PENDING' };
    }
    if (input.username && (await this.prisma.user.findUnique({ where: { username: input.username }, select: { id: true } }))) {
      // A taken username is the one duplicate the applicant is told about: it is not personal data.
      throw new AppError('USERNAME_TAKEN');
    }
    let user: UserRow;
    try {
      user = await this.createRegistration(input, nid, passwordHash, ctx, workspaceId);
    } catch (err) {
      const mapped = err instanceof AppError ? err : mapPrismaError(err);
      if (mapped && DUPLICATE_CODES.has(mapped.code)) {
        this.duplicateRegistration(await owners(), ctx);
        return { status: 'PENDING' };
      }
      throw mapped ?? err;
    }
    await this.notifications
      .notifyAdmins('REGISTRATION_REQUESTED', {
        applicantId: user.id,
        fullName: user.fullName,
        requestedRole: user.requestedRole,
      })
      .catch((err) => this.logger.warn(`Admin notification failed: ${(err as Error).message}`));
    return { status: 'PENDING' };
  }

  /** After the response: audit the attempt (no PII) and e-mail each existing owner once. */
  private duplicateRegistration(owners: Array<{ id: string; email: string; fullName: string }>, ctx: RequestContext): void {
    const web = this.cfg.PUBLIC_WEB_URL.replace(/\/$/, '');
    const run = async () => {
      for (const owner of owners) {
        await this.audit.log({
          actorId: null,
          action: AuditAction.REGISTRATION_DUPLICATE,
          entityType: 'user',
          entityId: owner.id,
          ip: ctx.ip,
          requestId: ctx.requestId,
        });
        await this.mail.send({ to: owner.email, ...emails.registrationAttempt({ name: owner.fullName, url: `${web}/login` }) });
      }
    };
    run().catch((err: unknown) => this.logger.warn(`Duplicate-registration notice failed: ${(err as Error).message}`));
  }

  private createRegistration(
    input: RegisterData,
    nid: ProtectedNationalId,
    passwordHash: string,
    ctx: RequestContext,
    workspaceId: string,
  ): Promise<UserRow> {
    return withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: await allocateUsername(tx, input.email, input.username),
            requestedWorkspaceId: workspaceId,
            fullName: input.fullName,
            email: input.email,
            mobile: input.mobile,
            nationalIdEnc: nid.enc,
            nationalIdHash: nid.hash,
            nationalIdFirst: nid.first,
            nationalIdLast2: nid.last2,
            passwordHash,
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
    // Review M5: the reset proved control of the mailbox — lift the lock (done above in the
    // same transaction) and the login delays for this account's identifiers.
    const owner = await this.prisma.user.findUnique({ where: { id: found.userId }, select: { email: true, mobile: true } });
    if (owner) for (const id of [owner.email, owner.mobile, `user:${found.userId}`]) this.throttle.clearIdentifier(id);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    // Security review L8: a stolen access token must not become an unthrottled password oracle.
    const throttleKey = `user:${userId}`;
    this.throttle.assertAllowed(throttleKey, ctx.ip);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, passwordHash: true },
    });
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      this.throttle.recordFailure(throttleKey, ctx.ip);
      await this.registerFailure(user, new Date(), ctx);
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { currentPassword: ['كلمة المرور الحالية غير صحيحة'] },
      });
    }
    this.throttle.recordSuccess(throttleKey, ctx.ip);
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
    return this.issueSession(updated, ctx, undefined, activeWorkspaceIdOrNull());
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

/**
 * Email (contains @), Saudi mobile in any accepted format (normalised to E.164), or — A12 — a
 * username (case-insensitive; usernames start with a letter, so they never look like a mobile).
 */
export function identifierToWhere(identifier: string): Prisma.UserWhereUniqueInput | null {
  const value = identifier.trim();
  if (value.includes('@')) return { email: value.toLowerCase() };
  const mobile = normalizeSaudiMobile(value);
  if (mobile) return { mobile };
  const username = value.toLowerCase();
  return /^[a-z][a-z0-9._-]{2,31}$/.test(username) ? { username } : null;
}
