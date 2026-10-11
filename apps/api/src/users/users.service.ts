import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import {
  can,
  isValidNationalId,
  type Paginated,
  type PermissionSubject,
  type UserDto,
  type UserStatus,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService, ActionPurpose } from '../auth/auth.service';
import { RefreshTokenService } from '../auth/refresh-tokens';
import { AppError } from '../common/app-error';
import { paginate, parseSort } from '../common/pagination';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { guardLastAdmin } from './last-admin';
import { auditUser, toUserDto, USER_DTO_SELECT, type UserRow } from './user-dto';

export interface UserListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  role?: Role;
  status?: UserStatus;
}

export interface CreateUserData {
  fullName: string;
  email: string;
  mobile: string;
  nationalId: string;
  role: Role;
}

type Viewer = PermissionSubject & { id: string };

const SORTABLE = ['createdAt', 'fullName', 'email', 'role', 'status', 'lastLoginAt'] as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  private dto(row: UserRow, viewer: Viewer, full = false): UserDto {
    return toUserDto(row, {
      fullNationalId: full && can(viewer, 'nationalIds.readFull'),
      crypto: this.crypto,
    });
  }

  private searchWhere(q: string | undefined): Prisma.UserWhereInput {
    if (!q) return {};
    const term = q.trim();
    if (isValidNationalId(term)) return { nationalIdHash: this.crypto.blindIndex(term) };
    return {
      OR: [
        { fullName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { mobile: { contains: term.replace(/^0/, '') } },
      ],
    };
  }

  async list(query: UserListQuery, viewer: Viewer): Promise<Paginated<UserDto>> {
    const where: Prisma.UserWhereInput = {
      ...this.searchWhere(query.q),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_DTO_SELECT,
        orderBy: parseSort(query.sort, SORTABLE, { createdAt: 'desc' }),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(
      rows.map((r) => this.dto(r, viewer)),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getById(id: string, viewer: Viewer): Promise<UserDto> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
    if (!row) throw new AppError('NOT_FOUND');
    return this.dto(row, viewer, true);
  }

  async supervisors(q: string | undefined, viewer: Viewer): Promise<UserDto[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: 'SUPERVISOR', status: 'ACTIVE', ...this.searchWhere(q) },
      select: USER_DTO_SELECT,
      orderBy: { fullName: 'asc' },
      take: 200,
    });
    return rows.map((r) => this.dto(r, viewer));
  }

  /** Admin creates a user directly: ACTIVE at once, with a one-time set-password e-mail. */
  async create(input: CreateUserData, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const { user, token } = await withPrismaErrors(() =>
      this.prisma.$transaction((tx) => this.createInTx(tx, input, viewer, ctx)),
    );
    await this.auth.sendSetPasswordEmail(user, token);
    return this.dto(user, viewer, true);
  }

  /**
   * The body of `create` inside a caller-owned transaction (used by team creation with an
   * inline new supervisor). The caller sends the set-password e-mail after the commit.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    input: CreateUserData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ user: UserRow; token: string }> {
    const nid = this.crypto.protectNationalId(input.nationalId);
    const now = new Date();
    const created = await tx.user.create({
      data: {
        fullName: input.fullName,
        email: input.email,
        mobile: input.mobile,
        nationalIdEnc: nid.enc,
        nationalIdHash: nid.hash,
        nationalIdFirst: nid.first,
        nationalIdLast2: nid.last2,
        passwordHash: null,
        role: input.role,
        status: 'ACTIVE',
        approvedAt: now,
        approvedById: viewer.id,
        createdById: viewer.id,
      },
      select: USER_DTO_SELECT,
    });
    const raw = await this.auth.createActionToken(created.id, ActionPurpose.SET_PASSWORD, tx);
    await this.audit.logCtx(
      ctx,
      {
        action: AuditAction.USER_CREATED,
        entityType: 'user',
        entityId: created.id,
        after: auditUser(created),
      },
      tx,
    );
    return { user: created, token: raw };
  }

  /** E-mails the one-time set-password link (after the creating transaction committed). */
  sendSetPasswordEmail(user: { email: string; fullName: string }, token: string): Promise<void> {
    return this.auth.sendSetPasswordEmail(user, token);
  }

  // ─────────────────────────────────────────── registrations (ADR-008)

  async approve(id: string, role: Role | undefined, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status !== 'PENDING') throw new AppError('NOT_PENDING');
      const finalRole = role ?? before.requestedRole ?? before.role;
      const claimed = await tx.user.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'ACTIVE',
          role: finalRole,
          approvedAt: new Date(),
          approvedById: viewer.id,
          rejectionReason: null,
        },
      });
      if (claimed.count !== 1) throw new AppError('NOT_PENDING');
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.REGISTRATION_APPROVED,
          entityType: 'user',
          entityId: id,
          before: { status: before.status, role: before.role },
          after: { status: after.status, role: after.role },
        },
        tx,
      );
      return after;
    });
    await this.notifySafely([user.id], 'REGISTRATION_APPROVED', { role: user.role });
    return this.dto(user, viewer, true);
  }

  async reject(id: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    if (!reason?.trim()) throw new AppError('REJECTION_REASON_REQUIRED');
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status !== 'PENDING') throw new AppError('NOT_PENDING');
      const claimed = await tx.user.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', rejectionReason: reason },
      });
      if (claimed.count !== 1) throw new AppError('NOT_PENDING');
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.REGISTRATION_REJECTED,
          entityType: 'user',
          entityId: id,
          before: { status: before.status },
          after: { status: after.status, rejectionReason: after.rejectionReason },
        },
        tx,
      );
      return after;
    });
    await this.notifySafely([user.id], 'REGISTRATION_REJECTED', { reason });
    return this.dto(user, viewer, true);
  }

  // ─────────────────────────────────────────── roles and status (ADR-009)

  async changeRole(id: string, role: Role, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.role === role) return before;
      await guardLastAdmin(tx, id, before, { role, status: before.status });
      const after = await tx.user.update({
        where: { id },
        data: { role, ...(before.status === 'PENDING' ? { requestedRole: role } : {}) },
        select: USER_DTO_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_ROLE_CHANGED,
          entityType: 'user',
          entityId: id,
          before: { role: before.role },
          after: { role: after.role },
        },
        tx,
      );
      return after;
    });
    return this.dto(user, viewer, true);
  }

  async suspend(id: string, reason: string | undefined, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status === 'SUSPENDED') return before;
      if (before.status !== 'ACTIVE') throw new AppError('INVALID_STATE');
      await guardLastAdmin(tx, id, before, { role: before.role, status: 'SUSPENDED' });
      const after = await tx.user.update({
        where: { id },
        data: { status: 'SUSPENDED' },
        select: USER_DTO_SELECT,
      });
      // Every refresh token dies with the suspension; access tokens are refused by the guard,
      // which reloads the user status on each request.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_SUSPENDED,
          entityType: 'user',
          entityId: id,
          before: { status: before.status },
          after: { status: after.status, reason: reason ?? null },
        },
        tx,
      );
      return after;
    });
    return this.dto(user, viewer, true);
  }

  async reactivate(id: string, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_DTO_SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status === 'ACTIVE') return before;
      if (before.status !== 'SUSPENDED') throw new AppError('INVALID_STATE');
      const after = await tx.user.update({
        where: { id },
        data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
        select: USER_DTO_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_REACTIVATED,
          entityType: 'user',
          entityId: id,
          before: { status: before.status },
          after: { status: after.status },
        },
        tx,
      );
      return after;
    });
    return this.dto(user, viewer, true);
  }

  /** Revokes sessions outside a transaction (used by tests and future admin tools). */
  revokeSessions(userId: string): Promise<number> {
    return this.refreshTokens.revokeAllForUser(userId);
  }

  private async notifySafely(
    ids: string[],
    type: 'REGISTRATION_APPROVED' | 'REGISTRATION_REJECTED',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notifications.notify(ids, type, payload);
    } catch (err) {
      this.logger.warn(`Notification ${type} failed: ${(err as Error).message}`);
    }
  }
}
