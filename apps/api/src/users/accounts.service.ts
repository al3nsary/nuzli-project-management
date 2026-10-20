import { Injectable } from '@nestjs/common';
import type { Prisma, WorkspaceRole } from '@prisma/client';
import {
  can,
  isValidNationalId,
  maskNationalIdParts,
  type AssistantPermissions,
  type AssistantScope,
  type Paginated,
  type UserDto,
} from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { ActionPurpose, AuthService } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { RefreshTokenService } from '../auth/refresh-tokens';
import { AppError } from '../common/app-error';
import { paginate, withIdTiebreak } from '../common/pagination';
import { withPrismaErrors } from '../common/prisma-errors';
import type { AuthUser, RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceIdOrNull, runWithoutWorkspace } from '../prisma/workspace-context';
import { assertAccountWithinReach } from './account-reach';
import { guardLastAdmin } from './last-admin';
import { inTargetWorkspace, MembershipsService } from './memberships.service';
import { auditUser, toUserDto, USER_DTO_SELECT, workspaceUsersWhere, type UserRow } from './user-dto';
import { allocateUsername } from './usernames';

type Tx = Prisma.TransactionClient;

export const AccountAction = {
  USER_UPDATED: 'user.updated',
  USERNAME_CHANGED: 'user.username_changed',
  PASSWORD_SET: 'user.password_set',
  OWNER_ADDED: 'owner.added',
  OWNER_REMOVED: 'owner.removed',
} as const;

export interface CreateAccountData {
  username?: string;
  fullName: string;
  email: string;
  mobile: string;
  nationalId: string;
  role?: 'ADMIN' | 'SUPERVISOR' | 'MONITOR';
  password?: string;
  mustChangePassword?: boolean;
  memberships?: Array<{ workspaceId?: string; role: WorkspaceRole; title?: string; permissions?: AssistantPermissions; scope?: AssistantScope }>;
  confirmDualRole?: boolean;
}

export interface UpdateAccountData {
  username?: string;
  fullName?: string;
  email?: string;
  mobile?: string;
  nationalId?: string;
}

/**
 * A12 round 2 — account administration (إدارة المستخدمين):
 *  - who may edit an account: owners anyone; an admin (`users.edit`) only a user who belongs to
 *    no workspace but the ones they administer (USER_IN_OTHER_WORKSPACES otherwise); nobody but
 *    owners touches an owner;
 *  - the username can change at any time (unique, case-insensitive), as can e-mail, mobile, name
 *    and national ID; nobody can read a password — `setPassword` sets a new one, ends every
 *    session of the user and is audited `user.password_set` (never the value);
 *  - every change is audited with before/after (masked national ID, no secrets).
 *  - security review A12 M1 (ADR-164): an OWNER's account changes (edit, username, password,
 *    global suspension, account creation) are ACCOUNT-LEVEL audit entries (workspace NULL, owners
 *    only, `GET /audit?scope=account`) — never in the workspace the owner happens to work in, where
 *    that workspace's admins would read another workspace's person. Membership changes stay in the
 *    workspace concerned. An admin's change of their own workspace's user stays in that workspace.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly memberships: MembershipsService,
  ) {}

  dto(row: UserRow, viewer: AuthUser, full = false): UserDto {
    return toUserDto(row, {
      fullNationalId: full && can(viewer, 'nationalIds.readFull'),
      crypto: this.crypto,
      viewerIsOwner: viewer.accountRole === 'OWNER',
    });
  }

  /**
   * M1: runs an owner's account change outside any workspace, so its audit entry (written in the
   * same transaction) is account-level. Admins act inside their workspace as before.
   */
  private accountLevel<T>(viewer: AuthUser, fn: () => Promise<T>): Promise<T> {
    return viewer.accountRole === 'OWNER' ? runWithoutWorkspace(fn, 'account-admin') : fn();
  }

  // ─────────────────────────────────────────── who may edit whom

  /** The target as the caller may see it: owners any account; others a user of their workspace (404 otherwise). */
  private async target(db: Tx | PrismaService, id: string, viewer: AuthUser): Promise<UserRow & { nationalIdHash: string }> {
    const ws = activeWorkspaceIdOrNull();
    const where: Prisma.UserWhereInput =
      viewer.accountRole === 'OWNER' ? { id } : ws ? { id, ...workspaceUsersWhere(ws) } : { id: { in: [] } };
    const row = await db.user.findFirst({ where, select: { ...USER_DTO_SELECT, nationalIdHash: true } });
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  /** Throws unless `viewer` may change this account's data or password. */
  async assertMayEdit(db: Tx | PrismaService, target: Pick<UserRow, 'id' | 'accountRole' | 'memberships'>, viewer: AuthUser): Promise<void> {
    if (viewer.accountRole === 'OWNER') return;
    if (target.accountRole === 'OWNER' || !can(viewer, 'users.edit')) throw new AppError('FORBIDDEN');
    await assertAccountWithinReach(db, target, viewer);
  }

  // ─────────────────────────────────────────── create (POST /users)

  async create(input: CreateAccountData, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    const active = viewer.workspaceId;
    const wanted = (input.memberships?.length ? input.memberships : [{ role: input.role! }]).map((m) => ({
      ...m,
      workspaceId: ('workspaceId' in m && m.workspaceId) || active,
    }));
    const seen = new Set<string>();
    for (const m of wanted) {
      if (!m.workspaceId) throw new AppError('VALIDATION_FAILED', { fieldErrors: { memberships: ['اختر القسم'] } });
      if (viewer.accountRole !== 'OWNER' && m.workspaceId !== active) throw new AppError('WORKSPACE_FORBIDDEN');
      const key = `${m.workspaceId}:${m.role}`;
      if (seen.has(key)) throw new AppError('VALIDATION_FAILED', { fieldErrors: { memberships: ['الصفة نفسها مكرّرة في القسم نفسه'] } });
      seen.add(key);
    }
    if (wanted.length > 1 && !input.confirmDualRole) {
      throw new AppError('DUAL_ROLE_CONFIRM_REQUIRED', { roles: wanted.map((m) => ({ workspaceId: m.workspaceId, role: m.role })) });
    }
    // Everything is validated before the account exists: each workspace (owners) and assistant scope.
    for (const m of wanted) {
      await inTargetWorkspace(this.prisma, viewer, m.workspaceId!, () =>
        m.role === 'ASSISTANT' ? this.memberships.assertScopeInWorkspace(this.prisma, m.scope) : Promise.resolve(),
      );
    }
    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    const nid = this.crypto.protectNationalId(input.nationalId);
    // M1: an owner creates the ACCOUNT at account level (its `user.created` entry has workspace
    // NULL); each membership is then created and audited inside its own workspace.
    const ownerCreates = viewer.accountRole === 'OWNER';
    const here = ownerCreates ? [] : wanted.filter((m) => m.workspaceId === active);
    const elsewhere = ownerCreates ? wanted : wanted.filter((m) => m.workspaceId !== active);
    const { user, token } = await this.accountLevel(viewer, () => withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: await allocateUsername(tx, input.email, input.username),
            fullName: input.fullName,
            email: input.email,
            mobile: input.mobile,
            nationalIdEnc: nid.enc,
            nationalIdHash: nid.hash,
            nationalIdFirst: nid.first,
            nationalIdLast2: nid.last2,
            passwordHash,
            mustChangePassword: passwordHash ? input.mustChangePassword ?? true : false,
            status: 'ACTIVE',
            approvedAt: new Date(),
            approvedById: viewer.id,
            createdById: viewer.id,
          },
          select: { id: true },
        });
        for (const m of here) await this.memberships.createInTx(tx, m.workspaceId!, created.id, m, viewer, ctx);
        const row = await tx.user.findUniqueOrThrow({ where: { id: created.id }, select: USER_DTO_SELECT });
        await this.audit.logCtx(
          ctx,
          { action: 'user.created', entityType: 'user', entityId: created.id, after: { ...auditUser(row), passwordSet: !!passwordHash } },
          tx,
        );
        const raw = passwordHash ? null : await this.auth.createActionToken(created.id, ActionPurpose.SET_PASSWORD, tx);
        return { user: row, token: raw };
      }),
    ));
    for (const m of elsewhere) {
      await inTargetWorkspace(this.prisma, viewer, m.workspaceId!, () =>
        this.prisma.$transaction((tx) => this.memberships.createInTx(tx, m.workspaceId!, user.id, m, viewer, ctx)),
      );
    }
    if (token) await this.auth.sendSetPasswordEmail(user, token);
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: USER_DTO_SELECT });
    return this.dto(fresh, viewer, true);
  }

  // ─────────────────────────────────────────── edit

  /** `PATCH /users/:id` — username, name, e-mail, mobile, national ID. */
  async update(id: string, patch: UpdateAccountData, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    const row = await this.accountLevel(viewer, () => withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.target(tx, id, viewer);
        await this.assertMayEdit(tx, before, viewer);
        const data: Prisma.UserUpdateInput = {};
        const b: Record<string, unknown> = {};
        const a: Record<string, unknown> = {};
        const set = (key: 'username' | 'fullName' | 'email' | 'mobile', value: string | undefined) => {
          if (value === undefined || value === before[key]) return;
          data[key] = value;
          b[key] = before[key];
          a[key] = value;
        };
        set('username', patch.username?.toLowerCase());
        set('fullName', patch.fullName);
        set('email', patch.email);
        set('mobile', patch.mobile);
        if (patch.nationalId !== undefined) {
          const p = this.crypto.protectNationalId(patch.nationalId);
          if (p.hash !== before.nationalIdHash) {
            Object.assign(data, { nationalIdEnc: p.enc, nationalIdHash: p.hash, nationalIdFirst: p.first, nationalIdLast2: p.last2 });
            b.nationalIdMasked = maskNationalIdParts(before.nationalIdFirst, before.nationalIdLast2);
            a.nationalIdMasked = maskNationalIdParts(p.first, p.last2);
          }
        }
        if (!Object.keys(data).length) return before;
        const after = await tx.user.update({ where: { id }, data, select: USER_DTO_SELECT });
        await this.audit.logCtx(ctx, { action: AccountAction.USER_UPDATED, entityType: 'user', entityId: id, before: b, after: a }, tx);
        return after;
      }),
    ));
    return this.dto(row, viewer, true);
  }

  /** `POST /users/:id/username`. */
  async changeUsername(id: string, username: string, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    const name = username.trim().toLowerCase();
    const row = await this.accountLevel(viewer, () => withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.target(tx, id, viewer);
        await this.assertMayEdit(tx, before, viewer);
        if (before.username === name) return before;
        const taken = await tx.user.findUnique({ where: { username: name }, select: { id: true } });
        if (taken && taken.id !== id) throw new AppError('USERNAME_TAKEN');
        const after = await tx.user.update({ where: { id }, data: { username: name }, select: USER_DTO_SELECT });
        await this.audit.logCtx(
          ctx,
          { action: AccountAction.USERNAME_CHANGED, entityType: 'user', entityId: id, before: { username: before.username }, after: { username: name } },
          tx,
        );
        return after;
      }),
    ));
    return this.dto(row, viewer, true);
  }

  /**
   * `POST /users/:id/password` — sets a new password (nobody can read the old one), optionally
   * forcing a change at next login; ends every session and pending reset link of the user;
   * lifts a login lock. Audited without the value.
   */
  async setPassword(id: string, input: { password: string; mustChangePassword: boolean }, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    const passwordHash = await this.passwords.hash(input.password);
    const row = await this.accountLevel(viewer, () => this.prisma.$transaction(async (tx) => {
      const before = await this.target(tx, id, viewer);
      await this.assertMayEdit(tx, before, viewer);
      const after = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: input.mustChangePassword, failedLoginCount: 0, lockedUntil: null },
        select: USER_DTO_SELECT,
      });
      await tx.actionToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.logCtx(
        ctx,
        { action: AccountAction.PASSWORD_SET, entityType: 'user', entityId: id, after: { mustChangePassword: input.mustChangePassword, sessionsEnded: true } },
        tx,
      );
      return after;
    }));
    return this.dto(row, viewer, true);
  }

  // ─────────────────────────────────────────── owners: every account, global suspension

  /** `GET /users/all` (owners) — every account of the system with its roles in every workspace. */
  async listAll(
    q: { page: number; pageSize: number; q?: string; status?: UserDto['status']; accountRole?: 'OWNER' | 'USER' },
    viewer: AuthUser,
  ): Promise<Paginated<UserDto>> {
    if (viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = {
      AND: [
        q.status ? { status: q.status } : {},
        q.accountRole ? { accountRole: q.accountRole } : {},
        term
          ? isValidNationalId(term)
            ? { nationalIdHash: this.crypto.blindIndex(term) }
            : {
                OR: [
                  { fullName: { contains: term, mode: 'insensitive' } },
                  { email: { contains: term, mode: 'insensitive' } },
                  { username: { contains: term.toLowerCase() } },
                  { mobile: { contains: term.replace(/^0/, '') } },
                ],
              }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_DTO_SELECT,
        orderBy: withIdTiebreak([{ createdAt: 'desc' }]),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(rows.map((r) => this.dto(r, viewer)), total, q.page, q.pageSize);
  }

  /** Owners: suspend the ACCOUNT everywhere (every session ends). Never the last owner; never a workspace's last admin. */
  async suspendGlobal(id: string, reason: string | undefined, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    if (viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
    const row = await this.accountLevel(viewer, () => this.prisma.$transaction(async (tx) => {
      const before = await this.target(tx, id, viewer);
      if (before.status === 'SUSPENDED') {
        // Already suspended by the cascade of a workspace suspension: the owner now makes it a
        // global suspension (H2: only an owner may lift it).
        const flag = await tx.user.findUniqueOrThrow({ where: { id }, select: { suspendedGlobally: true } });
        if (flag.suspendedGlobally) return before;
        const after = await tx.user.update({ where: { id }, data: { suspendedGlobally: true }, select: USER_DTO_SELECT });
        await this.audit.logCtx(
          ctx,
          { action: 'user.suspended', entityType: 'user', entityId: id, before: { status: 'SUSPENDED' }, after: { status: 'SUSPENDED', scope: 'global', reason: reason ?? null } },
          tx,
        );
        return after;
      }
      if (before.status !== 'ACTIVE') throw new AppError('INVALID_STATE');
      if (before.accountRole === 'OWNER') await assertNotLastOwner(tx, id);
      for (const m of before.memberships.filter((x) => x.role === 'ADMIN' && x.status === 'ACTIVE')) {
        await guardLastAdmin(tx, id, { role: 'ADMIN', status: 'ACTIVE' }, { role: 'ADMIN', status: 'SUSPENDED' }, m.workspaceId);
      }
      // H2: remembered, so only an owner can lift it (UsersService.reactivate answers SUSPENDED_BY_OWNER).
      const after = await tx.user.update({ where: { id }, data: { status: 'SUSPENDED', suspendedGlobally: true }, select: USER_DTO_SELECT });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.logCtx(
        ctx,
        { action: 'user.suspended', entityType: 'user', entityId: id, before: { status: before.status }, after: { status: 'SUSPENDED', scope: 'global', reason: reason ?? null } },
        tx,
      );
      return after;
    }));
    return this.dto(row, viewer, true);
  }

  async reactivateGlobal(id: string, viewer: AuthUser, ctx: RequestContext): Promise<UserDto> {
    if (viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
    const row = await this.accountLevel(viewer, () => this.prisma.$transaction(async (tx) => {
      const before = await this.target(tx, id, viewer);
      if (before.status === 'ACTIVE') return before;
      if (before.status !== 'SUSPENDED') throw new AppError('INVALID_STATE');
      const after = await tx.user.update({
        where: { id },
        data: { status: 'ACTIVE', suspendedGlobally: false, failedLoginCount: 0, lockedUntil: null },
        select: USER_DTO_SELECT,
      });
      await this.audit.logCtx(
        ctx,
        { action: 'user.reactivated', entityType: 'user', entityId: id, before: { status: before.status }, after: { status: 'ACTIVE', scope: 'global' } },
        tx,
      );
      return after;
    }));
    return this.dto(row, viewer, true);
  }
}

/**
 * Locks every active owner row for the rest of the transaction and throws LAST_OWNER when
 * `targetId` is the only one (two owners demoting each other serialise on the locks).
 */
export async function assertNotLastOwner(tx: Tx, targetId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users WHERE account_role = 'OWNER'::"AccountRole" AND status = 'ACTIVE'::"UserStatus" ORDER BY id FOR UPDATE`;
  const ids = rows.map((r) => r.id);
  if (ids.includes(targetId) && ids.length <= 1) throw new AppError('LAST_OWNER');
}
