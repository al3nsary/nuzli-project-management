import { Injectable } from '@nestjs/common';
import type { OrgUnitKind, Prisma } from '@prisma/client';
import { can, type OrgPositionDto, type OrgTreeDto, type OrgUnitDto } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId, activeWorkspaceIdOrNull } from '../prisma/workspace-context';
import { displayRole, memberOf, ROLE_VIEW_SELECT } from '../users/user-dto';
import { COLOR_SELECT, LEADERS_SELECT, toColorDto, toSupervisorDtos, type Viewer } from '../teams/team-dto';
import { nextSort, orderTree, wouldCreateCycle } from './org-tree';

type Tx = Prisma.TransactionClient;

const POSITION_SELECT = {
  id: true,
  unitId: true,
  title: true,
  sort: true,
  reportsToPositionId: true,
  holderUser: { select: { id: true, fullName: true, photoFileId: true, archivedAt: true, ...ROLE_VIEW_SELECT } },
  holderMember: {
    select: {
      id: true,
      fullName: true,
      photoFileId: true,
      archivedAt: true,
      memberships: {
        where: { validTo: null },
        take: 1,
        select: { team: { select: { id: true, name: true, color: { select: COLOR_SELECT } } } },
      },
    },
  },
} satisfies Prisma.OrgPositionSelect;

type PositionRow = Prisma.OrgPositionGetPayload<{ select: typeof POSITION_SELECT }>;

function toPositionDto(p: PositionRow): OrgPositionDto {
  let holder: OrgPositionDto['holder'] = null;
  if (p.holderUser && !p.holderUser.archivedAt) {
    holder = {
      type: 'USER',
      id: p.holderUser.id,
      fullName: p.holderUser.fullName,
      hasPhoto: !!p.holderUser.photoFileId,
      role: displayRole(p.holderUser, activeWorkspaceIdOrNull()),
    };
  } else if (p.holderMember && !p.holderMember.archivedAt) {
    const team = p.holderMember.memberships[0]?.team ?? null;
    holder = {
      type: 'MEMBER',
      id: p.holderMember.id,
      fullName: p.holderMember.fullName,
      hasPhoto: !!p.holderMember.photoFileId,
      team: team ? { id: team.id, name: team.name, color: toColorDto(team.color) } : null,
    };
  }
  return { id: p.id, unitId: p.unitId, title: p.title, holder, reportsToPositionId: p.reportsToPositionId, sort: p.sort };
}

export interface UnitInput {
  parentId: string | null;
  name: string;
  kind: OrgUnitKind;
  code?: string;
  sort?: number;
}

export interface PositionInput {
  unitId: string;
  title: string;
  holderUserId?: string | null;
  holderMemberId?: string | null;
  reportsToPositionId?: string | null;
  sort?: number;
}

/**
 * Organisational structure (owner request A9, ADR-102): units in a tree, positions held by a
 * user, a team member or nobody, reporting lines between positions, optional team links.
 * Admins (`org.manage`) change it; admins and supervisors (`org.read`) read it. Structural
 * changes run under one advisory lock, so two concurrent moves cannot build a loop together.
 * Every change is audited (`org.*`).
 */
@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────── read

  async tree(viewer: Viewer, includeArchived = false): Promise<OrgTreeDto> {
    // Archived units are an admin concern (restore); readers get the live tree.
    const withArchived = includeArchived && can(viewer, 'org.manage');
    const units = await this.prisma.orgUnit.findMany({
      where: withArchived ? {} : { archivedAt: null },
      select: {
        id: true,
        parentId: true,
        name: true,
        kind: true,
        code: true,
        sort: true,
        archivedAt: true,
        positions: { select: POSITION_SELECT, orderBy: [{ sort: 'asc' }, { title: 'asc' }] },
        teams: {
          where: { status: { not: 'ARCHIVED' } },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            status: true,
            color: { select: COLOR_SELECT },
            supervisors: LEADERS_SELECT,
            _count: { select: { memberships: { where: { validTo: null } } } },
          },
        },
      },
    });
    const out: OrgUnitDto[] = orderTree(units).map((u) => ({
      id: u.id,
      parentId: u.parentId,
      name: u.name,
      kind: u.kind,
      code: u.code,
      sort: u.sort,
      archivedAt: u.archivedAt?.toISOString() ?? null,
      positions: u.positions.map(toPositionDto),
      teams: u.teams.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        color: toColorDto(t.color),
        memberCount: t._count.memberships,
        supervisors: toSupervisorDtos(t.supervisors).map(({ id, fullName, isPrimary, hasPhoto }) => ({
          id,
          fullName,
          isPrimary,
          hasPhoto,
        })),
      })),
    }));
    return { units: out, generatedAt: new Date().toISOString() };
  }

  // ─────────────────────────────────────────── units

  async createUnit(input: UnitInput, ctx: RequestContext): Promise<OrgUnitDto> {
    const id = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lock(tx);
        if (input.parentId) await this.liveUnit(tx, input.parentId, 'parentId');
        const sort = input.sort ?? nextSort(await this.siblingUnitSorts(tx, input.parentId));
        const created = await tx.orgUnit.create({
          data: {
            parentId: input.parentId,
            name: input.name,
            kind: input.kind,
            code: input.code || null,
            sort,
            createdById: ctx.actorId,
          },
          select: { id: true },
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.ORG_UNIT_CREATED,
            entityType: 'org_unit',
            entityId: created.id,
            after: { name: input.name, kind: input.kind, parentId: input.parentId, code: input.code ?? null, sort },
          },
          tx,
        );
        return created.id;
      }),
    );
    return this.unitDto(id);
  }

  async updateUnit(
    id: string,
    patch: { name?: string; kind?: OrgUnitKind; code?: string | null; archived?: boolean },
    ctx: RequestContext,
  ): Promise<OrgUnitDto> {
    await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lock(tx);
        const before = await tx.orgUnit.findUnique({
          where: { id },
          select: { name: true, kind: true, code: true, archivedAt: true, parentId: true },
        });
        if (!before) throw new AppError('NOT_FOUND');
        const data: Prisma.OrgUnitUncheckedUpdateInput = {};
        const b: Record<string, unknown> = {};
        const a: Record<string, unknown> = {};
        const set = (key: 'name' | 'kind' | 'code', value: unknown) => {
          if (value === undefined || value === before[key]) return;
          (data as Record<string, unknown>)[key] = value;
          b[key] = before[key];
          a[key] = value;
        };
        set('name', patch.name);
        set('kind', patch.kind);
        set('code', patch.code === '' ? null : patch.code);
        if (patch.archived === true && !before.archivedAt) {
          await this.assertEmptyForArchive(tx, id);
          data.archivedAt = new Date();
          b.archived = false;
          a.archived = true;
        } else if (patch.archived === false && before.archivedAt) {
          if (before.parentId) await this.liveUnit(tx, before.parentId, 'parentId');
          data.archivedAt = null;
          b.archived = true;
          a.archived = false;
        }
        if (!Object.keys(data).length) return;
        await tx.orgUnit.update({ where: { id }, data });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.ORG_UNIT_UPDATED, entityType: 'org_unit', entityId: id, before: b, after: a },
          tx,
        );
      }),
    );
    return this.unitDto(id);
  }

  /** `POST /org/units/:id/move` — new parent (null = root) and/or sibling position. */
  async moveUnit(id: string, input: { parentId: string | null; sort?: number }, ctx: RequestContext): Promise<OrgUnitDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const unit = await tx.orgUnit.findUnique({ where: { id }, select: { parentId: true, sort: true, archivedAt: true } });
      if (!unit) throw new AppError('NOT_FOUND');
      if (unit.archivedAt) throw new AppError('ORG_UNIT_ARCHIVED');
      if (input.parentId) await this.liveUnit(tx, input.parentId, 'parentId');
      const all = await tx.orgUnit.findMany({ select: { id: true, parentId: true } });
      const parentOf = new Map(all.map((u) => [u.id, u.parentId]));
      if (wouldCreateCycle(parentOf, id, input.parentId)) throw new AppError('ORG_CYCLE');
      const sameParent = unit.parentId === input.parentId;
      const sort =
        input.sort ?? (sameParent ? unit.sort : nextSort(await this.siblingUnitSorts(tx, input.parentId)));
      if (sameParent && sort === unit.sort) return;
      await tx.orgUnit.update({ where: { id }, data: { parentId: input.parentId, sort } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_UNIT_MOVED,
          entityType: 'org_unit',
          entityId: id,
          before: { parentId: unit.parentId, sort: unit.sort },
          after: { parentId: input.parentId, sort },
        },
        tx,
      );
    });
    return this.unitDto(id);
  }

  /** Hard delete of an empty unit (no child units, positions or linked teams — archived ones included). */
  async deleteUnit(id: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const unit = await tx.orgUnit.findUnique({
        where: { id },
        select: { name: true, kind: true, parentId: true, _count: { select: { children: true, positions: true, teams: true } } },
      });
      if (!unit) throw new AppError('NOT_FOUND');
      const c = unit._count;
      if (c.children || c.positions || c.teams) {
        throw new AppError('ORG_UNIT_NOT_EMPTY', { children: c.children, positions: c.positions, teams: c.teams });
      }
      await tx.orgUnit.delete({ where: { id } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_UNIT_DELETED,
          entityType: 'org_unit',
          entityId: id,
          before: { name: unit.name, kind: unit.kind, parentId: unit.parentId },
        },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── positions

  async createPosition(input: PositionInput, ctx: RequestContext): Promise<OrgPositionDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      await this.liveUnit(tx, input.unitId, 'unitId');
      await this.assertHolder(tx, input.holderUserId ?? null, input.holderMemberId ?? null);
      if (input.reportsToPositionId) await this.positionExists(tx, input.reportsToPositionId);
      const siblings = await tx.orgPosition.findMany({ where: { unitId: input.unitId }, select: { sort: true } });
      const sort = input.sort ?? nextSort(siblings.map((s) => s.sort));
      const created = await tx.orgPosition.create({
        data: {
          unitId: input.unitId,
          title: input.title,
          holderUserId: input.holderUserId ?? null,
          holderMemberId: input.holderMemberId ?? null,
          reportsToPositionId: input.reportsToPositionId ?? null,
          sort,
          createdById: ctx.actorId,
        },
        select: { id: true },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_POSITION_CREATED,
          entityType: 'org_position',
          entityId: created.id,
          after: {
            unitId: input.unitId,
            title: input.title,
            holderUserId: input.holderUserId ?? null,
            holderMemberId: input.holderMemberId ?? null,
            reportsToPositionId: input.reportsToPositionId ?? null,
          },
        },
        tx,
      );
      return created.id;
    });
    return this.positionDto(id);
  }

  async updatePosition(
    id: string,
    patch: { title?: string; holderUserId?: string | null; holderMemberId?: string | null; reportsToPositionId?: string | null },
    ctx: RequestContext,
  ): Promise<OrgPositionDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const before = await tx.orgPosition.findUnique({
        where: { id },
        select: { title: true, holderUserId: true, holderMemberId: true, reportsToPositionId: true },
      });
      if (!before) throw new AppError('NOT_FOUND');
      const data: Prisma.OrgPositionUncheckedUpdateInput = {};
      if (patch.title !== undefined && patch.title !== before.title) data.title = patch.title;
      // One holder at a time: naming a user clears the member and vice versa; both null = vacant.
      if (patch.holderUserId !== undefined || patch.holderMemberId !== undefined) {
        let userId = patch.holderUserId !== undefined ? patch.holderUserId : before.holderUserId;
        let memberId = patch.holderMemberId !== undefined ? patch.holderMemberId : before.holderMemberId;
        if (patch.holderUserId) memberId = null;
        if (patch.holderMemberId) userId = null;
        await this.assertHolder(tx, userId, memberId);
        if (userId !== before.holderUserId) data.holderUserId = userId;
        if (memberId !== before.holderMemberId) data.holderMemberId = memberId;
      }
      if (patch.reportsToPositionId !== undefined && patch.reportsToPositionId !== before.reportsToPositionId) {
        await this.assertReportsTo(tx, id, patch.reportsToPositionId);
        data.reportsToPositionId = patch.reportsToPositionId;
      }
      if (!Object.keys(data).length) return;
      await tx.orgPosition.update({ where: { id }, data });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_POSITION_UPDATED,
          entityType: 'org_position',
          entityId: id,
          before: Object.fromEntries(Object.keys(data).map((k) => [k, before[k as keyof typeof before]])),
          after: data,
        },
        tx,
      );
    });
    return this.positionDto(id);
  }

  /** `POST /org/positions/:id/move` — another unit, another manager and/or sibling position. */
  async movePosition(
    id: string,
    input: { unitId?: string; reportsToPositionId?: string | null; sort?: number },
    ctx: RequestContext,
  ): Promise<OrgPositionDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const before = await tx.orgPosition.findUnique({
        where: { id },
        select: { unitId: true, reportsToPositionId: true, sort: true },
      });
      if (!before) throw new AppError('NOT_FOUND');
      const data: Prisma.OrgPositionUncheckedUpdateInput = {};
      const unitChanged = input.unitId !== undefined && input.unitId !== before.unitId;
      if (unitChanged) {
        await this.liveUnit(tx, input.unitId!, 'unitId');
        data.unitId = input.unitId;
      }
      if (input.reportsToPositionId !== undefined && input.reportsToPositionId !== before.reportsToPositionId) {
        await this.assertReportsTo(tx, id, input.reportsToPositionId);
        data.reportsToPositionId = input.reportsToPositionId;
      }
      if (input.sort !== undefined && input.sort !== before.sort) data.sort = input.sort;
      else if (unitChanged && input.sort === undefined) {
        const siblings = await tx.orgPosition.findMany({ where: { unitId: input.unitId }, select: { sort: true } });
        data.sort = nextSort(siblings.map((s) => s.sort));
      }
      if (!Object.keys(data).length) return;
      await tx.orgPosition.update({ where: { id }, data });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_POSITION_MOVED,
          entityType: 'org_position',
          entityId: id,
          before: { unitId: before.unitId, reportsToPositionId: before.reportsToPositionId, sort: before.sort },
          after: data,
        },
        tx,
      );
    });
    return this.positionDto(id);
  }

  /** Deleting a position: positions that reported to it report to nobody (FK SET NULL). */
  async deletePosition(id: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const before = await tx.orgPosition.findUnique({
        where: { id },
        select: { unitId: true, title: true, holderUserId: true, holderMemberId: true, _count: { select: { reports: true } } },
      });
      if (!before) throw new AppError('NOT_FOUND');
      await tx.orgPosition.delete({ where: { id } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.ORG_POSITION_DELETED,
          entityType: 'org_position',
          entityId: id,
          before: {
            unitId: before.unitId,
            title: before.title,
            holderUserId: before.holderUserId,
            holderMemberId: before.holderMemberId,
            detachedReports: before._count.reports,
          },
        },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── helpers

  /** One structural change at a time (cycle checks read the whole forest). */
  private async lock(tx: Tx): Promise<void> {
    // A12: one lock per workspace (each workspace has its own structure).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('nuzli.org_structure:' || ${activeWorkspaceId()}::text))`;
  }

  private async liveUnit(tx: Tx, id: string, field: string): Promise<void> {
    const unit = await tx.orgUnit.findUnique({ where: { id }, select: { archivedAt: true } });
    if (!unit) throw new AppError('VALIDATION_FAILED', { fieldErrors: { [field]: ['الوحدة غير موجودة'] } });
    if (unit.archivedAt) throw new AppError('ORG_UNIT_ARCHIVED', { field });
  }

  private async siblingUnitSorts(tx: Tx, parentId: string | null): Promise<number[]> {
    const rows = await tx.orgUnit.findMany({ where: { parentId }, select: { sort: true } });
    return rows.map((r) => r.sort);
  }

  private async assertEmptyForArchive(tx: Tx, id: string): Promise<void> {
    const [children, teams] = await Promise.all([
      tx.orgUnit.count({ where: { parentId: id, archivedAt: null } }),
      tx.team.count({ where: { orgUnitId: id, status: { not: 'ARCHIVED' } } }),
    ]);
    if (children || teams) throw new AppError('ORG_UNIT_NOT_EMPTY', { children, teams });
  }

  private async assertHolder(tx: Tx, userId: string | null, memberId: string | null): Promise<void> {
    if (userId && memberId) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { holderUserId: ['المنصب يشغله مستخدم أو عضو فريق، لا الاثنان'] },
      });
    }
    if (userId) {
      // A12: only a member of this workspace (or an owner) may hold one of its positions.
      const u = await tx.user.findFirst({
        where: { id: userId, OR: [memberOf(activeWorkspaceId()), { accountRole: 'OWNER' }] },
        select: { archivedAt: true },
      });
      if (!u || u.archivedAt) throw new AppError('VALIDATION_FAILED', { fieldErrors: { holderUserId: ['المستخدم غير موجود'] } });
    }
    if (memberId) {
      const m = await tx.teamMember.findUnique({ where: { id: memberId }, select: { archivedAt: true } });
      if (!m || m.archivedAt) throw new AppError('VALIDATION_FAILED', { fieldErrors: { holderMemberId: ['العضو غير موجود'] } });
    }
  }

  private async positionExists(tx: Tx, id: string): Promise<void> {
    const p = await tx.orgPosition.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new AppError('VALIDATION_FAILED', { fieldErrors: { reportsToPositionId: ['المنصب غير موجود'] } });
  }

  private async assertReportsTo(tx: Tx, id: string, reportsTo: string | null): Promise<void> {
    if (!reportsTo) return;
    if (reportsTo === id) throw new AppError('ORG_REPORTS_CYCLE');
    await this.positionExists(tx, reportsTo);
    const all = await tx.orgPosition.findMany({ select: { id: true, reportsToPositionId: true } });
    const parentOf = new Map(all.map((p) => [p.id, p.reportsToPositionId]));
    if (wouldCreateCycle(parentOf, id, reportsTo)) throw new AppError('ORG_REPORTS_CYCLE');
  }

  private async unitDto(id: string): Promise<OrgUnitDto> {
    const tree = await this.tree({ id: 'system', role: 'ADMIN', status: 'ACTIVE' }, true);
    const unit = tree.units.find((u) => u.id === id);
    if (!unit) throw new AppError('NOT_FOUND');
    return unit;
  }

  private async positionDto(id: string): Promise<OrgPositionDto> {
    const row = await this.prisma.orgPosition.findUnique({ where: { id }, select: POSITION_SELECT });
    if (!row) throw new AppError('NOT_FOUND');
    return toPositionDto(row);
  }
}
