import { Injectable } from '@nestjs/common';
import { effectiveRole, type AccountRole, type Role, type WorkspaceRole, type WorkspaceSummaryDto } from '@nuzli/shared';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

export interface WorkspaceAccess {
  workspace: { id: string; name: string; code: string };
  /** Live roles of the user there (owners may have none — they hold everything). */
  roles: WorkspaceRole[];
  /** The matrix role used by `can()`: ADMIN for owners, else the strongest membership role. */
  role: Role | null;
}

/**
 * A12 (ADR-144): who may enter which workspace. The single source for the guard (every request),
 * login/refresh/switch (sessions) and the workspace lists. Memberships and workspaces are global
 * (identity-layer) tables, always filtered here by user AND workspace explicitly.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Workspaces the user can enter: owners every active one; users their live memberships. */
  async accessible(userId: string, accountRole: AccountRole | string): Promise<WorkspaceSummaryDto[]> {
    if (accountRole === 'OWNER') {
      const all = await this.prisma.workspace.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, code: true, memberships: { where: { userId, archivedAt: null, status: 'ACTIVE' }, select: { role: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return all.map((w) => ({ id: w.id, name: w.name, code: w.code, roles: w.memberships.map((m) => m.role) }));
    }
    const rows = await this.prisma.workspaceMembership.findMany({
      where: { userId, archivedAt: null, status: 'ACTIVE', workspace: { status: 'ACTIVE' } },
      select: { role: true, workspace: { select: { id: true, name: true, code: true, createdAt: true } } },
    });
    const byId = new Map<string, WorkspaceSummaryDto & { createdAt: Date }>();
    for (const r of rows) {
      const cur = byId.get(r.workspace.id) ?? { id: r.workspace.id, name: r.workspace.name, code: r.workspace.code, roles: [], createdAt: r.workspace.createdAt };
      cur.roles.push(r.role);
      byId.set(r.workspace.id, cur);
    }
    return [...byId.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ createdAt: _c, ...w }) => w);
  }

  /**
   * The user's access to `workspaceId`, or an AppError: WORKSPACE_ARCHIVED for an archived
   * workspace, WORKSPACE_FORBIDDEN for no live membership (an unknown id answers the same, so
   * workspace ids cannot be probed).
   */
  async resolve(userId: string, accountRole: AccountRole | string, workspaceId: string): Promise<WorkspaceAccess> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        code: true,
        status: true,
        memberships: { where: { userId, archivedAt: null, status: 'ACTIVE' }, select: { role: true } },
      },
    });
    const roles = (ws?.memberships ?? []).map((m) => m.role);
    if (!ws || (accountRole !== 'OWNER' && roles.length === 0)) throw new AppError('WORKSPACE_FORBIDDEN');
    if (ws.status !== 'ACTIVE') throw new AppError('WORKSPACE_ARCHIVED');
    return {
      workspace: { id: ws.id, name: ws.name, code: ws.code },
      roles,
      role: accountRole === 'OWNER' ? 'ADMIN' : effectiveRole(roles),
    };
  }

  /**
   * The workspace a new session binds to: the requested one when allowed, else the only one the
   * user can enter (single-workspace mode), else none (the user picks after login).
   */
  async pick(userId: string, accountRole: AccountRole | string, preferred: string | null): Promise<{ list: WorkspaceSummaryDto[]; active: WorkspaceSummaryDto | null }> {
    const list = await this.accessible(userId, accountRole);
    const active = (preferred ? list.find((w) => w.id === preferred) : undefined) ?? (list.length === 1 ? list[0]! : null);
    return { list, active: active ?? null };
  }

  async activeCount(): Promise<number> {
    return this.prisma.workspace.count({ where: { status: 'ACTIVE' } });
  }

  /** Single-workspace mode (A12): while only one workspace exists the UI shows no workspaces at all. */
  async singleWorkspace(): Promise<boolean> {
    return (await this.activeCount()) <= 1;
  }

  /** The workspace a registration applies to: the requested one, or the only one. */
  async registrationWorkspace(requested: string | undefined): Promise<string> {
    if (requested) {
      const ws = await this.prisma.workspace.findUnique({ where: { id: requested }, select: { id: true, status: true } });
      if (!ws || ws.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', { fieldErrors: { workspaceId: ['اختر قسمًا من القائمة'] } });
      return ws.id;
    }
    const all = await this.prisma.workspace.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 2, orderBy: { createdAt: 'asc' } });
    if (all.length !== 1) throw new AppError('VALIDATION_FAILED', { fieldErrors: { workspaceId: ['اختر القسم الذي تتقدّم إليه'] } });
    return all[0]!.id;
  }
}
