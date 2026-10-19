import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  isValidNationalId,
  maskNationalIdParts,
  toWesternDigits,
  type ImportMembersResultDto,
  type MemberDto,
  type MembershipHistoryDto,
  type Paginated,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { paginate, parseSort, withIdTiebreak } from '../common/pagination';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertTeamManageable,
  canManageMemberIn,
  canReadAllTeams,
  leads,
  MEMBER_SELECT,
  OPEN_LEADERS,
  memberScopeWhere,
  TEAM_SUMMARY_SELECT,
  toMemberDto,
  toTeamSummary,
  type MemberRow,
  type Viewer,
} from '../teams/team-dto';
import {
  assertReferencesExist,
  hideDuplicateNationalId,
  insertMembers,
  moveMembersInTx,
  type MemberInputData,
} from './member-writes';
import { candidateNationalIds, validateImportRows } from './members-import';

export interface MemberListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  teamId?: string;
  unassigned?: boolean;
}

export type MemberPatch = Partial<MemberInputData>;

const SORTABLE = ['fullName', 'createdAt'] as const;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** `q`: exact national ID (blind index), its last 4 digits, or part of the name. */
  searchWhere(q: string | undefined): Prisma.TeamMemberWhereInput {
    if (!q) return {};
    const term = toWesternDigits(q).trim();
    if (isValidNationalId(term)) return { nationalIdHash: this.crypto.blindIndex(term) };
    if (/^\d{4}$/.test(term)) return { nationalIdLast4: term };
    return { fullName: { contains: q.trim(), mode: 'insensitive' } };
  }

  async list(query: MemberListQuery, viewer: Viewer): Promise<Paginated<MemberDto>> {
    const and: Prisma.TeamMemberWhereInput[] = [
      { archivedAt: null },
      memberScopeWhere(viewer),
      this.searchWhere(query.q),
    ];
    if (query.teamId) and.push({ memberships: { some: { teamId: query.teamId, validTo: null } } });
    if (query.unassigned) and.push({ memberships: { none: { validTo: null } } });
    const where: Prisma.TeamMemberWhereInput = { AND: and };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamMember.findMany({
        where,
        select: MEMBER_SELECT,
        orderBy: withIdTiebreak(parseSort(query.sort, SORTABLE, { fullName: 'asc' })),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamMember.count({ where }),
    ]);
    return paginate(
      rows.map((r) => toMemberDto(r)),
      total,
      query.page,
      query.pageSize,
    );
  }

  private async load(id: string, viewer: Viewer): Promise<MemberRow> {
    const row = await this.prisma.teamMember.findFirst({
      where: { AND: [{ id, archivedAt: null }, memberScopeWhere(viewer)] },
      select: MEMBER_SELECT,
    });
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  async get(id: string, viewer: Viewer): Promise<MemberDto> {
    const row = await this.load(id, viewer);
    return toMemberDto(row, { viewer, full: true, crypto: this.crypto });
  }

  async history(id: string, viewer: Viewer): Promise<MembershipHistoryDto[]> {
    await this.load(id, viewer);
    const rows = await this.prisma.teamMembership.findMany({
      where: { memberId: id },
      orderBy: { validFrom: 'desc' },
      select: {
        id: true,
        validFrom: true,
        validTo: true,
        reason: true,
        team: { select: TEAM_SUMMARY_SELECT },
        movedBy: { select: { id: true, fullName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      team: toTeamSummary(r.team),
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo?.toISOString() ?? null,
      movedBy: r.movedBy ? { id: r.movedBy.id, fullName: r.movedBy.fullName } : null,
      reason: r.reason,
    }));
  }

  /** `POST /teams/:id/members` — a new member record with an open membership in the team. */
  async createInTeam(teamId: string, input: MemberInputData, viewer: Viewer, ctx: RequestContext): Promise<MemberDto> {
    const row = await hideDuplicateNationalId(viewer, this.audit, ctx, { teamId, via: 'members.create' }, () =>
      withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const team = await tx.team.findUnique({ where: { id: teamId }, select: { supervisors: OPEN_LEADERS, status: true } });
        if (!team) throw new AppError('NOT_FOUND');
        assertTeamManageable(viewer, team);
        if (!canManageMemberIn(viewer, team)) throw new AppError('FORBIDDEN');
        if (team.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
        const [id] = await insertMembers(tx, this.crypto, [input], {
          teamId,
          at: new Date(),
          actorId: viewer.id,
          fieldPrefix: '',
        });
        const created = await tx.teamMember.findUniqueOrThrow({ where: { id: id! }, select: MEMBER_SELECT });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.MEMBER_CREATED,
            entityType: 'member',
            entityId: created.id,
            after: {
              fullName: created.fullName,
              nationalIdMasked: maskNationalIdParts(created.nationalIdFirst, created.nationalIdLast4),
              teamId,
            },
          },
          tx,
        );
        return created;
      }),
      ),
    );
    return toMemberDto(row, { viewer, full: true, crypto: this.crypto });
  }

  async update(id: string, patch: MemberPatch, viewer: Viewer, ctx: RequestContext): Promise<MemberDto> {
    const row = await hideDuplicateNationalId(viewer, this.audit, ctx, { memberId: id, via: 'members.update' }, () =>
      withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.teamMember.findFirst({ where: { id, archivedAt: null }, select: MEMBER_SELECT });
        if (!before) throw new AppError('NOT_FOUND');
        const team = before.memberships[0]?.team ?? null;
        if (!canManageMemberIn(viewer, team)) {
          // Hide members outside the viewer's scope; a visible member without rights → 403.
          const visible = canReadAllTeams(viewer) || !team || leads(viewer.id, team);
          throw new AppError(visible ? 'FORBIDDEN' : 'NOT_FOUND');
        }
        await assertReferencesExist(tx, [patch]);
        const { data, beforeAudit, afterAudit } = this.buildPatch(before, patch);
        if (!Object.keys(data).length) return before;
        const after = await tx.teamMember.update({ where: { id }, data, select: MEMBER_SELECT });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.MEMBER_UPDATED, entityType: 'member', entityId: id, before: beforeAudit, after: afterAudit },
          tx,
        );
        return after;
      }),
      ),
    );
    return toMemberDto(row, { viewer, full: true, crypto: this.crypto });
  }

  /** Only the changed columns; a list id replaces the free text and vice versa. */
  buildPatch(before: MemberRow, patch: MemberPatch) {
    const data: Prisma.TeamMemberUncheckedUpdateInput = {};
    const beforeAudit: Record<string, unknown> = {};
    const afterAudit: Record<string, unknown> = {};
    const set = (key: string, from: unknown, to: unknown) => {
      if (from === to) return;
      (data as Record<string, unknown>)[key] = to;
      beforeAudit[key] = from;
      afterAudit[key] = to;
    };
    if (patch.fullName !== undefined) set('fullName', before.fullName, patch.fullName);
    if (patch.nationalId !== undefined) {
      const p = this.crypto.protectNationalId(patch.nationalId);
      const oldMasked = maskNationalIdParts(before.nationalIdFirst, before.nationalIdLast4);
      if (before.nationalIdHash !== p.hash) {
        Object.assign(data, {
          nationalIdEnc: p.enc,
          nationalIdHash: p.hash,
          nationalIdFirst: p.first,
          nationalIdLast4: p.last4,
        });
        beforeAudit.nationalIdMasked = oldMasked;
        afterAudit.nationalIdMasked = maskNationalIdParts(p.first, p.last4);
      }
    }
    if (patch.jobTitleId !== undefined) {
      set('jobTitleId', before.jobTitleId, patch.jobTitleId);
      set('jobTitleText', before.jobTitleText, null);
    } else if (patch.jobTitleText !== undefined) {
      set('jobTitleText', before.jobTitleText, patch.jobTitleText);
      set('jobTitleId', before.jobTitleId, null);
    }
    if (patch.departmentId !== undefined) {
      set('departmentId', before.departmentId, patch.departmentId);
      set('departmentText', before.departmentText, null);
    } else if (patch.departmentText !== undefined) {
      set('departmentText', before.departmentText, patch.departmentText);
      set('departmentId', before.departmentId, null);
    }
    return { data, beforeAudit, afterAudit };
  }

  // ─────────────────────────────────────────── move (brief §5.3, ADR-013)

  async move(
    input: { memberIds: string[]; toTeamId: string; reason?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<MemberDto[]> {
    if (!can(viewer, 'members.move')) throw new AppError('FORBIDDEN');
    const ids = [...new Set(input.memberIds)];
    const rows = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const team = await tx.team.findUnique({ where: { id: input.toTeamId }, select: { status: true } });
        if (!team) throw new AppError('NOT_FOUND');
        if (team.status !== 'ACTIVE') throw new AppError('TEAM_NOT_ACTIVE');
        const found = await tx.teamMember.count({ where: { id: { in: ids }, archivedAt: null } });
        if (found !== ids.length) throw new AppError('NOT_FOUND');
        const t = new Date(); // taken once: every closed row ends exactly where its new row starts
        const moves = await moveMembersInTx(tx, ids, input.toTeamId, {
          at: t,
          actorId: viewer.id,
          reason: input.reason ?? null,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.MEMBERS_MOVED,
            entityType: 'team',
            entityId: input.toTeamId,
            before: { moves: moves.map((m) => ({ memberId: m.memberId, teamId: m.fromTeamId })) },
            after: {
              toTeamId: input.toTeamId,
              fromTeamIds: [...new Set(moves.map((m) => m.fromTeamId))],
              memberIds: moves.map((m) => m.memberId),
              at: t.toISOString(),
              reason: input.reason ?? null,
            },
          },
          tx,
        );
        // A9 (ADR-101): moving the worker foreman out of their team ends the flag.
        for (const m of moves) {
          if (!m.wasForeman || !m.fromTeamId) continue;
          await this.audit.logCtx(
            ctx,
            {
              action: AuditAction.TEAM_FOREMAN_CLEARED,
              entityType: 'team',
              entityId: m.fromTeamId,
              before: { foremanId: m.memberId },
              after: { foremanId: null, reason: 'نقل العضو إلى فريق آخر' },
            },
            tx,
          );
        }
        return tx.teamMember.findMany({ where: { id: { in: ids } }, select: MEMBER_SELECT, orderBy: { fullName: 'asc' } });
      }),
    );
    return rows.map((r) => toMemberDto(r));
  }

  // ─────────────────────────────────────────── import (brief §5.1)

  async import(
    input: { teamId: string; rows: Array<Record<string, unknown>>; commit: boolean },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<ImportMembersResultDto> {
    const team = await this.prisma.team.findUnique({
      where: { id: input.teamId },
      select: { supervisors: OPEN_LEADERS, status: true },
    });
    if (!team) throw new AppError('NOT_FOUND');
    assertTeamManageable(viewer, team);
    if (team.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');

    const [jobTitles, departments] = await Promise.all([
      this.prisma.jobTitle.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      this.prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);
    const hashes = candidateNationalIds(input.rows).map((id) => this.crypto.blindIndex(id));
    const existing = hashes.length
      ? await this.prisma.teamMember.findMany({
          where: { nationalIdHash: { in: [...new Set(hashes)] } },
          select: { nationalIdHash: true },
        })
      : [];
    const { results, valid } = validateImportRows(
      input.rows,
      { jobTitles, departments },
      { hashOf: (id) => this.crypto.blindIndex(id), existingHashes: new Set(existing.map((e) => e.nationalIdHash)) },
    );
    if (!input.commit || !valid.length) return { results, committed: 0 };

    const committed = await withPrismaErrors(() =>
      this.prisma.$transaction(
        async (tx) => {
          const ids = await insertMembers(
            tx,
            this.crypto,
            valid.map((v) => v.input),
            { teamId: input.teamId, at: new Date(), actorId: viewer.id, reason: 'استيراد', fieldPrefix: 'rows' },
          );
          await this.audit.logCtx(
            ctx,
            {
              action: AuditAction.MEMBERS_IMPORTED,
              entityType: 'team',
              entityId: input.teamId,
              after: {
                teamId: input.teamId,
                committed: ids.length,
                rejected: results.length - valid.length,
                rows: results.length,
              },
            },
            tx,
          );
          return ids.length;
        },
        { timeout: 60_000 },
      ),
    );
    return { results, committed };
  }
}
