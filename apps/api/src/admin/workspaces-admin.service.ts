import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  WORKSPACE_ROLES,
  type WorkspaceAdminDto,
  type WorkspaceCountsDto,
  type WorkspaceMemberDto,
  type WorkspaceRole,
} from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { AuthUser, RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { newStore, runInStore } from '../prisma/workspace-context';
import { seedWorkspaceDefaults } from '../seed/seed';
import { MembershipsService } from '../users/memberships.service';

export const WorkspaceAction = {
  CREATED: 'workspace.created',
  RENAMED: 'workspace.renamed',
  ARCHIVED: 'workspace.archived',
  RESTORED: 'workspace.restored',
} as const;

const WS_SELECT = { id: true, name: true, code: true, status: true, createdAt: true, archivedAt: true } as const;

/**
 * A12 round 2 — workspaces (أقسام), owners only:
 *  - create: a new, EMPTY workspace with its neutral defaults (settings, 24-colour palette, the
 *    default calendar with a Fri/Sat weekend, the 6 card sizes and 3 built-in templates) — no
 *    demo data; audited `workspace.created` inside it;
 *  - rename; archive (soft — nothing is deleted; its sessions end; never the last active one);
 *    restore;
 *  - admins: list / assign / remove (memberships with role ADMIN);
 *  - summary: counts only (no business rows leave the workspace).
 * Each workspace's own data is touched only inside that workspace's context (scoping + RLS).
 */
@Injectable()
export class WorkspacesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
  ) {}

  private assertOwner(viewer: AuthUser): void {
    if (viewer.accountRole !== 'OWNER') throw new AppError('FORBIDDEN');
  }

  /** Runs `fn` inside workspace `id` as this owner (scoped queries, RLS, audit there). */
  private inside<T>(id: string, viewer: AuthUser, fn: () => Promise<T>): Promise<T> {
    return runInStore(newStore({ workspaceId: id, userId: viewer.id, accountRole: 'OWNER', label: 'owner-workspace' }), fn);
  }

  private async load(id: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id }, select: WS_SELECT });
    if (!ws) throw new AppError('NOT_FOUND');
    return ws;
  }

  async list(status: 'ACTIVE' | 'ARCHIVED' | 'ALL', viewer: AuthUser): Promise<WorkspaceAdminDto[]> {
    this.assertOwner(viewer);
    const rows = await this.prisma.workspace.findMany({
      where: status === 'ALL' ? {} : { status },
      select: WS_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    if (!rows.length) return [];
    const ms = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId: { in: rows.map((r) => r.id) }, archivedAt: null },
      select: { workspaceId: true, userId: true, role: true },
    });
    return rows.map((w) => {
      const mine = ms.filter((m) => m.workspaceId === w.id);
      return {
        id: w.id,
        name: w.name,
        code: w.code,
        status: w.status,
        createdAt: w.createdAt.toISOString(),
        archivedAt: w.archivedAt?.toISOString() ?? null,
        adminCount: new Set(mine.filter((m) => m.role === 'ADMIN').map((m) => m.userId)).size,
        memberCount: new Set(mine.map((m) => m.userId)).size,
      };
    });
  }

  async create(input: { name: string; code?: string }, viewer: AuthUser, ctx: RequestContext): Promise<WorkspaceAdminDto> {
    this.assertOwner(viewer);
    const code = input.code ?? `ws-${randomBytes(4).toString('hex')}`;
    const ws = await withPrismaErrors(() =>
      this.prisma.workspace.create({ data: { name: input.name, code, createdById: viewer.id }, select: WS_SELECT }),
    );
    await this.inside(ws.id, viewer, async () => {
      // Neutral defaults only (the same idempotent seed every workspace gets at start-up).
      const seeded = await seedWorkspaceDefaults(this.prisma as unknown as PrismaClient);
      await this.audit.logCtx(ctx, {
        action: WorkspaceAction.CREATED,
        entityType: 'workspace',
        entityId: ws.id,
        after: { name: ws.name, code: ws.code, defaults: seeded },
      });
    });
    return { ...this.dto(ws), adminCount: 0, memberCount: 0 };
  }

  private dto(w: { id: string; name: string; code: string; status: 'ACTIVE' | 'ARCHIVED'; createdAt: Date; archivedAt: Date | null }) {
    return {
      id: w.id,
      name: w.name,
      code: w.code,
      status: w.status,
      createdAt: w.createdAt.toISOString(),
      archivedAt: w.archivedAt?.toISOString() ?? null,
    };
  }

  private async withCounts(id: string): Promise<WorkspaceAdminDto> {
    const [w] = (await this.list('ALL', { accountRole: 'OWNER' } as AuthUser)).filter((x) => x.id === id);
    if (!w) throw new AppError('NOT_FOUND');
    return w;
  }

  async rename(id: string, name: string, viewer: AuthUser, ctx: RequestContext): Promise<WorkspaceAdminDto> {
    this.assertOwner(viewer);
    const before = await this.load(id);
    if (before.name !== name) {
      await this.prisma.workspace.update({ where: { id }, data: { name } });
      await this.inside(id, viewer, () =>
        this.audit.logCtx(ctx, { action: WorkspaceAction.RENAMED, entityType: 'workspace', entityId: id, before: { name: before.name }, after: { name } }),
      );
    }
    return this.withCounts(id);
  }

  /** Soft archive: nothing is deleted; entering it answers WORKSPACE_ARCHIVED; its sessions end. */
  async archive(id: string, viewer: AuthUser, ctx: RequestContext): Promise<WorkspaceAdminDto> {
    this.assertOwner(viewer);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status FROM workspaces WHERE status = 'ACTIVE'::"WorkspaceStatus" OR id = ${id}::uuid ORDER BY id FOR UPDATE`;
      const target = rows.find((r) => r.id === id);
      if (!target) throw new AppError('NOT_FOUND');
      if (target.status !== 'ACTIVE') return;
      if (rows.filter((r) => r.status === 'ACTIVE').length <= 1) throw new AppError('LAST_WORKSPACE');
      await tx.workspace.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { workspaceId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.inside(id, viewer, () =>
      this.audit.logCtx(ctx, { action: WorkspaceAction.ARCHIVED, entityType: 'workspace', entityId: id, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } }),
    );
    return this.withCounts(id);
  }

  async restore(id: string, viewer: AuthUser, ctx: RequestContext): Promise<WorkspaceAdminDto> {
    this.assertOwner(viewer);
    const before = await this.load(id);
    if (before.status === 'ARCHIVED') {
      await this.prisma.workspace.update({ where: { id }, data: { status: 'ACTIVE', archivedAt: null } });
      await this.inside(id, viewer, () =>
        this.audit.logCtx(ctx, { action: WorkspaceAction.RESTORED, entityType: 'workspace', entityId: id, before: { status: 'ARCHIVED' }, after: { status: 'ACTIVE' } }),
      );
    }
    return this.withCounts(id);
  }

  /** Counts only — computed inside the workspace (scoped). */
  async summary(id: string, viewer: AuthUser): Promise<WorkspaceCountsDto> {
    this.assertOwner(viewer);
    const ws = await this.load(id);
    const ms = await this.prisma.workspaceMembership.findMany({ where: { workspaceId: id, archivedAt: null }, select: { userId: true, role: true } });
    const byRole = Object.fromEntries(WORKSPACE_ROLES.map((r) => [r, 0])) as Record<WorkspaceRole, number>;
    for (const m of ms) byRole[m.role] += 1;
    const pendingRegistrations = await this.prisma.user.count({ where: { requestedWorkspaceId: id, status: 'PENDING' } });
    const counts = await this.inside(id, viewer, async () => {
      const [projects, tasks, teams, members, violations, pendingMemberRequests] = await this.prisma.$transaction([
        this.prisma.project.count({ where: { isTemplate: false, archivedAt: null } }),
        this.prisma.task.count({ where: { archivedAt: null, project: { isTemplate: false } } }),
        this.prisma.team.count({ where: { status: { not: 'ARCHIVED' } } }),
        this.prisma.teamMember.count({ where: { archivedAt: null } }),
        this.prisma.violation.count(),
        this.prisma.memberRequest.count({ where: { status: 'PENDING' } }),
      ]);
      return { projects, tasks, teams, members, violations, pendingMemberRequests };
    });
    return {
      workspace: { id: ws.id, name: ws.name, code: ws.code, status: ws.status },
      users: { total: new Set(ms.map((m) => m.userId)).size, byRole, pendingRegistrations },
      ...counts,
    };
  }

  // ─────────────────────────────────────────── admins (ADMIN memberships)

  async admins(id: string, viewer: AuthUser): Promise<WorkspaceMemberDto[]> {
    this.assertOwner(viewer);
    return (await this.memberships.list(id, viewer)).filter((m) => m.role === 'ADMIN');
  }

  async addAdmin(
    id: string,
    input: { userId?: string; identifier?: string; title?: string; confirmDualRole?: boolean },
    viewer: AuthUser,
    ctx: RequestContext,
  ): Promise<WorkspaceMemberDto> {
    this.assertOwner(viewer);
    return this.memberships.add(id, { ...input, role: 'ADMIN' }, viewer, ctx);
  }

  async removeAdmin(id: string, userId: string, viewer: AuthUser, ctx: RequestContext): Promise<void> {
    this.assertOwner(viewer);
    const m = await this.prisma.workspaceMembership.findFirst({ where: { workspaceId: id, userId, role: 'ADMIN', archivedAt: null }, select: { id: true } });
    if (!m) throw new AppError('NOT_FOUND');
    await this.memberships.remove(id, m.id, viewer, ctx);
  }
}
