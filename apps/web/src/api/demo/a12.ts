import {
  DEFAULT_SETTINGS,
  ERRORS,
  PROJECT_COVER_MAX_BYTES,
  addParticipantSchema,
  archiveMemberSchema,
  can,
  canAny,
  maskNationalId,
  memberInputSchema,
  memberRequestListQuery,
  projectColor,
  rejectMemberRequestSchema,
  updateParticipantSchema,
  type MemberRequestAcceptedDto,
  type MemberRequestDto,
  type ParticipantDto,
  type Permission,
  type WorkspaceRole,
} from '@nuzli/shared';
import a12SeedJson from '../../../../../seed/demo/a12.json';
import colorsSeed from '../../../../../seed/demo/colors.json';
import cardsSeed from '../../../../../seed/demo/cards.json';
import type { ApiClient, UploadOptions } from '../client';
import { ApiError } from '../errors';
import type { DemoApi } from './DemoApi';
import type {
  DemoCalendar,
  DemoFile,
  DemoMemberRequest,
  DemoParticipant,
  DemoUser,
  DemoWorkspace,
  DemoWsMembership,
} from './db';
import { loadPhase2Seed } from './seed';
import { openLeaderIds, teamsLedBy } from './leaders';
import { isParticipant, projectInScope, stripMoney, teamInScope, touchesMoney, type Actor } from './access';
import { fail, hashPassword, newId, paginate, validate } from './util';
import { DEMO_PASSWORD } from './constants';
import { sniffImageType } from './phase2';

/**
 * A12 in the demo (ADR-153): the seed of workspaces and memberships, and the round-2 features that
 * live inside a workspace — project participants, the supervisors' worker requests, the project
 * cover and the money rule. Everything here runs in the session's workspace through the scoping
 * layer (scoping.ts), so nothing can reach another workspace's rows.
 */

interface A12SeedFile {
  workspaces: { id: string; name: string; code: string; createdAt: string }[];
  defaultWorkspaceId: string;
  owners: string[];
  users: { id: string; username: string; fullName: string; email: string; mobile: string; nationalId: string; createdAt: string }[];
  memberships: { userId: string; role: WorkspaceRole; title?: string; permissions?: Record<string, string> }[];
  participants: { id: string; projectId: string; userId: string; title: string; level: 'EDITOR' | 'CONTRIBUTOR' | 'VIEWER' }[];
  memberRequests: {
    id: string;
    kind: 'ADD' | 'REMOVE';
    teamId: string;
    requestedById: string;
    payload: { fullName: string; nationalId: string; jobTitleText?: string };
    offsetHours: number;
  }[];
}

export const A12_SEED = a12SeedJson as unknown as A12SeedFile;
/** «إدارة المشاريع» — every existing seed is this workspace's data (like the server migration). */
export const DEFAULT_WORKSPACE_ID = A12_SEED.defaultWorkspaceId;

const SEED_IDENTITY_KEY = 'seededA12Identity';
const SEED_BUSINESS_KEY = 'seededA12Business';

/** Workspaces, owners, usernames and one membership per approved account (global rows). */
export async function seedA12Identity(api: DemoApi) {
  if (await api.db.kv.get(SEED_IDENTITY_KEY)) return;
  const hash = await hashPassword(DEMO_PASSWORD);
  await api.unscoped(async () => {
    const db = api.db;
    for (const w of A12_SEED.workspaces) {
      const row: DemoWorkspace = { ...w, status: 'ACTIVE', createdBy: null, archivedAt: null };
      await db.workspaces.put(row);
    }
    // The extra A12 accounts (owner, assistant, two participants), demo password, no forced change.
    for (const u of A12_SEED.users) {
      const row: DemoUser = {
        id: u.id,
        username: u.username,
        accountRole: A12_SEED.owners.includes(u.id) ? 'OWNER' : 'USER',
        requestedWorkspaceId: null,
        fullName: u.fullName,
        email: u.email,
        mobile: u.mobile,
        nationalId: u.nationalId,
        role: 'MONITOR',
        requestedRole: null,
        requestedTeamName: null,
        status: 'ACTIVE',
        rejectionReason: null,
        // Demo only: the real bootstrap owner must change the password at first login.
        mustChangePassword: false,
        lastLoginAt: null,
        createdAt: u.createdAt,
        preferences: { theme: 'auto', digits: 'latn', showHijri: false, emailNotifications: {} },
        passwordHash: hash,
      };
      await db.users.put(row);
    }
    const memberships: DemoWsMembership[] = [];
    const special = new Set(A12_SEED.memberships.map((m) => m.userId));
    // Approved accounts of the original seed → one membership of their role (status follows the account).
    for (const u of await db.users.toArray()) {
      if (special.has(u.id)) continue;
      if (u.status !== 'ACTIVE' && u.status !== 'SUSPENDED') continue;
      memberships.push({
        id: `00000000-0000-4000-8000-a12${u.id.slice(-9)}`,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: u.id,
        role: u.role,
        title: null,
        permissions: {},
        scope: {},
        status: u.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        createdAt: u.createdAt,
        createdBy: null,
        archivedAt: null,
      });
    }
    for (const m of A12_SEED.memberships) {
      memberships.push({
        id: `00000000-0000-4000-8000-a12${m.userId.slice(-9)}`,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: m.userId,
        role: m.role,
        title: m.title ?? null,
        permissions: (m.permissions ?? {}) as DemoWsMembership['permissions'],
        scope: {},
        status: 'ACTIVE',
        createdAt: '2026-08-05T06:00:00.000Z',
        createdBy: null,
        archivedAt: null,
      });
    }
    await db.wsMemberships.bulkPut(memberships);
    await db.kv.put({ key: SEED_IDENTITY_KEY, value: new Date().toISOString() });
  });
}

/** Participants and one pending worker request in «إدارة المشاريع» (runs inside that workspace). */
export async function seedA12Business(api: DemoApi) {
  const db = api.db;
  if (await db.kv.get(SEED_BUSINESS_KEY)) return;
  const now = Date.now();
  await db.transaction('rw', db.tables, async () => {
    for (const p of A12_SEED.participants) {
      const row: DemoParticipant = { ...p, addedById: A12_SEED.owners[0] ?? null, createdAt: new Date(now - 86_400_000).toISOString() };
      await db.participants.put(row);
    }
    for (const r of A12_SEED.memberRequests) {
      const row: DemoMemberRequest = {
        id: r.id,
        kind: r.kind,
        status: 'PENDING',
        teamId: r.teamId,
        memberId: null,
        payload: { fullName: r.payload.fullName, nationalId: r.payload.nationalId, jobTitleText: r.payload.jobTitleText ?? null },
        reason: null,
        decisionReason: null,
        requestedById: r.requestedById,
        decidedById: null,
        createdAt: new Date(now + r.offsetHours * 3_600_000).toISOString(),
        decidedAt: null,
      };
      await db.memberRequests.put(row);
    }
    await db.kv.put({ key: SEED_BUSINESS_KEY, value: new Date(now).toISOString() });
  });
}

/**
 * A new workspace is EMPTY except neutral defaults (docs/API.md «Workspaces»): settings, the
 * 24-colour palette, the default calendar (Fri/Sat weekend), 6 card sizes and the 3 built-in
 * templates. Fresh ids: rows of two workspaces never share an id.
 */
export async function seedWorkspaceDefaults(api: DemoApi, wid: string) {
  const db = api.db;
  const phase2 = loadPhase2Seed();
  const at = new Date().toISOString();
  await api.inWorkspace(wid, async () => {
    await db.kv.put({ key: api.wsKey('settings', wid), value: { ...DEFAULT_SETTINGS } });
    for (const c of colorsSeed.colors) await db.colors.add({ ...c, id: newId() });
    const calendar: DemoCalendar = {
      id: newId(),
      name: 'تقويم العمل الافتراضي',
      weekendDays: [5, 6],
      isDefault: true,
      createdAt: at,
      exceptions: [],
    };
    await db.calendars.add(calendar);
    const sizeIds = new Map<string, string>();
    for (const s of cardsSeed.sizes) {
      const id = newId();
      sizeIds.set(s.id, id);
      await db.cardSizes.add({ ...s, id });
    }
    for (const tpl of phase2.cardTemplates) {
      await db.cardTemplates.add({ ...tpl, id: newId(), sizeId: sizeIds.get(tpl.sizeId) ?? tpl.sizeId, logoId: null });
    }
  });
}

// ---------------------------------------------------------------------------- round-2 features

export interface A12RolesApi {
  participants: ApiClient['participants'];
  memberRequests: ApiClient['memberRequests'];
  projectCover: Pick<ApiClient['projects'], 'coverUrl' | 'uploadCover' | 'removeCover'>;
  /** Wraps the older modules: supervisors' requests, the money rule. */
  decorate(): void;
  beforeCoverPresign(input: { entityId?: string; contentType?: string; sizeBytes?: number }, actor: DemoUser): Promise<void>;
  afterCoverConfirm(file: DemoFile, actor: DemoUser): Promise<void>;
}

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function createA12Roles(api: DemoApi): A12RolesApi {
  const db = api.db;
  /** Object URLs of covers viewed in this session. */
  const coverUrls = new Map<string, string>();

  // ------------------------------------------------------------ participants

  async function projectVisible(viewer: Actor, projectId: string) {
    const p = await db.projects.get(projectId);
    if (!p) fail('NOT_FOUND');
    const reads = can(viewer, 'projects.readAll') && projectInScope(viewer, projectId);
    if (!reads && !isParticipant(viewer, projectId)) fail('NOT_FOUND');
    return p;
  }

  async function participantDto(p: DemoParticipant): Promise<ParticipantDto> {
    const [u, by] = await Promise.all([api.rawUser(p.userId), p.addedById ? api.rawUser(p.addedById) : undefined]);
    return {
      projectId: p.projectId,
      user: { id: p.userId, username: u?.username ?? '', fullName: u?.fullName ?? '', hasPhoto: Boolean(u?.photoFileId) },
      title: p.title,
      level: p.level,
      addedBy: by ? { id: by.id, fullName: by.fullName } : null,
      createdAt: p.createdAt,
    };
  }

  async function manageable(projectId: string) {
    const viewer = await api.actor('projects.manage');
    const p = await db.projects.get(projectId);
    if (!p || !projectInScope(viewer, projectId)) fail('NOT_FOUND');
    if (p.archivedAt) fail('PROJECT_ARCHIVED');
    return { viewer, project: p };
  }

  const participants: ApiClient['participants'] = {
    list: async (projectId) => {
      const viewer = await api.actor(undefined, { project: { projectId } });
      if (!canAny(viewer, ['projects.readAll', 'projects.readGranted'])) fail('FORBIDDEN');
      await projectVisible(viewer, projectId);
      const rows = await db.participants.where('projectId').equals(projectId).toArray();
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.all(rows.map(participantDto));
    },
    add: async (projectId, input) => {
      const { viewer } = await manageable(projectId);
      const data = validate(addParticipantSchema, input);
      const wid = viewer._wid!;
      const member = api.liveMemberships(data.userId).some((m) => m.workspaceId === wid && m.status === 'ACTIVE');
      if (!member) fail('PARTICIPANT_NOT_MEMBER');
      const exists = await db.participants.where('projectId').equals(projectId).filter((p) => p.userId === data.userId).first();
      if (exists) fail('PARTICIPANT_EXISTS');
      const row: DemoParticipant = {
        id: newId(),
        projectId,
        userId: data.userId,
        title: data.title,
        level: data.level,
        addedById: viewer.id,
        createdAt: new Date().toISOString(),
      };
      await db.participants.add(row);
      const project = (await db.projects.get(projectId))!;
      await api.writeAudit({
        actorId: viewer.id,
        action: 'project.participant_added',
        entityType: 'project',
        entityId: projectId,
        before: null,
        after: { userId: data.userId, title: data.title, level: data.level },
      });
      await api.notify(data.userId, 'PROJECT_PARTICIPANT_ADDED', {
        projectId,
        projectName: project.name,
        level: data.level,
        title: data.title,
      });
      return participantDto(row);
    },
    update: async (projectId, userId, input) => {
      const { viewer } = await manageable(projectId);
      const data = validate(updateParticipantSchema, input);
      const row = await db.participants.where('projectId').equals(projectId).filter((p) => p.userId === userId).first();
      if (!row) fail('NOT_FOUND');
      const next = { ...row, ...(data.title ? { title: data.title } : {}), ...(data.level ? { level: data.level } : {}) };
      await db.participants.put(next);
      await api.writeAudit({
        actorId: viewer.id,
        action: 'project.participant_updated',
        entityType: 'project',
        entityId: projectId,
        before: { userId, title: row.title, level: row.level },
        after: { userId, title: next.title, level: next.level },
      });
      return participantDto(next);
    },
    remove: async (projectId, userId) => {
      const { viewer } = await manageable(projectId);
      const row = await db.participants.where('projectId').equals(projectId).filter((p) => p.userId === userId).first();
      if (!row) fail('NOT_FOUND');
      await db.participants.delete(row.id);
      await api.writeAudit({
        actorId: viewer.id,
        action: 'project.participant_removed',
        entityType: 'project',
        entityId: projectId,
        before: { userId, title: row.title, level: row.level },
        after: null,
      });
    },
  };

  // ------------------------------------------------------------ worker requests

  async function requestDto(r: DemoMemberRequest): Promise<MemberRequestDto> {
    const [team, member, by, decider, jobTitle, department] = await Promise.all([
      r.teamId ? db.teams.get(r.teamId) : undefined,
      r.memberId ? db.members.get(r.memberId) : undefined,
      r.requestedById ? api.rawUser(r.requestedById) : undefined,
      r.decidedById ? api.rawUser(r.decidedById) : undefined,
      r.payload.jobTitleId ? db.reference.get(r.payload.jobTitleId) : undefined,
      r.payload.departmentId ? db.reference.get(r.payload.departmentId) : undefined,
    ]);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      team: team ? { id: team.id, name: team.name } : null,
      member: member ? { id: member.id, fullName: member.fullName } : null,
      payload:
        r.kind === 'ADD'
          ? {
              fullName: r.payload.fullName,
              // Only ever masked on the wire; the full value is cleared on decision.
              nationalIdMasked: r.payload.nationalId ? maskNationalId(r.payload.nationalId) : (r.payload as { nationalIdMasked?: string }).nationalIdMasked,
              jobTitle: jobTitle?.name ?? r.payload.jobTitleText ?? null,
              department: department?.name ?? r.payload.departmentText ?? null,
            }
          : {},
      reason: r.reason,
      decisionReason: r.decisionReason,
      requestedBy: by ? { id: by.id, fullName: by.fullName } : null,
      decidedBy: decider ? { id: decider.id, fullName: decider.fullName } : null,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
    };
  }

  const approver = (u: Actor) => can(u, 'registrations.review') || can(u, 'registrations.read') || can(u, 'members.manage');

  /** Approvers see the workspace (assistant team scope applies); supervisors their own and their teams'. */
  async function visibleRequests(viewer: Actor): Promise<DemoMemberRequest[]> {
    const all = await db.memberRequests.toArray();
    if (approver(viewer)) return all.filter((r) => teamInScope(viewer, r.teamId));
    if (!can(viewer, 'members.manageOwn')) fail('FORBIDDEN');
    const led = await teamsLedBy(db, viewer.id);
    return all.filter((r) => r.requestedById === viewer.id || (r.teamId && led.has(r.teamId)));
  }

  async function notifyApprovers(viewer: Actor, type: string, payload: Record<string, unknown>) {
    for (const id of api.approversOf(viewer._wid!)) if (id !== viewer.id) await api.notify(id, type, payload);
  }

  const memberRequests: ApiClient['memberRequests'] = {
    list: async (query = {}) => {
      const viewer = await api.actor();
      const data = validate(memberRequestListQuery, query);
      const rows = (await visibleRequests(viewer))
        .filter((r) => data.status === 'ALL' || r.status === data.status)
        .filter((r) => !data.teamId || r.teamId === data.teamId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const page = paginate(rows, data.page, data.pageSize);
      return { ...page, items: await Promise.all(page.items.map(requestDto)) };
    },
    get: async (id) => {
      const viewer = await api.actor();
      const row = (await visibleRequests(viewer)).find((r) => r.id === id);
      if (!row) fail('NOT_FOUND');
      return requestDto(row);
    },
    approve: async (id) => {
      const viewer = await api.actor('registrations.review');
      const row = await db.memberRequests.get(id);
      if (!row || !teamInScope(viewer, row.teamId)) fail('NOT_FOUND');
      if (row.status !== 'PENDING') fail('MEMBER_REQUEST_NOT_PENDING');
      const at = new Date().toISOString();
      let next: DemoMemberRequest = row;
      await db.transaction('rw', db.tables, async () => {
        if (row.kind === 'ADD') {
          const team = row.teamId ? await db.teams.get(row.teamId) : undefined;
          if (!team || team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
          const input = memberInputSchema.parse({
            fullName: row.payload.fullName,
            nationalId: row.payload.nationalId,
            ...(row.payload.jobTitleId ? { jobTitleId: row.payload.jobTitleId } : {}),
            ...(row.payload.jobTitleText ? { jobTitleText: row.payload.jobTitleText } : {}),
            ...(row.payload.departmentId ? { departmentId: row.payload.departmentId } : {}),
            ...(row.payload.departmentText ? { departmentText: row.payload.departmentText } : {}),
          });
          const member = await api.phase2Hooks.insertMember(input, team.id, viewer.id, at);
          next = {
            ...row,
            status: 'APPROVED',
            memberId: member.id,
            payload: { ...row.payload, nationalId: null, nationalIdMasked: maskNationalId(input.nationalId) } as DemoMemberRequest['payload'],
            decidedById: viewer.id,
            decidedAt: at,
          };
          await api.writeAudit({
            actorId: viewer.id,
            action: 'member.created',
            entityType: 'team_member',
            entityId: member.id,
            before: null,
            after: { fullName: member.fullName, nationalId: maskNationalId(member.nationalId), teamId: team.id, requestId: row.id },
          });
        } else {
          await archiveMember(row.memberId!, at);
          next = { ...row, status: 'APPROVED', decidedById: viewer.id, decidedAt: at };
          await api.writeAudit({
            actorId: viewer.id,
            action: 'member.archived',
            entityType: 'team_member',
            entityId: row.memberId,
            before: { status: 'ACTIVE' },
            after: { status: 'INACTIVE', reason: row.reason, requestId: row.id },
          });
        }
        await db.memberRequests.put(next);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'member_request.approved',
          entityType: 'member_request',
          entityId: row.id,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', kind: row.kind },
        });
        if (row.requestedById) {
          await api.notify(row.requestedById, 'MEMBER_REQUEST_DECIDED', {
            requestId: row.id,
            kind: row.kind,
            status: 'APPROVED',
            fullName: row.payload.fullName ?? null,
          });
        }
      });
      return requestDto(next);
    },
    reject: async (id, input) => {
      const viewer = await api.actor('registrations.review');
      const data = validate(rejectMemberRequestSchema, input);
      const row = await db.memberRequests.get(id);
      if (!row || !teamInScope(viewer, row.teamId)) fail('NOT_FOUND');
      if (row.status !== 'PENDING') fail('MEMBER_REQUEST_NOT_PENDING');
      const at = new Date().toISOString();
      const masked = row.payload.nationalId ? maskNationalId(row.payload.nationalId) : undefined;
      const next: DemoMemberRequest = {
        ...row,
        status: 'REJECTED',
        decisionReason: data.reason,
        payload: { ...row.payload, nationalId: null, ...(masked ? { nationalIdMasked: masked } : {}) } as DemoMemberRequest['payload'],
        decidedById: viewer.id,
        decidedAt: at,
      };
      await db.memberRequests.put(next);
      await api.writeAudit({
        actorId: viewer.id,
        action: 'member_request.rejected',
        entityType: 'member_request',
        entityId: row.id,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', reason: data.reason },
      });
      if (row.requestedById) {
        await api.notify(row.requestedById, 'MEMBER_REQUEST_DECIDED', {
          requestId: row.id,
          kind: row.kind,
          status: 'REJECTED',
          reason: data.reason,
          fullName: row.payload.fullName ?? null,
        });
      }
      return requestDto(next);
    },
  };

  /** Archives a worker: the record becomes INACTIVE and the open team membership is closed. */
  async function archiveMember(memberId: string, at: string) {
    const m = await db.members.get(memberId);
    if (!m) fail('NOT_FOUND');
    await db.members.update(memberId, { status: 'INACTIVE' });
    await db.memberships
      .where('memberId')
      .equals(memberId)
      .filter((x) => x.validTo === null)
      .modify({ validTo: at });
  }

  // ------------------------------------------------------------ project cover

  async function liveCover(projectId: string): Promise<DemoFile | undefined> {
    const p = await db.projects.get(projectId);
    if (!p?.coverFileId) return undefined;
    const f = await db.files.get(p.coverFileId);
    return f && f.status === 'READY' && !f.deletedAt ? f : undefined;
  }

  async function coverObjectUrl(file: DemoFile): Promise<string> {
    const cached = coverUrls.get(file.id);
    if (cached) return cached;
    const obj = await db.objects.get(file.id);
    if (!obj) fail('NOT_FOUND');
    const blob = new Blob([obj.data], { type: obj.type });
    let url: string;
    if (typeof URL.createObjectURL === 'function') url = URL.createObjectURL(blob);
    else {
      const bytes = new Uint8Array(obj.data);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
      url = `data:${obj.type};base64,${btoa(s)}`;
    }
    coverUrls.set(file.id, url);
    return url;
  }

  const projectCover: A12RolesApi['projectCover'] = {
    coverUrl: async (id) => {
      const viewer = await api.actor(undefined, { project: { projectId: id } });
      await projectVisible(viewer, id);
      const file = await liveCover(id);
      if (!file) fail('NOT_FOUND');
      return { url: await coverObjectUrl(file), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
    uploadCover: async (id, blob: Blob, opts?: UploadOptions) => {
      const presigned = await api.files.presign({
        entityType: 'project_cover',
        entityId: id,
        contentType: blob.type as never,
        sizeBytes: blob.size,
      });
      await api.files.upload(presigned, blob, opts);
      opts?.onProgress?.(1);
      await api.files.confirm(presigned.fileId);
      return { fileId: presigned.fileId };
    },
    removeCover: async (id) => {
      const { viewer, project } = await manageable(id);
      if (!project.coverFileId) return;
      const old = project.coverFileId;
      await db.transaction('rw', [db.projects, db.files, db.objects, db.audit], async () => {
        await db.projects.update(id, { coverFileId: null });
        await db.files.delete(old);
        await db.objects.delete(old);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.cover_removed',
          entityType: 'project',
          entityId: id,
          before: { fileId: old },
          after: null,
        });
      });
      coverUrls.delete(old);
    },
  };

  async function beforeCoverPresign(input: { entityId?: string; contentType?: string; sizeBytes?: number }, actor: DemoUser) {
    if (!can(actor, 'projects.manage')) fail('FORBIDDEN');
    if (!input.entityId) fail('VALIDATION_FAILED', { fieldErrors: { entityId: ['اختر المشروع'] } });
    const p = await db.projects.get(input.entityId);
    if (!p || !projectInScope(actor, p.id)) fail('NOT_FOUND');
    if (p.archivedAt) fail('PROJECT_ARCHIVED');
    if (!COVER_TYPES.includes(input.contentType ?? '')) throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
    if ((input.sizeBytes ?? 0) > PROJECT_COVER_MAX_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413);
  }

  async function afterCoverConfirm(file: DemoFile, actor: DemoUser) {
    const obj = await db.objects.get(file.id);
    const sniffed = obj ? sniffImageType(new Uint8Array(obj.data)) : null;
    if (!obj || !sniffed || obj.data.byteLength > PROJECT_COVER_MAX_BYTES) {
      await db.files.delete(file.id);
      await db.objects.delete(file.id);
      throw ApiError.of(obj && obj.data.byteLength > PROJECT_COVER_MAX_BYTES ? 'FILE_TOO_LARGE' : 'FILE_TYPE_NOT_ALLOWED', 415);
    }
    const projectId = file.entityId!;
    const p = await db.projects.get(projectId);
    if (!p) fail('NOT_FOUND');
    const previous = p.coverFileId ?? null;
    await db.transaction('rw', [db.projects, db.files, db.objects, db.audit], async () => {
      await db.projects.update(projectId, { coverFileId: file.id });
      if (previous && previous !== file.id) {
        await db.files.delete(previous);
        await db.objects.delete(previous);
      }
      await api.writeAudit({
        actorId: actor.id,
        action: 'project.cover_updated',
        entityType: 'project',
        entityId: projectId,
        before: previous ? { fileId: previous } : null,
        after: { fileId: file.id },
      });
    });
    if (previous) coverUrls.delete(previous);
  }

  // ------------------------------------------------------------ decorations of older modules

  function decorate() {
    // Supervisors: adding a worker is a request (202); admins as before (201).
    const addMember = api.teams.addMember;
    api.teams.addMember = async (teamId, input) => {
      const u = await api.actor();
      if (can(u, 'members.manage') || !can(u, 'members.manageOwn')) return addMember(teamId, input);
      const data = validate(memberInputSchema, input);
      const team = await db.teams.get(teamId);
      if (!team || !teamInScope(u, teamId)) fail('NOT_FOUND');
      if (!(await openLeaderIds(db, teamId)).includes(u.id)) fail('NOT_FOUND');
      if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
      // Never "taken": a duplicate is refused without confirming that the ID exists (review L7).
      const dupMember = await db.members.where('nationalId').equals(data.nationalId).first();
      const dupRequest = await db.memberRequests
        .filter((r) => r.status === 'PENDING' && r.kind === 'ADD' && r.payload.nationalId === data.nationalId)
        .first();
      if (dupMember || dupRequest) {
        await api.writeAudit({
          actorId: u.id,
          action: 'member.duplicate_rejected',
          entityType: 'member',
          entityId: null,
          before: null,
          after: { route: 'teams.addMember', rows: 1 },
        });
        fail('NATIONAL_ID_NOT_ACCEPTED', { fieldErrors: { nationalId: [ERRORS.NATIONAL_ID_NOT_ACCEPTED] } });
      }
      const row: DemoMemberRequest = {
        id: newId(),
        kind: 'ADD',
        status: 'PENDING',
        teamId,
        memberId: null,
        payload: {
          fullName: data.fullName,
          nationalId: data.nationalId,
          jobTitleId: data.jobTitleId ?? null,
          jobTitleText: data.jobTitleText ?? null,
          departmentId: data.departmentId ?? null,
          departmentText: data.departmentText ?? null,
        },
        reason: null,
        decisionReason: null,
        requestedById: u.id,
        decidedById: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
      };
      await db.memberRequests.add(row);
      await api.writeAudit({
        actorId: u.id,
        action: 'member_request.created',
        entityType: 'member_request',
        entityId: row.id,
        before: null,
        after: { kind: 'ADD', teamId, fullName: data.fullName, nationalId: maskNationalId(data.nationalId) },
      });
      await notifyApprovers(u, 'MEMBER_REQUEST_CREATED', { requestId: row.id, kind: 'ADD', teamName: team.name, fullName: data.fullName, by: u.fullName });
      const accepted: MemberRequestAcceptedDto = { status: 'PENDING_APPROVAL', request: await requestDto(row) };
      return accepted;
    };

    // Removing a worker: admins archive; a supervisor of the worker's team asks.
    api.members.archive = async (id, input) => {
      const u = await api.actor();
      if (!can(u, 'members.manage') && !can(u, 'members.manageOwn')) fail('FORBIDDEN');
      const data = validate(archiveMemberSchema, input);
      const m = await db.members.get(id);
      if (!m) fail('NOT_FOUND');
      const open = await db.memberships.where('memberId').equals(id).filter((x) => x.validTo === null).first();
      if (!teamInScope(u, open?.teamId ?? null)) fail('NOT_FOUND');
      if (can(u, 'members.manage')) {
        if (m.status !== 'ACTIVE') return { status: 'ARCHIVED' as const };
        const at = new Date().toISOString();
        await db.transaction('rw', db.tables, async () => {
          await archiveMember(id, at);
          await api.writeAudit({
            actorId: u.id,
            action: 'member.archived',
            entityType: 'team_member',
            entityId: id,
            before: { status: 'ACTIVE' },
            after: { status: 'INACTIVE', reason: data.reason },
          });
        });
        return { status: 'ARCHIVED' as const };
      }
      if (!open || !(await openLeaderIds(db, open.teamId)).includes(u.id)) fail('NOT_FOUND');
      const existing = await db.memberRequests
        .filter((r) => r.status === 'PENDING' && r.kind === 'REMOVE' && r.memberId === id)
        .first();
      if (existing) return { status: 'PENDING_APPROVAL' as const, request: await requestDto(existing) };
      const team = await db.teams.get(open.teamId);
      const row: DemoMemberRequest = {
        id: newId(),
        kind: 'REMOVE',
        status: 'PENDING',
        teamId: open.teamId,
        memberId: id,
        payload: {},
        reason: data.reason,
        decisionReason: null,
        requestedById: u.id,
        decidedById: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
      };
      await db.memberRequests.add(row);
      await api.writeAudit({
        actorId: u.id,
        action: 'member_request.created',
        entityType: 'member_request',
        entityId: row.id,
        before: null,
        after: { kind: 'REMOVE', teamId: open.teamId, memberId: id, reason: data.reason },
      });
      await notifyApprovers(u, 'MEMBER_REQUEST_CREATED', { requestId: row.id, kind: 'REMOVE', teamName: team?.name ?? null, fullName: m.fullName, by: u.fullName });
      return { status: 'PENDING_APPROVAL' as const, request: await requestDto(row) };
    };

    // The money rule (BudgetInterceptor): no money fields without budget.read; no money writes without budget.manage.
    const budgetRead = async () => can(await api.actor(undefined, { optionalWorkspace: true }), 'budget.read');
    const guardWrite = async (input: unknown) => {
      if (!touchesMoney(input)) return;
      const viewer = await api.actor();
      if (!can(viewer, 'budget.manage')) fail('FORBIDDEN', { field: 'budget' });
    };
    const WRITES: Record<string, (args: unknown[]) => unknown> = {
      'projects.create': (a) => a[0],
      'projects.update': (a) => a[1],
      'tasks.create': (a) => a[1],
      'tasks.update': (a) => a[1],
      'tasks.batch': (a) => a[1],
      'tasks.bulk': (a) => a[1],
    };
    const wrap = (ns: 'projects' | 'tasks' | 'hub' | 'portfolios') => {
      const target = api[ns] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      for (const key of Object.keys(target)) {
        const fn = target[key];
        if (typeof fn !== 'function') continue;
        const write = WRITES[`${ns}.${key}`];
        target[key] = async (...args: unknown[]) => {
          if (write) await guardWrite(write(args));
          const out = await fn(...args);
          if (out instanceof Blob || out === undefined) return out;
          return (await budgetRead()) ? out : stripMoney(out);
        };
      }
    };
    wrap('projects');
    wrap('tasks');
    wrap('hub');
    wrap('portfolios');
    const budget = api.projects.budget;
    api.projects.budget = async (id) => {
      const viewer = await api.actor();
      if (!can(viewer, 'budget.read')) fail('FORBIDDEN');
      return budget(id);
    };
  }

  return { participants, memberRequests, projectCover, decorate, beforeCoverPresign, afterCoverConfirm };
}

/** The colour of a project's generated cover (stable per id). */
export { projectColor };

/** Permissions a level grants, re-exported for the web's own checks. */
export type { Permission };
