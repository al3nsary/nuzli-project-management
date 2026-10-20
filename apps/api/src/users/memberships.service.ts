import { Injectable } from '@nestjs/common';
import type { Prisma, WorkspaceRole } from '@prisma/client';
import {
  assistantScopeOf,
  isValidNationalId,
  normalizeSaudiMobile,
  type AssistantPermissions,
  type AssistantScope,
  type WorkspaceMemberDto,
} from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { AuthUser, RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { newStore, runInStore } from '../prisma/workspace-context';
import { guardLastAdmin } from './last-admin';
import { roleEntries } from './user-dto';

type Tx = Prisma.TransactionClient;

export const MembershipAction = {
  ADDED: 'membership.added',
  UPDATED: 'membership.updated',
  REMOVED: 'membership.removed',
} as const;

/**
 * A12 round 2 — runs `fn` for `workspaceId`: an admin only for the workspace of their session
 * (anything else → 403 WORKSPACE_FORBIDDEN, so another workspace's id reveals nothing); an owner
 * for any workspace, inside THAT workspace's context (scoped queries, RLS, audit there).
 */
export async function inTargetWorkspace<T>(
  prisma: PrismaService,
  viewer: Pick<AuthUser, 'id' | 'accountRole' | 'workspaceId'>,
  workspaceId: string,
  fn: () => Promise<T>,
  opts: { allowArchived?: boolean } = {},
): Promise<T> {
  if (viewer.accountRole !== 'OWNER') {
    if (!viewer.workspaceId || workspaceId !== viewer.workspaceId) throw new AppError('WORKSPACE_FORBIDDEN');
    return fn();
  }
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, status: true } });
  if (!ws) throw new AppError('NOT_FOUND');
  if (ws.status !== 'ACTIVE' && !opts.allowArchived) throw new AppError('WORKSPACE_ARCHIVED');
  if (workspaceId === viewer.workspaceId) return fn();
  return runInStore(newStore({ workspaceId, userId: viewer.id, accountRole: 'OWNER', label: 'owner-admin' }), fn);
}

const MEMBER_ROW = {
  id: true,
  workspaceId: true,
  role: true,
  title: true,
  permissions: true,
  scope: true,
  status: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      username: true,
      fullName: true,
      email: true,
      status: true,
      accountRole: true,
      photoFileId: true,
      memberships: { where: { archivedAt: null }, select: { id: true } },
    },
  },
} satisfies Prisma.WorkspaceMembershipSelect;

type MemberRow = Prisma.WorkspaceMembershipGetPayload<{ select: typeof MEMBER_ROW }>;

export function toWorkspaceMemberDto(m: MemberRow): WorkspaceMemberDto {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    role: m.role,
    title: m.title,
    permissions: (m.permissions ?? {}) as AssistantPermissions,
    scope: (m.scope ?? {}) as AssistantScope,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    user: {
      id: m.user.id,
      username: m.user.username,
      fullName: m.user.fullName,
      email: m.user.email,
      status: m.user.status,
      accountRole: m.user.accountRole,
      hasPhoto: !!m.user.photoFileId,
    },
    dualRole: m.user.memberships.length > 1,
  };
}

export interface MembershipInput {
  userId?: string;
  identifier?: string;
  role: WorkspaceRole;
  title?: string;
  permissions?: AssistantPermissions;
  scope?: AssistantScope;
  confirmDualRole?: boolean;
}

/** Audit view of a membership: no personal data beyond the ids. */
function auditMembership(m: { id?: string; userId?: string; role: string; title?: string | null; permissions?: unknown; scope?: unknown; status?: string }) {
  return {
    ...(m.id ? { membershipId: m.id } : {}),
    ...(m.userId ? { userId: m.userId } : {}),
    role: m.role,
    title: m.title ?? null,
    ...(m.role === 'ASSISTANT' ? { permissions: m.permissions ?? {}, scope: m.scope ?? {} } : {}),
    ...(m.status ? { status: m.status } : {}),
  };
}

/**
 * A12 round 2 — memberships (أدوار المستخدمين في الأقسام): add an EXISTING account to a
 * workspace with a role (fixes round 1's EMAIL_TAKEN gap), change an assistant's modules and
 * scope, remove a role. Owners act on any workspace; admins on their own. Granting a second live
 * role needs `confirmDualRole` (DUAL_ROLE_CONFIRM_REQUIRED). Every change is audited in the
 * workspace concerned (before/after, no personal data).
 */
@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  /** An ACTIVE account by id, or by username / e-mail / mobile / national ID. */
  async findAccount(db: Tx | PrismaService, ref: { userId?: string; identifier?: string }) {
    const select = {
      id: true,
      status: true,
      accountRole: true,
      memberships: {
        where: { archivedAt: null },
        select: { workspaceId: true, role: true, status: true, title: true, workspace: { select: { name: true } } },
      },
    } as const;
    let where: Prisma.UserWhereUniqueInput | null = null;
    if (ref.userId) where = { id: ref.userId };
    else if (ref.identifier) {
      const v = ref.identifier.trim();
      if (v.includes('@')) where = { email: v.toLowerCase() };
      else if (isValidNationalId(v)) where = { nationalIdHash: this.crypto.blindIndex(v) };
      else if (normalizeSaudiMobile(v)) where = { mobile: normalizeSaudiMobile(v)! };
      else where = { username: v.toLowerCase() };
    }
    const user = where ? await db.user.findUnique({ where, select }) : null;
    if (!user) throw new AppError('NOT_FOUND', { field: ref.userId ? 'userId' : 'identifier' });
    if (user.status !== 'ACTIVE') throw new AppError('INVALID_STATE', { status: user.status });
    return user;
  }

  /** 409 DUAL_ROLE_CONFIRM_REQUIRED when the person already holds a live role (anywhere). */
  assertDualRoleConfirmed(
    user: { memberships: Array<{ workspaceId: string; role: WorkspaceRole; status: 'ACTIVE' | 'SUSPENDED'; title: string | null; workspace: { name: string } }> },
    confirm: boolean | undefined,
    viewer: Pick<AuthUser, 'accountRole' | 'workspaceId'>,
  ): void {
    if (!user.memberships.length || confirm) return;
    throw new AppError('DUAL_ROLE_CONFIRM_REQUIRED', {
      roles: roleEntries(user, viewer.workspaceId, viewer.accountRole === 'OWNER'),
    });
  }

  /** An assistant's scope may only name projects and teams of the workspace (run inside it). */
  async assertScopeInWorkspace(db: Tx | PrismaService, scope: AssistantScope | undefined): Promise<void> {
    if (!scope) return;
    const s = assistantScopeOf(scope);
    const fieldErrors: Record<string, string[]> = {};
    if (s.projectIds?.length) {
      const n = await db.project.count({ where: { id: { in: s.projectIds } } });
      if (n !== new Set(s.projectIds).size) fieldErrors['scope.projectIds'] = ['مشروع غير موجود في هذا القسم'];
    }
    if (s.teamIds?.length) {
      const n = await db.team.count({ where: { id: { in: s.teamIds } } });
      if (n !== new Set(s.teamIds).size) fieldErrors['scope.teamIds'] = ['فريق غير موجود في هذا القسم'];
    }
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
  }

  async list(workspaceId: string, viewer: AuthUser): Promise<WorkspaceMemberDto[]> {
    return inTargetWorkspace(this.prisma, viewer, workspaceId, async () => {
      const rows = await this.prisma.workspaceMembership.findMany({
        where: { workspaceId, archivedAt: null },
        select: MEMBER_ROW,
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map(toWorkspaceMemberDto);
    }, { allowArchived: true });
  }

  /**
   * Creates the membership inside a caller-owned transaction (users.create uses it too). The
   * caller has checked the dual-role confirmation and runs in the target workspace's context.
   */
  async createInTx(
    tx: Tx,
    workspaceId: string,
    userId: string,
    input: Pick<MembershipInput, 'role' | 'title' | 'permissions' | 'scope'>,
    viewer: Pick<AuthUser, 'id'>,
    ctx: RequestContext,
  ): Promise<string> {
    if (input.role === 'ASSISTANT') await this.assertScopeInWorkspace(tx, input.scope);
    const data = {
      title: input.title ?? null,
      permissions: (input.role === 'ASSISTANT' ? input.permissions ?? {} : {}) as Prisma.InputJsonValue,
      scope: (input.role === 'ASSISTANT' ? input.scope ?? {} : {}) as Prisma.InputJsonValue,
    };
    const existing = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId_role: { workspaceId, userId, role: input.role } },
      select: { id: true, archivedAt: true },
    });
    if (existing && !existing.archivedAt) throw new AppError('MEMBERSHIP_EXISTS');
    const row = existing
      ? await tx.workspaceMembership.update({
          where: { id: existing.id },
          data: { ...data, archivedAt: null, status: 'ACTIVE', createdById: viewer.id, createdAt: new Date() },
          select: { id: true },
        })
      : await tx.workspaceMembership.create({
          data: { workspaceId, userId, role: input.role, createdById: viewer.id, ...data },
          select: { id: true },
        });
    await this.audit.logCtx(
      ctx,
      {
        action: MembershipAction.ADDED,
        entityType: 'user',
        entityId: userId,
        before: null,
        after: auditMembership({ id: row.id, userId, role: input.role, title: data.title, permissions: data.permissions, scope: data.scope }),
      },
      tx,
    );
    return row.id;
  }

  /** `POST /workspaces/:id/members` — an existing account gets a role in the workspace. */
  async add(workspaceId: string, input: MembershipInput, viewer: AuthUser, ctx: RequestContext): Promise<WorkspaceMemberDto> {
    return inTargetWorkspace(this.prisma, viewer, workspaceId, () =>
      withPrismaErrors(() =>
        this.prisma.$transaction(async (tx) => {
          const user = await this.findAccount(tx, input);
          if (user.memberships.some((m) => m.workspaceId === workspaceId && m.role === input.role)) throw new AppError('MEMBERSHIP_EXISTS');
          this.assertDualRoleConfirmed(user, input.confirmDualRole, viewer);
          const id = await this.createInTx(tx, workspaceId, user.id, input, viewer, ctx);
          return toWorkspaceMemberDto(await tx.workspaceMembership.findUniqueOrThrow({ where: { id }, select: MEMBER_ROW }));
        }),
      ),
    );
  }

  private async liveMembership(tx: Tx | PrismaService, workspaceId: string, membershipId: string) {
    const m = await tx.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, archivedAt: null },
      select: { id: true, userId: true, role: true, title: true, permissions: true, scope: true, status: true, user: { select: { accountRole: true } } },
    });
    if (!m) throw new AppError('NOT_FOUND');
    return m;
  }

  /** `PATCH /workspaces/:id/members/:membershipId` — position, assistant modules and scope. */
  async update(
    workspaceId: string,
    membershipId: string,
    patch: { title?: string | null; permissions?: AssistantPermissions; scope?: AssistantScope },
    viewer: AuthUser,
    ctx: RequestContext,
  ): Promise<WorkspaceMemberDto> {
    return inTargetWorkspace(this.prisma, viewer, workspaceId, () =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.liveMembership(tx, workspaceId, membershipId);
        if (before.user.accountRole === 'OWNER' && viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
        if ((patch.permissions !== undefined || patch.scope !== undefined) && before.role !== 'ASSISTANT') {
          throw new AppError('VALIDATION_FAILED', { fieldErrors: { permissions: ['الصلاحيات التفصيلية للمساعد فقط'] } });
        }
        if (patch.scope) await this.assertScopeInWorkspace(tx, patch.scope);
        const data: Prisma.WorkspaceMembershipUpdateInput = {};
        if (patch.title !== undefined) data.title = patch.title;
        if (patch.permissions !== undefined) data.permissions = patch.permissions as Prisma.InputJsonValue;
        if (patch.scope !== undefined) data.scope = patch.scope as Prisma.InputJsonValue;
        const after = await tx.workspaceMembership.update({ where: { id: membershipId }, data, select: MEMBER_ROW });
        await this.audit.logCtx(
          ctx,
          {
            action: MembershipAction.UPDATED,
            entityType: 'user',
            entityId: before.userId,
            before: auditMembership(before),
            after: auditMembership({ id: after.id, userId: before.userId, role: after.role, title: after.title, permissions: after.permissions, scope: after.scope }),
          },
          tx,
        );
        return toWorkspaceMemberDto(after);
      }),
    );
  }

  /**
   * `DELETE /workspaces/:id/members/:membershipId` — the role ends (archived, never deleted).
   * An admin cannot remove the workspace's last active admin (LAST_ADMIN); owners can (they keep
   * every right). When it was the person's last role there, their sessions in it end.
   */
  async remove(workspaceId: string, membershipId: string, viewer: AuthUser, ctx: RequestContext): Promise<void> {
    await inTargetWorkspace(this.prisma, viewer, workspaceId, () =>
      this.prisma.$transaction(async (tx) => {
        const m = await this.liveMembership(tx, workspaceId, membershipId);
        if (m.user.accountRole === 'OWNER' && viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
        if (viewer.accountRole !== 'OWNER' && m.role === 'ADMIN' && m.status === 'ACTIVE') {
          await guardLastAdmin(tx, m.userId, { role: 'ADMIN', status: 'ACTIVE' }, { role: null, status: 'ACTIVE' }, workspaceId);
        }
        await tx.workspaceMembership.update({ where: { id: membershipId }, data: { archivedAt: new Date() } });
        const left = await tx.workspaceMembership.count({ where: { workspaceId, userId: m.userId, archivedAt: null } });
        if (!left) {
          await tx.refreshToken.updateMany({ where: { userId: m.userId, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
        }
        await this.audit.logCtx(
          ctx,
          { action: MembershipAction.REMOVED, entityType: 'user', entityId: m.userId, before: auditMembership(m), after: { archived: true, sessionsEnded: !left } },
          tx,
        );
      }),
    );
  }
}
