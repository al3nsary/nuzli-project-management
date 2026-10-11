import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, TeamStatus, VisibilityMode } from '@prisma/client';
import {
  can,
  type SupervisorHistoryDto,
  type TeamDetailDto,
  type TeamDto,
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
  canReadAllTeams,
  MEMBER_SELECT,
  RESERVING,
  TEAM_SELECT,
  toMemberDto,
  toTeamDto,
  type Viewer,
} from './team-dto';

type Tx = Prisma.TransactionClient;

/** `createTeamSchema` output (zod defaults applied). */
export interface CreateTeamData {
  name: string;
  colorId: string;
  supervisorId?: string;
  newSupervisor?: { fullName: string; email: string; mobile: string; nationalId: string };
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
      ...(canReadAllTeams(viewer) ? {} : { supervisorId: viewer.id }),
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
    assertTeamReadable(viewer, team);
    const members = await this.prisma.teamMember.findMany({
      where: { archivedAt: null, memberships: { some: { teamId: id, validTo: null } } },
      select: MEMBER_SELECT,
      orderBy: { fullName: 'asc' },
    });
    return { ...toTeamDto(team), members: members.map((m) => toMemberDto(m)) };
  }

  async supervisorHistory(id: string, viewer: Viewer): Promise<SupervisorHistoryDto[]> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { supervisorId: true } });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamReadable(viewer, team);
    const rows = await this.prisma.teamSupervisorHistory.findMany({
      where: { teamId: id },
      orderBy: { validFrom: 'desc' },
      include: { supervisor: { select: { id: true, fullName: true } } },
    });
    const changers = [...new Set(rows.map((r) => r.changedById).filter((v): v is string => !!v))];
    const names = changers.length
      ? await this.prisma.user.findMany({ where: { id: { in: changers } }, select: { id: true, fullName: true } })
      : [];
    const byId = new Map(names.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      supervisor: { id: r.supervisor.id, fullName: r.supervisor.fullName },
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo?.toISOString() ?? null,
      changedBy: r.changedById ? (byId.get(r.changedById) ?? null) : null,
      reason: r.reason,
    }));
  }

  // ─────────────────────────────────────────── create (brief §5.1)

  async create(input: CreateTeamData, viewer: Viewer, ctx: RequestContext): Promise<TeamDto> {
    const isAdmin = can(viewer, 'teams.create');
    if (!isAdmin && !can(viewer, 'teams.createOwn')) throw new AppError('FORBIDDEN');
    if (isAdmin && !input.supervisorId && !input.newSupervisor) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { supervisorId: ['اختر مشرفًا موجودًا أو أنشئ مشرفًا جديدًا'] },
      });
    }
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
        let supervisorId: string;
        if (!isAdmin) {
          supervisorId = viewer.id; // brief §5.1: a supervisor creates a team for themselves
        } else if (input.newSupervisor) {
          newSupervisor = await this.users.createInTx(tx, { ...input.newSupervisor, role: 'SUPERVISOR' }, viewer, ctx);
          supervisorId = newSupervisor.user.id;
        } else {
          supervisorId = input.supervisorId!;
          await this.assertSupervisor(tx, supervisorId);
        }
        if (!allowMultiple && !newSupervisor) await this.assertNoOtherTeam(tx, supervisorId, null);
        await this.assertColorFree(tx, input.colorId, null);

        if (input.existingMemberIds.length) {
          await this.assertExistingMembersUsable(tx, input.existingMemberIds, viewer);
        }

        const team = await tx.team.create({
          data: {
            name: input.name,
            colorId: input.colorId,
            supervisorId,
            status,
            ...(status === 'ACTIVE' ? { approvedAt: t, approvedById: viewer.id } : {}),
            createdById: viewer.id,
          },
          select: { id: true },
        });
        await tx.teamSupervisorHistory.create({
          data: { teamId: team.id, supervisorId, validFrom: t, changedById: viewer.id },
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
              supervisorId,
              newSupervisor: !!newSupervisor,
              newMemberIds: newIds,
              movedMembers: moves,
            },
          },
          tx,
        );
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
    patch: { name?: string; colorId?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<TeamDto> {
    const row = await this.guard(
      () =>
        this.prisma.$transaction(async (tx) => {
          const before = await this.loadForWrite(tx, id, viewer);
          if (before.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
          const data: Prisma.TeamUncheckedUpdateInput = {};
          if (patch.name !== undefined && patch.name !== before.name) data.name = patch.name;
          if (patch.colorId !== undefined && patch.colorId !== before.colorId) {
            await this.assertColorFree(tx, patch.colorId, id);
            data.colorId = patch.colorId;
          }
          if (!Object.keys(data).length) return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
          const after = await tx.team.update({ where: { id }, data, select: TEAM_SELECT });
          await this.audit.logCtx(
            ctx,
            {
              action: AuditAction.TEAM_UPDATED,
              entityType: 'team',
              entityId: id,
              before: Object.fromEntries(Object.keys(data).map((k) => [k, before[k as 'name' | 'colorId']])),
              after: data,
            },
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
      this.notifications.notify([row.supervisorId], 'TEAM_APPROVED', { teamId: row.id, teamName: row.name }),
    );
    return toTeamDto(row);
  }

  /** Rejecting a pending team archives it: the colour is freed and its memberships closed. */
  async reject(id: string, reason: string, ctx: RequestContext): Promise<TeamDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.team.findUnique({ where: { id }, select: { status: true } });
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
      return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });
    this.notifications.safe(
      this.notifications.notify([row.supervisorId], 'TEAM_REJECTED', { teamId: row.id, teamName: row.name, reason }),
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
   * memberships and the open supervisor row are closed with one timestamp, so the members
   * become "unassigned" and history stays contiguous.
   */
  private async closeTeam(tx: Tx, id: string, from: TeamStatus): Promise<number> {
    const t = new Date();
    const claimed = await tx.team.updateMany({
      where: { id, status: from },
      data: { status: 'ARCHIVED', archivedAt: t },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT_VERSION');
    const closed = await tx.teamMembership.updateMany({ where: { teamId: id, validTo: null }, data: { validTo: t } });
    await tx.teamSupervisorHistory.updateMany({ where: { teamId: id, validTo: null }, data: { validTo: t } });
    return closed.count;
  }

  // ─────────────────────────────────────────── supervisor change (brief §5.3)

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
        if (before.supervisorId === input.supervisorId) {
          return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
        }
        await this.assertSupervisor(tx, input.supervisorId);
        if (!allowMultiple) await this.assertNoOtherTeam(tx, input.supervisorId, id);
        const t = new Date(); // one instant for close and open (ADR-013)
        await tx.teamSupervisorHistory.updateMany({ where: { teamId: id, validTo: null }, data: { validTo: t } });
        await tx.teamSupervisorHistory.create({
          data: {
            teamId: id,
            supervisorId: input.supervisorId,
            validFrom: t,
            changedById: viewer.id,
            reason: input.reason ?? null,
          },
        });
        const after = await tx.team.update({
          where: { id },
          data: { supervisorId: input.supervisorId },
          select: TEAM_SELECT,
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
        return after;
      }),
    );
    return toTeamDto(row);
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

  private async loadForWrite(tx: Tx, id: string, viewer: Viewer) {
    const team = await tx.team.findUnique({
      where: { id },
      select: { id: true, name: true, colorId: true, status: true, supervisorId: true },
    });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamManageable(viewer, team);
    return team;
  }

  private async assertSupervisor(tx: Tx, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (!user || user.role !== 'SUPERVISOR' || user.status !== 'ACTIVE') throw new AppError('NOT_A_SUPERVISOR');
  }

  /** ADR-023: with ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR off, a leader holds one live team. */
  private async assertNoOtherTeam(tx: Tx, supervisorId: string, exceptTeamId: string | null): Promise<void> {
    const other = await tx.team.findFirst({
      where: {
        supervisorId,
        status: { in: RESERVING },
        ...(exceptTeamId ? { id: { not: exceptTeamId } } : {}),
      },
      select: { id: true },
    });
    if (other) throw new AppError('MULTIPLE_TEAMS_DISABLED');
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
      select: { id: true, memberships: { where: { validTo: null }, select: { team: { select: { supervisorId: true } } } } },
    });
    if (rows.length !== unique.length) throw new AppError('NOT_FOUND', { field: 'existingMemberIds' });
    if (can(viewer, 'members.move')) return;
    const foreign = rows.filter((r) => r.memberships[0] && r.memberships[0].team.supervisorId !== viewer.id);
    if (foreign.length) throw new AppError('FORBIDDEN', { memberIds: foreign.map((f) => f.id) });
  }

  /** Maps database errors: colour race → COLOR_TAKEN with a fresh list; leader trigger → NOT_A_SUPERVISOR. */
  private async guard<T>(fn: () => Promise<T>, excludeTeamId?: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const mapped = err instanceof AppError ? err : mapPrismaError(err);
      if (mapped?.code === 'COLOR_TAKEN') throw await this.colors.colorTakenError(excludeTeamId);
      if (!mapped && err instanceof Error && /NOT_A_SUPERVISOR/.test(err.message)) {
        throw new AppError('NOT_A_SUPERVISOR');
      }
      throw mapped ?? err;
    }
  }
}
