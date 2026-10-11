import {
  COLOR_RESERVING_STATUSES,
  ERRORS,
  archiveTeamSchema,
  can,
  cardPreviewSchema,
  cardSizeSchema,
  cardTemplateSchema,
  changeSupervisorSchema,
  createTeamSchema,
  importMembersSchema,
  maskNationalId,
  memberInputSchema,
  moveMembersSchema,
  printBatchSchema,
  referenceItemSchema,
  rejectTeamSchema,
  teamColorSchema,
  toWesternDigits,
  updateCardTemplateSchema,
  updateMemberSchema,
  updateReferenceItemSchema,
  updateTeamColorSchema,
  updateTeamSchema,
  violationVisibilitySchema,
  type CardData,
  type CardPreviewSubjectDto,
  type CardSizeDto,
  type CardTemplateDto,
  type ColorTakenDetails,
  type LogoDto,
  type MemberDto,
  type Permission,
  type PrintBatchDetailDto,
  type PrintBatchDto,
  type ReferenceItemDto,
  type TeamColorDto,
  type TeamDto,
  type TeamSummaryDto,
} from '@nuzli/shared';
import type { ApiClient } from '../client';
import { t } from '../../i18n';
import { toMemberInput, validateImportRows } from '../../features/members/importRows';
import type {
  DemoAudit,
  DemoBatch,
  DemoColor,
  DemoDb,
  DemoLogo,
  DemoMember,
  DemoMembership,
  DemoReference,
  DemoTeam,
  DemoTemplate,
  DemoUser,
} from './db';
import { fail, newId, paginate, sameName, validate } from './util';

/** What the Phase 2 module needs from the DemoApi instance. */
export interface DemoInternals {
  db: DemoDb;
  actor(permission?: Permission): Promise<DemoUser>;
  writeAudit(entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>): Promise<unknown>;
  notify(userId: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  readSettings(): ReturnType<ApiClient['settings']['get']>;
  demoPasswordHash(): Promise<string>;
}

export type Phase2Api = Pick<
  ApiClient,
  'colors' | 'teams' | 'members' | 'reference' | 'cards' | 'logos'
>;

const RESERVING = new Set<string>(COLOR_RESERVING_STATUSES);
const STATUS_ORDER: Record<string, number> = { PENDING_APPROVAL: 0, ACTIVE: 1, ARCHIVED: 2 };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ar');
const byFullName = (a: { fullName: string }, b: { fullName: string }) =>
  a.fullName.localeCompare(b.fullName, 'ar');
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

interface World {
  users: Map<string, DemoUser>;
  colors: Map<string, DemoColor>;
  teams: Map<string, DemoTeam>;
  reference: Map<string, DemoReference>;
  /** memberId → the open membership row. */
  open: Map<string, DemoMembership>;
  /** teamId → open membership count. */
  counts: Map<string, number>;
}

// ---------------------------------------------------------------- pure helpers

/** Same rule as the API's `availableColors()` (brief §5.2). */
export function availableColors(
  colors: readonly DemoColor[],
  teams: readonly DemoTeam[],
  excludeTeamId?: string,
): TeamColorDto[] {
  const reserving = teams.filter((tm) => RESERVING.has(tm.status));
  const own = excludeTeamId ? reserving.find((tm) => tm.id === excludeTeamId)?.colorId : undefined;
  const taken = new Set(reserving.filter((tm) => tm.id !== excludeTeamId).map((tm) => tm.colorId));
  return [...colors]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((c) => c.id === own || (c.isActive && !taken.has(c.id)))
    .map(colorDto);
}

function colorDto(c: DemoColor): TeamColorDto {
  return { id: c.id, name: c.name, hex: c.hex, isActive: c.isActive };
}

const MISSING_COLOR: DemoColor = {
  id: '00000000-0000-4000-8000-000000000000',
  name: '—',
  hex: '#5B6B72',
  isActive: false,
  sortOrder: 0,
};

/** Bytes → base64 without Buffer (works in browsers and jsdom). */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(blob);
    });
  }
  return blob.arrayBuffer().then((b) => new Uint8Array(b));
}

/** Magic bytes: the declared type must match the content (no SVG, no renamed files). */
export function sniffImageType(bytes: Uint8Array): (typeof LOGO_TYPES)[number] | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

// ---------------------------------------------------------------- module

export function createPhase2(api: DemoInternals): Phase2Api {
  const db = api.db;
  const tx = <T>(fn: () => Promise<T>) => db.transaction('rw', db.tables, fn);

  async function world(): Promise<World> {
    const [users, colors, teams, reference, memberships] = await Promise.all([
      db.users.toArray(),
      db.colors.toArray(),
      db.teams.toArray(),
      db.reference.toArray(),
      db.memberships.toArray(),
    ]);
    const open = new Map<string, DemoMembership>();
    const counts = new Map<string, number>();
    for (const m of memberships) {
      if (m.validTo !== null) continue;
      open.set(m.memberId, m);
      counts.set(m.teamId, (counts.get(m.teamId) ?? 0) + 1);
    }
    return {
      users: new Map(users.map((u) => [u.id, u])),
      colors: new Map(colors.map((c) => [c.id, c])),
      teams: new Map(teams.map((tm) => [tm.id, tm])),
      reference: new Map(reference.map((r) => [r.id, r])),
      open,
      counts,
    };
  }

  const person = (w: World, id: string | null) => {
    const u = id ? w.users.get(id) : undefined;
    return u ? { id: u.id, fullName: u.fullName } : null;
  };

  function summary(team: DemoTeam, w: World): TeamSummaryDto {
    return { id: team.id, name: team.name, color: colorDto(w.colors.get(team.colorId) ?? MISSING_COLOR) };
  }

  function teamDto(team: DemoTeam, w: World): TeamDto {
    return {
      ...summary(team, w),
      status: team.status,
      supervisor: person(w, team.supervisorId),
      memberCount: w.counts.get(team.id) ?? 0,
      createdAt: team.createdAt,
      violationVisibility: team.violationVisibility,
    };
  }

  const refName = (w: World, id: string | null) => (id ? w.reference.get(id)?.name ?? null : null);

  function memberDto(m: DemoMember, w: World, full = false): MemberDto {
    const open = w.open.get(m.id);
    const team = open ? w.teams.get(open.teamId) : undefined;
    return {
      id: m.id,
      fullName: m.fullName,
      nationalIdMasked: maskNationalId(m.nationalId),
      ...(full ? { nationalId: m.nationalId } : {}),
      jobTitle: refName(w, m.jobTitleId) ?? m.jobTitleText,
      jobTitleId: m.jobTitleId,
      department: refName(w, m.departmentId) ?? m.departmentText,
      departmentId: m.departmentId,
      status: m.status,
      team: team ? summary(team, w) : null,
      photoFileId: m.photoFileId,
    };
  }

  // ------------------------------------------------------------ scope (same rules as apps/api)

  const readsAll = (u: DemoUser) => can(u, 'teams.readAll');
  const canReadTeam = (u: DemoUser, team: DemoTeam) =>
    readsAll(u) || (can(u, 'teams.readOwn') && team.supervisorId === u.id);
  function assertReadable(u: DemoUser, team: DemoTeam | undefined): asserts team is DemoTeam {
    if (!team || !canReadTeam(u, team)) fail('NOT_FOUND');
  }
  function assertManageable(u: DemoUser, team: DemoTeam | undefined): asserts team is DemoTeam {
    assertReadable(u, team);
    if (can(u, 'teams.manageAll')) return;
    if (can(u, 'teams.manageOwn') && team.supervisorId === u.id) return;
    fail('FORBIDDEN');
  }
  const canManageMemberIn = (u: DemoUser, team: DemoTeam | null | undefined) =>
    can(u, 'members.manage') || (!!team && can(u, 'members.manageOwn') && team.supervisorId === u.id);
  /** Supervisors see their own teams' members and unassigned people (apps/api memberScopeWhere). */
  const canSeeMember = (u: DemoUser, team: DemoTeam | null | undefined) =>
    readsAll(u) || can(u, 'members.manage') || !team || team.supervisorId === u.id;
  const memberTeam = (w: World, memberId: string) => {
    const open = w.open.get(memberId);
    return open ? w.teams.get(open.teamId) ?? null : null;
  };

  async function readerOfTeams() {
    const u = await api.actor();
    if (!can(u, 'teams.readOwn') && !readsAll(u)) fail('FORBIDDEN');
    return u;
  }

  // ------------------------------------------------------------ colour checks (inside tx)

  async function assertColorFree(colorId: string, excludeTeamId?: string) {
    const [colors, teams] = await Promise.all([db.colors.toArray(), db.teams.toArray()]);
    const color = colors.find((c) => c.id === colorId);
    const own = excludeTeamId ? teams.find((tm) => tm.id === excludeTeamId)?.colorId : undefined;
    if (!color || (!color.isActive && color.id !== own)) {
      fail('COLOR_INACTIVE', { fieldErrors: { colorId: [ERRORS.COLOR_INACTIVE] } });
    }
    const taken = teams.some(
      (tm) => tm.id !== excludeTeamId && tm.colorId === colorId && RESERVING.has(tm.status),
    );
    if (taken) {
      const details: ColorTakenDetails = {
        fieldErrors: { colorId: [ERRORS.COLOR_TAKEN] },
        refresh: 'colors',
        available: availableColors(colors, teams, excludeTeamId),
      };
      fail('COLOR_TAKEN', details);
    }
  }

  async function assertSupervisor(userId: string) {
    const u = await db.users.get(userId);
    if (!u || u.role !== 'SUPERVISOR' || u.status !== 'ACTIVE') {
      fail('NOT_A_SUPERVISOR', { fieldErrors: { supervisorId: [ERRORS.NOT_A_SUPERVISOR] } });
    }
    return u;
  }

  async function assertMayLeadAnother(supervisorId: string, exceptTeamId?: string) {
    const settings = await api.readSettings();
    if (settings.ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR) return;
    const leads = await db.teams
      .where('supervisorId')
      .equals(supervisorId)
      .filter((tm) => tm.id !== exceptTeamId && RESERVING.has(tm.status))
      .count();
    if (leads > 0) fail('MULTIPLE_TEAMS_DISABLED');
  }

  async function assertNationalIdFree(nationalId: string, exceptMemberId?: string) {
    const hit = await db.members.where('nationalId').equals(nationalId).first();
    if (hit && hit.id !== exceptMemberId) {
      fail('NATIONAL_ID_TAKEN', { fieldErrors: { nationalId: [ERRORS.NATIONAL_ID_TAKEN] } });
    }
  }

  async function assertReference(kind: DemoReference['kind'], id: string | undefined, field: string) {
    if (!id) return;
    const r = await db.reference.get(id);
    if (!r || r.kind !== kind) fail('VALIDATION_FAILED', { fieldErrors: { [field]: [ERRORS.NOT_FOUND] } });
  }

  /** Closes every open membership of a team at `at` (archive / reject). */
  async function closeTeamMemberships(teamId: string, at: string) {
    const rows = await db.memberships
      .where('teamId')
      .equals(teamId)
      .filter((m) => m.validTo === null)
      .toArray();
    for (const r of rows) await db.memberships.update(r.id, { validTo: at });
    return rows.length;
  }

  async function closeSupervisorHistory(teamId: string, at: string) {
    const rows = await db.supervisorHistory
      .where('teamId')
      .equals(teamId)
      .filter((h) => h.validTo === null)
      .toArray();
    for (const r of rows) await db.supervisorHistory.update(r.id, { validTo: at });
  }

  async function insertMember(
    input: ReturnType<typeof memberInputSchema.parse>,
    teamId: string,
    actorId: string,
    at: string,
  ): Promise<DemoMember> {
    await assertNationalIdFree(input.nationalId);
    await assertReference('job-titles', input.jobTitleId, 'jobTitleId');
    await assertReference('departments', input.departmentId, 'departmentId');
    const member: DemoMember = {
      id: newId(),
      fullName: input.fullName,
      nationalId: input.nationalId,
      jobTitleId: input.jobTitleId ?? null,
      jobTitleText: input.jobTitleId ? null : input.jobTitleText ?? null,
      departmentId: input.departmentId ?? null,
      departmentText: input.departmentId ? null : input.departmentText ?? null,
      status: 'ACTIVE',
      photoFileId: null,
      createdAt: at,
    };
    await db.members.add(member);
    await db.memberships.add({
      id: newId(),
      memberId: member.id,
      teamId,
      validFrom: at,
      validTo: null,
      movedById: actorId,
      reason: null,
    });
    return member;
  }

  // ------------------------------------------------------------ colours

  const colors: Phase2Api['colors'] = {
    available: async (excludeTeamId) => {
      const u = await readerOfTeams();
      const [all, teams] = await Promise.all([db.colors.toArray(), db.teams.toArray()]);
      let exclude = excludeTeamId;
      // A supervisor may only keep the colour of a team they lead.
      const team = exclude ? teams.find((tm) => tm.id === exclude) : undefined;
      if (exclude && (!team || !canReadTeam(u, team))) exclude = undefined;
      return availableColors(all, teams, exclude);
    },
    list: async () => {
      await api.actor('colors.manage');
      const [all, teams] = await Promise.all([db.colors.toArray(), db.teams.toArray()]);
      const holder = new Map(
        teams.filter((tm) => RESERVING.has(tm.status)).map((tm) => [tm.colorId, tm]),
      );
      return all
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => {
          const h = holder.get(c.id);
          return { ...colorDto(c), inUseBy: h ? { teamId: h.id, teamName: h.name } : null };
        });
    },
    create: async (input) => {
      const u = await api.actor('colors.manage');
      const data = validate(teamColorSchema, input);
      const hex = data.hex.toUpperCase();
      return tx(async () => {
        const all = await db.colors.toArray();
        if (all.some((c) => c.hex.toUpperCase() === hex))
          fail('COLOR_EXISTS', { fieldErrors: { hex: [ERRORS.COLOR_EXISTS] } });
        if (all.some((c) => sameName(c.name, data.name)))
          fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        const row: DemoColor = {
          id: newId(),
          name: data.name,
          hex,
          isActive: true,
          sortOrder: Math.max(0, ...all.map((c) => c.sortOrder)) + 1,
        };
        await db.colors.add(row);
        await api.writeAudit({
          actorId: u.id,
          action: 'color.created',
          entityType: 'team_color',
          entityId: row.id,
          before: null,
          after: { name: row.name, hex: row.hex },
        });
        return colorDto(row);
      });
    },
    update: async (id, input) => {
      const u = await api.actor('colors.manage');
      const data = validate(updateTeamColorSchema, input);
      return tx(async () => {
        const before = await db.colors.get(id);
        if (!before) fail('NOT_FOUND');
        if (data.name !== undefined) {
          const clash = (await db.colors.toArray()).some(
            (c) => c.id !== id && sameName(c.name, data.name!),
          );
          if (clash) fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        }
        const after: DemoColor = {
          ...before,
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        };
        await db.colors.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'color.updated',
          entityType: 'team_color',
          entityId: id,
          before: { name: before.name, isActive: before.isActive },
          after: { name: after.name, isActive: after.isActive },
        });
        return colorDto(after);
      });
    },
  };

  // ------------------------------------------------------------ teams

  const teams: Phase2Api['teams'] = {
    list: async (query = {}) => {
      const u = await readerOfTeams();
      const w = await world();
      const q = (query.q ?? '').trim().toLowerCase();
      return [...w.teams.values()]
        .filter((tm) => canReadTeam(u, tm))
        // As built: no status = ACTIVE + PENDING_APPROVAL; ALL includes archived teams.
        .filter((tm) =>
          query.status === 'ALL'
            ? true
            : query.status
              ? tm.status === query.status
              : tm.status !== 'ARCHIVED',
        )
        .filter((tm) => !q || tm.name.toLowerCase().includes(q))
        .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || byName(a, b))
        .map((tm) => teamDto(tm, w));
    },

    get: async (id) => {
      const u = await readerOfTeams();
      const w = await world();
      const team = w.teams.get(id);
      assertReadable(u, team);
      const memberIds = [...w.open.values()].filter((m) => m.teamId === id).map((m) => m.memberId);
      const members = (await db.members.bulkGet(memberIds))
        .filter((m): m is DemoMember => Boolean(m))
        .sort(byFullName)
        .map((m) => memberDto(m, w));
      return { ...teamDto(team, w), members };
    },

    create: async (input) => {
      const u = await api.actor();
      const isAdmin = can(u, 'teams.create');
      if (!isAdmin && !can(u, 'teams.createOwn')) fail('FORBIDDEN');
      const data = validate(createTeamSchema, input);
      const settings = await api.readSettings();
      const passwordHash = data.newSupervisor && isAdmin ? await api.demoPasswordHash() : '';
      let created!: DemoTeam;
      await tx(async () => {
        const at = new Date().toISOString();
        let supervisorId: string;
        if (!isAdmin) {
          supervisorId = u.id;
        } else if (data.newSupervisor) {
          const ns = data.newSupervisor;
          if (await db.users.where('email').equals(ns.email).first())
            fail('EMAIL_TAKEN', { fieldErrors: { 'newSupervisor.email': [ERRORS.EMAIL_TAKEN] } });
          if (await db.users.where('mobile').equals(ns.mobile).first())
            fail('MOBILE_TAKEN', { fieldErrors: { 'newSupervisor.mobile': [ERRORS.MOBILE_TAKEN] } });
          if (await db.users.where('nationalId').equals(ns.nationalId).first())
            fail('NATIONAL_ID_TAKEN', {
              fieldErrors: { 'newSupervisor.nationalId': [ERRORS.NATIONAL_ID_TAKEN] },
            });
          const sup: DemoUser = {
            id: newId(),
            fullName: ns.fullName,
            email: ns.email,
            mobile: ns.mobile,
            nationalId: ns.nationalId,
            role: 'SUPERVISOR',
            requestedRole: null,
            requestedTeamName: null,
            status: 'ACTIVE',
            rejectionReason: null,
            mustChangePassword: true,
            lastLoginAt: null,
            createdAt: at,
            preferences: { ...u.preferences, emailNotifications: {} },
            passwordHash,
          };
          await db.users.add(sup);
          await api.writeAudit({
            actorId: u.id,
            action: 'user.created',
            entityType: 'user',
            entityId: sup.id,
            before: null,
            after: { fullName: sup.fullName, role: sup.role, status: sup.status },
          });
          supervisorId = sup.id;
        } else if (data.supervisorId) {
          supervisorId = (await assertSupervisor(data.supervisorId)).id;
        } else {
          fail('VALIDATION_FAILED', { fieldErrors: { supervisorId: [t('teams.supervisorRequired')] } });
        }
        await assertMayLeadAnother(supervisorId);
        await assertColorFree(data.colorId);

        const pending = !isAdmin && settings.REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS;
        created = {
          id: newId(),
          name: data.name,
          colorId: data.colorId,
          supervisorId,
          status: pending ? 'PENDING_APPROVAL' : 'ACTIVE',
          createdAt: at,
          createdById: u.id,
          violationVisibility: 'INHERIT',
          archivedAt: null,
          archiveReason: null,
        };
        await db.teams.add(created);
        await db.supervisorHistory.add({
          id: newId(),
          teamId: created.id,
          supervisorId,
          validFrom: at,
          validTo: null,
          changedById: u.id,
          reason: null,
        });
        for (const [i, m] of data.members.entries()) {
          try {
            await insertMember(m, created.id, u.id, at);
          } catch (err) {
            // Point the error at the row so the dialog can highlight it.
            if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'NATIONAL_ID_TAKEN')
              fail('NATIONAL_ID_TAKEN', {
                fieldErrors: { [`members.${i}.nationalId`]: [ERRORS.NATIONAL_ID_TAKEN] },
              });
            throw err;
          }
        }
        if (data.existingMemberIds.length) {
          const w = await world();
          for (const memberId of data.existingMemberIds) {
            const current = memberTeam(w, memberId);
            if (!(await db.members.get(memberId))) fail('NOT_FOUND');
            if (!can(u, 'members.move') && current && !canManageMemberIn(u, current)) fail('FORBIDDEN');
            const open = w.open.get(memberId);
            if (open) await db.memberships.update(open.id, { validTo: at });
            await db.memberships.add({
              id: newId(),
              memberId,
              teamId: created.id,
              validFrom: at,
              validTo: null,
              movedById: u.id,
              reason: null,
            });
          }
        }
        await api.writeAudit({
          actorId: u.id,
          action: 'team.created',
          entityType: 'team',
          entityId: created.id,
          before: null,
          after: {
            name: created.name,
            status: created.status,
            colorId: created.colorId,
            supervisorId,
            members: data.members.length + data.existingMemberIds.length,
          },
        });
        if (pending) {
          const admins = await db.users
            .where('role')
            .equals('ADMIN')
            .filter((a) => a.status === 'ACTIVE')
            .toArray();
          for (const admin of admins) {
            await api.notify(admin.id, 'TEAM_PENDING_APPROVAL', {
              teamId: created.id,
              name: created.name,
              fullName: u.fullName,
            });
          }
        }
      });
      return teamDto(created, await world());
    },

    update: async (id, input) => {
      const u = await api.actor();
      const data = validate(updateTeamSchema, input);
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        assertManageable(u, team);
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        if (data.colorId && data.colorId !== team.colorId) await assertColorFree(data.colorId, id);
        after = {
          ...team,
          ...(data.name ? { name: data.name } : {}),
          ...(data.colorId ? { colorId: data.colorId } : {}),
        };
        await db.teams.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.updated',
          entityType: 'team',
          entityId: id,
          before: { name: team.name, colorId: team.colorId },
          after: { name: after.name, colorId: after.colorId },
        });
      });
      return teamDto(after, await world());
    },

    approve: async (id) => {
      const u = await api.actor('teams.approve');
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        if (!team) fail('NOT_FOUND');
        if (team.status !== 'PENDING_APPROVAL') fail('NOT_PENDING_TEAM');
        after = { ...team, status: 'ACTIVE' };
        await db.teams.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.approved',
          entityType: 'team',
          entityId: id,
          before: { status: team.status },
          after: { status: 'ACTIVE' },
        });
        await api.notify(team.supervisorId, 'TEAM_APPROVED', { teamId: id, name: team.name });
      });
      return teamDto(after, await world());
    },

    reject: async (id, input) => {
      const u = await api.actor('teams.approve');
      const data = validate(rejectTeamSchema, input);
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        if (!team) fail('NOT_FOUND');
        if (team.status !== 'PENDING_APPROVAL') fail('NOT_PENDING_TEAM');
        const at = new Date().toISOString();
        after = { ...team, status: 'ARCHIVED', archivedAt: at, archiveReason: data.reason };
        await db.teams.put(after);
        await closeTeamMemberships(id, at);
        await closeSupervisorHistory(id, at);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.rejected',
          entityType: 'team',
          entityId: id,
          before: { status: team.status },
          after: { status: 'ARCHIVED', reason: data.reason },
        });
        await api.notify(team.supervisorId, 'TEAM_REJECTED', {
          teamId: id,
          name: team.name,
          reason: data.reason,
        });
      });
      return teamDto(after, await world());
    },

    archive: async (id, input) => {
      const u = await api.actor();
      const data = validate(archiveTeamSchema, input);
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        assertManageable(u, team);
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        const at = new Date().toISOString();
        after = { ...team, status: 'ARCHIVED', archivedAt: at, archiveReason: data.reason };
        await db.teams.put(after);
        // Archiving frees the colour (status leaves the reserving set) and unassigns members.
        const closed = await closeTeamMemberships(id, at);
        await closeSupervisorHistory(id, at);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.archived',
          entityType: 'team',
          entityId: id,
          before: { status: team.status },
          after: { status: 'ARCHIVED', reason: data.reason, unassignedMembers: closed },
        });
      });
      return teamDto(after, await world());
    },

    changeSupervisor: async (id, input) => {
      const u = await api.actor('teams.manageAll');
      const data = validate(changeSupervisorSchema, input);
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        if (!team) fail('NOT_FOUND');
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        await assertSupervisor(data.supervisorId);
        after = team;
        if (team.supervisorId === data.supervisorId) return;
        await assertMayLeadAnother(data.supervisorId, id);
        // One timestamp closes the old row and opens the new one.
        const at = new Date().toISOString();
        await closeSupervisorHistory(id, at);
        await db.supervisorHistory.add({
          id: newId(),
          teamId: id,
          supervisorId: data.supervisorId,
          validFrom: at,
          validTo: null,
          changedById: u.id,
          reason: data.reason ?? null,
        });
        after = { ...team, supervisorId: data.supervisorId };
        await db.teams.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.supervisor_changed',
          entityType: 'team',
          entityId: id,
          before: { supervisorId: team.supervisorId },
          after: { supervisorId: data.supervisorId, ...(data.reason ? { reason: data.reason } : {}) },
        });
      });
      return teamDto(after, await world());
    },

    supervisorHistory: async (id) => {
      const u = await readerOfTeams();
      const w = await world();
      assertReadable(u, w.teams.get(id));
      const rows = await db.supervisorHistory.where('teamId').equals(id).toArray();
      return rows
        .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
        .map((h) => ({
          id: h.id,
          supervisor: person(w, h.supervisorId) ?? { id: h.supervisorId, fullName: t('common.unknownUser') },
          validFrom: h.validFrom,
          validTo: h.validTo,
          changedBy: person(w, h.changedById),
          reason: h.reason,
        }));
    },

    setViolationVisibility: async (id, mode) => {
      const u = await api.actor('teams.manageAll');
      const data = validate(violationVisibilitySchema, { mode });
      let after!: DemoTeam;
      await tx(async () => {
        const team = await db.teams.get(id);
        if (!team) fail('NOT_FOUND');
        after = { ...team, violationVisibility: data.mode };
        await db.teams.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'team.visibility_changed',
          entityType: 'team',
          entityId: id,
          before: { violationVisibility: team.violationVisibility },
          after: { violationVisibility: data.mode },
        });
      });
      return teamDto(after, await world());
    },

    addMember: async (teamId, input) => {
      const u = await api.actor();
      const data = validate(memberInputSchema, input);
      let member!: DemoMember;
      await tx(async () => {
        const team = await db.teams.get(teamId);
        assertReadable(u, team);
        if (!canManageMemberIn(u, team)) fail('FORBIDDEN');
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        member = await insertMember(data, teamId, u.id, new Date().toISOString());
        await api.writeAudit({
          actorId: u.id,
          action: 'member.created',
          entityType: 'team_member',
          entityId: member.id,
          before: null,
          after: {
            fullName: member.fullName,
            nationalId: maskNationalId(member.nationalId),
            teamId,
          },
        });
      });
      return memberDto(member, await world());
    },

    importMembers: async (input) => {
      const u = await api.actor();
      const data = validate(importMembersSchema, input);
      return tx(async () => {
        const team = await db.teams.get(data.teamId);
        assertReadable(u, team);
        if (!canManageMemberIn(u, team)) fail('FORBIDDEN');
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        const [members, reference] = await Promise.all([db.members.toArray(), db.reference.toArray()]);
        const taken = new Set(members.map((m) => m.nationalId));
        const ref = {
          jobTitles: reference.filter((r) => r.kind === 'job-titles'),
          departments: reference.filter((r) => r.kind === 'departments'),
        };
        const results = validateImportRows(data.rows, { isTaken: (id) => taken.has(id), ...ref });
        if (!data.commit) return { results, committed: 0 };
        const at = new Date().toISOString();
        let committed = 0;
        for (const r of results) {
          if (!r.ok) continue;
          const parsed = memberInputSchema.parse(toMemberInput(data.rows[r.row - 1]!, ref));
          await insertMember(parsed, data.teamId, u.id, at);
          committed++;
        }
        if (committed) {
          await api.writeAudit({
            actorId: u.id,
            action: 'members.imported',
            entityType: 'team',
            entityId: data.teamId,
            before: null,
            after: { committed, rejected: results.length - committed },
          });
        }
        return { results, committed };
      });
    },
  };

  // ------------------------------------------------------------ members

  const members: Phase2Api['members'] = {
    list: async (query = {}) => {
      const u = await readerOfTeams();
      const w = await world();
      const raw = toWesternDigits(query.q ?? '').trim();
      const q = raw.toLowerCase();
      const digits = /^\d{4}$/.test(raw) ? raw : null;
      const fullId = /^\d{10}$/.test(raw) ? raw : null;
      const rows = (await db.members.toArray())
        .filter((m) => canSeeMember(u, memberTeam(w, m.id)))
        .filter((m) => {
          const open = w.open.get(m.id);
          if (query.unassigned) return !open;
          if (query.teamId) return open?.teamId === query.teamId;
          return true;
        })
        .filter((m) => {
          if (!q) return true;
          if (fullId) return m.nationalId === fullId;
          if (digits && m.nationalId.endsWith(digits)) return true;
          return m.fullName.toLowerCase().includes(q);
        })
        .sort(byFullName);
      const page = paginate(rows, query.page, query.pageSize);
      return { ...page, items: page.items.map((m) => memberDto(m, w)) };
    },

    get: async (id) => {
      const u = await readerOfTeams();
      const w = await world();
      const m = await db.members.get(id);
      if (!m || !canSeeMember(u, memberTeam(w, id))) fail('NOT_FOUND');
      return memberDto(m, w, can(u, 'nationalIds.readFull'));
    },

    update: async (id, input) => {
      const u = await api.actor();
      const data = validate(updateMemberSchema, input);
      let after!: DemoMember;
      await tx(async () => {
        const w = await world();
        const m = await db.members.get(id);
        const team = memberTeam(w, id);
        if (!m || !canSeeMember(u, team)) fail('NOT_FOUND');
        if (!canManageMemberIn(u, team)) fail('FORBIDDEN');
        if (data.nationalId && data.nationalId !== m.nationalId) await assertNationalIdFree(data.nationalId, id);
        await assertReference('job-titles', data.jobTitleId, 'jobTitleId');
        await assertReference('departments', data.departmentId, 'departmentId');
        after = { ...m };
        if (data.fullName !== undefined) after.fullName = data.fullName;
        if (data.nationalId !== undefined) after.nationalId = data.nationalId;
        if ('jobTitleId' in data || 'jobTitleText' in data) {
          after.jobTitleId = data.jobTitleId ?? null;
          after.jobTitleText = data.jobTitleId ? null : data.jobTitleText ?? null;
        }
        if ('departmentId' in data || 'departmentText' in data) {
          after.departmentId = data.departmentId ?? null;
          after.departmentText = data.departmentId ? null : data.departmentText ?? null;
        }
        await db.members.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'member.updated',
          entityType: 'team_member',
          entityId: id,
          ...auditDiff(m, after),
        });
      });
      return memberDto(after, await world(), can(u, 'nationalIds.readFull'));
    },

    history: async (id) => {
      const u = await readerOfTeams();
      const w = await world();
      const m = await db.members.get(id);
      if (!m || !canSeeMember(u, memberTeam(w, id))) fail('NOT_FOUND');
      const rows = await db.memberships.where('memberId').equals(id).toArray();
      return rows
        .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
        .map((r) => {
          const team = w.teams.get(r.teamId);
          return {
            id: r.id,
            team: team
              ? summary(team, w)
              : { id: r.teamId, name: t('common.none'), color: colorDto(MISSING_COLOR) },
            validFrom: r.validFrom,
            validTo: r.validTo,
            movedBy: person(w, r.movedById),
            reason: r.reason,
          };
        });
    },

    move: async (input) => {
      const u = await api.actor('members.move');
      const data = validate(moveMembersSchema, input);
      const ids = Array.from(new Set(data.memberIds));
      await tx(async () => {
        const target = await db.teams.get(data.toTeamId);
        if (!target) fail('NOT_FOUND');
        if (target.status !== 'ACTIVE') fail('TEAM_NOT_ACTIVE');
        const w = await world();
        // One transaction, one timestamp: close each open row and open the new one at `at`.
        const at = new Date().toISOString();
        const from: string[] = [];
        for (const memberId of ids) if (!(await db.members.get(memberId))) fail('NOT_FOUND');
        // As built: the whole move is rejected, naming the members already in the team.
        const already = ids.filter((id) => w.open.get(id)?.teamId === data.toTeamId);
        if (already.length) fail('MEMBER_ALREADY_IN_TEAM', { memberIds: already });
        for (const memberId of ids) {
          const open = w.open.get(memberId);
          from.push(open ? w.teams.get(open.teamId)?.name ?? '' : t('formation.unassigned'));
          if (open) await db.memberships.update(open.id, { validTo: at });
          await db.memberships.add({
            id: newId(),
            memberId,
            teamId: data.toTeamId,
            validFrom: at,
            validTo: null,
            movedById: u.id,
            reason: data.reason ?? null,
          });
        }
        await api.writeAudit({
          actorId: u.id,
          action: 'members.moved',
          entityType: 'team',
          entityId: data.toTeamId,
          before: { teams: Array.from(new Set(from)).join('، ') },
          after: {
            team: target.name,
            count: ids.length,
            ...(data.reason ? { reason: data.reason } : {}),
          },
        });
      });
      const w = await world();
      return (await db.members.bulkGet(ids))
        .filter((m): m is DemoMember => Boolean(m))
        .map((m) => memberDto(m, w));
    },
  };

  // ------------------------------------------------------------ reference data

  const refEntity = (kind: DemoReference['kind']) => (kind === 'departments' ? 'department' : 'job_title');
  const refDto = (r: DemoReference): ReferenceItemDto => ({ id: r.id, name: r.name, isActive: r.isActive });

  const reference: Phase2Api['reference'] = {
    list: async (kind) => {
      const u = await api.actor();
      const rows = await db.reference.where('kind').equals(kind).toArray();
      return rows
        .filter((r) => r.isActive || can(u, 'reference.manage'))
        .sort(byName)
        .map(refDto);
    },
    create: async (kind, input) => {
      const u = await api.actor('reference.manage');
      const data = validate(referenceItemSchema, input);
      return tx(async () => {
        const rows = await db.reference.where('kind').equals(kind).toArray();
        if (rows.some((r) => sameName(r.name, data.name)))
          fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        const row: DemoReference = { id: newId(), kind, name: data.name, isActive: true };
        await db.reference.add(row);
        await api.writeAudit({
          actorId: u.id,
          action: 'reference.created',
          entityType: refEntity(kind),
          entityId: row.id,
          before: null,
          after: { name: row.name },
        });
        return refDto(row);
      });
    },
    update: async (kind, id, input) => {
      const u = await api.actor('reference.manage');
      const data = validate(updateReferenceItemSchema, input);
      return tx(async () => {
        const before = await db.reference.get(id);
        if (!before || before.kind !== kind) fail('NOT_FOUND');
        if (data.name !== undefined) {
          const rows = await db.reference.where('kind').equals(kind).toArray();
          if (rows.some((r) => r.id !== id && sameName(r.name, data.name!)))
            fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        }
        const after: DemoReference = {
          ...before,
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        };
        await db.reference.put(after);
        await api.writeAudit({
          actorId: u.id,
          action: 'reference.updated',
          entityType: refEntity(kind),
          entityId: id,
          before: { name: before.name, isActive: before.isActive },
          after: { name: after.name, isActive: after.isActive },
        });
        return refDto(after);
      });
    },
    remove: async (kind, id) => {
      const u = await api.actor('reference.manage');
      return tx(async () => {
        const row = await db.reference.get(id);
        if (!row || row.kind !== kind) fail('NOT_FOUND');
        const field = kind === 'departments' ? 'departmentId' : 'jobTitleId';
        const used = (await db.members.toArray()).some((m) => m[field] === id);
        if (used) await db.reference.update(id, { isActive: false });
        else await db.reference.delete(id);
        await api.writeAudit({
          actorId: u.id,
          action: 'reference.deleted',
          entityType: refEntity(kind),
          entityId: id,
          before: { name: row.name, isActive: row.isActive },
          after: used ? { isActive: false } : null,
        });
        return {
          result: used ? ('DEACTIVATED' as const) : ('DELETED' as const),
          item: refDto({ ...row, isActive: used ? false : row.isActive }),
        };
      });
    },
  };

  // ------------------------------------------------------------ cards

  async function cardReader() {
    const u = await api.actor();
    if (!can(u, 'cards.print') && !can(u, 'cards.manageTemplates')) fail('FORBIDDEN');
    return u;
  }

  const sizeDto = (s: CardSizeDto): CardSizeDto => ({ ...s });

  async function templateDto(tpl: DemoTemplate): Promise<CardTemplateDto> {
    const size = await db.cardSizes.get(tpl.sizeId);
    return {
      id: tpl.id,
      name: tpl.name,
      size: sizeDto(size ?? { id: tpl.sizeId, name: '—', widthMm: 85.6, heightMm: 54, isBuiltin: true }),
      orientation: tpl.orientation,
      layoutKey: tpl.layoutKey,
      config: tpl.config,
      isDefault: tpl.isDefault,
      logoId: tpl.logoId,
    };
  }

  async function liveTemplates() {
    return (await db.cardTemplates.toArray()).filter((x) => !x.archived);
  }

  async function ensureOneDefault() {
    const live = await liveTemplates();
    if (live.length && !live.some((x) => x.isDefault)) {
      await db.cardTemplates.update(live.sort(byName)[0]!.id, { isDefault: true });
    }
  }

  const batchDto = (b: DemoBatch, w: World): PrintBatchDto => ({
    id: b.id,
    idempotencyKey: b.idempotencyKey,
    template: { id: b.templateId, name: b.templateName },
    printedBy: person(w, b.printedById) ?? { id: b.printedById, fullName: t('common.unknownUser') },
    printedAt: b.printedAt,
    cardCount: b.items.length,
  });

  /** Writes edited name / job title / department back to the member (brief §8.1 step 4). */
  async function saveBack(memberId: string, data: CardData, actor: DemoUser, w: World) {
    const m = await db.members.get(memberId);
    if (!m) fail('NOT_FOUND');
    if (!canManageMemberIn(actor, memberTeam(w, memberId))) fail('FORBIDDEN');
    const refs = [...w.reference.values()].filter((r) => r.isActive);
    const match = (kind: DemoReference['kind'], text: string) =>
      refs.find((r) => r.kind === kind && sameName(r.name, text));
    const after: DemoMember = { ...m };
    const name = (data.fullName ?? '').trim();
    if (name.length >= 3) after.fullName = name;
    const job = (data.jobTitle ?? '').trim();
    const jobRef = job ? match('job-titles', job) : undefined;
    after.jobTitleId = jobRef?.id ?? null;
    after.jobTitleText = jobRef ? null : job || null;
    const dep = (data.department ?? '').trim();
    const depRef = dep ? match('departments', dep) : undefined;
    after.departmentId = depRef?.id ?? null;
    after.departmentText = depRef ? null : dep || null;
    await db.members.put(after);
    await api.writeAudit({
      actorId: actor.id,
      action: 'member.updated',
      entityType: 'team_member',
      entityId: memberId,
      ...auditDiff(m, after),
    });
  }

  const cards: Phase2Api['cards'] = {
    sizes: async () => {
      await cardReader();
      const rows = await db.cardSizes.toArray();
      return rows
        // Built-ins in seed order (CR80 first), then custom sizes by name.
        .sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || (a.isBuiltin ? 0 : byName(a, b)))
        .map(sizeDto);
    },
    createSize: async (input) => {
      const u = await api.actor('cards.manageTemplates');
      const data = validate(cardSizeSchema, input);
      return tx(async () => {
        if ((await db.cardSizes.toArray()).some((s) => sameName(s.name, data.name)))
          fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        const row: CardSizeDto = { id: newId(), ...data, isBuiltin: false };
        await db.cardSizes.add(row);
        await api.writeAudit({
          actorId: u.id,
          action: 'card_size.created',
          entityType: 'card_size',
          entityId: row.id,
          before: null,
          after: { name: row.name, widthMm: row.widthMm, heightMm: row.heightMm },
        });
        return sizeDto(row);
      });
    },
    deleteSize: async (id) => {
      const u = await api.actor('cards.manageTemplates');
      await tx(async () => {
        const row = await db.cardSizes.get(id);
        if (!row) fail('NOT_FOUND');
        if (row.isBuiltin) fail('BUILTIN_LOCKED');
        if ((await liveTemplates()).some((x) => x.sizeId === id)) fail('IN_USE');
        await db.cardSizes.delete(id);
        await api.writeAudit({
          actorId: u.id,
          action: 'card_size.deleted',
          entityType: 'card_size',
          entityId: id,
          before: { name: row.name, widthMm: row.widthMm, heightMm: row.heightMm },
          after: null,
        });
      });
    },

    templates: async () => {
      await cardReader();
      const rows = (await liveTemplates()).sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || byName(a, b),
      );
      return Promise.all(rows.map(templateDto));
    },
    createTemplate: async (input) => {
      const u = await api.actor('cards.manageTemplates');
      const data = validate(cardTemplateSchema, input);
      let row!: DemoTemplate;
      await tx(async () => {
        if (!(await db.cardSizes.get(data.sizeId)))
          fail('VALIDATION_FAILED', { fieldErrors: { sizeId: [ERRORS.NOT_FOUND] } });
        if (data.logoId && !(await db.logos.get(data.logoId)))
          fail('VALIDATION_FAILED', { fieldErrors: { logoId: [ERRORS.NOT_FOUND] } });
        const live = await liveTemplates();
        if (live.some((x) => sameName(x.name, data.name)))
          fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        if (data.isDefault) for (const x of live) await db.cardTemplates.update(x.id, { isDefault: false });
        row = {
          id: newId(),
          name: data.name,
          sizeId: data.sizeId,
          orientation: data.orientation,
          layoutKey: data.layoutKey,
          config: data.config,
          isDefault: data.isDefault,
          logoId: data.logoId ?? null,
          archived: false,
        };
        await db.cardTemplates.add(row);
        await ensureOneDefault();
        await api.writeAudit({
          actorId: u.id,
          action: 'card_template.created',
          entityType: 'card_template',
          entityId: row.id,
          before: null,
          after: { name: row.name, layoutKey: row.layoutKey, orientation: row.orientation },
        });
      });
      return templateDto((await db.cardTemplates.get(row.id))!);
    },
    updateTemplate: async (id, input) => {
      const u = await api.actor('cards.manageTemplates');
      const data = validate(updateCardTemplateSchema, input);
      await tx(async () => {
        const before = await db.cardTemplates.get(id);
        if (!before || before.archived) fail('NOT_FOUND');
        if (data.sizeId && !(await db.cardSizes.get(data.sizeId)))
          fail('VALIDATION_FAILED', { fieldErrors: { sizeId: [ERRORS.NOT_FOUND] } });
        if (data.logoId && !(await db.logos.get(data.logoId)))
          fail('VALIDATION_FAILED', { fieldErrors: { logoId: [ERRORS.NOT_FOUND] } });
        const live = await liveTemplates();
        if (data.name && live.some((x) => x.id !== id && sameName(x.name, data.name!)))
          fail('NAME_TAKEN', { fieldErrors: { name: [ERRORS.NAME_TAKEN] } });
        if (data.isDefault) for (const x of live) await db.cardTemplates.update(x.id, { isDefault: false });
        const after: DemoTemplate = {
          ...before,
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.sizeId !== undefined ? { sizeId: data.sizeId } : {}),
          ...(data.orientation !== undefined ? { orientation: data.orientation } : {}),
          ...(data.layoutKey !== undefined ? { layoutKey: data.layoutKey } : {}),
          ...(data.config !== undefined ? { config: data.config } : {}),
          ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
          ...(data.logoId !== undefined ? { logoId: data.logoId ?? null } : {}),
        };
        await db.cardTemplates.put(after);
        await ensureOneDefault();
        await api.writeAudit({
          actorId: u.id,
          action: 'card_template.updated',
          entityType: 'card_template',
          entityId: id,
          before: { name: before.name, layoutKey: before.layoutKey, isDefault: before.isDefault },
          after: { name: after.name, layoutKey: after.layoutKey, isDefault: after.isDefault },
        });
      });
      return templateDto((await db.cardTemplates.get(id))!);
    },
    archiveTemplate: async (id) => {
      const u = await api.actor('cards.manageTemplates');
      await tx(async () => {
        const before = await db.cardTemplates.get(id);
        if (!before || before.archived) fail('NOT_FOUND');
        await db.cardTemplates.update(id, { archived: true, isDefault: false });
        await ensureOneDefault();
        await api.writeAudit({
          actorId: u.id,
          action: 'card_template.archived',
          entityType: 'card_template',
          entityId: id,
          before: { name: before.name },
          after: { archived: true },
        });
      });
    },

    preview: async (input) => {
      const u = await api.actor('cards.print');
      const data = validate(cardPreviewSchema, input);
      const tpl = await db.cardTemplates.get(data.templateId);
      if (!tpl || tpl.archived) fail('NOT_FOUND');
      const w = await world();
      const mask = tpl.config.maskNationalId;
      const idOut = (id: string) => (mask ? maskNationalId(id) : id);
      const validUntil = tpl.config.validUntil;
      const subjects: CardPreviewSubjectDto[] = [];
      const seen = new Set<string>();
      const memberSubject = (m: DemoMember) => {
        if (seen.has(`m:${m.id}`)) return;
        seen.add(`m:${m.id}`);
        const team = memberTeam(w, m.id);
        const color = team ? w.colors.get(team.colorId) : undefined;
        subjects.push({
          memberId: m.id,
          data: {
            fullName: m.fullName,
            jobTitle: refName(w, m.jobTitleId) ?? m.jobTitleText ?? '',
            nationalId: idOut(m.nationalId),
            department: refName(w, m.departmentId) ?? m.departmentText ?? '',
            teamName: team?.name ?? '',
            teamColor: color?.hex ?? '#1D5C63',
            qrValue: m.id,
            photoFileId: m.photoFileId,
            ...(validUntil ? { validUntil } : {}),
          },
        });
      };
      const allMembers = new Map((await db.members.toArray()).map((m) => [m.id, m]));
      for (const teamId of data.teamIds) {
        const team = w.teams.get(teamId);
        assertReadable(u, team);
        const color = w.colors.get(team.colorId);
        const sup = w.users.get(team.supervisorId);
        if (data.includeSupervisors && sup && !seen.has(`u:${sup.id}`)) {
          seen.add(`u:${sup.id}`);
          subjects.push({
            userId: sup.id,
            data: {
              fullName: sup.fullName,
              jobTitle: t('cards.supervisorJobTitle'),
              nationalId: idOut(sup.nationalId),
              department: '',
              teamName: team.name,
              teamColor: color?.hex ?? '#1D5C63',
              qrValue: sup.id,
              roleLabel: t('role.SUPERVISOR'),
              ...(validUntil ? { validUntil } : {}),
            },
          });
        }
        [...w.open.values()]
          .filter((r) => r.teamId === teamId)
          .map((r) => allMembers.get(r.memberId))
          .filter((m): m is DemoMember => Boolean(m))
          .sort(byFullName)
          .forEach(memberSubject);
      }
      for (const memberId of data.memberIds) {
        const m = allMembers.get(memberId);
        if (!m || !canSeeMember(u, memberTeam(w, memberId))) fail('NOT_FOUND');
        memberSubject(m);
      }
      return { template: await templateDto(tpl), subjects };
    },

    createBatch: async (input) => {
      const u = await api.actor('cards.print');
      const data = validate(printBatchSchema, input);
      let batch!: DemoBatch;
      await tx(async () => {
        // Idempotency (brief §12): the same key returns the original batch, nothing is redone.
        const existing = await db.batches.where('idempotencyKey').equals(data.idempotencyKey).first();
        if (existing) {
          batch = existing;
          return;
        }
        const tpl = await db.cardTemplates.get(data.templateId);
        if (!tpl) fail('NOT_FOUND');
        const size = await db.cardSizes.get(tpl.sizeId);
        const w = await world();
        let savedBack = 0;
        const items: DemoBatch['items'] = [];
        for (const item of data.items) {
          const doSave = Boolean(item.saveBack && item.memberId);
          if (doSave) {
            await saveBack(item.memberId!, item.data, u, w);
            savedBack++;
          }
          const id = (item.data.nationalId ?? '').trim();
          items.push({
            id: newId(),
            memberId: item.memberId ?? null,
            userId: item.userId ?? null,
            data: { ...item.data, nationalId: tpl.config.maskNationalId ? maskNationalId(id) : id },
            savedBack: doSave,
          });
        }
        batch = {
          id: newId(),
          idempotencyKey: data.idempotencyKey,
          templateId: tpl.id,
          templateName: tpl.name,
          templateSnapshot: {
            name: tpl.name,
            size: size ? sizeDto(size) : null,
            orientation: tpl.orientation,
            layoutKey: tpl.layoutKey,
            config: tpl.config,
            logoId: tpl.logoId,
          },
          printedById: u.id,
          printedAt: new Date().toISOString(),
          items,
        };
        await db.batches.add(batch);
        await api.writeAudit({
          actorId: u.id,
          action: 'cards.printed',
          entityType: 'print_batch',
          entityId: batch.id,
          before: null,
          after: { template: tpl.name, cardCount: items.length, savedBack },
        });
      });
      return batchDto(batch, await world());
    },

    batches: async (query = {}) => {
      await api.actor('cards.print');
      const w = await world();
      const rows = (await db.batches.toArray()).sort((a, b) => b.printedAt.localeCompare(a.printedAt));
      const page = paginate(rows, query.page, query.pageSize);
      return { ...page, items: page.items.map((b) => batchDto(b, w)) };
    },

    batch: async (id) => {
      await api.actor('cards.print');
      const b = await db.batches.get(id);
      if (!b) fail('NOT_FOUND');
      const detail: PrintBatchDetailDto = {
        ...batchDto(b, await world()),
        templateSnapshot: b.templateSnapshot,
        items: b.items,
      };
      return detail;
    },

    pdf: async (id) => {
      await api.actor('cards.print');
      if (!(await db.batches.get(id))) fail('NOT_FOUND');
      // The demo has no server, like an API without the pdf service (ADR-024).
      fail('PDF_NOT_CONFIGURED');
    },
  };

  // ------------------------------------------------------------ logos

  const logoDto = (l: DemoLogo): LogoDto => ({
    id: l.id,
    name: l.name,
    fileId: l.fileId,
    url: l.dataUrl,
    isDefault: l.isDefault,
  });

  const logos: Phase2Api['logos'] = {
    list: async () => {
      await cardReader();
      const rows = await db.logos.toArray();
      return rows
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt))
        .map(logoDto);
    },
    upload: async ({ name, file, isDefault }) => {
      const u = await api.actor('logos.manage');
      const cleanName = (name ?? '').trim();
      if (cleanName.length < 2)
        fail('VALIDATION_FAILED', { fieldErrors: { name: [t('logos.nameRequired')] } });
      if (!(LOGO_TYPES as readonly string[]).includes(file.type)) fail('LOGO_FILE_INVALID');
      if (file.size > LOGO_MAX_BYTES) fail('FILE_TOO_LARGE');
      const bytes = await readBytes(file);
      const sniffed = sniffImageType(bytes);
      if (!sniffed || sniffed !== file.type) fail('LOGO_FILE_INVALID');
      const dataUrl = `data:${sniffed};base64,${toBase64(bytes)}`;
      let row!: DemoLogo;
      await tx(async () => {
        const all = await db.logos.toArray();
        const makeDefault = Boolean(isDefault) || all.length === 0;
        if (makeDefault) for (const l of all) await db.logos.update(l.id, { isDefault: false });
        row = {
          id: newId(),
          name: cleanName,
          fileId: newId(),
          isDefault: makeDefault,
          dataUrl,
          createdAt: new Date().toISOString(),
        };
        await db.logos.add(row);
        await api.writeAudit({
          actorId: u.id,
          action: 'logo.created',
          entityType: 'logo',
          entityId: row.id,
          before: null,
          after: { name: row.name, isDefault: row.isDefault },
        });
      });
      return logoDto(row);
    },
    setDefault: async (id) => {
      const u = await api.actor('logos.manage');
      let row!: DemoLogo;
      await tx(async () => {
        const target = await db.logos.get(id);
        if (!target) fail('NOT_FOUND');
        for (const l of await db.logos.toArray()) await db.logos.update(l.id, { isDefault: l.id === id });
        row = { ...target, isDefault: true };
        await api.writeAudit({
          actorId: u.id,
          action: 'logo.default_set',
          entityType: 'logo',
          entityId: id,
          before: { isDefault: target.isDefault },
          after: { isDefault: true },
        });
      });
      return logoDto(row);
    },
    remove: async (id) => {
      const u = await api.actor('logos.manage');
      await tx(async () => {
        const target = await db.logos.get(id);
        if (!target) fail('NOT_FOUND');
        // As built: deleting a logo detaches it from the templates that used it.
        for (const x of await db.cardTemplates.toArray())
          if (x.logoId === id) await db.cardTemplates.update(x.id, { logoId: null });
        await db.logos.delete(id);
        if (target.isDefault) {
          const next = (await db.logos.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (next) await db.logos.update(next.id, { isDefault: true });
        }
        await api.writeAudit({
          actorId: u.id,
          action: 'logo.deleted',
          entityType: 'logo',
          entityId: id,
          before: { name: target.name },
          after: null,
        });
      });
    },
  };

  return { colors, teams, members, reference, cards, logos };
}

/** Changed fields only; the national ID is masked in audit snapshots (ADR-032). */
function auditDiff(before: DemoMember, after: DemoMember) {
  const keys = [
    'fullName',
    'nationalId',
    'jobTitleId',
    'jobTitleText',
    'departmentId',
    'departmentText',
  ] as const;
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of keys) {
    if (before[k] === after[k]) continue;
    b[k] = k === 'nationalId' ? maskNationalId(before[k]) : before[k];
    a[k] = k === 'nationalId' ? maskNationalId(after[k]) : after[k];
  }
  return { before: b, after: a };
}
