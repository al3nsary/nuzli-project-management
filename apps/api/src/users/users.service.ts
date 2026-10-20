import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Role, WorkspaceRole } from '@prisma/client';
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
import { paginate, parseSort, withIdTiebreak } from '../common/pagination';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { guardLastAdmin } from './last-admin';
import { auditUser, displayRole, displayStatus, matrixRole, toUserDto, USER_DTO_SELECT, workspaceUsersWhere, type UserRow } from './user-dto';
import { allocateUsername } from './usernames';

export interface UserListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  role?: Role;
  status?: UserStatus;
}

export interface CreateUserData {
  username?: string;
  fullName: string;
  email: string;
  mobile: string;
  nationalId: string;
  role: Role;
}

type Viewer = PermissionSubject & { id: string; accountRole?: string };

const SORTABLE = ['createdAt', 'fullName', 'email', 'username', 'status', 'lastLoginAt'] as const;

/** Matrix roles a membership can carry today (A12 round 2 adds ASSISTANT/MEMBER management). */
const MATRIX_ROLES: WorkspaceRole[] = ['ADMIN', 'SUPERVISOR', 'MONITOR'];

export { workspaceUsersWhere };

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
      viewerIsOwner: viewer.accountRole === 'OWNER',
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
        { username: { contains: term.toLowerCase() } },
        { mobile: { contains: term.replace(/^0/, '') } },
      ],
    };
  }

  private roleWhere(role: Role, workspaceId: string): Prisma.UserWhereInput {
    return {
      OR: [
        { memberships: { some: { workspaceId, role, archivedAt: null } } },
        { requestedWorkspaceId: workspaceId, status: { in: ['PENDING', 'REJECTED'] }, requestedRole: role },
      ],
    };
  }

  private statusWhere(status: UserStatus, workspaceId: string): Prisma.UserWhereInput {
    if (status === 'SUSPENDED') {
      return {
        OR: [
          { status: 'SUSPENDED' },
          { status: 'ACTIVE', memberships: { some: { workspaceId, archivedAt: null }, none: { workspaceId, archivedAt: null, status: 'ACTIVE' } } },
        ],
      };
    }
    if (status === 'ACTIVE') {
      return { status: 'ACTIVE', memberships: { some: { workspaceId, archivedAt: null, status: 'ACTIVE' } } };
    }
    return { status };
  }

  async list(query: UserListQuery, viewer: Viewer): Promise<Paginated<UserDto>> {
    const ws = activeWorkspaceId();
    const where: Prisma.UserWhereInput = {
      AND: [
        workspaceUsersWhere(ws),
        this.searchWhere(query.q),
        query.role ? this.roleWhere(query.role, ws) : {},
        query.status ? this.statusWhere(query.status, ws) : {},
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_DTO_SELECT,
        orderBy: withIdTiebreak(parseSort(query.sort, SORTABLE, { createdAt: 'desc' })),
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

  /** A user of the active workspace (404 for anyone else — ids of other workspaces reveal nothing). */
  private async findInWorkspace(db: Prisma.TransactionClient | PrismaService, id: string): Promise<UserRow> {
    const row = await db.user.findFirst({ where: { id, ...workspaceUsersWhere(activeWorkspaceId()) }, select: USER_DTO_SELECT });
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  async getById(id: string, viewer: Viewer): Promise<UserDto> {
    return this.dto(await this.findInWorkspace(this.prisma, id), viewer, true);
  }

  async supervisors(q: string | undefined, viewer: Viewer): Promise<UserDto[]> {
    const ws = activeWorkspaceId();
    const rows = await this.prisma.user.findMany({
      where: {
        AND: [
          { status: 'ACTIVE', memberships: { some: { workspaceId: ws, role: 'SUPERVISOR', status: 'ACTIVE', archivedAt: null } } },
          this.searchWhere(q),
        ],
      },
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
   * A12: the account is global; its role is a membership of the ACTIVE workspace.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    input: CreateUserData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ user: UserRow; token: string }> {
    const ws = activeWorkspaceId();
    const nid = this.crypto.protectNationalId(input.nationalId);
    const now = new Date();
    const createdUser = await tx.user.create({
      data: {
        username: await allocateUsername(tx, input.email, input.username),
        fullName: input.fullName,
        email: input.email,
        mobile: input.mobile,
        nationalIdEnc: nid.enc,
        nationalIdHash: nid.hash,
        nationalIdFirst: nid.first,
        nationalIdLast2: nid.last2,
        passwordHash: null,
        status: 'ACTIVE',
        approvedAt: now,
        approvedById: viewer.id,
        createdById: viewer.id,
        memberships: { create: { workspaceId: ws, role: input.role, createdById: viewer.id } },
      },
      select: USER_DTO_SELECT,
    });
    const raw = await this.auth.createActionToken(createdUser.id, ActionPurpose.SET_PASSWORD, tx);
    await this.audit.logCtx(
      ctx,
      {
        action: AuditAction.USER_CREATED,
        entityType: 'user',
        entityId: createdUser.id,
        after: auditUser(createdUser),
      },
      tx,
    );
    return { user: createdUser, token: raw };
  }

  /** E-mails the one-time set-password link (after the creating transaction committed). */
  sendSetPasswordEmail(user: { email: string; fullName: string }, token: string): Promise<void> {
    return this.auth.sendSetPasswordEmail(user, token);
  }

  // ─────────────────────────────────────────── registrations (ADR-008)

  /** A12: approves a registration addressed to the active workspace; the role becomes a membership there. */
  async approve(id: string, role: Role | undefined, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const ws = activeWorkspaceId();
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await this.findInWorkspace(tx, id);
      if (before.status !== 'PENDING') throw new AppError('NOT_PENDING');
      const finalRole: Role = role ?? before.requestedRole ?? 'MONITOR';
      const claimed = await tx.user.updateMany({
        where: { id, status: 'PENDING', requestedWorkspaceId: ws },
        data: { status: 'ACTIVE', approvedAt: new Date(), approvedById: viewer.id, rejectionReason: null },
      });
      if (claimed.count !== 1) throw new AppError('NOT_PENDING');
      await tx.workspaceMembership.upsert({
        where: { workspaceId_userId_role: { workspaceId: ws, userId: id, role: finalRole } },
        create: { workspaceId: ws, userId: id, role: finalRole, createdById: viewer.id },
        update: { archivedAt: null, status: 'ACTIVE' },
      });
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.REGISTRATION_APPROVED,
          entityType: 'user',
          entityId: id,
          before: { status: before.status, role: before.requestedRole },
          after: { status: after.status, role: finalRole },
        },
        tx,
      );
      return after;
    });
    await this.notifySafely([user.id], 'REGISTRATION_APPROVED', { role: matrixRole(user, ws) });
    return this.dto(user, viewer, true);
  }

  async reject(id: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    if (!reason?.trim()) throw new AppError('REJECTION_REASON_REQUIRED');
    const ws = activeWorkspaceId();
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await this.findInWorkspace(tx, id);
      if (before.status !== 'PENDING') throw new AppError('NOT_PENDING');
      const claimed = await tx.user.updateMany({
        where: { id, status: 'PENDING', requestedWorkspaceId: ws },
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

  // ─────────────────────────────────────────── roles and status (ADR-009, per workspace since A12)

  /** Only owners act on owners. */
  private assertMayManage(target: UserRow, viewer: Viewer): void {
    if (target.accountRole === 'OWNER' && viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
  }

  async changeRole(id: string, role: Role, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const ws = activeWorkspaceId();
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await this.findInWorkspace(tx, id);
      this.assertMayManage(before, viewer);
      const beforeRole = matrixRole(before, ws);
      const beforeShown = displayRole(before, ws);
      if (before.status === 'PENDING' || before.status === 'REJECTED') {
        if (before.requestedRole === role) return before;
        await tx.user.update({ where: { id }, data: { requestedRole: role } });
      } else {
        const live = before.memberships.filter((m) => m.workspaceId === ws && MATRIX_ROLES.includes(m.role));
        if (live.length === 1 && live[0]!.role === role) return before;
        const status = displayStatus(before, ws);
        await guardLastAdmin(tx, id, { role: beforeRole, status }, { role, status }, ws);
        await tx.workspaceMembership.updateMany({
          where: { workspaceId: ws, userId: id, role: { in: MATRIX_ROLES.filter((r) => r !== role) }, archivedAt: null },
          data: { archivedAt: new Date() },
        });
        await tx.workspaceMembership.upsert({
          where: { workspaceId_userId_role: { workspaceId: ws, userId: id, role } },
          create: { workspaceId: ws, userId: id, role, createdById: viewer.id, status: status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE' },
          update: { archivedAt: null },
        });
      }
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_ROLE_CHANGED,
          entityType: 'user',
          entityId: id,
          before: { role: beforeShown },
          after: { role: displayRole(after, ws) },
        },
        tx,
      );
      return after;
    });
    return this.dto(user, viewer, true);
  }

  /**
   * A12: suspends the user's memberships in the ACTIVE workspace and ends that workspace's
   * sessions. The account itself is suspended only when it has no live membership elsewhere
   * (single-workspace mode: exactly the pre-A12 behaviour).
   */
  async suspend(id: string, reason: string | undefined, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const ws = activeWorkspaceId();
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await this.findInWorkspace(tx, id);
      this.assertMayManage(before, viewer);
      const beforeStatus = displayStatus(before, ws);
      if (beforeStatus === 'SUSPENDED') return before;
      if (beforeStatus !== 'ACTIVE') throw new AppError('INVALID_STATE');
      const role = matrixRole(before, ws);
      await guardLastAdmin(tx, id, { role, status: 'ACTIVE' }, { role, status: 'SUSPENDED' }, ws);
      await tx.workspaceMembership.updateMany({ where: { workspaceId: ws, userId: id, archivedAt: null }, data: { status: 'SUSPENDED' } });
      const elsewhere = before.memberships.some((m) => m.workspaceId !== ws && m.status === 'ACTIVE');
      if (!elsewhere && before.accountRole !== 'OWNER') {
        await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
      }
      // Sessions bound to this workspace die at once (all of them when the account is suspended);
      // access tokens are refused by the guard, which re-checks the membership on each request.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null, ...(elsewhere ? { workspaceId: ws } : {}) },
        data: { revokedAt: new Date() },
      });
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_SUSPENDED,
          entityType: 'user',
          entityId: id,
          before: { status: beforeStatus },
          after: { status: displayStatus(after, ws), reason: reason ?? null },
        },
        tx,
      );
      return after;
    });
    return this.dto(user, viewer, true);
  }

  async reactivate(id: string, viewer: Viewer, ctx: RequestContext): Promise<UserDto> {
    const ws = activeWorkspaceId();
    const user = await this.prisma.$transaction(async (tx) => {
      const before = await this.findInWorkspace(tx, id);
      this.assertMayManage(before, viewer);
      const beforeStatus = displayStatus(before, ws);
      if (beforeStatus === 'ACTIVE') return before;
      if (beforeStatus !== 'SUSPENDED') throw new AppError('INVALID_STATE');
      await tx.workspaceMembership.updateMany({ where: { workspaceId: ws, userId: id, archivedAt: null }, data: { status: 'ACTIVE' } });
      if (before.status === 'SUSPENDED') {
        await tx.user.update({ where: { id }, data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null } });
      }
      const after = await tx.user.findUniqueOrThrow({ where: { id }, select: USER_DTO_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.USER_REACTIVATED,
          entityType: 'user',
          entityId: id,
          before: { status: beforeStatus },
          after: { status: displayStatus(after, ws) },
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
