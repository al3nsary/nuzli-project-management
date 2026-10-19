import {
  ALLOWED_IMAGE_TYPES,
  ERRORS,
  MAX_IMPORT_BYTES,
  MAX_UPLOAD_BYTES,
  assignViolationSchema,
  nationalIdKind,
  registerViolationMemberSchema,
  unassignViolationSchema,
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
  type MemberDto,
  type ViolationDto,
  type ViolationFileKind,
  type ViolationFilter,
  type ViolationOcrDto,
  type ViolationSuggestionDto,
  type ViolationTypeDto,
} from '@nuzli/shared';
import type { OcrEngine } from '../../features/violations/ocr/engine';
import { rankByName } from '../../features/violations/ocr/nameSimilarity';
import { groupOpenLeaders, leadersAt } from './leaders';
import { createOcrRunner, type OcrRunner } from './ocrRunner';
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
  DemoObject,
  DemoReference,
  DemoTeam,
  DemoTeamSupervisor,
  DemoUser,
  DemoViolation,
  DemoViolationOcr,
  DemoViolationType,
} from './db';
import type { DemoInternals } from './phase2';
import { sniffImageType } from './phase2';
import { verifyImportBytes } from '../../features/imports/files';
import { drawIdCard, drawPlaceholder, drawPortrait } from './placeholderImage';
import { fail, newId, paginate, sameName, validate } from './util';

export type Phase3Api = Pick<ApiClient, 'files' | 'violationTypes' | 'violations'> & {
  /** @internal A9: the in-browser ID-card reading queue (tests await `ocrRunner.idle()`). */
  ocrRunner: OcrRunner;
};

export interface Phase3Internals extends DemoInternals {
  /** Phase 4 hook: who may upload to a task (admins and the assignee, ADR-058). */
  beforeTaskPresign?(input: { entityId?: string; kind?: string }, actor: DemoUser): Promise<void>;
  afterTaskConfirm?(file: DemoFile, actor: DemoUser): Promise<void>;
  /** Owner request A8 hooks (demo/photos.ts): scope checks at presign, linking at confirm. */
  beforePhotoPresign?(
    input: { entityType: string; entityId?: string; kind?: string; contentType: string; sizeBytes: number },
    actor: DemoUser,
  ): Promise<void>;
  afterPhotoConfirm?(file: DemoFile, actor: DemoUser): Promise<void>;
  /** True when the demo should behave as if the network were down (navigator offline or forced). */
  isOffline(): boolean;
  /** A9: the OCR engine (tesseract.js in the browser; tests inject a fake). */
  ocrEngine(): Promise<OcrEngine>;
}

/** What the Excel export and the lists say for a violation without a person (ADR-103). */
const UNASSIGNED_EXPORT = '— لم تُسند إلى شخص بعد';

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
  /** A9 (ADR-100): every leadership row (snapshots at captured_at) and the open ones per team. */
  leaderRows: DemoTeamSupervisor[];
  leaders: Map<string, DemoTeamSupervisor[]>;
  ocr: Map<string, DemoViolationOcr>;
  reference: Map<string, DemoReference>;
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
    const [users, members, teams, colors, types, memberships, leaderRows, ocrRows, reference, files, settings] =
      await Promise.all([
        db.users.toArray(),
        db.members.toArray(),
        db.teams.toArray(),
        db.colors.toArray(),
        db.violationTypes.toArray(),
        db.memberships.toArray(),
        db.teamSupervisors.toArray(),
        db.violationOcr.toArray(),
        db.reference.toArray(),
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
      leaderRows,
      leaders: groupOpenLeaders(leaderRows),
      ocr: new Map(ocrRows.map((o) => [o.violationId, o])),
      reference: new Map(reference.map((r) => [r.id, r])),
      files: byViolation,
      settings,
    };
  }

  /** A9: leads the team now (any open leadership row, primary or not). */
  const leadsNow = (w: World, teamId: string, userId: string) =>
    (w.leaders.get(teamId) ?? []).some((r) => r.userId === userId);

  /** Team, primary and every supervisor at an instant (ADR-014, ADR-100). */
  function snapshotAt(w: World, memberId: string, at: string) {
    const membership = resolveTeamAt(
      w.memberships.filter((m) => m.memberId === memberId),
      at,
    );
    const teamId = membership?.teamId ?? null;
    const sup = teamId ? leadersAt(w.leaderRows, teamId, at) : { primaryId: null, ids: [] as string[] };
    return { teamId, supervisorId: sup.primaryId, supervisorIds: sup.ids };
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
    const member = v.memberId ? w.members.get(v.memberId) : undefined;
    const type = w.types.get(v.typeId);
    const files = (w.files.get(v.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const dto: ViolationDto = {
      id: v.id,
      clientUuid: v.clientUuid,
      member: v.memberId === null ? null : {
        id: v.memberId,
        fullName: member?.fullName ?? '—',
        nationalIdMasked: maskNationalId(member?.nationalId ?? ''),
      },
      team: teamSummary(w, v.teamIdSnapshot),
      supervisor: person(w, v.supervisorIdSnapshot),
      assigned: v.memberId !== null,
      supervisors: (v.supervisorIdsSnapshot ?? (v.supervisorIdSnapshot ? [v.supervisorIdSnapshot] : []))
        .map((id) => person(w, id))
        .filter((p): p is { id: string; fullName: string } => Boolean(p)),
      assignedAt: v.assignedAt ?? null,
      assignedBy: person(w, v.assignedById ?? null),
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
        kind: f.kind as ViolationFileKind,
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
      expectedPhotos: { idCard: v.expectedIdPhotos, evidence: v.expectedEvidence, person: v.expectedPersonPhotos ?? 0 },
      clientSentAt: v.clientSentAt,
    };
    if (can(viewer, 'violations.manage')) dto.deviceInfo = { ...v.deviceInfo };
    // A9: the OCR state for the people who assign the violation (admins and the recorder).
    if (can(viewer, 'violations.manage') || v.recordedById === viewer.id) {
      dto.ocrStatus = w.ocr.get(v.id)?.status ?? null;
    }
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
      return !!team && leadsNow(w, team.id, viewer.id) && teamVisible(w, team);
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
      memberId: v.memberId ?? '',
      recordedById: v.recordedById,
      typeId: v.typeId,
      severity: w.types.get(v.typeId)?.severity ?? null,
      status: v.status,
      latitude: v.latitude,
      longitude: v.longitude,
      memberName: (v.memberId ? w.members.get(v.memberId) : undefined)?.fullName ?? '',
    };
  }

  /** Recorder or admin; anyone else → 404 (ADR-103, like the API's loadForAssign). */
  async function loadForAssign(id: string, viewer: DemoUser, w: World): Promise<DemoViolation> {
    const v = await findScoped(id, viewer, w);
    if (!can(viewer, 'violations.manage') && v.recordedById !== viewer.id) fail('NOT_FOUND');
    return v;
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

  const limitOf = (kind: string, s: Settings) => (kind === 'ID_CARD' || kind === 'PERSON' ? 1 : s.VIOLATION_MAX_PHOTOS);

  // Object URLs of viewed photos, reused within the session.
  const urls = new Map<string, string>();

  /** The stored bytes, or a seeded placeholder drawn on first use (person, card, evidence). */
  async function objectOf(file: DemoFile): Promise<DemoObject | undefined> {
    let obj = await db.objects.get(file.id);
    if (!obj && file.placeholder) {
      const ph = file.placeholder;
      const img =
        file.kind === 'PERSON'
          ? await drawPortrait({ hue: ph.hue, variant: ph.variant ?? 0 })
          : file.kind === 'ID_CARD' && ph.card
            ? await drawIdCard(ph.card)
            : await drawPlaceholder({
                title: file.kind === 'ID_CARD' ? 'صورة هوية تجريبية' : 'صورة تجريبية',
                subtitle: ph.label,
                hue: ph.hue,
                idCard: file.kind === 'ID_CARD',
              });
      obj = { key: file.id, data: img.data, type: img.type };
      await db.objects.put(obj);
    }
    return obj;
  }

  const ocrRunner = createOcrRunner({
    db,
    engine: () => api.ocrEngine(),
    imageOf: async (file) => {
      const obj = await objectOf(file);
      return new Blob(obj ? [obj.data] : [], { type: obj?.type ?? file.mimeType });
    },
  });

  async function objectUrl(file: DemoFile): Promise<string> {
    const cached = urls.get(file.id);
    if (cached) return cached;
    const obj = await objectOf(file);
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
      // ADR-083: personal photos go through the photo hooks (refused when none is registered);
      // logos are admin-only, no entityId.
      if (data.entityType === 'member_photo' || data.entityType === 'user_photo') {
        if (!api.beforePhotoPresign) fail('FORBIDDEN');
        await api.beforePhotoPresign(data, actor);
      }
      if (data.entityType === 'logo' && (data.entityId || !can(actor, 'logos.manage'))) fail('FORBIDDEN');
      // A9 imports (ADR-110): admins only (projects.create), no entityId/kind, ≤ 20 MB (schema).
      if (data.entityType === 'import' && !can(actor, 'projects.create')) fail('FORBIDDEN');
      if (data.entityType === 'task') await api.beforeTaskPresign?.(data, actor);
      if (data.entityType === 'violation') {
        if (!data.entityId || (data.kind !== 'ID_CARD' && data.kind !== 'EVIDENCE' && data.kind !== 'PERSON')) {
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
      const result = await db.transaction('rw', [db.files, db.objects, db.violations], async () => {
        const file = await db.files.get(fileId);
        if (!file || (file.createdById !== actor.id && !can(actor, 'violations.manage'))) {
          fail('NOT_FOUND');
        }
        if (file.status === 'READY') return { id: file.id, status: 'READY' as const };
        const obj = await db.objects.get(fileId);
        if (!obj) fail('FILE_NOT_UPLOADED');
        const bytes = new Uint8Array(obj.data);
        if (file.entityType === 'import') {
          // A structure check instead of an image sniff (verifyImportBytes, like the API).
          if (file.createdById !== actor.id) fail('NOT_FOUND');
          if (bytes.byteLength > MAX_IMPORT_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413);
          if (!verifyImportBytes(bytes, file.mimeType)) throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 400);
          await db.files.update(fileId, { status: 'READY' });
          return { id: fileId, status: 'READY' as const };
        }
        if (bytes.byteLength > MAX_UPLOAD_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413);
        const isPdf = String.fromCharCode(...bytes.slice(0, 4)) === '%PDF';
        const sniffed = isPdf ? 'application/pdf' : sniffImageType(bytes);
        if (sniffed !== file.mimeType) throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
        if (sniffed === 'application/pdf' && file.entityType !== 'task') throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
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
      // Phase 4 hook: a confirmed task upload is attached and audited once (ADR-058).
      const confirmed = await db.files.get(fileId);
      if (confirmed?.entityType === 'task') await api.afterTaskConfirm?.(confirmed, actor);
      if (confirmed?.entityType === 'user_photo' || confirmed?.entityType === 'member_photo') {
        await api.afterPhotoConfirm?.(confirmed, actor);
      }
      // A9 (ADR-104): a confirmed ID-card photo queues the reading of the card.
      if (confirmed?.entityType === 'violation' && confirmed.kind === 'ID_CARD' && confirmed.violationId) {
        await ocrRunner.enqueue(confirmed.violationId, confirmed.id);
      }
      return result;
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
        memberName: v.memberId ? (w.members.get(v.memberId)?.fullName ?? '—') : UNASSIGNED_EXPORT,
        nationalIdMasked: v.memberId ? maskNationalId(w.members.get(v.memberId)?.nationalId ?? '') : '',
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
          photoFileId: m.photoFileId,
          hasPhoto: Boolean(m.photoFileId),
          // A10: the roster marks the worker foreman (optional in RosterEntry).
          ...(ms?.role === 'FOREMAN' ? { isForeman: true } : {}),
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
        // A9: a violation may be recorded without a person (assigned later).
        const memberId = data.memberId ?? null;
        if (memberId) {
          const member = w.members.get(memberId);
          if (!member || member.status !== 'ACTIVE') {
            fail('VALIDATION_FAILED', { fieldErrors: { memberId: [t('violations.err.member')] } });
          }
        }
        const type = w.types.get(data.typeId);
        if (!type || !type.isActive) {
          fail('VALIDATION_FAILED', { fieldErrors: { typeId: [t('violations.err.type')] } });
        }
        if (data.expectedEvidencePhotos > w.settings.VIOLATION_MAX_PHOTOS) {
          throw ApiError.of('TOO_MANY_PHOTOS', 409);
        }
        // ADR-014/100: team, primary and all supervisors at captured_at; none without a person.
        const snap = memberId
          ? snapshotAt(w, memberId, data.capturedAt)
          : { teamId: null, supervisorId: null, supervisorIds: [] as string[] };
        const receivedAt = new Date().toISOString();
        const v: DemoViolation = {
          id: newId(),
          clientUuid: data.clientUuid,
          memberId,
          typeId: data.typeId,
          teamIdSnapshot: snap.teamId,
          supervisorIdSnapshot: snap.supervisorId,
          supervisorIdsSnapshot: snap.supervisorIds,
          assignedAt: null,
          assignedById: null,
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
          expectedPersonPhotos: data.expectedPersonPhotos,
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
      const v = await findScoped(id, viewer, w);
      // Seeded cards are read lazily, the first time somebody who may assign opens them.
      if (w.ocr.get(id)?.status === 'PENDING' && (can(viewer, 'violations.manage') || v.recordedById === viewer.id)) {
        void ocrRunner.kick(id);
      }
      return toDto(v, w, viewer, { withResponses: true });
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
            memberName: (v.memberId ? w.members.get(v.memberId) : undefined)?.fullName ?? '',
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

    // ---------------------------------------------------------- A9 (ADR-103/104)

    ocr: async (id) => {
      network();
      const viewer = await reader();
      if (!can(viewer, 'violations.manage') && !can(viewer, 'violations.create')) fail('NOT_FOUND');
      const w = await world();
      const v = await loadForAssign(id, viewer, w);
      const job = w.ocr.get(id);
      const empty: ViolationOcrDto['fields'] = {
        nationalId: null,
        name: null,
        nameLatin: null,
        birthDate: null,
        expiryDate: null,
        nationality: null,
      };
      if (!job) return { status: 'NONE', attempts: 0, extractedAt: null, fields: empty, suggestedMembers: [], suggestedUsers: [] };
      if (job.status === 'PENDING') void ocrRunner.kick(id);
      const f = job.status === 'DONE' ? job.extracted : null;
      const full = can(viewer, 'nationalIds.readFull');
      const fields: ViolationOcrDto['fields'] = f
        ? {
            nationalId: f.nationalId
              ? {
                  value: full ? f.nationalId.value : maskNationalId(f.nationalId.value),
                  masked: maskNationalId(f.nationalId.value),
                  full,
                  confidence: f.nationalId.confidence,
                  kind: nationalIdKind(f.nationalId.value) ?? 'RESIDENT',
                }
              : null,
            name: f.name,
            nameLatin: f.nameLatin,
            birthDate: f.birthDate,
            expiryDate: f.expiryDate,
            nationality: f.nationality,
          }
        : empty;
      const suggestedMembers: ViolationSuggestionDto[] = [];
      let suggestedUsers: ViolationOcrDto['suggestedUsers'] = [];
      if (f && !v.memberId) {
        const open = new Map<string, DemoMembership>();
        for (const m of w.memberships) if (m.validTo === null) open.set(m.memberId, m);
        const suggest = (m: DemoMember, match: 'NATIONAL_ID' | 'NAME', score: number): ViolationSuggestionDto => {
          const ms = open.get(m.id);
          return {
            memberId: m.id,
            fullName: m.fullName,
            nationalIdMasked: maskNationalId(m.nationalId),
            team: ms ? teamSummary(w, ms.teamId) : null,
            hasPhoto: Boolean(m.photoFileId),
            match,
            score,
          };
        };
        if (f.nationalId) {
          for (const m of w.members.values()) {
            if (m.nationalId === f.nationalId.value) suggestedMembers.push(suggest(m, 'NATIONAL_ID', 1));
          }
          if (can(viewer, 'violations.manage')) {
            suggestedUsers = [...w.users.values()]
              .filter((u) => u.nationalId === f.nationalId!.value)
              .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role }));
          }
        }
        if (f.name) {
          const taken = new Set(suggestedMembers.map((s) => s.memberId));
          const pool = [...w.members.values()].filter((m) => m.status === 'ACTIVE' && !taken.has(m.id));
          for (const r of rankByName(f.name.value, pool, { threshold: 0.45, limit: 5 })) {
            suggestedMembers.push(suggest(r, 'NAME', r.score));
          }
        }
      }
      // Like ID-card photo views (ADR-050): every view is audited, flagged when the full ID was returned.
      await api.writeAudit({
        actorId: viewer.id,
        action: 'violation.ocr_viewed',
        entityType: 'violation',
        entityId: id,
        before: null,
        after: { status: job.status, fullNationalId: full && !!f?.nationalId, suggestions: suggestedMembers.length },
      });
      return {
        status: job.status,
        attempts: job.attempts,
        extractedAt: job.extractedAt,
        error: job.status === 'FAILED' ? job.error : null,
        fields,
        suggestedMembers,
        suggestedUsers,
      };
    },

    retryOcr: async (id) => {
      network();
      const viewer = await api.actor('violations.manage');
      const w = await world();
      const v = await findScoped(id, viewer, w);
      if (!(await ocrRunner.retry(id))) {
        const card = (w.files.get(v.id) ?? []).find((f) => f.kind === 'ID_CARD' && f.status === 'READY');
        if (!card) fail('NOT_FOUND');
        await ocrRunner.enqueue(v.id, card.id);
      }
      return { queued: true as const };
    },

    assign: async (id, input) => {
      network();
      const viewer = await reader();
      const data = validate(assignViolationSchema, input);
      const w = await world();
      const current = await loadForAssign(id, viewer, w);
      if (current.memberId === data.memberId) return toDto(current, w, viewer, { withResponses: true });
      if (current.memberId) fail('VIOLATION_ALREADY_ASSIGNED');
      if (!w.members.get(data.memberId)) {
        fail('VALIDATION_FAILED', { fieldErrors: { memberId: [t('violations.err.member')] } });
      }
      await db.transaction('rw', [db.violations, db.audit], async () => {
        await assignInTx(id, data.memberId, viewer, w, 'assign');
      });
      const after = await world();
      return toDto((await db.violations.get(id))!, after, viewer, { withResponses: true });
    },

    unassign: async (id, input) => {
      network();
      const viewer = await api.actor('violations.manage');
      const data = validate(unassignViolationSchema, input ?? {});
      const w = await world();
      const current = await findScoped(id, viewer, w);
      if (!current.memberId) return toDto(current, w, viewer, { withResponses: true });
      const next: DemoViolation = {
        ...current,
        memberId: null,
        teamIdSnapshot: null,
        supervisorIdSnapshot: null,
        supervisorIdsSnapshot: [],
        assignedAt: null,
        assignedById: null,
      };
      await db.transaction('rw', [db.violations, db.audit], async () => {
        await db.violations.put(next);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'violation.unassigned',
          entityType: 'violation',
          entityId: id,
          before: {
            memberId: current.memberId,
            teamIdSnapshot: current.teamIdSnapshot,
            supervisorIdsSnapshot: current.supervisorIdsSnapshot ?? [],
          },
          after: { memberId: null, reason: data.reason ?? null },
        });
      });
      return toDto(next, w, viewer, { withResponses: true });
    },

    registerMember: async (id, input) => {
      network();
      // A9 security review (ADR-118): admins only — supervisors and monitors get 403.
      const viewer = await api.actor();
      if (!can(viewer, 'members.manage')) fail('FORBIDDEN');
      const isAdmin = true;
      const data = validate(registerViolationMemberSchema, input);
      const w = await world();
      // A supervisor cannot see an unassigned violation; their right comes from the team they lead.
      const v = isAdmin ? await findScoped(id, viewer, w) : await db.violations.get(id);
      if (!v) fail('NOT_FOUND');
      if (v.memberId) fail(isAdmin ? 'VIOLATION_ALREADY_ASSIGNED' : 'NOT_FOUND');
      if (!data.teamId && !isAdmin) fail('FORBIDDEN', { field: 'teamId' });
      if (data.teamId) {
        const team = w.teams.get(data.teamId);
        if (!team) fail('NOT_FOUND', { field: 'teamId' });
        if (!isAdmin && !leadsNow(w, team.id, viewer.id)) fail('NOT_FOUND');
        if (team.status === 'ARCHIVED') fail('TEAM_ARCHIVED');
        // M1: a membership backdated to captured_at only for a recent capture (and not from the future).
        const maxAgeDays = w.settings.VIOLATION_REGISTER_MAX_AGE_DAYS ?? 30;
        const driftMinutes = w.settings.CLOCK_DRIFT_THRESHOLD_MINUTES ?? 10;
        const age = Date.now() - Date.parse(v.capturedAt);
        if (age > maxAgeDays * 86_400_000 || age < -driftMinutes * 60_000) {
          fail('VIOLATION_TOO_OLD_TO_REGISTER', { maxAgeDays, capturedAt: v.capturedAt });
        }
      }
      for (const [field, kind, refId] of [
        ['jobTitleId', 'job-titles', data.jobTitleId],
        ['departmentId', 'departments', data.departmentId],
      ] as const) {
        if (refId && w.reference.get(refId)?.kind !== kind) {
          fail('VALIDATION_FAILED', { fieldErrors: { [field]: [ERRORS.NOT_FOUND] } });
        }
      }
      const dup = await db.members.where('nationalId').equals(data.nationalId).first();
      if (dup) {
        // Admins learn which member holds the ID (assign that one instead); others get the generic answer (ADR-067).
        if (isAdmin) {
          fail('NATIONAL_ID_TAKEN', { fieldErrors: { nationalId: [ERRORS.NATIONAL_ID_TAKEN] }, existingMemberId: dup.id });
        }
        await api.writeAudit({
          actorId: viewer.id,
          action: 'member.duplicate_rejected',
          entityType: 'member',
          entityId: null,
          before: null,
          after: { route: 'violations.register_member', rows: 1, violationId: id },
        });
        fail('NATIONAL_ID_NOT_ACCEPTED', { fieldErrors: { nationalId: [ERRORS.NATIONAL_ID_NOT_ACCEPTED] } });
      }
      // The PERSON photo becomes the member photo (a copy: the violation keeps its own).
      const personFile = data.usePersonPhoto
        ? (w.files.get(v.id) ?? []).find((f) => f.kind === 'PERSON' && f.status === 'READY')
        : undefined;
      const personBytes = personFile ? await objectOf(personFile) : undefined;
      const now = new Date().toISOString();
      const memberId = newId();
      const photoId = personBytes ? newId() : null;
      // The person was evidently on that team when recorded: the membership starts at captured_at.
      const membership: DemoMembership | null = data.teamId
        ? {
            id: newId(),
            memberId,
            teamId: data.teamId,
            validFrom: v.capturedAt < now ? v.capturedAt : now,
            validTo: null,
            movedById: viewer.id,
            reason: t('violations.register.membershipReason'),
            role: 'WORKER',
          }
        : null;
      await db.transaction(
        'rw',
        [db.members, db.memberships, db.files, db.objects, db.violations, db.audit],
        async () => {
          if (photoId && personBytes && personFile) {
            await db.objects.put({ key: photoId, data: personBytes.data, type: personBytes.type });
            await db.files.add({
              id: photoId,
              entityType: 'member_photo',
              entityId: memberId,
              kind: 'PHOTO',
              mimeType: personBytes.type,
              sizeBytes: personBytes.data.byteLength,
              status: 'READY',
              createdById: viewer.id,
              createdAt: now,
              expiresAt: now,
              violationId: null,
            });
          }
          await db.members.add({
            id: memberId,
            fullName: data.fullName,
            nationalId: data.nationalId,
            jobTitleId: data.jobTitleId ?? null,
            jobTitleText: data.jobTitleId ? null : (data.jobTitleText ?? null),
            departmentId: data.departmentId ?? null,
            departmentText: data.departmentId ? null : (data.departmentText ?? null),
            status: 'ACTIVE',
            photoFileId: photoId,
            createdAt: now,
          });
          if (membership) await db.memberships.add(membership);
          await api.writeAudit({
            actorId: viewer.id,
            action: 'member.created',
            entityType: 'member',
            entityId: memberId,
            before: null,
            after: {
              fullName: data.fullName,
              nationalIdMasked: maskNationalId(data.nationalId),
              teamId: data.teamId ?? null,
              fromViolationId: id,
            },
          });
          if (photoId) {
            await api.writeAudit({
              actorId: viewer.id,
              action: 'member.photo_updated',
              entityType: 'member',
              entityId: memberId,
              before: { photoFileId: null },
              after: { photoFileId: photoId, fromViolationId: id },
            });
          }
          await api.writeAudit({
            actorId: viewer.id,
            action: 'violation.member_registered',
            entityType: 'violation',
            entityId: id,
            before: null,
            after: { memberId, teamId: data.teamId ?? null, photoCopied: Boolean(photoId) },
          });
          await assignInTx(id, memberId, viewer, { ...w, memberships: membership ? [...w.memberships, membership] : w.memberships }, 'register');
        },
      );
      const after = await world();
      const m = after.members.get(memberId)!;
      const ms = after.memberships.find((x) => x.memberId === memberId && x.validTo === null);
      const refName = (rid: string | null) => (rid ? (after.reference.get(rid)?.name ?? null) : null);
      const member: MemberDto = {
        id: m.id,
        fullName: m.fullName,
        nationalIdMasked: maskNationalId(m.nationalId),
        ...(can(viewer, 'nationalIds.readFull') ? { nationalId: m.nationalId } : {}),
        jobTitle: refName(m.jobTitleId) ?? m.jobTitleText,
        jobTitleId: m.jobTitleId,
        department: refName(m.departmentId) ?? m.departmentText,
        departmentId: m.departmentId,
        status: m.status,
        team: ms ? teamSummary(after, ms.teamId) : null,
        photoFileId: m.photoFileId,
        hasPhoto: Boolean(m.photoFileId),
        isForeman: false,
      };
      let violation: ViolationDto | null = null;
      try {
        const row = await findScoped(id, viewer, after);
        violation = toDto(row, after, viewer, { withResponses: true });
      } catch {
        violation = null; // e.g. a supervisor whose team hides violations
      }
      return { member, violation };
    },
  };

  /**
   * Links the member and resolves the snapshot at captured_at (ADR-103). Runs inside a
   * transaction over violations + audit; a concurrent assignment of another person → 409.
   */
  async function assignInTx(id: string, memberId: string, viewer: DemoUser, w: World, via: 'assign' | 'register') {
    const v = await db.violations.get(id);
    if (!v) fail('NOT_FOUND');
    if (v.memberId) {
      if (v.memberId === memberId) return;
      fail('VIOLATION_ALREADY_ASSIGNED');
    }
    const snap = snapshotAt(w, memberId, v.capturedAt);
    await db.violations.put({
      ...v,
      memberId,
      teamIdSnapshot: snap.teamId,
      supervisorIdSnapshot: snap.supervisorId,
      supervisorIdsSnapshot: snap.supervisorIds,
      assignedAt: new Date().toISOString(),
      assignedById: viewer.id,
    });
    await api.writeAudit({
      actorId: viewer.id,
      action: 'violation.assigned',
      entityType: 'violation',
      entityId: id,
      before: { memberId: null },
      after: {
        memberId,
        via,
        teamIdSnapshot: snap.teamId,
        supervisorIdSnapshot: snap.supervisorId,
        supervisorIdsSnapshot: snap.supervisorIds,
      },
    });
  }

  return { files, violationTypes, violations, ocrRunner };
}
