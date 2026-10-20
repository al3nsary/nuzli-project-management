import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PARTICIPANT_CANDIDATES_LIMIT, type MyParticipationDto, type ParticipantCandidateDto, type ParticipantDto, type ParticipantLevel, type PermissionSubject } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { displayRole, isDualRole } from '../users/user-dto';
import { ProjectStore } from './project-store';

type Viewer = PermissionSubject & { id: string };

export const ParticipantAction = {
  ADDED: 'project.participant_added',
  UPDATED: 'project.participant_updated',
  REMOVED: 'project.participant_removed',
} as const;

const ROW = {
  projectId: true,
  title: true,
  level: true,
  createdAt: true,
  user: { select: { id: true, username: true, fullName: true, photoFileId: true } },
  addedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ProjectParticipantSelect;

type Row = Prisma.ProjectParticipantGetPayload<{ select: typeof ROW }>;

function toDto(r: Row): ParticipantDto {
  return {
    projectId: r.projectId,
    user: { id: r.user.id, username: r.user.username, fullName: r.user.fullName, hasPhoto: !!r.user.photoFileId },
    title: r.title,
    level: r.level,
    addedBy: r.addedBy ? { id: r.addedBy.id, fullName: r.addedBy.fullName } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * A12 round 2 — project participants (المشاركون): an admin (or an assistant with projects:edit)
 * grants a person ONE project with a free-text position (منصب) and a level — محرّر / مساهم /
 * مطّلع. The person must be a live member of the workspace (any role); an explicit grant, kept
 * apart from the supervisors' «مهامي» model. Audited; the person is notified.
 */
@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** `GET /me/participations` — the caller's live (non-archived, non-template) project grants here. */
  async mine(viewer: Viewer): Promise<MyParticipationDto[]> {
    const rows = await this.prisma.projectParticipant.findMany({
      where: { userId: viewer.id, project: { archivedAt: null, isTemplate: false } },
      select: { projectId: true, title: true, level: true, project: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ projectId: r.projectId, projectName: r.project.name, title: r.title, level: r.level }));
  }

  async list(projectId: string, viewer: Viewer): Promise<ParticipantDto[]> {
    await this.store.visibleProject(projectId, viewer);
    const rows = await this.prisma.projectParticipant.findMany({ where: { projectId }, select: ROW, orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  /**
   * A12 round 3 — `GET /projects/:id/participant-candidates?q=`: the people who can be added to this
   * project, for whoever may manage its participants (`projects.manage` + the project in scope —
   * an assistant limited to other projects gets 404). The same rule as `add`: an ACTIVE account
   * with a live, ACTIVE membership of THIS workspace, not yet a participant. Minimal data only
   * (id, name, username, photo flag, role here, the dual-role flag) — never e-mail, mobile,
   * national ID or anything about other workspaces.
   */
  async candidates(projectId: string, q: string | undefined, viewer: Viewer): Promise<ParticipantCandidateDto[]> {
    await this.store.visibleProject(projectId, viewer);
    const ws = activeWorkspaceId();
    const taken = await this.prisma.projectParticipant.findMany({ where: { projectId }, select: { userId: true } });
    const term = q?.trim();
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        archivedAt: null,
        memberships: { some: { workspaceId: ws, archivedAt: null, status: 'ACTIVE' } },
        ...(taken.length ? { id: { notIn: taken.map((t) => t.userId) } } : {}),
        ...(term
          ? { OR: [{ fullName: { contains: term, mode: 'insensitive' as const } }, { username: { contains: term.toLowerCase() } }] }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        username: true,
        photoFileId: true,
        accountRole: true,
        requestedRole: true,
        // Every live membership: the role shown is THIS workspace's; the others only count for the badge.
        memberships: { where: { archivedAt: null }, select: { workspaceId: true, role: true, status: true } },
      },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: PARTICIPANT_CANDIDATES_LIMIT,
    });
    return rows.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      username: u.username,
      hasPhoto: !!u.photoFileId,
      role: displayRole(u, ws) ?? 'MEMBER',
      ...(isDualRole(u) ? { dualRole: true } : {}),
    }));
  }

  private async assertMember(userId: string): Promise<{ id: string; fullName: string }> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', memberships: { some: { workspaceId: activeWorkspaceId(), archivedAt: null, status: 'ACTIVE' } } },
      select: { id: true, fullName: true },
    });
    if (!u) throw new AppError('PARTICIPANT_NOT_MEMBER');
    return u;
  }

  async add(projectId: string, input: { userId: string; title: string; level: ParticipantLevel }, viewer: Viewer, ctx: RequestContext): Promise<ParticipantDto> {
    const project = await this.store.visibleProject(projectId, viewer);
    if (project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    await this.assertMember(input.userId);
    if (await this.prisma.projectParticipant.findUnique({ where: { projectId_userId: { projectId, userId: input.userId } }, select: { userId: true } })) {
      throw new AppError('PARTICIPANT_EXISTS');
    }
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.projectParticipant.create({
          data: { projectId, userId: input.userId, title: input.title, level: input.level, addedById: viewer.id },
          select: ROW,
        });
        await this.audit.logCtx(
          ctx,
          { action: ParticipantAction.ADDED, entityType: 'project', entityId: projectId, after: { userId: input.userId, title: input.title, level: input.level } },
          tx,
        );
        return created;
      }),
    );
    this.notifications.safe(
      this.notifications.notify([input.userId], 'PROJECT_PARTICIPANT_ADDED', { projectId, projectName: project.name, level: input.level, title: input.title }),
    );
    return toDto(row);
  }

  async update(
    projectId: string,
    userId: string,
    patch: { title?: string; level?: ParticipantLevel },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<ParticipantDto> {
    await this.store.visibleProject(projectId, viewer);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.projectParticipant.findUnique({ where: { projectId_userId: { projectId, userId } }, select: ROW });
      if (!before) throw new AppError('NOT_FOUND');
      const after = await tx.projectParticipant.update({
        where: { projectId_userId: { projectId, userId } },
        data: { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.level !== undefined ? { level: patch.level } : {}) },
        select: ROW,
      });
      await this.audit.logCtx(
        ctx,
        {
          action: ParticipantAction.UPDATED,
          entityType: 'project',
          entityId: projectId,
          before: { userId, title: before.title, level: before.level },
          after: { userId, title: after.title, level: after.level },
        },
        tx,
      );
      return toDto(after);
    });
  }

  async remove(projectId: string, userId: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.store.visibleProject(projectId, viewer);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.projectParticipant.findUnique({ where: { projectId_userId: { projectId, userId } }, select: ROW });
      if (!before) throw new AppError('NOT_FOUND');
      await tx.projectParticipant.delete({ where: { projectId_userId: { projectId, userId } } });
      await this.audit.logCtx(
        ctx,
        { action: ParticipantAction.REMOVED, entityType: 'project', entityId: projectId, before: { userId, title: before.title, level: before.level } },
        tx,
      );
    });
  }
}
