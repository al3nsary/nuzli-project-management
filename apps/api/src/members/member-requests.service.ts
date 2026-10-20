import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  maskNationalIdParts,
  type MemberRequestAcceptedDto,
  type MemberRequestDto,
  type Paginated,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { paginate } from '../common/pagination';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { canManageMemberIn, leads, OPEN_LEADERS, teamLimitWhere, withinTeamLimit, type Viewer } from '../teams/team-dto';
import { assertReferencesExist, hideDuplicateNationalId, insertMembers, type MemberInputData } from './member-writes';

type Tx = Prisma.TransactionClient;

export const MemberRequestAction = {
  CREATED: 'member_request.created',
  APPROVED: 'member_request.approved',
  REJECTED: 'member_request.rejected',
  MEMBER_ARCHIVED: 'member.archived',
} as const;

const ROW = {
  id: true,
  kind: true,
  status: true,
  payload: true,
  reason: true,
  decisionReason: true,
  createdAt: true,
  decidedAt: true,
  teamId: true,
  memberId: true,
  requestedById: true,
  team: { select: { id: true, name: true } },
  member: { select: { id: true, fullName: true } },
  requestedBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.MemberRequestSelect;

type Row = Prisma.MemberRequestGetPayload<{ select: typeof ROW }>;

interface AddPayload {
  fullName?: string;
  nationalIdMasked?: string;
  jobTitleId?: string | null;
  jobTitleText?: string | null;
  departmentId?: string | null;
  departmentText?: string | null;
}

function toDto(r: Row, names?: { jobTitle?: string | null; department?: string | null }): MemberRequestDto {
  const p = (r.payload ?? {}) as AddPayload;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    team: r.team ? { id: r.team.id, name: r.team.name } : null,
    member: r.member ? { id: r.member.id, fullName: r.member.fullName } : null,
    payload: {
      ...(p.fullName ? { fullName: p.fullName } : {}),
      ...(p.nationalIdMasked ? { nationalIdMasked: p.nationalIdMasked } : {}),
      ...(r.kind === 'ADD' ? { jobTitle: names?.jobTitle ?? p.jobTitleText ?? null, department: names?.department ?? p.departmentText ?? null } : {}),
    },
    reason: r.reason,
    decisionReason: r.decisionReason,
    requestedBy: r.requestedBy ? { id: r.requestedBy.id, fullName: r.requestedBy.fullName } : null,
    decidedBy: r.decidedBy ? { id: r.decidedBy.id, fullName: r.decidedBy.fullName } : null,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}

/** Who decides requests: admins/owners and assistants with registrations:edit. */
export function canDecideRequests(viewer: Viewer): boolean {
  return can(viewer, 'registrations.review');
}

/** Who reads every request of the workspace (within an assistant's team scope). */
function readsAllRequests(viewer: Viewer): boolean {
  return can(viewer, 'registrations.review') || can(viewer, 'registrations.read') || can(viewer, 'members.manage');
}

/**
 * A12 round 2 (owner rule) — a supervisor no longer adds or removes a worker directly: the change
 * becomes a request decided by the workspace's admins / owners / assistants with
 * registrations:edit. Editing a worker's data stays direct; admins still add and remove directly.
 *  - ADD keeps what the supervisor typed in `payload` (masked national ID) and the national ID
 *    itself encrypted (AES-256-GCM) in `national_id_enc`, cleared once decided;
 *  - REMOVE names the member; approving it closes the member's team membership and archives the
 *    record (nothing is deleted; violations and history stay).
 * Approvers are notified on a new request, the supervisor on the decision. Everything is audited.
 */
@Injectable()
export class MemberRequestsService {
  private readonly logger = new Logger(MemberRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async names(rows: Row[]): Promise<Map<string, { jobTitle?: string | null; department?: string | null }>> {
    const payloads = rows.map((r) => [r.id, (r.payload ?? {}) as AddPayload] as const);
    const jobIds = [...new Set(payloads.map(([, p]) => p.jobTitleId).filter((v): v is string => !!v))];
    const depIds = [...new Set(payloads.map(([, p]) => p.departmentId).filter((v): v is string => !!v))];
    const [jobs, deps] = await Promise.all([
      jobIds.length ? this.prisma.jobTitle.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } }) : [],
      depIds.length ? this.prisma.department.findMany({ where: { id: { in: depIds } }, select: { id: true, name: true } }) : [],
    ]);
    const j = new Map(jobs.map((x) => [x.id, x.name]));
    const d = new Map(deps.map((x) => [x.id, x.name]));
    return new Map(payloads.map(([id, p]) => [id, { jobTitle: p.jobTitleId ? j.get(p.jobTitleId) : undefined, department: p.departmentId ? d.get(p.departmentId) : undefined }]));
  }

  private async dto(r: Row): Promise<MemberRequestDto> {
    return toDto(r, (await this.names([r])).get(r.id));
  }

  private notifyApprovers(r: Row): void {
    this.notifications.safe(
      this.notifications.notifyApprovers('MEMBER_REQUEST_CREATED', {
        requestId: r.id,
        kind: r.kind,
        teamName: r.team?.name ?? '',
        fullName: ((r.payload ?? {}) as AddPayload).fullName ?? r.member?.fullName ?? '',
      }),
    );
  }

  // ─────────────────────────────────────────── create (supervisors)

  /** ADD — called by `POST /teams/:id/members` for a supervisor (manageOwn) of the team. */
  async requestAdd(teamId: string, input: MemberInputData, viewer: Viewer, ctx: RequestContext): Promise<MemberRequestAcceptedDto> {
    const row = await hideDuplicateNationalId(viewer, this.audit, ctx, { teamId, via: 'member_request.add' }, () =>
      withPrismaErrors(() =>
        this.prisma.$transaction(async (tx) => {
          const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, status: true, supervisors: OPEN_LEADERS } });
          if (!team || !leads(viewer.id, team)) throw new AppError('NOT_FOUND');
          if (!can(viewer, 'members.manageOwn')) throw new AppError('FORBIDDEN');
          if (team.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
          await assertReferencesExist(tx, [input]);
          const p = this.crypto.protectNationalId(input.nationalId);
          if (await tx.teamMember.findFirst({ where: { nationalIdHash: p.hash }, select: { id: true } })) {
            throw new AppError('NATIONAL_ID_TAKEN', { fieldErrors: { nationalId: ['NATIONAL_ID_TAKEN'] } });
          }
          const created = await tx.memberRequest.create({
            data: {
              teamId,
              kind: 'ADD',
              payload: {
                fullName: input.fullName,
                nationalIdMasked: maskNationalIdParts(p.first, p.last4),
                jobTitleId: input.jobTitleId ?? null,
                jobTitleText: input.jobTitleId ? null : (input.jobTitleText ?? null),
                departmentId: input.departmentId ?? null,
                departmentText: input.departmentId ? null : (input.departmentText ?? null),
              },
              nationalIdEnc: p.enc,
              requestedById: viewer.id,
            },
            select: ROW,
          });
          await this.audit.logCtx(
            ctx,
            {
              action: MemberRequestAction.CREATED,
              entityType: 'member_request',
              entityId: created.id,
              after: { kind: 'ADD', teamId, fullName: input.fullName, nationalIdMasked: maskNationalIdParts(p.first, p.last4) },
            },
            tx,
          );
          return created;
        }),
      ),
    );
    this.notifyApprovers(row);
    return { status: 'PENDING_APPROVAL', request: await this.dto(row) };
  }

  /** REMOVE — a supervisor asks to take a worker of their team out (idempotent while pending). */
  async requestRemove(memberId: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<MemberRequestAcceptedDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const m = await tx.teamMember.findFirst({
        where: { id: memberId, archivedAt: null },
        select: { id: true, fullName: true, memberships: { where: { validTo: null }, take: 1, select: { team: { select: { id: true, supervisors: OPEN_LEADERS } } } } },
      });
      const team = m?.memberships[0]?.team ?? null;
      if (!m || !team || !leads(viewer.id, team)) throw new AppError('NOT_FOUND');
      if (!can(viewer, 'members.manageOwn')) throw new AppError('FORBIDDEN');
      const pending = await tx.memberRequest.findFirst({ where: { memberId, kind: 'REMOVE', status: 'PENDING' }, select: ROW });
      if (pending) return { row: pending, created: false };
      const created = await tx.memberRequest.create({
        data: { teamId: team.id, memberId, kind: 'REMOVE', payload: { fullName: m.fullName }, reason, requestedById: viewer.id },
        select: ROW,
      });
      await this.audit.logCtx(
        ctx,
        { action: MemberRequestAction.CREATED, entityType: 'member_request', entityId: created.id, after: { kind: 'REMOVE', teamId: team.id, memberId, reason } },
        tx,
      );
      return { row: created, created: true };
    });
    if (row.created) this.notifyApprovers(row.row);
    return { status: 'PENDING_APPROVAL', request: await this.dto(row.row) };
  }

  // ─────────────────────────────────────────── read

  async list(
    q: { status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'; teamId?: string; page: number; pageSize: number },
    viewer: Viewer,
  ): Promise<Paginated<MemberRequestDto>> {
    const scope: Prisma.MemberRequestWhereInput = readsAllRequests(viewer)
      ? { team: teamLimitWhere(viewer) }
      : { OR: [{ requestedById: viewer.id }, { team: { supervisors: { some: { userId: viewer.id, validTo: null } } } }] };
    const where: Prisma.MemberRequestWhereInput = {
      AND: [scope, q.status === 'ALL' ? {} : { status: q.status }, q.teamId ? { teamId: q.teamId } : {}],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.memberRequest.findMany({ where, select: ROW, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.memberRequest.count({ where }),
    ]);
    const names = await this.names(rows);
    return paginate(rows.map((r) => toDto(r, names.get(r.id))), total, q.page, q.pageSize);
  }

  private async visible(db: Tx | PrismaService, id: string, viewer: Viewer): Promise<Row> {
    const r = await db.memberRequest.findUnique({
      where: { id },
      select: { ...ROW, team: { select: { id: true, name: true, supervisors: OPEN_LEADERS } } },
    });
    if (!r) throw new AppError('NOT_FOUND');
    const ok = readsAllRequests(viewer) ? withinTeamLimit(viewer, r.team) : r.requestedById === viewer.id || leads(viewer.id, r.team);
    if (!ok) throw new AppError('NOT_FOUND');
    return r;
  }

  async get(id: string, viewer: Viewer): Promise<MemberRequestDto> {
    return this.dto(await this.visible(this.prisma, id, viewer));
  }

  // ─────────────────────────────────────────── decide (approvers)

  async approve(id: string, viewer: Viewer, ctx: RequestContext): Promise<MemberRequestDto> {
    if (!canDecideRequests(viewer)) throw new AppError('FORBIDDEN');
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const r = await this.visible(tx, id, viewer);
        const claimed = await tx.memberRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', decidedById: viewer.id, decidedAt: new Date() } });
        if (claimed.count !== 1) throw new AppError('MEMBER_REQUEST_NOT_PENDING');
        let memberId = r.memberId;
        if (r.kind === 'ADD') {
          const full = await tx.memberRequest.findUniqueOrThrow({ where: { id }, select: { nationalIdEnc: true, payload: true } });
          if (!full.nationalIdEnc) throw new AppError('MEMBER_REQUEST_NOT_PENDING');
          const team = await tx.team.findUnique({ where: { id: r.teamId }, select: { id: true, status: true, supervisors: OPEN_LEADERS } });
          if (!team) throw new AppError('NOT_FOUND');
          if (team.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
          if (!canManageMemberIn(viewer, team)) throw new AppError('FORBIDDEN');
          const p = (full.payload ?? {}) as AddPayload;
          const input: MemberInputData = {
            fullName: p.fullName ?? '',
            nationalId: this.crypto.decrypt(full.nationalIdEnc),
            ...(p.jobTitleId ? { jobTitleId: p.jobTitleId } : p.jobTitleText ? { jobTitleText: p.jobTitleText } : {}),
            ...(p.departmentId ? { departmentId: p.departmentId } : p.departmentText ? { departmentText: p.departmentText } : {}),
          };
          const [createdId] = await insertMembers(tx, this.crypto, [input], { teamId: r.teamId, at: new Date(), actorId: viewer.id, fieldPrefix: '', reason: 'member_request' });
          memberId = createdId!;
          await this.audit.logCtx(
            ctx,
            { action: AuditAction.MEMBER_CREATED, entityType: 'member', entityId: memberId, after: { fullName: input.fullName, nationalIdMasked: p.nationalIdMasked ?? null, teamId: r.teamId, viaRequest: id } },
            tx,
          );
        } else {
          if (!memberId) throw new AppError('NOT_FOUND');
          await this.archiveInTx(tx, memberId, viewer, ctx, r.reason ?? 'member_request', id);
        }
        await tx.memberRequest.update({ where: { id }, data: { nationalIdEnc: null, memberId } });
        await this.audit.logCtx(
          ctx,
          { action: MemberRequestAction.APPROVED, entityType: 'member_request', entityId: id, before: { status: 'PENDING' }, after: { status: 'APPROVED', kind: r.kind, memberId } },
          tx,
        );
        return tx.memberRequest.findUniqueOrThrow({ where: { id }, select: ROW });
      }),
    );
    this.notifyDecided(row);
    return this.dto(row);
  }

  async reject(id: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<MemberRequestDto> {
    if (!canDecideRequests(viewer)) throw new AppError('FORBIDDEN');
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await this.visible(tx, id, viewer);
      const claimed = await tx.memberRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', decidedById: viewer.id, decidedAt: new Date(), decisionReason: reason, nationalIdEnc: null },
      });
      if (claimed.count !== 1) throw new AppError('MEMBER_REQUEST_NOT_PENDING');
      await this.audit.logCtx(
        ctx,
        { action: MemberRequestAction.REJECTED, entityType: 'member_request', entityId: id, before: { status: 'PENDING' }, after: { status: 'REJECTED', kind: r.kind, reason } },
        tx,
      );
      return tx.memberRequest.findUniqueOrThrow({ where: { id }, select: ROW });
    });
    this.notifyDecided(row);
    return this.dto(row);
  }

  private notifyDecided(r: Row): void {
    this.notifications.safe(
      this.notifications.notify([r.requestedById], 'MEMBER_REQUEST_DECIDED', {
        requestId: r.id,
        kind: r.kind,
        status: r.status,
        teamName: r.team?.name ?? '',
        fullName: ((r.payload ?? {}) as AddPayload).fullName ?? r.member?.fullName ?? '',
        ...(r.decisionReason ? { reason: r.decisionReason } : {}),
      }),
    );
  }

  // ─────────────────────────────────────────── remove a worker (admins directly, or an approved request)

  /**
   * Closes the member's open team membership and archives the record (status INACTIVE). Nothing is
   * deleted: violations, card history and the membership timeline stay.
   */
  async archiveInTx(tx: Tx, memberId: string, viewer: Viewer, ctx: RequestContext, reason: string, requestId?: string): Promise<void> {
    const m = await tx.teamMember.findFirst({
      where: { id: memberId, archivedAt: null },
      select: { id: true, fullName: true, nationalIdFirst: true, nationalIdLast4: true, memberships: { where: { validTo: null }, take: 1, select: { id: true, teamId: true, role: true } } },
    });
    if (!m) throw new AppError('NOT_FOUND');
    const now = new Date();
    const open = m.memberships[0];
    if (open) await tx.teamMembership.update({ where: { id: open.id }, data: { validTo: now, reason } });
    await tx.teamMember.update({ where: { id: memberId }, data: { archivedAt: now, status: 'INACTIVE' } });
    await this.audit.logCtx(
      ctx,
      {
        action: MemberRequestAction.MEMBER_ARCHIVED,
        entityType: 'member',
        entityId: memberId,
        before: { teamId: open?.teamId ?? null, wasForeman: open?.role === 'FOREMAN' },
        after: { archived: true, reason, nationalIdMasked: maskNationalIdParts(m.nationalIdFirst, m.nationalIdLast4), ...(requestId ? { viaRequest: requestId } : {}) },
      },
      tx,
    );
    void viewer;
  }

  /** `POST /members/:id/archive` for an admin (members.manage on the member's team). */
  async archiveDirect(memberId: string, reason: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const m = await tx.teamMember.findFirst({
        where: { id: memberId, archivedAt: null },
        select: { memberships: { where: { validTo: null }, take: 1, select: { team: { select: { id: true, supervisors: OPEN_LEADERS } } } } },
      });
      if (!m) throw new AppError('NOT_FOUND');
      if (!canManageMemberIn(viewer, m.memberships[0]?.team ?? null)) throw new AppError('NOT_FOUND');
      await this.archiveInTx(tx, memberId, viewer, ctx, reason);
    });
    this.logger.debug(`member ${memberId} archived`);
  }
}
