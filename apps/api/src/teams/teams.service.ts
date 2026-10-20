import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, TeamStatus, VisibilityMode } from '@prisma/client';
import {
  can,
  type SupervisorHistoryDto,
  type TeamDetailDto,
  type TeamDto,
  type TeamSupervisorsDto,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { mapPrismaError } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { ColorsService } from '../colors/colors.service';
import { CryptoService } from '../crypto/crypto.service';
import { hideDuplicateNationalId, insertMembers, moveMembersInTx, type MemberInputData } from '../members/member-writes';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { UserRow } from '../users/user-dto';
import { UsersService } from '../users/users.service';
import {
  assertTeamManageable,
  assertTeamReadable,
  canManageAllTeams,
  canReadAllTeams,
  LEADERS_SELECT,
  leaderIds,
  ledByWhere,
  MEMBER_SELECT,
  OPEN_LEADERS,
  RESERVING,
  TEAM_SELECT,
  toMemberDto,
  toSupervisorDtos,
  toTeamDto,
  type Viewer,
} from './team-dto';
import { closeLeaderRow, openLeaders, resolveCreateLeaders, switchPrimary } from './team-leaders';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { supervisorsOf } from '../users/user-dto';

type Tx = Prisma.TransactionClient;

/** `createTeamSchema` output (zod defaults applied). */
export interface CreateTeamData {
  name: string;
  colorId: string;
  supervisorId?: string;
  newSupervisor?: { fullName: string; email: string; mobile: string; nationalId: string };
  supervisorIds?: string[];
  primarySupervisorId?: string;
  orgUnitId?: string;
  members: MemberInputData[];
  existingMemberIds: string[];
}

export interface TeamListQuery {
  status?: TeamStatus | 'ALL';
  q?: string;
}

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly colors: ColorsService,
  ) {}

  // ─────────────────────────────────────────── reads

  async list(query: TeamListQuery, viewer: Viewer): Promise<TeamDto[]> {
    const where: Prisma.TeamWhereInput = {
      // A9 (ADR-100): a supervisor sees every team they lead, primary or not.
      ...(canReadAllTeams(viewer) ? {} : ledByWhere(viewer.id)),
      // Default: the teams that matter today (active + pending). ARCHIVED or ALL on request.
      ...(query.status === 'ALL' ? {} : { status: query.status ? query.status : { in: RESERVING } }),
      ...(query.q ? { name: { contains: query.q.trim(), mode: 'insensitive' as const } } : {}),
    };
    const rows = await this.prisma.team.findMany({
      where,
      select: TEAM_SELECT,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    return rows.map(toTeamDto);
  }

  async get(id: string, viewer: Viewer): Promise<TeamDetailDto> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: TEAM_SELECT });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamReadable(viewer, { supervisors: team.supervisors });
    return this.detail(this.prisma, team);
  }

  private async detail(db: Tx | PrismaService, team: Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>): Promise<TeamDetailDto> {
    const members = await db.teamMember.findMany({
      where: { archivedAt: null, memberships: { some: { teamId: team.id, validTo: null } } },
      select: MEMBER_SELECT,
      orderBy: { fullName: 'asc' },
    });
    const dtos = members.map((m) => toMemberDto(m));
    // The foreman first, then the workers by name (ADR-101: clearly distinguished among the names).
    dtos.sort((a, b) => Number(!!b.isForeman) - Number(!!a.isForeman));
    const foreman = dtos.find((m) => m.isForeman);
    return {
      ...toTeamDto(team),
      members: dtos,
      foreman: foreman ? { id: foreman.id, fullName: foreman.fullName } : null,
    };
  }

  /** Every leadership row of the team (all supervisors, primary or not), newest first. */
  async supervisorHistory(id: string, viewer: Viewer): Promise<SupervisorHistoryDto[]> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { supervisors: OPEN_LEADERS } });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamReadable(viewer, team);
    const rows = await this.prisma.teamSupervisor.findMany({
      where: { teamId: id },
      orderBy: [{ validFrom: 'desc' }, { isPrimary: 'desc' }],
      include: { user: { select: { id: true, fullName: true } } },
    });
    const changers = [...new Set(rows.map((r) => r.addedById).filter((v): v is string => !!v))];
    const names = changers.length
      ? await this.prisma.user.findMany({ where: { id: { in: changers } }, select: { id: true, fullName: true } })
      : [];
    const byId = new Map(names.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      supervisor: { id: r.user.id, fullName: r.user.fullName },
      isPrimary: r.isPrimary,
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo?.toISOString() ?? null,
      changedBy: r.addedById ? (byId.get(r.addedById) ?? null) : null,
      reason: r.reason,
    }));
  }

  /** `GET /teams/:id/supervisors` — the current supervisors and the full history. */
  async supervisors(id: string, viewer: Viewer): Promise<TeamSupervisorsDto> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { supervisors: LEADERS_SELECT } });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamReadable(viewer, team);
    return { current: toSupervisorDtos(team.supervisors), history: await this.supervisorHistory(id, viewer) };
  }

  // ─────────────────────────────────────────── create (brief §5.1, A9 ADR-100)

  async create(input: CreateTeamData, viewer: Viewer, ctx: RequestContext): Promise<TeamDto> {
    const isAdmin = can(viewer, 'teams.create');
    if (!isAdmin && !can(viewer, 'teams.createOwn')) throw new AppError('FORBIDDEN');
    if (isAdmin && !input.supervisorId && !input.newSupervisor && !input.supervisorIds?.length) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { supervisorId: ['اختر مشرفًا موجودًا أو أنشئ مشرفًا جديدًا'] },
      });
    }
    if (!isAdmin && input.orgUnitId) throw new AppError('FORBIDDEN', { field: 'orgUnitId' });
    const status: TeamStatus = isAdmin
      ? 'ACTIVE'
      : (await this.settings.get('REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS'))
        ? 'PENDING_APPROVAL'
        : 'ACTIVE';
    const allowMultiple = await this.settings.get('ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR');

    const result = await hideDuplicateNationalId(viewer, this.audit, ctx, { via: 'teams.create' }, () =>
      this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const t = new Date();
        let newSupervisor: { user: UserRow; token: string } | null = null;
        if (isAdmin && input.newSupervisor) {
          newSupervisor = await this.users.createInTx(tx, { ...input.newSupervisor, role: 'SUPERVISOR' }, viewer, ctx);
        }
        // A supervisor creates a team for themselves (brief §5.1); an admin names one or more leaders.
        const leaders = resolveCreateLeaders({
          isAdmin,
          viewerId: viewer.id,
          newSupervisorId: newSupervisor?.user.id ?? null,
          supervisorId: input.supervisorId,
          supervisorIds: input.supervisorIds,
          primarySupervisorId: input.primarySupervisorId,
        });
        for (const userId of leaders.ids) {
          if (userId === newSupervisor?.user.id) continue;
          if (isAdmin) await this.assertSupervisor(tx, userId);
          if (!allowMultiple) await this.assertNoOtherTeam(tx, userId, null);
        }
        await this.assertColorFree(tx, input.colorId, null);
        if (input.orgUnitId) await this.assertOrgUnitUsable(tx, input.orgUnitId);

        if (input.existingMemberIds.length) {
          await this.assertExistingMembersUsable(tx, input.existingMemberIds, viewer);
        }

        const team = await tx.team.create({
          data: {
            name: input.name,
            colorId: input.colorId,
            supervisorId: leaders.primary,
            status,
            orgUnitId: input.orgUnitId ?? null,
            ...(status === 'ACTIVE' ? { approvedAt: t, approvedById: viewer.id } : {}),
            createdById: viewer.id,
          },
          select: { id: true },
        });
        await tx.teamSupervisor.createMany({
          data: leaders.ids.map((userId) => ({
            teamId: team.id,
            userId,
            isPrimary: userId === leaders.primary,
            validFrom: t,
            addedById: viewer.id,
          })),
        });
        const newIds = await insertMembers(tx, this.crypto, input.members, {
          teamId: team.id,
          at: t,
          actorId: viewer.id,
        });
        const moves = await moveMembersInTx(tx, input.existingMemberIds, team.id, {
          at: t,
          actorId: viewer.id,
          reason: 'إنشاء فريق جديد',
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_CREATED,
            entityType: 'team',
            entityId: team.id,
            after: {
              name: input.name,
              colorId: input.colorId,
              status,
              supervisorId: leaders.primary,
              supervisorIds: leaders.ids,
              orgUnitId: input.orgUnitId ?? null,
              newSupervisor: !!newSupervisor,
              newMemberIds: newIds,
              movedMembers: moves,
            },
          },
          tx,
        );
        await this.logForemenCleared(tx, ctx, moves, 'إنشاء فريق جديد');
        const row = await tx.team.findUniqueOrThrow({ where: { id: team.id }, select: TEAM_SELECT });
        return { row, newSupervisor };
      }),
      ),
    );

    if (result.newSupervisor) {
      await this.users
        .sendSetPasswordEmail(result.newSupervisor.user, result.newSupervisor.token)
        .catch((err: Error) => this.logger.warn(`Set-password e-mail failed: ${err.message}`));
    }
    if (status === 'PENDING_APPROVAL') {
      this.notifications.safe(
        this.notifications.notifyAdmins('TEAM_PENDING_APPROVAL', {
          teamId: result.row.id,
          teamName: result.row.name,
          supervisorName: result.row.supervisor?.fullName ?? '',
        }),
      );
    }
    return toTeamDto(result.row);
  }

  // ─────────────────────────────────────────── edit

  async update(
    id: string,
    patch: { name?: string; colorId?: string; orgUnitId?: string | null },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const row = await this.guard(
      () =>
        this.prisma.$transaction(async (tx) => {
          const before = await this.loadForWrite(tx, id, viewer);
          if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
          const data: Prisma.TeamUncheckedUpdateInput = {};
          const beforeAudit: Record<string, unknown> = {};
          if (patch.name !== undefined && patch.name !== before.name) {
            data.name = patch.name;
            beforeAudit.name = before.name;
          }
          if (patch.colorId !== undefined && patch.colorId !== before.colorId) {
            await this.assertColorFree(tx, patch.colorId, id);
            data.colorId = patch.colorId;
            beforeAudit.colorId = before.colorId;
          }
          if (patch.orgUnitId !== undefined && patch.orgUnitId !== before.orgUnitId) {
            // The organisational link is an admin decision (ADR-102).
            if (!canManageAllTeams(viewer)) throw new AppError('FORBIDDEN', { field: 'orgUnitId' });
            if (patch.orgUnitId) await this.assertOrgUnitUsable(tx, patch.orgUnitId);
            data.orgUnitId = patch.orgUnitId;
            beforeAudit.orgUnitId = before.orgUnitId;
          }
          if (!Object.keys(data).length) return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
          const after = await tx.team.update({ where: { id }, data, select: TEAM_SELECT });
          await this.audit.logCtx(
            ctx,
            { action: AuditAction.TEAM_UPDATED, entityType: 'team', entityId: id, before: beforeAudit, after: data },
            tx,
          );
          return after;
        }),
      id,
    );
    return toTeamDto(row);
  }

  // ─────────────────────────────────────────── approval workflow

  async approve(id: string, viewer: Viewer, ctx: RequestContext): Promise<TeamDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.team.findUnique({ where: { id }, select: { status: true } });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status !== 'PENDING_APPROVAL') throw new AppError('NOT_PENDING_TEAM');
      const claimed = await tx.team.updateMany({
        where: { id, status: 'PENDING_APPROVAL' },
        data: { status: 'ACTIVE', approvedAt: new Date(), approvedById: viewer.id },
      });
      if (claimed.count !== 1) throw new AppError('NOT_PENDING_TEAM');
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TEAM_APPROVED,
          entityType: 'team',
          entityId: id,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'ACTIVE' },
        },
        tx,
      );
      return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });
    this.notifications.safe(
      this.notifications.notify(this.recipients(row), 'TEAM_APPROVED', { teamId: row.id, teamName: row.name }),
    );
    return toTeamDto(row);
  }

  /** Rejecting a pending team archives it: the colour is freed and its memberships closed. */
  async reject(id: string, reason: string, ctx: RequestContext): Promise<TeamDto> {
    const { row, leaders } = await this.prisma.$transaction(async (tx) => {
      const before = await tx.team.findUnique({ where: { id }, select: { status: true, supervisors: OPEN_LEADERS } });
      if (!before) throw new AppError('NOT_FOUND');
      if (before.status !== 'PENDING_APPROVAL') throw new AppError('NOT_PENDING_TEAM');
      const closed = await this.closeTeam(tx, id, 'PENDING_APPROVAL');
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TEAM_REJECTED,
          entityType: 'team',
          entityId: id,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'ARCHIVED', reason, closedMemberships: closed },
        },
        tx,
      );
      return { row: await tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT }), leaders: leaderIds(before) };
    });
    this.notifications.safe(
      this.notifications.notify(leaders.length ? leaders : [row.supervisorId], 'TEAM_REJECTED', {
        teamId: row.id,
        teamName: row.name,
        reason,
      }),
    );
    return toTeamDto(row);
  }

  async archive(id: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<TeamDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await this.loadForWrite(tx, id, viewer);
      if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
      const closed = await this.closeTeam(tx, id, before.status);
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TEAM_ARCHIVED,
          entityType: 'team',
          entityId: id,
          before: { status: before.status },
          after: { status: 'ARCHIVED', reason, closedMemberships: closed },
        },
        tx,
      );
      return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });
    return toTeamDto(row);
  }

  /**
   * ARCHIVED frees the colour (the partial unique index only covers ACTIVE/PENDING). Open
   * memberships and every open supervisor row are closed with one timestamp, so the members
   * become "unassigned" (the foreman flag ends with the membership) and history stays contiguous.
   */
  private async closeTeam(tx: Tx, id: string, from: TeamStatus): Promise<number> {
    const t = new Date();
    const claimed = await tx.team.updateMany({
      where: { id, status: from },
      data: { status: 'ARCHIVED', archivedAt: t },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT_VERSION');
    const closed = await tx.teamMembership.updateMany({ where: { teamId: id, validTo: null }, data: { validTo: t } });
    await tx.teamSupervisor.updateMany({ where: { teamId: id, validTo: null }, data: { validTo: t } });
    return closed.count;
  }

  // ─────────────────────────────────────────── supervisors (brief §5.3, A9 ADR-100)

  /**
   * Legacy `POST /teams/:id/supervisor`: replaces the primary supervisor. The previous primary
   * stops leading the team; co-supervisors are kept. Same instant for every row (ADR-013).
   */
  async changeSupervisor(
    id: string,
    input: { supervisorId: string; reason?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const allowMultiple = await this.settings.get('ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR');
    const row = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.loadForWrite(tx, id, viewer);
        if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        await this.lockTeam(tx, id);
        let rows = await openLeaders(tx, id);
        const primary = rows.find((r) => r.isPrimary);
        if (primary?.userId === input.supervisorId) {
          return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
        }
        await this.assertSupervisor(tx, input.supervisorId);
        if (!allowMultiple) await this.assertNoOtherTeam(tx, input.supervisorId, id);
        const t = new Date();
        if (!rows.some((r) => r.userId === input.supervisorId)) {
          await tx.teamSupervisor.create({
            data: { teamId: id, userId: input.supervisorId, isPrimary: false, validFrom: t, addedById: viewer.id, reason: input.reason ?? null },
          });
          rows = await openLeaders(tx, id);
        }
        await switchPrimary(tx, id, rows, input.supervisorId, t, {
          actorId: viewer.id,
          reason: input.reason ?? null,
          removeOld: true,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_SUPERVISOR_CHANGED,
            entityType: 'team',
            entityId: id,
            before: { supervisorId: before.supervisorId },
            after: { supervisorId: input.supervisorId, reason: input.reason ?? null },
          },
          tx,
        );
        return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
      }),
    );
    return toTeamDto(row);
  }

  /** `POST /teams/:id/supervisors` — adds a co-supervisor (or a new primary with `isPrimary`). */
  async addSupervisor(
    id: string,
    input: { userId: string; isPrimary: boolean; reason?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const allowMultiple = await this.settings.get('ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR');
    const row = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.loadForWrite(tx, id, viewer);
        if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        await this.lockTeam(tx, id);
        const rows = await openLeaders(tx, id);
        if (rows.some((r) => r.userId === input.userId)) throw new AppError('SUPERVISOR_ALREADY_IN_TEAM');
        await this.assertSupervisor(tx, input.userId);
        // The setting applies per person: someone who leads another live team cannot be added.
        if (!allowMultiple) await this.assertNoOtherTeam(tx, input.userId, id);
        const t = new Date();
        const isPrimary = input.isPrimary || !rows.length;
        await tx.teamSupervisor.create({
          data: { teamId: id, userId: input.userId, isPrimary: false, validFrom: t, addedById: viewer.id, reason: input.reason ?? null },
        });
        let fromUserId: string | null = null;
        if (isPrimary) {
          const fresh = await openLeaders(tx, id);
          ({ fromUserId } = await switchPrimary(tx, id, fresh, input.userId, t, { actorId: viewer.id, reason: input.reason ?? null }));
        }
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_SUPERVISOR_ADDED,
            entityType: 'team',
            entityId: id,
            before: { supervisorIds: rows.map((r) => r.userId), primaryId: rows.find((r) => r.isPrimary)?.userId ?? null },
            after: { userId: input.userId, isPrimary, previousPrimaryId: fromUserId, reason: input.reason ?? null },
          },
          tx,
        );
        return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
      }),
    );
    return toTeamDto(row);
  }

  /**
   * `DELETE /teams/:id/supervisors/:userId`. The last supervisor of a live team cannot be removed
   * (`LAST_SUPERVISOR`); removing the primary needs `newPrimaryUserId`, another current supervisor
   * (`PRIMARY_SUPERVISOR_REQUIRED`), so a live team always has exactly one primary.
   */
  async removeSupervisor(
    id: string,
    userId: string,
    input: { reason: string; newPrimaryUserId?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const row = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.loadForWrite(tx, id, viewer);
        if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        await this.lockTeam(tx, id);
        const rows = await openLeaders(tx, id);
        const target = rows.find((r) => r.userId === userId);
        if (!target) throw new AppError('NOT_FOUND', { field: 'userId' });
        if (rows.length === 1) throw new AppError('LAST_SUPERVISOR');
        const t = new Date();
        if (target.isPrimary) {
          const next = input.newPrimaryUserId;
          if (!next || next === userId) throw new AppError('PRIMARY_SUPERVISOR_REQUIRED', { field: 'newPrimaryUserId' });
          if (!rows.some((r) => r.userId === next)) {
            throw new AppError('VALIDATION_FAILED', {
              fieldErrors: { newPrimaryUserId: ['اختر المشرف الرئيسي البديل من مشرفي الفريق الحاليين'] },
            });
          }
          await switchPrimary(tx, id, rows, next, t, { actorId: viewer.id, reason: input.reason, removeOld: true });
        } else {
          await closeLeaderRow(tx, target, t);
        }
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_SUPERVISOR_REMOVED,
            entityType: 'team',
            entityId: id,
            before: { userId, wasPrimary: target.isPrimary },
            after: {
              reason: input.reason,
              primaryId: target.isPrimary ? input.newPrimaryUserId : (rows.find((r) => r.isPrimary)?.userId ?? null),
            },
          },
          tx,
        );
        return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
      }),
    );
    return toTeamDto(row);
  }

  /** `POST /teams/:id/supervisors/:userId/primary` — the user must already lead the team. */
  async setPrimarySupervisor(
    id: string,
    userId: string,
    input: { reason?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const row = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.loadForWrite(tx, id, viewer);
        if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        await this.lockTeam(tx, id);
        const rows = await openLeaders(tx, id);
        const target = rows.find((r) => r.userId === userId);
        if (!target) throw new AppError('NOT_FOUND', { field: 'userId' });
        if (target.isPrimary) return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
        const { fromUserId } = await switchPrimary(tx, id, rows, userId, new Date(), {
          actorId: viewer.id,
          reason: input.reason ?? null,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_PRIMARY_SUPERVISOR_CHANGED,
            entityType: 'team',
            entityId: id,
            before: { primaryId: fromUserId },
            after: { primaryId: userId, reason: input.reason ?? null },
          },
          tx,
        );
        return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
      }),
    );
    return toTeamDto(row);
  }

  // ─────────────────────────────────────────── worker foreman (A9, ADR-101)

  /**
   * `POST /teams/:id/foreman` (admin or a supervisor leading the team). The foreman is a current
   * member of the team marked on their open membership; setting a new one replaces the old one.
   * A member record only: no account, no permissions — a member linked to a user is refused.
   */
  async setForeman(id: string, memberId: string, viewer: Viewer, ctx: RequestContext): Promise<TeamDetailDto> {
    return this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.loadForWrite(tx, id, viewer);
        if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        await this.lockTeam(tx, id);
        const membership = await tx.teamMembership.findFirst({
          where: { teamId: id, memberId, validTo: null, member: { archivedAt: null } },
          select: { id: true, role: true, member: { select: { userId: true } } },
        });
        if (!membership) throw new AppError('FOREMAN_NOT_MEMBER');
        if (membership.member.userId) throw new AppError('FOREMAN_HAS_ACCOUNT');
        if (membership.role !== 'FOREMAN') {
          const current = await tx.teamMembership.findFirst({
            where: { teamId: id, validTo: null, role: 'FOREMAN' },
            select: { id: true, memberId: true },
          });
          if (current) await tx.teamMembership.update({ where: { id: current.id }, data: { role: 'WORKER' } });
          await tx.teamMembership.update({ where: { id: membership.id }, data: { role: 'FOREMAN' } });
          await this.audit.logCtx(
            ctx,
            {
              action: AuditAction.TEAM_FOREMAN_SET,
              entityType: 'team',
              entityId: id,
              before: { foremanId: current?.memberId ?? null },
              after: { foremanId: memberId },
            },
            tx,
          );
        }
        const team = await tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
        return this.detail(tx, team);
      }),
    );
  }

  /** `DELETE /teams/:id/foreman` — no foreman → nothing to do. */
  async clearForeman(id: string, viewer: Viewer, ctx: RequestContext): Promise<TeamDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.loadForWrite(tx, id, viewer);
      const current = await tx.teamMembership.findFirst({
        where: { teamId: id, validTo: null, role: 'FOREMAN' },
        select: { id: true, memberId: true },
      });
      if (current) {
        await tx.teamMembership.update({ where: { id: current.id }, data: { role: 'WORKER' } });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.TEAM_FOREMAN_CLEARED,
            entityType: 'team',
            entityId: id,
            before: { foremanId: current.memberId },
            after: { foremanId: null },
          },
          tx,
        );
      }
      const team = await tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
      return this.detail(tx, team);
    });
  }

  /** Moving the foreman out of a team ends the flag with the closed membership (audited here). */
  private async logForemenCleared(
    tx: Tx,
    ctx: RequestContext,
    moves: ReadonlyArray<{ memberId: string; fromTeamId: string | null; wasForeman?: boolean }>,
    reason: string,
  ): Promise<void> {
    for (const m of moves) {
      if (!m.wasForeman || !m.fromTeamId) continue;
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TEAM_FOREMAN_CLEARED,
          entityType: 'team',
          entityId: m.fromTeamId,
          before: { foremanId: m.memberId },
          after: { foremanId: null, reason },
        },
        tx,
      );
    }
  }

  // ─────────────────────────────────────────── violation visibility override (brief §7.6)

  async setVisibility(id: string, mode: VisibilityMode, viewer: Viewer, ctx: RequestContext): Promise<TeamDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.loadForWrite(tx, id, viewer);
      const before = await tx.violationVisibility.findUnique({ where: { teamId: id } });
      await tx.violationVisibility.upsert({
        where: { teamId: id },
        create: { teamId: id, mode, updatedById: viewer.id },
        update: { mode, updatedById: viewer.id },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TEAM_VISIBILITY_CHANGED,
          entityType: 'team',
          entityId: id,
          before: { mode: before?.mode ?? 'INHERIT' },
          after: { mode },
        },
        tx,
      );
      return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });
    return toTeamDto(row);
  }

  // ─────────────────────────────────────────── helpers

  /** Notification recipients for a team: every current supervisor (fallback: the primary column). */
  private recipients(row: { supervisorId: string; supervisors: ReadonlyArray<{ userId: string }> }): string[] {
    const ids = leaderIds(row);
    return ids.length ? ids : [row.supervisorId];
  }

  private async loadForWrite(tx: Tx, id: string, viewer: Viewer) {
    const team = await tx.team.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        colorId: true,
        status: true,
        supervisorId: true,
        orgUnitId: true,
        supervisors: OPEN_LEADERS,
      },
    });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamManageable(viewer, team);
    return team;
  }

  /** Serialises leadership and foreman changes of one team (READ COMMITTED + row lock, ADR-030). */
  private async lockTeam(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM teams WHERE id = ${id}::uuid AND workspace_id = ${activeWorkspaceId()}::uuid FOR UPDATE`;
  }

  private async assertSupervisor(tx: Tx, userId: string): Promise<void> {
    // A12: a SUPERVISOR of this workspace (the DB trigger checks the membership too).
    const user = await tx.user.findFirst({ where: { id: userId, ...supervisorsOf(activeWorkspaceId()) }, select: { id: true } });
    if (!user) throw new AppError('NOT_A_SUPERVISOR');
  }

  /**
   * ADR-023: with ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR off, a person leads one live team — as
   * primary or co-supervisor (A9: the setting applies per user).
   */
  private async assertNoOtherTeam(tx: Tx, userId: string, exceptTeamId: string | null): Promise<void> {
    const other = await tx.team.findFirst({
      where: {
        ...ledByWhere(userId),
        status: { in: RESERVING },
        ...(exceptTeamId ? { id: { not: exceptTeamId } } : {}),
      },
      select: { id: true },
    });
    if (other) throw new AppError('MULTIPLE_TEAMS_DISABLED', { userId });
  }

  private async assertOrgUnitUsable(tx: Tx, unitId: string): Promise<void> {
    const unit = await tx.orgUnit.findUnique({ where: { id: unitId }, select: { archivedAt: true } });
    if (!unit) throw new AppError('VALIDATION_FAILED', { fieldErrors: { orgUnitId: ['الوحدة التنظيمية غير موجودة'] } });
    if (unit.archivedAt) throw new AppError('ORG_UNIT_ARCHIVED');
  }

  /**
   * Friendly pre-check; the partial unique index `teams_color_reserved_uq` is the real guard
   * against two concurrent creations (its violation is mapped in `guard`).
   */
  private async assertColorFree(tx: Tx, colorId: string, exceptTeamId: string | null): Promise<void> {
    const color = await tx.teamColor.findUnique({ where: { id: colorId }, select: { isActive: true } });
    if (!color) throw new AppError('VALIDATION_FAILED', { fieldErrors: { colorId: ['اللون غير موجود'] } });
    if (!color.isActive) throw new AppError('COLOR_INACTIVE');
    const holder = await tx.team.findFirst({
      where: { colorId, status: { in: RESERVING }, ...(exceptTeamId ? { id: { not: exceptTeamId } } : {}) },
      select: { id: true },
    });
    if (holder) throw new AppError('COLOR_TAKEN');
  }

  /** Existing members joining a new team: they must exist; a supervisor may only take unassigned or own-team members. */
  private async assertExistingMembersUsable(tx: Tx, ids: string[], viewer: Viewer): Promise<void> {
    const unique = [...new Set(ids)];
    const rows = await tx.teamMember.findMany({
      where: { id: { in: unique }, archivedAt: null },
      select: { id: true, memberships: { where: { validTo: null }, select: { team: { select: { supervisors: OPEN_LEADERS } } } } },
    });
    if (rows.length !== unique.length) throw new AppError('NOT_FOUND', { field: 'existingMemberIds' });
    if (can(viewer, 'members.move')) return;
    const foreign = rows.filter((r) => r.memberships[0] && !leaderIds(r.memberships[0].team).includes(viewer.id));
    if (foreign.length) throw new AppError('FORBIDDEN', { memberIds: foreign.map((f) => f.id) });
  }

  /** Maps database errors: colour race → COLOR_TAKEN with a fresh list; triggers → their codes. */
  private async guard<T>(fn: () => Promise<T>, excludeTeamId?: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const mapped = err instanceof AppError ? err : mapPrismaError(err);
      if (mapped?.code === 'COLOR_TAKEN') throw await this.colors.colorTakenError(excludeTeamId);
      if (!mapped && err instanceof Error && /NOT_A_SUPERVISOR/.test(err.message)) {
        throw new AppError('NOT_A_SUPERVISOR');
      }
      if (!mapped && err instanceof Error && /FOREMAN_HAS_ACCOUNT/.test(err.message)) {
        throw new AppError('FOREMAN_HAS_ACCOUNT');
      }
      throw mapped ?? err;
    }
  }
}
