import {
  can,
  createOrgPositionSchema,
  createOrgUnitSchema,
  moveOrgPositionSchema,
  moveOrgUnitSchema,
  updateOrgPositionSchema,
  updateOrgUnitSchema,
  type OrgPositionDto,
  type OrgTreeDto,
  type OrgUnitDto,
  type Permission,
} from '@nuzli/shared';
import type { ApiClient } from '../client';
import { nextSort, orderTree, wouldCreateCycle } from '../../features/org/tree';
import type { DemoAudit, DemoDb, DemoOrgPosition, DemoOrgUnit, DemoUser } from './db';
import { groupOpenLeaders, supervisorDtos } from './leaders';
import { fail, newId, validate } from './util';

export interface OrgInternals {
  db: DemoDb;
  actor(permission?: Permission): Promise<DemoUser>;
  writeAudit(entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>): Promise<unknown>;
}

const MISSING_COLOR = { id: '00000000-0000-4000-8000-000000000000', name: '—', hex: '#5B6B72', isActive: false };

/**
 * The organisational structure in the demo (owner request A9, ADR-102) with the API's rules
 * (`apps/api/src/org/org.service.ts`): units in a tree, positions held by a user, a member or
 * nobody, reporting lines, optional team links; admins manage (`org.manage`), admins and
 * supervisors read (`org.read`); cycles are refused (ORG_CYCLE / ORG_REPORTS_CYCLE); archived
 * units take nothing new (ORG_UNIT_ARCHIVED); only empty units are deleted (ORG_UNIT_NOT_EMPTY).
 * Every change is audited `org.*`. Dexie transactions serialise structural changes.
 */
export function createOrg(api: OrgInternals): ApiClient['org'] {
  const db = api.db;
  const tx = <T>(fn: () => Promise<T>) =>
    db.transaction('rw', [db.orgUnits, db.orgPositions, db.teams, db.users, db.members, db.audit], fn);

  async function buildTree(includeArchived: boolean): Promise<OrgTreeDto> {
    const [units, positions, users, members, memberships, teams, colors, leaderRows] = await Promise.all([
      db.orgUnits.toArray(),
      db.orgPositions.toArray(),
      db.users.toArray(),
      db.members.toArray(),
      db.memberships.toArray(),
      db.teams.toArray(),
      db.colors.toArray(),
      db.teamSupervisors.toArray(),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const memberById = new Map(members.map((m) => [m.id, m]));
    const colorById = new Map(colors.map((c) => [c.id, c]));
    const teamById = new Map(teams.map((tm) => [tm.id, tm]));
    const leaders = groupOpenLeaders(leaderRows);
    const openTeam = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const m of memberships) {
      if (m.validTo !== null) continue;
      openTeam.set(m.memberId, m.teamId);
      counts.set(m.teamId, (counts.get(m.teamId) ?? 0) + 1);
    }
    const colorOf = (id: string) => {
      const c = colorById.get(id);
      return c ? { id: c.id, name: c.name, hex: c.hex, isActive: c.isActive } : MISSING_COLOR;
    };
    const positionDto = (p: DemoOrgPosition): OrgPositionDto => {
      let holder: OrgPositionDto['holder'] = null;
      const u = p.holderUserId ? userById.get(p.holderUserId) : undefined;
      const m = p.holderMemberId ? memberById.get(p.holderMemberId) : undefined;
      if (u) {
        holder = { type: 'USER', id: u.id, fullName: u.fullName, hasPhoto: Boolean(u.photoFileId), role: u.role };
      } else if (m) {
        const tm = openTeam.has(m.id) ? teamById.get(openTeam.get(m.id)!) : undefined;
        holder = {
          type: 'MEMBER',
          id: m.id,
          fullName: m.fullName,
          hasPhoto: Boolean(m.photoFileId),
          team: tm ? { id: tm.id, name: tm.name, color: colorOf(tm.colorId) } : null,
        };
      }
      return { id: p.id, unitId: p.unitId, title: p.title, holder, reportsToPositionId: p.reportsToPositionId, sort: p.sort };
    };
    const live = includeArchived ? units : units.filter((u) => !u.archivedAt);
    const out: OrgUnitDto[] = orderTree(live).map((u) => ({
      id: u.id,
      parentId: u.parentId,
      name: u.name,
      kind: u.kind,
      code: u.code,
      sort: u.sort,
      archivedAt: u.archivedAt,
      positions: positions
        .filter((p) => p.unitId === u.id)
        .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title, 'ar'))
        .map(positionDto),
      teams: teams
        .filter((tm) => tm.orgUnitId === u.id && tm.status !== 'ARCHIVED')
        .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        .map((tm) => ({
          id: tm.id,
          name: tm.name,
          status: tm.status,
          color: colorOf(tm.colorId),
          memberCount: counts.get(tm.id) ?? 0,
          supervisors: supervisorDtos(leaders.get(tm.id) ?? [], userById).map(({ id, fullName, isPrimary, hasPhoto }) => ({
            id,
            fullName,
            isPrimary,
            hasPhoto,
          })),
        })),
    }));
    return { units: out, generatedAt: new Date().toISOString() };
  }

  async function unitDto(id: string): Promise<OrgUnitDto> {
    const unit = (await buildTree(true)).units.find((u) => u.id === id);
    if (!unit) fail('NOT_FOUND');
    return unit;
  }

  async function positionDto(id: string): Promise<OrgPositionDto> {
    for (const u of (await buildTree(true)).units) {
      const p = u.positions.find((x) => x.id === id);
      if (p) return p;
    }
    fail('NOT_FOUND');
  }

  async function liveUnit(id: string, field: string): Promise<DemoOrgUnit> {
    const unit = await db.orgUnits.get(id);
    if (!unit) fail('VALIDATION_FAILED', { fieldErrors: { [field]: ['الوحدة غير موجودة'] } });
    if (unit.archivedAt) fail('ORG_UNIT_ARCHIVED', { field });
    return unit;
  }

  async function siblingSorts(parentId: string | null) {
    return (await db.orgUnits.toArray()).filter((u) => u.parentId === parentId).map((u) => u.sort);
  }

  async function assertHolder(userId: string | null, memberId: string | null) {
    if (userId && memberId) {
      fail('VALIDATION_FAILED', { fieldErrors: { holderUserId: ['المنصب يشغله مستخدم أو عضو فريق، لا الاثنان'] } });
    }
    if (userId && !(await db.users.get(userId))) {
      fail('VALIDATION_FAILED', { fieldErrors: { holderUserId: ['المستخدم غير موجود'] } });
    }
    if (memberId && !(await db.members.get(memberId))) {
      fail('VALIDATION_FAILED', { fieldErrors: { holderMemberId: ['العضو غير موجود'] } });
    }
  }

  async function assertReportsTo(id: string | null, reportsTo: string | null) {
    if (!reportsTo) return;
    if (reportsTo === id) fail('ORG_REPORTS_CYCLE');
    if (!(await db.orgPositions.get(reportsTo))) {
      fail('VALIDATION_FAILED', { fieldErrors: { reportsToPositionId: ['المنصب غير موجود'] } });
    }
    if (!id) return;
    const all = await db.orgPositions.toArray();
    const parentOf = new Map(all.map((p) => [p.id, p.reportsToPositionId]));
    if (wouldCreateCycle(parentOf, id, reportsTo)) fail('ORG_REPORTS_CYCLE');
  }

  const audit = (actorId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) =>
    api.writeAudit({ actorId, action, entityType, entityId, before, after });

  return {
    tree: async (query = {}) => {
      const viewer = await api.actor('org.read');
      return buildTree(Boolean(query.includeArchived) && can(viewer, 'org.manage'));
    },

    createUnit: async (input) => {
      const actor = await api.actor('org.manage');
      const data = validate(createOrgUnitSchema, input);
      const id = newId();
      await tx(async () => {
        if (data.parentId) await liveUnit(data.parentId, 'parentId');
        if (data.code && (await db.orgUnits.toArray()).some((u) => !u.archivedAt && u.code === data.code)) fail('NAME_TAKEN');
        const sort = data.sort ?? nextSort(await siblingSorts(data.parentId));
        await db.orgUnits.add({
          id,
          parentId: data.parentId,
          name: data.name,
          kind: data.kind,
          code: data.code || null,
          sort,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        });
        await audit(actor.id, 'org.unit_created', 'org_unit', id, null, {
          name: data.name,
          kind: data.kind,
          parentId: data.parentId,
          code: data.code ?? null,
          sort,
        });
      });
      return unitDto(id);
    },

    updateUnit: async (id, input) => {
      const actor = await api.actor('org.manage');
      const data = validate(updateOrgUnitSchema, input);
      await tx(async () => {
        const before = await db.orgUnits.get(id);
        if (!before) fail('NOT_FOUND');
        const next: DemoOrgUnit = { ...before };
        const b: Record<string, unknown> = {};
        const a: Record<string, unknown> = {};
        const set = (key: 'name' | 'kind' | 'code', value: unknown) => {
          if (value === undefined || value === before[key]) return;
          (next as unknown as Record<string, unknown>)[key] = value;
          b[key] = before[key];
          a[key] = value;
        };
        set('name', data.name);
        set('kind', data.kind);
        set('code', data.code === '' ? null : data.code);
        if (data.archived === true && !before.archivedAt) {
          const children = (await db.orgUnits.toArray()).filter((u) => u.parentId === id && !u.archivedAt).length;
          const teams = (await db.teams.toArray()).filter((tm) => tm.orgUnitId === id && tm.status !== 'ARCHIVED').length;
          if (children || teams) fail('ORG_UNIT_NOT_EMPTY', { children, teams });
          next.archivedAt = new Date().toISOString();
          b.archived = false;
          a.archived = true;
        } else if (data.archived === false && before.archivedAt) {
          if (before.parentId) await liveUnit(before.parentId, 'parentId');
          next.archivedAt = null;
          b.archived = true;
          a.archived = false;
        }
        if (!Object.keys(a).length) return;
        await db.orgUnits.put(next);
        await audit(actor.id, 'org.unit_updated', 'org_unit', id, b, a);
      });
      return unitDto(id);
    },

    moveUnit: async (id, input) => {
      const actor = await api.actor('org.manage');
      const data = validate(moveOrgUnitSchema, input);
      await tx(async () => {
        const unit = await db.orgUnits.get(id);
        if (!unit) fail('NOT_FOUND');
        if (unit.archivedAt) fail('ORG_UNIT_ARCHIVED');
        if (data.parentId) await liveUnit(data.parentId, 'parentId');
        const all = await db.orgUnits.toArray();
        const parentOf = new Map(all.map((u) => [u.id, u.parentId]));
        if (wouldCreateCycle(parentOf, id, data.parentId)) fail('ORG_CYCLE');
        const sameParent = unit.parentId === data.parentId;
        const sort = data.sort ?? (sameParent ? unit.sort : nextSort(await siblingSorts(data.parentId)));
        if (sameParent && sort === unit.sort) return;
        await db.orgUnits.update(id, { parentId: data.parentId, sort });
        await audit(actor.id, 'org.unit_moved', 'org_unit', id, { parentId: unit.parentId, sort: unit.sort }, { parentId: data.parentId, sort });
      });
      return unitDto(id);
    },

    deleteUnit: async (id) => {
      const actor = await api.actor('org.manage');
      await tx(async () => {
        const unit = await db.orgUnits.get(id);
        if (!unit) fail('NOT_FOUND');
        const children = (await db.orgUnits.toArray()).filter((u) => u.parentId === id).length;
        const positions = await db.orgPositions.where('unitId').equals(id).count();
        const teams = (await db.teams.toArray()).filter((tm) => tm.orgUnitId === id).length;
        if (children || positions || teams) fail('ORG_UNIT_NOT_EMPTY', { children, positions, teams });
        await db.orgUnits.delete(id);
        await audit(actor.id, 'org.unit_deleted', 'org_unit', id, { name: unit.name, kind: unit.kind, parentId: unit.parentId }, null);
      });
    },

    createPosition: async (input) => {
      const actor = await api.actor('org.manage');
      const data = validate(createOrgPositionSchema, input);
      const id = newId();
      await tx(async () => {
        await liveUnit(data.unitId, 'unitId');
        await assertHolder(data.holderUserId ?? null, data.holderMemberId ?? null);
        await assertReportsTo(null, data.reportsToPositionId ?? null);
        const siblings = await db.orgPositions.where('unitId').equals(data.unitId).toArray();
        const sort = data.sort ?? nextSort(siblings.map((s) => s.sort));
        await db.orgPositions.add({
          id,
          unitId: data.unitId,
          title: data.title,
          holderUserId: data.holderUserId ?? null,
          holderMemberId: data.holderMemberId ?? null,
          reportsToPositionId: data.reportsToPositionId ?? null,
          sort,
          createdAt: new Date().toISOString(),
        });
        await audit(actor.id, 'org.position_created', 'org_position', id, null, {
          unitId: data.unitId,
          title: data.title,
          holderUserId: data.holderUserId ?? null,
          holderMemberId: data.holderMemberId ?? null,
          reportsToPositionId: data.reportsToPositionId ?? null,
        });
      });
      return positionDto(id);
    },

    updatePosition: async (id, input) => {
      const actor = await api.actor('org.manage');
      const data = validate(updateOrgPositionSchema, input);
      await tx(async () => {
        const before = await db.orgPositions.get(id);
        if (!before) fail('NOT_FOUND');
        const patch: Partial<DemoOrgPosition> = {};
        if (data.title !== undefined && data.title !== before.title) patch.title = data.title;
        // One holder at a time: naming a user clears the member and vice versa; both null = vacant.
        if (data.holderUserId !== undefined || data.holderMemberId !== undefined) {
          let userId = data.holderUserId !== undefined ? data.holderUserId : before.holderUserId;
          let memberId = data.holderMemberId !== undefined ? data.holderMemberId : before.holderMemberId;
          if (data.holderUserId) memberId = null;
          if (data.holderMemberId) userId = null;
          await assertHolder(userId, memberId);
          if (userId !== before.holderUserId) patch.holderUserId = userId;
          if (memberId !== before.holderMemberId) patch.holderMemberId = memberId;
        }
        if (data.reportsToPositionId !== undefined && data.reportsToPositionId !== before.reportsToPositionId) {
          await assertReportsTo(id, data.reportsToPositionId);
          patch.reportsToPositionId = data.reportsToPositionId;
        }
        if (!Object.keys(patch).length) return;
        await db.orgPositions.update(id, patch);
        await audit(
          actor.id,
          'org.position_updated',
          'org_position',
          id,
          Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof DemoOrgPosition]])),
          patch,
        );
      });
      return positionDto(id);
    },

    movePosition: async (id, input) => {
      const actor = await api.actor('org.manage');
      const data = validate(moveOrgPositionSchema, input);
      await tx(async () => {
        const before = await db.orgPositions.get(id);
        if (!before) fail('NOT_FOUND');
        const patch: Partial<DemoOrgPosition> = {};
        const unitChanged = data.unitId !== undefined && data.unitId !== before.unitId;
        if (unitChanged) {
          await liveUnit(data.unitId!, 'unitId');
          patch.unitId = data.unitId;
        }
        if (data.reportsToPositionId !== undefined && data.reportsToPositionId !== before.reportsToPositionId) {
          await assertReportsTo(id, data.reportsToPositionId);
          patch.reportsToPositionId = data.reportsToPositionId;
        }
        if (data.sort !== undefined && data.sort !== before.sort) patch.sort = data.sort;
        else if (unitChanged && data.sort === undefined) {
          const siblings = await db.orgPositions.where('unitId').equals(data.unitId!).toArray();
          patch.sort = nextSort(siblings.map((s) => s.sort));
        }
        if (!Object.keys(patch).length) return;
        await db.orgPositions.update(id, patch);
        await audit(
          actor.id,
          'org.position_moved',
          'org_position',
          id,
          { unitId: before.unitId, reportsToPositionId: before.reportsToPositionId, sort: before.sort },
          patch,
        );
      });
      return positionDto(id);
    },

    deletePosition: async (id) => {
      const actor = await api.actor('org.manage');
      await tx(async () => {
        const before = await db.orgPositions.get(id);
        if (!before) fail('NOT_FOUND');
        // Positions that reported to it now report to nobody (FK SET NULL in the API).
        const reports = await db.orgPositions.filter((p) => p.reportsToPositionId === id).toArray();
        for (const r of reports) await db.orgPositions.update(r.id, { reportsToPositionId: null });
        await db.orgPositions.delete(id);
        await audit(actor.id, 'org.position_deleted', 'org_position', id, {
          unitId: before.unitId,
          title: before.title,
          holderUserId: before.holderUserId,
          holderMemberId: before.holderMemberId,
          detachedReports: reports.length,
        }, null);
      });
    },
  };
}
