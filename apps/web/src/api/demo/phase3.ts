import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  can,
  changeViolationStatusSchema,
  createViolationSchema,
  isClockDriftSuspect,
  maskNationalId,
  presignUploadSchema,
  resolveTeamAt,
  updateViolationSchema,
  updateViolationTypeSchema,
  violationResponseSchema,
  violationTypeSchema,
  type Paginated,
  type RosterEntry,
  type Settings,
  type ViolationDto,
  type ViolationFilter,
  type ViolationTypeDto,
} from '@nuzli/shared';
import type { ApiClient, ViolationListQuery } from '../client';
import { ApiError } from '../errors';
import { t } from '../../i18n';
import { blobToArrayBuffer } from '../../lib/bytes';
import {
  computeViolationStats,
  matchesFilter,
  type StatsLookups,
  type ViolationFact,
} from '../../features/violations/stats';
import {
  buildViolationsWorkbook,
  workbookToBlob,
  type ExportRow,
} from '../../features/violations/excel';
import type {
  DemoColor,
  DemoFile,
  DemoMember,
  DemoMembership,
  DemoSupervisorHistory,
  DemoTeam,
  DemoUser,
  DemoViolation,
  DemoViolationType,
} from './db';
import type { DemoInternals } from './phase2';
import { sniffImageType } from './phase2';
import { drawPlaceholder } from './placeholderImage';
import { fail, newId, paginate, sameName, validate } from './util';

export type Phase3Api = Pick<ApiClient, 'files' | 'violationTypes' | 'violations'>;

export interface Phase3Internals extends DemoInternals {
  /** True when the demo should behave as if the network were down (navigator offline or forced). */
  isOffline(): boolean;
}

/** URL scheme of the demo's fake bucket. */
export const DEMO_STORAGE_SCHEME = 'demo-storage://';

const READ_ANY = ['violations.readAll', 'violations.readRecorded', 'violations.readOwnTeams'] as const;
const DEVICE_KEYS = ['userAgent', 'platform', 'appVersion', 'online'] as const;

interface World {
  users: Map<string, DemoUser>;
  members: Map<string, DemoMember>;
  teams: Map<string, DemoTeam>;
  colors: Map<string, DemoColor>;
  types: Map<string, DemoViolationType>;
  memberships: DemoMembership[];
  supervisorHistory: DemoSupervisorHistory[];
  files: Map<string, DemoFile[]>;
  settings: Settings;
}

/** Same rule as the API's `isClockDriftSuspect` call site (ADR-046). */
function pickDeviceInfo(info: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DEVICE_KEYS) if (info && info[k] !== undefined) out[k] = info[k];
  return out;
}

export function createPhase3(api: Phase3Internals): Phase3Api {
  const db = api.db;

  /** Network-shaped endpoints fail like `fetch` does when the device is offline. */
  function network() {
    if (api.isOffline()) throw new ApiError(0, 'NETWORK_ERROR', t('error.network'));
  }

  async function world(): Promise<World> {
    const [users, members, teams, colors, types, memberships, supervisorHistory, files, settings] =
      await Promise.all([
        db.users.toArray(),
        db.members.toArray(),
        db.teams.toArray(),
        db.colors.toArray(),
        db.violationTypes.toArray(),
        db.memberships.toArray(),
        db.supervisorHistory.toArray(),
        db.files.where('violationId').notEqual('').toArray(),
        api.readSettings(),
      ]);
    const byViolation = new Map<string, DemoFile[]>();
    for (const f of files) {
      if (!f.violationId) continue;
      const list = byViolation.get(f.violationId) ?? [];
      list.push(f);
      byViolation.set(f.violationId, list);
    }
    return {
      users: new Map(users.map((u) => [u.id, u])),
      members: new Map(members.map((m) => [m.id, m])),
      teams: new Map(teams.map((tm) => [tm.id, tm])),
      colors: new Map(colors.map((c) => [c.id, c])),
      types: new Map(types.map((ty) => [ty.id, ty])),
      memberships,
      supervisorHistory,
      files: byViolation,
      settings,
    };
  }

  const typeDto = (ty: DemoViolationType): ViolationTypeDto => ({
    id: ty.id,
    name: ty.name,
    severity: ty.severity,
    isActive: ty.isActive,
  });

  function teamSummary(w: World, teamId: string | null) {
    const tm = teamId ? w.teams.get(teamId) : undefined;
    if (!tm) return null;
    const c = w.colors.get(tm.colorId);
    return {
      id: tm.id,
      name: tm.name,
      color: {
        id: c?.id ?? tm.colorId,
        name: c?.name ?? '—',
        hex: c?.hex ?? '#5B6B72',
        isActive: c?.isActive ?? false,
      },
    };
  }

  const person = (w: World, id: string | null) => {
    const u = id ? w.users.get(id) : undefined;
    return u ? { id: u.id, fullName: u.fullName } : null;
  };

  function toDto(
    v: DemoViolation,
    w: World,
    viewer: DemoUser,
    opts: { withResponses?: boolean } = {},
  ): ViolationDto {
    const member = w.members.get(v.memberId);
    const type = w.types.get(v.typeId);
    const files = (w.files.get(v.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const dto: ViolationDto = {
      id: v.id,
      clientUuid: v.clientUuid,
      member: {
        id: v.memberId,
        fullName: member?.fullName ?? '—',
        nationalIdMasked: maskNationalId(member?.nationalId ?? ''),
      },
      team: teamSummary(w, v.teamIdSnapshot),
      supervisor: person(w, v.supervisorIdSnapshot),
      recordedBy: person(w, v.recordedById) ?? { id: v.recordedById, fullName: '—' },
      type: type ? typeDto(type) : { id: v.typeId, name: '—', severity: null, isActive: false },
      description: v.description,
      notes: v.notes,
      latitude: v.latitude,
      longitude: v.longitude,
      accuracyM: v.accuracyM,
      capturedAt: v.capturedAt,
      receivedAt: v.receivedAt,
      clockDriftSuspect: v.clockDriftSuspect,
      status: v.status,
      cancelReason: v.cancelReason,
      files: files.map((f) => ({
        id: f.id,
        kind: f.kind as 'ID_CARD' | 'EVIDENCE',
        mimeType: f.mimeType,
        ready: f.status === 'READY',
      })),
      responses: opts.withResponses
        ? v.responses.map((r) => ({
            id: r.id,
            supervisor: person(w, r.supervisorId) ?? { id: r.supervisorId, fullName: '—' },
            body: r.body,
            createdAt: r.createdAt,
          }))
        : [],
      editableUntil: new Date(
        Date.parse(v.receivedAt) + w.settings.VIOLATION_EDIT_WINDOW_MINUTES * 60_000,
      ).toISOString(),
      expectedPhotos: { idCard: v.expectedIdPhotos, evidence: v.expectedEvidence },
      clientSentAt: v.clientSentAt,
    };
    if (can(viewer, 'violations.manage')) dto.deviceInfo = { ...v.deviceInfo };
    return dto;
  }

  // ------------------------------------------------------------ scope (ADR-047)

  /** The supervisor's visibility for one team: override SHOW/HIDE, INHERIT → the setting. */
  function teamVisible(w: World, team: DemoTeam | undefined): boolean {
    if (!team || team.status === 'ARCHIVED') return false;
    if (team.violationVisibility === 'SHOW') return true;
    if (team.violationVisibility === 'HIDE') return false;
    return w.settings.SUPERVISORS_CAN_SEE_VIOLATIONS;
  }

  function inScope(v: DemoViolation, w: World, viewer: DemoUser): boolean {
    if (can(viewer, 'violations.readAll')) return true;
    if (can(viewer, 'violations.readRecorded') && v.recordedById === viewer.id) return true;
    if (can(viewer, 'violations.readOwnTeams') && v.teamIdSnapshot) {
      const team = w.teams.get(v.teamIdSnapshot);
      return !!team && team.supervisorId === viewer.id && teamVisible(w, team);
    }
    return false;
  }

  async function reader(): Promise<DemoUser> {
    const u = await api.actor();
    if (u.mustChangePassword) fail('PASSWORD_CHANGE_REQUIRED');
    if (!READ_ANY.some((p) => can(u, p))) fail('FORBIDDEN');
    return u;
  }

  async function findScoped(id: string, viewer: DemoUser, w: World): Promise<DemoViolation> {
    const v = await db.violations.get(id);
    if (!v || !inScope(v, w, viewer)) fail('NOT_FOUND');
    return v;
  }

  function fact(v: DemoViolation, w: World): ViolationFact {
    return {
      id: v.id,
      capturedAt: v.capturedAt,
      teamId: v.teamIdSnapshot,
      memberId: v.memberId,
      recordedById: v.recordedById,
      typeId: v.typeId,
      severity: w.types.get(v.typeId)?.severity ?? null,
      status: v.status,
      latitude: v.latitude,
      longitude: v.longitude,
      memberName: w.members.get(v.memberId)?.fullName ?? '',
    };
  }

  function sortRows(rows: DemoViolation[], sort: string | undefined) {
    const [field, dir] = (sort ?? 'capturedAt:desc').split(':');
    const key = (v: DemoViolation) =>
      field === 'receivedAt' ? v.receivedAt : field === 'status' ? v.status : v.capturedAt;
    const sign = dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => sign * key(a).localeCompare(key(b)) || b.id.localeCompare(a.id));
  }

  async function listScoped(
    query: ViolationListQuery,
    viewer: DemoUser,
    opts: { mine?: boolean } = {},
  ): Promise<Paginated<ViolationDto>> {
    const w = await world();
    const q = (query.q ?? '').trim().toLowerCase();
    const rows = (await db.violations.toArray()).filter((v) => {
      if (opts.mine ? v.recordedById !== viewer.id : !inScope(v, w, viewer)) return false;
      const f = fact(v, w);
      if (!matchesFilter(f, query)) return false;
      return !q || (f.memberName ?? '').toLowerCase().includes(q);
    });
    const page = paginate(sortRows(rows, query.sort), query.page, query.pageSize);
    return { ...page, items: page.items.map((v) => toDto(v, w, viewer)) };
  }

  // ------------------------------------------------------------ photo limits (ADR-048)

  async function activeCount(violationId: string, kind: string): Promise<number> {
    const now = Date.now();
    const files = await db.files.where('violationId').equals(violationId).toArray();
    const pending = await db.files
      .where('entityId')
      .equals(violationId)
      .filter((f) => f.status === 'PENDING' && Date.parse(f.expiresAt) > now)
      .toArray();
    return [...files, ...pending].filter((f) => f.kind === kind).length;
  }

  const limitOf = (kind: string, s: Settings) => (kind === 'ID_CARD' ? 1 : s.VIOLATION_MAX_PHOTOS);

  // Object URLs of viewed photos, reused within the session.
  const urls = new Map<string, string>();

  async function objectUrl(file: DemoFile): Promise<string> {
    const cached = urls.get(file.id);
    if (cached) return cached;
    let obj = await db.objects.get(file.id);
    if (!obj && file.placeholder) {
      const img = await drawPlaceholder({
        title: file.kind === 'ID_CARD' ? 'صورة هوية تجريبية' : 'صورة تجريبية',
        subtitle: file.placeholder.label,
        hue: file.placeholder.hue,
        idCard: file.kind === 'ID_CARD',
      });
      obj = { key: file.id, data: img.data, type: img.type };
      await db.objects.put(obj);
    }
    if (!obj) fail('NOT_FOUND');
    const blob = new Blob([obj.data], { type: obj.type });
    let url: string;
    if (typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(blob);
    } else {
      const bytes = new Uint8Array(obj.data);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
      url = `data:${obj.type};base64,${btoa(s)}`;
    }
    urls.set(file.id, url);
    return url;
  }

  // ------------------------------------------------------------ files

  const files: Phase3Api['files'] = {
    presign: async (input) => {
      network();
      const actor = await api.actor();
      const data = validate(presignUploadSchema, input);
      const settings = await api.readSettings();
      if (data.entityType === 'violation') {
        if (!data.entityId || (data.kind !== 'ID_CARD' && data.kind !== 'EVIDENCE')) {
          fail('VALIDATION_FAILED', { fieldErrors: { kind: [t('violations.err.kind')] } });
        }
        if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(data.contentType)) {
          throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
        }
        const v = await db.violations.get(data.entityId);
        if (!v || (v.recordedById !== actor.id && !can(actor, 'violations.manage'))) fail('NOT_FOUND');
        if ((await activeCount(v.id, data.kind)) >= limitOf(data.kind, settings)) {
          throw ApiError.of('TOO_MANY_PHOTOS', 409);
        }
      }
      const now = Date.now();
      const file: DemoFile = {
        id: newId(),
        entityType: data.entityType,
        entityId: data.entityId ?? null,
        kind: data.kind ?? null,
        mimeType: data.contentType,
        sizeBytes: data.sizeBytes,
        status: 'PENDING',
        createdById: actor.id,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + settings.PRESIGNED_URL_TTL_SECONDS * 1000).toISOString(),
        violationId: null,
      };
      await db.files.add(file);
      return {
        fileId: file.id,
        url: `${DEMO_STORAGE_SCHEME}${file.id}`,
        method: 'PUT',
        headers: { 'Content-Type': data.contentType },
        expiresAt: file.expiresAt,
      };
    },

    upload: async (presigned, blob) => {
      network();
      if (!presigned.url.startsWith(DEMO_STORAGE_SCHEME)) fail('FILE_NOT_UPLOADED');
      const id = presigned.url.slice(DEMO_STORAGE_SCHEME.length);
      const file = await db.files.get(id);
      // Like S3: an expired or unknown URL is refused (403), and the content type must match.
      if (!file || Date.parse(file.expiresAt) < Date.now()) {
        throw ApiError.of('FILE_NOT_UPLOADED', 403);
      }
      if (presigned.headers['Content-Type'] !== file.mimeType) {
        throw ApiError.of('FILE_NOT_UPLOADED', 403);
      }
      const data = await blobToArrayBuffer(blob);
      await db.objects.put({ key: id, data, type: file.mimeType });
    },

    confirm: async (fileId) => {
      network();
      const actor = await api.actor();
      const settings = await api.readSettings();
      return db.transaction('rw', [db.files, db.objects, db.violations], async () => {
        const file = await db.files.get(fileId);
        if (!file || (file.createdById !== actor.id && !can(actor, 'violations.manage'))) {
          fail('NOT_FOUND');
        }
        if (file.status === 'READY') return { id: file.id, status: 'READY' as const };
        const obj = await db.objects.get(fileId);
        if (!obj) fail('FILE_NOT_UPLOADED');
        const bytes = new Uint8Array(obj.data);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413);
        if (sniffImageType(bytes) !== file.mimeType) throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
        if (file.entityType === 'violation' && file.entityId) {
          const linked = (await db.files.where('violationId').equals(file.entityId).toArray()).filter(
            (f) => f.kind === file.kind,
          ).length;
          if (linked >= limitOf(String(file.kind), settings)) {
            await db.objects.delete(fileId);
            await db.files.delete(fileId);
            throw ApiError.of('TOO_MANY_PHOTOS', 409);
          }
          await db.files.update(fileId, { status: 'READY', violationId: file.entityId });
        } else {
          await db.files.update(fileId, { status: 'READY' });
        }
        return { id: fileId, status: 'READY' as const };
      });
    },
  };

  // ------------------------------------------------------------ violation types

  const violationTypes: Phase3Api['violationTypes'] = {
    list: async (query = {}) => {
      const u = await api.actor();
      const all = can(u, 'violations.manage') && !query.active;
      return (await db.violationTypes.toArray())
        .filter((ty) => all || ty.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        .map(typeDto);
    },
    create: async (input) => {
      const actor = await api.actor('violations.manage');
      const data = validate(violationTypeSchema, input);
      let created!: DemoViolationType;
      await db.transaction('rw', [db.violationTypes, db.audit], async () => {
        const all = await db.violationTypes.toArray();
        if (all.some((ty) => sameName(ty.name, data.name))) fail('NAME_TAKEN');
        created = {
          id: newId(),
          name: data.name,
          severity: data.severity,
          isActive: data.isActive,
          createdAt: new Date().toISOString(),
        };
        await db.violationTypes.add(created);
        await api.writeAudit({
          actorId: actor.id,
          action: 'violation_type.created',
          entityType: 'violation_type',
          entityId: created.id,
          before: null,
          after: typeDto(created),
        });
      });
      return typeDto(created);
    },
    update: async (id, input) => {
      const actor = await api.actor('violations.manage');
      const data = validate(updateViolationTypeSchema, input);
      let next!: DemoViolationType;
      await db.transaction('rw', [db.violationTypes, db.audit], async () => {
        const cur = await db.violationTypes.get(id);
        if (!cur) fail('NOT_FOUND');
        if (data.name !== undefined) {
          const all = await db.violationTypes.toArray();
          if (all.some((ty) => ty.id !== id && sameName(ty.name, data.name as string))) fail('NAME_TAKEN');
        }
        next = {
          ...cur,
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.severity !== undefined ? { severity: data.severity } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        };
        const changed = (['name', 'severity', 'isActive'] as const).filter((k) => cur[k] !== next[k]);
        if (!changed.length) return;
        await db.violationTypes.put(next);
        await api.writeAudit({
          actorId: actor.id,
          action: 'violation_type.updated',
          entityType: 'violation_type',
          entityId: id,
          before: Object.fromEntries(changed.map((k) => [k, cur[k]])),
          after: Object.fromEntries(changed.map((k) => [k, next[k]])),
        });
      });
      return typeDto(next);
    },
  };

  // ------------------------------------------------------------ violations

  async function exportRows(filter: ViolationFilter, w: World): Promise<ExportRow[]> {
    const rows = (await db.violations.toArray())
      .filter((v) => matchesFilter(fact(v, w), filter))
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return rows.map((v) => {
      const type = w.types.get(v.typeId);
      return {
        id: v.id,
        capturedAt: new Date(v.capturedAt),
        receivedAt: new Date(v.receivedAt),
        memberName: w.members.get(v.memberId)?.fullName ?? '—',
        nationalIdMasked: maskNationalId(w.members.get(v.memberId)?.nationalId ?? ''),
        teamName: v.teamIdSnapshot ? w.teams.get(v.teamIdSnapshot)?.name ?? null : null,
        supervisorName: person(w, v.supervisorIdSnapshot)?.fullName ?? null,
        recordedByName: person(w, v.recordedById)?.fullName ?? '—',
        typeName: type?.name ?? '—',
        severity: type?.severity ?? null,
        status: v.status,
        description: v.description,
        notes: v.notes,
        latitude: v.latitude,
        longitude: v.longitude,
        accuracyM: v.accuracyM,
        clockDriftSuspect: v.clockDriftSuspect,
        cancelReason: v.cancelReason,
        evidenceCount: (w.files.get(v.id) ?? []).filter((f) => f.kind === 'EVIDENCE').length,
      };
    });
  }

  function lookups(w: World): StatsLookups {
    const open = new Map<string, string>();
    for (const m of w.memberships) if (m.validTo === null) open.set(m.memberId, m.teamId);
    const teams = new Map<string, { name: string; color: string }>();
    for (const tm of w.teams.values()) {
      teams.set(tm.id, { name: tm.name, color: w.colors.get(tm.colorId)?.hex ?? '#5B6B72' });
    }
    return {
      teams,
      members: new Map(
        [...w.members.values()].map((m) => [
          m.id,
          { fullName: m.fullName, currentTeamId: open.get(m.id) ?? null },
        ]),
      ),
      users: new Map([...w.users.values()].map((u) => [u.id, { fullName: u.fullName }])),
      types: new Map([...w.types.values()].map((ty) => [ty.id, { name: ty.name }])),
      teamMembersAt: (teamId, at) => {
        const t0 = at.getTime();
        return w.memberships.filter(
          (m) =>
            m.teamId === teamId &&
            Date.parse(m.validFrom) <= t0 &&
            (m.validTo === null || Date.parse(m.validTo) > t0),
        ).length;
      },
    };
  }

  const violations: Phase3Api['violations'] = {
    roster: async () => {
      network();
      await api.actor('violations.create');
      const w = await world();
      const open = new Map<string, DemoMembership>();
      for (const m of w.memberships) if (m.validTo === null) open.set(m.memberId, m);
      const items: RosterEntry[] = [];
      for (const m of w.members.values()) {
        const ms = open.get(m.id);
        const team = ms ? w.teams.get(ms.teamId) : undefined;
        if (m.status !== 'ACTIVE' || !team || team.status === 'ARCHIVED') continue;
        items.push({
          memberId: m.id,
          fullName: m.fullName,
          nationalIdMasked: maskNationalId(m.nationalId),
          nationalIdTail: m.nationalId.slice(-4),
          teamId: team.id,
          teamName: team.name,
          teamColor: w.colors.get(team.colorId)?.hex ?? null,
        });
      }
      items.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'));
      return { items, generatedAt: new Date().toISOString() };
    },

    create: async (input) => {
      network();
      const actor = await api.actor('violations.create');
      const data = validate(createViolationSchema, input);
      const w = await world();
      let result!: { violation: DemoViolation; created: boolean };
      await db.transaction('rw', [db.violations], async () => {
        const existing = await db.violations.where('clientUuid').equals(data.clientUuid).first();
        if (existing) {
          // Another user's UUID is never revealed (ADR-046).
          if (existing.recordedById !== actor.id) throw ApiError.of('CONFLICT_VERSION', 409);
          result = { violation: existing, created: false };
          return;
        }
        const member = w.members.get(data.memberId);
        if (!member || member.status !== 'ACTIVE') {
          fail('VALIDATION_FAILED', { fieldErrors: { memberId: [t('violations.err.member')] } });
        }
        const type = w.types.get(data.typeId);
        if (!type || !type.isActive) {
          fail('VALIDATION_FAILED', { fieldErrors: { typeId: [t('violations.err.type')] } });
        }
        if (data.expectedEvidencePhotos > w.settings.VIOLATION_MAX_PHOTOS) {
          throw ApiError.of('TOO_MANY_PHOTOS', 409);
        }
        const at = data.capturedAt;
        const membership = resolveTeamAt(
          w.memberships.filter((m) => m.memberId === data.memberId),
          at,
        );
        const teamId = membership?.teamId ?? null;
        const sup = teamId
          ? resolveTeamAt(
              w.supervisorHistory.filter((h) => h.teamId === teamId),
              at,
            )
          : null;
        const receivedAt = new Date().toISOString();
        const v: DemoViolation = {
          id: newId(),
          clientUuid: data.clientUuid,
          memberId: data.memberId,
          typeId: data.typeId,
          teamIdSnapshot: teamId,
          supervisorIdSnapshot: sup?.supervisorId ?? null,
          recordedById: actor.id,
          description: data.description,
          notes: data.notes ?? null,
          latitude: data.latitude,
          longitude: data.longitude,
          accuracyM: data.accuracyM,
          capturedAt: new Date(data.capturedAt).toISOString(),
          receivedAt,
          clientSentAt: data.clientSentAt ? new Date(data.clientSentAt).toISOString() : null,
          clockDriftSuspect: isClockDriftSuspect({
            capturedAt: data.capturedAt,
            receivedAt,
            clientSentAt: data.clientSentAt ?? null,
            thresholdMinutes: w.settings.CLOCK_DRIFT_THRESHOLD_MINUTES,
          }),
          deviceInfo: pickDeviceInfo(data.deviceInfo),
          expectedIdPhotos: data.expectedIdPhotos,
          expectedEvidence: data.expectedEvidencePhotos,
          status: 'SUBMITTED',
          cancelReason: null,
          responses: [],
        };
        await db.violations.add(v);
        result = { violation: v, created: true };
      });
      return { violation: toDto(result.violation, w, actor, { withResponses: true }), created: result.created };
    },

    list: async (query = {}) => {
      network();
      return listScoped(query, await reader());
    },

    mine: async (query = {}) => {
      network();
      const u = await api.actor('violations.create');
      return listScoped(query, u, { mine: true });
    },

    get: async (id) => {
      network();
      const viewer = await reader();
      const w = await world();
      return toDto(await findScoped(id, viewer, w), w, viewer, { withResponses: true });
    },

    fileUrl: async (id, fileId) => {
      network();
      const viewer = await reader();
      const w = await world();
      const v = await findScoped(id, viewer, w);
      const file = (w.files.get(v.id) ?? []).find((f) => f.id === fileId);
      if (!file || file.status !== 'READY') fail('NOT_FOUND');
      if (file.kind === 'ID_CARD' && !can(viewer, 'violations.viewIdPhoto')) fail('FORBIDDEN');
      const settings = w.settings;
      const url = await objectUrl(file);
      if (file.kind === 'ID_CARD') {
        await api.writeAudit({
          actorId: viewer.id,
          action: 'violation.id_photo_viewed',
          entityType: 'violation',
          entityId: v.id,
          before: null,
          after: { fileId, ttlSeconds: settings.PRESIGNED_URL_TTL_SECONDS },
        });
      }
      return {
        url,
        expiresAt: new Date(Date.now() + settings.PRESIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },

    update: async (id, input) => {
      const viewer = await api.actor();
      if (!can(viewer, 'violations.create') && !can(viewer, 'violations.manage')) fail('FORBIDDEN');
      const data = validate(updateViolationSchema, input);
      const w = await world();
      const v = await findScoped(id, viewer, w);
      if (!can(viewer, 'violations.manage')) {
        const until = Date.parse(v.receivedAt) + w.settings.VIOLATION_EDIT_WINDOW_MINUTES * 60_000;
        if (v.recordedById !== viewer.id) fail('FORBIDDEN');
        if (Date.now() > until) throw ApiError.of('EDIT_WINDOW_CLOSED', 403);
      }
      if (data.typeId !== undefined && data.typeId !== v.typeId) {
        const type = w.types.get(data.typeId);
        if (!type || !type.isActive) {
          fail('VALIDATION_FAILED', { fieldErrors: { typeId: [t('violations.err.type')] } });
        }
      }
      const next: DemoViolation = {
        ...v,
        ...(data.typeId !== undefined ? { typeId: data.typeId } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
      };
      const changed = (['typeId', 'description', 'notes'] as const).filter((k) => v[k] !== next[k]);
      if (changed.length) {
        await db.transaction('rw', [db.violations, db.audit], async () => {
          await db.violations.put(next);
          await api.writeAudit({
            actorId: viewer.id,
            action: 'violation.updated',
            entityType: 'violation',
            entityId: id,
            before: Object.fromEntries(changed.map((k) => [k, v[k]])),
            after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          });
        });
      }
      return toDto(next, w, viewer, { withResponses: true });
    },

    setStatus: async (id, input) => {
      const viewer = await api.actor('violations.manage');
      const data = validate(changeViolationStatusSchema, input);
      const w = await world();
      const v = await findScoped(id, viewer, w);
      const next: DemoViolation = {
        ...v,
        status: data.status,
        cancelReason: data.status === 'CANCELLED' ? data.reason ?? null : null,
      };
      if (next.status !== v.status || next.cancelReason !== v.cancelReason) {
        await db.transaction('rw', [db.violations, db.audit], async () => {
          await db.violations.put(next);
          await api.writeAudit({
            actorId: viewer.id,
            action: 'violation.status_changed',
            entityType: 'violation',
            entityId: id,
            before: { status: v.status, ...(v.cancelReason ? { reason: v.cancelReason } : {}) },
            after: { status: next.status, ...(next.cancelReason ? { reason: next.cancelReason } : {}) },
          });
        });
      }
      return toDto(next, w, viewer, { withResponses: true });
    },

    respond: async (id, input) => {
      const viewer = await api.actor('violations.respond');
      const data = validate(violationResponseSchema, input);
      const w = await world();
      const v = await findScoped(id, viewer, w);
      const response = {
        id: newId(),
        supervisorId: viewer.id,
        body: data.body,
        createdAt: new Date().toISOString(),
      };
      const next: DemoViolation = { ...v, responses: [...v.responses, response] };
      await db.transaction('rw', [db.violations, db.audit, db.notifications], async () => {
        await db.violations.put(next);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'violation.response_added',
          entityType: 'violation',
          entityId: id,
          before: null,
          after: { responseId: response.id, length: data.body.length },
        });
        const admins = [...w.users.values()].filter(
          (u) => u.role === 'ADMIN' && u.status === 'ACTIVE' && u.id !== viewer.id,
        );
        for (const admin of admins) {
          // Same payload as the API (violations.service.ts respond()).
          await api.notify(admin.id, 'VIOLATION_OBJECTION', {
            violationId: id,
            responseId: response.id,
            supervisorName: viewer.fullName,
            teamName: v.teamIdSnapshot ? w.teams.get(v.teamIdSnapshot)?.name ?? '' : '',
            typeName: w.types.get(v.typeId)?.name ?? '',
            memberName: w.members.get(v.memberId)?.fullName ?? '',
          });
        }
      });
      return toDto(next, w, viewer, { withResponses: true });
    },

    stats: async (filter = {}) => {
      network();
      await api.actor('violations.stats');
      const w = await world();
      const facts = (await db.violations.toArray()).map((v) => fact(v, w));
      return computeViolationStats(facts, filter, new Date(), lookups(w));
    },

    exportXlsx: async (filter = {}) => {
      const actor = await api.actor('violations.export');
      const w = await world();
      const rows = await exportRows(filter, w);
      const labels: Array<[string, string]> = [];
      if (filter.from) labels.push(['من تاريخ', filter.from]);
      if (filter.to) labels.push(['إلى تاريخ', filter.to]);
      if (filter.teamId) labels.push(['الفريق', w.teams.get(filter.teamId)?.name ?? '—']);
      const wb = await buildViolationsWorkbook(rows, { generatedAt: new Date(), filterLabels: labels });
      await api.writeAudit({
        actorId: actor.id,
        action: 'violations.exported',
        entityType: 'violation',
        entityId: null,
        before: null,
        after: { count: rows.length, filters: filter },
      });
      return workbookToBlob(wb);
    },

    dashboardPdf: async () => {
      await api.actor('violations.export');
      throw ApiError.of('PDF_NOT_CONFIGURED', 501);
    },
  };

  return { files, violationTypes, violations };
}
