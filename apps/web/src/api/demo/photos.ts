import {
  ALLOWED_IMAGE_TYPES,
  PHOTO_MAX_BYTES,
  can,
  type Permission,
  type PhotoEntityType,
  type PhotoUrlDto,
} from '@nuzli/shared';
import type { ApiClient, PhotoTarget } from '../client';
import { ApiError } from '../errors';
import { t } from '../../i18n';
import type { DemoAudit, DemoDb, DemoFile, DemoMember, DemoTeam, DemoUser } from './db';
import { drawPortrait } from './placeholderImage';
import { fail } from './util';
import { openLeaderIds } from './leaders';

/**
 * Personal photos in the demo (owner request A8), with the same matrix as
 * `apps/api/src/photos/photo-policy.ts` (ADR-083):
 *  - user photos: self or admin write (else 403); self, admins and any active user for an
 *    ACTIVE user read;
 *  - member photos: admin, or the supervisor leading the member's current non-archived team
 *    write — another supervisor's member 404, unassigned/archived/monitor 403; admins, the
 *    leading supervisor and recorders (monitors) for roster members read.
 * The bytes live in the fake bucket (IndexedDB `objects`); reads hand out object URLs with an
 * `expiresAt` like a presigned GET. A replaced or removed photo's object is deleted at once.
 */
export interface PhotoInternals {
  db: DemoDb;
  actor(permission?: Permission, opts?: import('./access').ActorOptions): Promise<DemoUser>;
  writeAudit(entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>): Promise<unknown>;
  readSettings(): ReturnType<ApiClient['settings']['get']>;
  isOffline(): boolean;
  files: ApiClient['files'];
  /** Security review A12 M2: the account rule for someone else's profile photo (see DemoApi). */
  assertPhotoAccountReach(viewer: DemoUser, targetId: string): Promise<DemoUser>;
}

type Decision = 'ALLOW' | 'FORBIDDEN' | 'NOT_FOUND';

interface MemberScope {
  member: DemoMember;
  team: DemoTeam | null;
  /** A9 (ADR-100): every user leading the team now (primary or co-supervisor). */
  leaderIds: string[];
}

export interface PhotoHooks {
  photos: ApiClient['photos'];
  /** `POST /files/presign` for `user_photo` / `member_photo`. */
  beforePresign(
    input: { entityType: string; entityId?: string; kind?: string; contentType: string; sizeBytes: number },
    actor: DemoUser,
  ): Promise<void>;
  /** `POST /files/:id/confirm` once the bytes are verified: link, retire the old file, audit. */
  afterConfirm(file: DemoFile, actor: DemoUser): Promise<void>;
  /** A displayable URL for a linked photo file (cards); null when missing or deleted. */
  urlForFile(fileId: string | null | undefined): Promise<string | null>;
}

const ACTIONS = {
  user_photo: { updated: 'user.photo_updated', removed: 'user.photo_removed', entityType: 'user' },
  member_photo: { updated: 'member.photo_updated', removed: 'member.photo_removed', entityType: 'member' },
} as const;

const enforce = (d: Decision) => {
  if (d !== 'ALLOW') fail(d);
};

export function userPhotoWrite(viewer: DemoUser, targetId: string): Decision {
  if (viewer.id === targetId && can(viewer, 'profile.update')) return 'ALLOW';
  if (can(viewer, 'users.manageRoles')) return 'ALLOW';
  return 'FORBIDDEN';
}

export function memberPhotoWrite(viewer: DemoUser, team: DemoTeam | null, leaderIds: readonly string[] = team ? [team.supervisorId] : []): Decision {
  if (can(viewer, 'members.manage')) return 'ALLOW';
  if (!can(viewer, 'members.manageOwn')) return 'FORBIDDEN';
  if (!team) return 'FORBIDDEN';
  if (!leaderIds.includes(viewer.id)) return 'NOT_FOUND';
  if (team.status === 'ARCHIVED') return 'FORBIDDEN';
  return 'ALLOW';
}

function userPhotoRead(viewer: DemoUser, target: DemoUser): boolean {
  if (viewer.status !== 'ACTIVE') return false;
  if (viewer.id === target.id) return true;
  if (can(viewer, 'users.read')) return true;
  return target.status === 'ACTIVE';
}

function memberPhotoRead(viewer: DemoUser, s: MemberScope): boolean {
  if (can(viewer, 'teams.readAll') || can(viewer, 'members.manage')) return true;
  if (s.team && can(viewer, 'teams.readOwn') && s.leaderIds.includes(viewer.id)) return true;
  return (
    can(viewer, 'violations.create') &&
    s.member.status === 'ACTIVE' &&
    !!s.team &&
    s.team.status !== 'ARCHIVED'
  );
}

const entityTypeOf = (target: PhotoTarget): PhotoEntityType =>
  target.kind === 'member' ? 'member_photo' : 'user_photo';

export function createPhotos(api: PhotoInternals): PhotoHooks {
  const db = api.db;
  /** Object URLs of photos viewed in this session, revoked when the photo is replaced. */
  const urls = new Map<string, string>();

  function network() {
    if (api.isOffline()) throw new ApiError(0, 'NETWORK_ERROR', t('error.network'));
  }

  async function memberScope(id: string): Promise<MemberScope | null> {
    const member = await db.members.get(id);
    if (!member) return null;
    const open = await db.memberships
      .where('memberId')
      .equals(id)
      .filter((r) => r.validTo === null)
      .first();
    const team = open ? ((await db.teams.get(open.teamId)) ?? null) : null;
    const leaderIds = team ? await openLeaderIds(db, team.id) : [];
    return { member, team, leaderIds };
  }

  /** NOT_FOUND / FORBIDDEN unless `viewer` may change the photo; answers the current file id. */
  async function assertCanWrite(type: PhotoEntityType, id: string, viewer: DemoUser): Promise<string | null> {
    if (type === 'user_photo') {
      // Security review A12 M2: resolved through the LIVE memberships (never the users view, which
      // also shows former members and owners), then the account-edit rule.
      enforce(userPhotoWrite(viewer, id));
      const u = await api.assertPhotoAccountReach(viewer, id);
      return u.photoFileId ?? null;
    }
    const s = await memberScope(id);
    if (!s) fail('NOT_FOUND');
    enforce(memberPhotoWrite(viewer, s.team, s.leaderIds));
    return s.member.photoFileId;
  }

  async function setPhoto(type: PhotoEntityType, id: string, fileId: string | null) {
    if (type === 'user_photo') await db.users.update(id, { photoFileId: fileId });
    else await db.members.update(id, { photoFileId: fileId });
  }

  /** Marks the previous file deleted and drops its bytes (the API deletes the object). */
  async function retire(fileId: string) {
    await db.files.update(fileId, { deletedAt: new Date().toISOString() });
    await db.objects.delete(fileId);
    const url = urls.get(fileId);
    if (url) {
      urls.delete(fileId);
      if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }
  }

  async function objectUrl(file: DemoFile): Promise<string> {
    const cached = urls.get(file.id);
    if (cached) return cached;
    let obj = await db.objects.get(file.id);
    if (!obj && file.placeholder?.portrait) {
      const img = await drawPortrait({ hue: file.placeholder.hue, variant: Number(file.placeholder.label) || 0 });
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

  async function liveFile(fileId: string | null | undefined): Promise<DemoFile | null> {
    if (!fileId) return null;
    const f = await db.files.get(fileId);
    return f && !f.deletedAt && f.status === 'READY' ? f : null;
  }

  async function readUrl(type: PhotoEntityType, id: string, viewer: DemoUser): Promise<PhotoUrlDto> {
    let fileId: string | null | undefined;
    if (type === 'user_photo') {
      const u = await db.users.get(id);
      if (!u || !userPhotoRead(viewer, u)) fail('NOT_FOUND');
      fileId = u.photoFileId;
    } else {
      const s = await memberScope(id);
      if (!s || !memberPhotoRead(viewer, s)) fail('NOT_FOUND');
      fileId = s.member.photoFileId;
    }
    const file = await liveFile(fileId);
    if (!file) fail('NOT_FOUND');
    const ttl = (await api.readSettings()).PRESIGNED_URL_TTL_SECONDS;
    return { url: await objectUrl(file), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async function remove(type: PhotoEntityType, id: string, viewer: DemoUser) {
    let old: string | null = null;
    await db.transaction('rw', [db.users, db.members, db.memberships, db.teams, db.teamSupervisors, db.files, db.objects, db.audit], async () => {
      const current = await assertCanWrite(type, id, viewer);
      if (!current) return;
      await setPhoto(type, id, null);
      old = current;
      await api.writeAudit({
        actorId: viewer.id,
        action: ACTIONS[type].removed,
        entityType: ACTIONS[type].entityType,
        entityId: id,
        before: { photoFileId: current },
        after: { photoFileId: null },
      });
    });
    if (old) await retire(old);
  }

  const photos: ApiClient['photos'] = {
    url: async (target) => {
      network();
      const viewer = await api.actor();
      if (target.kind === 'member' && !['teams.readAll', 'teams.readOwn', 'members.manage', 'violations.create'].some((p) => can(viewer, p as Permission))) {
        fail('FORBIDDEN');
      }
      const id = target.kind === 'me' ? viewer.id : target.id;
      return readUrl(entityTypeOf(target), id, viewer);
    },

    upload: async (target, blob, opts) => {
      const presigned = await api.files.presign({
        entityType: entityTypeOf(target),
        entityId: target.id,
        kind: 'PHOTO',
        contentType: blob.type as (typeof ALLOWED_IMAGE_TYPES)[number],
        sizeBytes: blob.size,
      });
      opts?.onProgress?.(0.3);
      await api.files.upload(presigned, blob);
      opts?.onProgress?.(1);
      await api.files.confirm(presigned.fileId);
      return { fileId: presigned.fileId };
    },

    remove: async (target) => {
      network();
      if (target.kind === 'me') {
        const viewer = await api.actor('profile.update');
        return remove('user_photo', viewer.id, viewer);
      }
      if (target.kind === 'user') {
        const viewer = await api.actor('users.manageRoles');
        return remove('user_photo', target.id, viewer);
      }
      const viewer = await api.actor();
      if (!can(viewer, 'members.manage') && !can(viewer, 'members.manageOwn')) fail('FORBIDDEN');
      return remove('member_photo', target.id, viewer);
    },
  };

  return {
    photos,

    async beforePresign(input, actor) {
      const fieldErrors: Record<string, string[]> = {};
      if (!input.entityId) fieldErrors.entityId = ['حدّد صاحب الصورة'];
      if (input.kind && input.kind !== 'PHOTO') fieldErrors.kind = ['نوع الملف: صورة شخصية'];
      if (Object.keys(fieldErrors).length) fail('VALIDATION_FAILED', { fieldErrors });
      if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType)) {
        throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 400);
      }
      if (input.sizeBytes > PHOTO_MAX_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413, { maxBytes: PHOTO_MAX_BYTES });
      await assertCanWrite(input.entityType as PhotoEntityType, input.entityId!, actor);
    },

    async afterConfirm(file, actor) {
      const id = file.entityId;
      if (!id) return;
      const type = file.entityType as PhotoEntityType;
      if (file.sizeBytes > PHOTO_MAX_BYTES || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)) {
        throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 400);
      }
      let old: string | null = null;
      await db.transaction('rw', [db.users, db.members, db.memberships, db.teams, db.teamSupervisors, db.files, db.objects, db.audit], async () => {
        const current = await assertCanWrite(type, id, actor);
        if (current === file.id) return;
        await setPhoto(type, id, file.id);
        if (file.kind !== 'PHOTO') await db.files.update(file.id, { kind: 'PHOTO' });
        old = current;
        await api.writeAudit({
          actorId: actor.id,
          action: ACTIONS[type].updated,
          entityType: ACTIONS[type].entityType,
          entityId: id,
          before: { photoFileId: current },
          after: { photoFileId: file.id },
        });
      });
      if (old) await retire(old);
    },

    async urlForFile(fileId) {
      const file = await liveFile(fileId);
      if (!file) return null;
      try {
        return await objectUrl(file);
      } catch {
        return null;
      }
    },
  };
}
