import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { File as FileRow, Prisma } from '@prisma/client';
import {
  ALLOWED_IMAGE_TYPES,
  PHOTO_MAX_BYTES,
  type PhotoEntityType,
  type PhotoUrlDto,
  type PresignUploadInput,
} from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { FilesService } from '../storage/files.service';
import { StorageService } from '../storage/storage.service';
import {
  memberPhotoRead,
  memberPhotoWrite,
  userPhotoRead,
  userPhotoWrite,
  type Decision,
  type MemberPhotoScope,
  type Viewer,
} from './photo-policy';

type Db = Prisma.TransactionClient | PrismaService;

/** Cumulative cap of photo bytes inlined into one PDF request; beyond it a presigned URL is sent. */
export const PDF_INLINE_PHOTO_BUDGET = 40 * 1024 * 1024;

const ACTIONS = {
  user_photo: { updated: AuditAction.USER_PHOTO_UPDATED, removed: AuditAction.USER_PHOTO_REMOVED, entityType: 'user' },
  member_photo: { updated: AuditAction.MEMBER_PHOTO_UPDATED, removed: AuditAction.MEMBER_PHOTO_REMOVED, entityType: 'member' },
} as const;

function ctxOf(user: AuthUser, ctx?: RequestContext): RequestContext {
  return ctx ?? { actorId: user.id, ip: null, requestId: null, userAgent: null };
}

function enforce(decision: Decision): void {
  if (decision !== 'ALLOW') throw new AppError(decision);
}

/**
 * Personal photos (owner request A8, ADR-083) through the generic presign → PUT → confirm flow:
 *  - `entityType: 'user_photo'` (entityId = user id) and `'member_photo'` (entityId = member id);
 *    JPEG/PNG/WebP only, at most 2 MB, magic bytes verified by FilesService.confirm;
 *  - confirm links the file (users.photo_file_id / team_members.photo_file_id) under a row lock,
 *    marks the previous photo deleted, audits `*.photo_updated` with file ids only, and deletes
 *    the previous object after commit;
 *  - remove unlinks, audits `*.photo_removed` and deletes the object;
 *  - reads hand out short-lived presigned GETs after the scope check of photo-policy.ts.
 */
@Injectable()
export class PhotosService implements OnModuleInit {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    for (const type of ['user_photo', 'member_photo'] as const) {
      this.files.registerHook(type, {
        beforePresign: (input, user) => this.beforePresign(type, input, user),
        onConfirmed: (file, user, ctx) => this.onConfirmed(type, file, user, ctx),
      });
    }
  }

  // ─────────────────────────────────────────── scope

  private async memberScope(db: Db, id: string): Promise<(MemberPhotoScope & { photoFileId: string | null }) | null> {
    const m = await db.teamMember.findUnique({
      where: { id },
      select: {
        archivedAt: true,
        status: true,
        photoFileId: true,
        memberships: { where: { validTo: null }, take: 1, select: { team: { select: { supervisorId: true, status: true } } } },
      },
    });
    if (!m || m.archivedAt) return null;
    return { status: m.status, photoFileId: m.photoFileId, team: m.memberships[0]?.team ?? null };
  }

  /** Throws NOT_FOUND / FORBIDDEN unless `viewer` may change the photo; returns the current file id. */
  async assertCanWrite(type: PhotoEntityType, id: string, viewer: Viewer, db: Db = this.prisma): Promise<string | null> {
    if (type === 'user_photo') {
      const u = await db.user.findUnique({ where: { id }, select: { archivedAt: true, photoFileId: true } });
      if (!u || u.archivedAt) throw new AppError('NOT_FOUND');
      enforce(userPhotoWrite(viewer, id));
      return u.photoFileId;
    }
    const m = await this.memberScope(db, id);
    if (!m) throw new AppError('NOT_FOUND');
    enforce(memberPhotoWrite(viewer, m));
    return m.photoFileId;
  }

  // ─────────────────────────────────────────── upload hooks

  async beforePresign(type: PhotoEntityType, input: PresignUploadInput, user: AuthUser): Promise<void> {
    const fieldErrors: Record<string, string[]> = {};
    if (!input.entityId) fieldErrors.entityId = ['حدّد صاحب الصورة'];
    if (input.kind && input.kind !== 'PHOTO') fieldErrors.kind = ['نوع الملف: صورة شخصية'];
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType)) throw new AppError('FILE_TYPE_NOT_ALLOWED');
    if (input.sizeBytes > PHOTO_MAX_BYTES) throw new AppError('FILE_TOO_LARGE', { maxBytes: PHOTO_MAX_BYTES });
    await this.assertCanWrite(type, input.entityId!, user);
  }

  /**
   * Links a verified upload. Idempotent: a repeated confirm of the linked file changes nothing.
   * A refused confirm (the scope changed since presign) leaves the READY file unlinked; the
   * orphan job deletes it after 24 h.
   */
  async onConfirmed(type: PhotoEntityType, file: FileRow, user: AuthUser, ctx?: RequestContext): Promise<void> {
    const id = file.entityId;
    if (!id) return;
    if (file.sizeBytes > PHOTO_MAX_BYTES || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED');
    }
    const oldKey = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, type, id);
      const current = await this.assertCanWrite(type, id, user, tx);
      if (current === file.id) return null;
      await this.setPhoto(tx, type, id, file.id);
      if (file.kind !== 'PHOTO') await tx.file.update({ where: { id: file.id }, data: { kind: 'PHOTO' } });
      const old = current ? await this.retire(tx, current) : null;
      await this.audit.logCtx(
        ctxOf(user, ctx),
        {
          action: ACTIONS[type].updated,
          entityType: ACTIONS[type].entityType,
          entityId: id,
          before: { photoFileId: current },
          after: { photoFileId: file.id },
        },
        tx,
      );
      return old;
    });
    if (oldKey) await this.deleteObject(oldKey);
  }

  // ─────────────────────────────────────────── remove

  /** `DELETE /me/photo`, `/users/:id/photo`, `/members/:id/photo`. No photo → nothing to do. */
  async remove(type: PhotoEntityType, id: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    const oldKey = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, type, id);
      const current = await this.assertCanWrite(type, id, viewer, tx);
      if (!current) return null;
      await this.setPhoto(tx, type, id, null);
      const old = await this.retire(tx, current);
      await this.audit.logCtx(
        ctx,
        {
          action: ACTIONS[type].removed,
          entityType: ACTIONS[type].entityType,
          entityId: id,
          before: { photoFileId: current },
          after: { photoFileId: null },
        },
        tx,
      );
      return old;
    });
    if (oldKey) await this.deleteObject(oldKey);
  }

  // ─────────────────────────────────────────── read

  /** `GET /me/photo-url`, `/users/:id/photo-url`, `/members/:id/photo-url`. */
  async photoUrl(type: PhotoEntityType, id: string, viewer: Viewer): Promise<PhotoUrlDto> {
    const fileSelect = { select: { storageKey: true, status: true, deletedAt: true } } as const;
    let photo: { storageKey: string; status: string; deletedAt: Date | null } | null;
    if (type === 'user_photo') {
      const u = await this.prisma.user.findUnique({
        where: { id },
        select: { id: true, status: true, archivedAt: true, photo: fileSelect },
      });
      if (!u || u.archivedAt || !userPhotoRead(viewer, u)) throw new AppError('NOT_FOUND');
      photo = u.photo;
    } else {
      const m = await this.prisma.teamMember.findUnique({
        where: { id },
        select: {
          archivedAt: true,
          status: true,
          photo: fileSelect,
          memberships: { where: { validTo: null }, take: 1, select: { team: { select: { supervisorId: true, status: true } } } },
        },
      });
      if (!m || m.archivedAt || !memberPhotoRead(viewer, { status: m.status, team: m.memberships[0]?.team ?? null })) {
        throw new AppError('NOT_FOUND');
      }
      photo = m.photo;
    }
    if (!photo || photo.deletedAt || photo.status !== 'READY') throw new AppError('NOT_FOUND');
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.presignGet(photo.storageKey, ttl);
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /**
   * Presigned GETs for card photos (preview and print run), keyed by file id. Callers have
   * `cards.print` (admin) already; unknown, deleted or unready files are simply left out.
   */
  async presignMany(fileIds: Array<string | null | undefined>): Promise<Map<string, string>> {
    const ids = [...new Set(fileIds.filter((v): v is string => !!v))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.prisma.file.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'READY' },
      select: { id: true, storageKey: true },
    });
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    for (const r of rows) {
      try {
        out.set(r.id, await this.storage.presignGet(r.storageKey, ttl));
      } catch (err) {
        this.logger.warn(`Photo URL failed for file ${r.id}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Photos for the PDF service as `data:` URLs (the service may not reach the public bucket
   * endpoint). Above PDF_INLINE_PHOTO_BUDGET bytes the rest get presigned URLs instead.
   */
  async inlineMany(fileIds: Array<string | null | undefined>): Promise<Map<string, string>> {
    const ids = [...new Set(fileIds.filter((v): v is string => !!v))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.prisma.file.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'READY' },
      select: { id: true, storageKey: true, mimeType: true, sizeBytes: true },
    });
    let budget = PDF_INLINE_PHOTO_BUDGET;
    const overflow: string[] = [];
    for (const r of rows) {
      if (r.sizeBytes > budget) {
        overflow.push(r.id);
        continue;
      }
      try {
        const bytes = Buffer.from(await this.storage.readAll(r.storageKey));
        budget -= bytes.length;
        out.set(r.id, `data:${r.mimeType};base64,${bytes.toString('base64')}`);
      } catch (err) {
        this.logger.warn(`Photo bytes failed for file ${r.id}: ${(err as Error).message}`);
      }
    }
    if (overflow.length) for (const [k, v] of await this.presignMany(overflow)) out.set(k, v);
    return out;
  }

  // ─────────────────────────────────────────── helpers

  /** Serialises photo changes of one person (READ COMMITTED + row lock, like ADR-030). */
  private async lock(tx: Prisma.TransactionClient, type: PhotoEntityType, id: string): Promise<void> {
    if (type === 'user_photo') await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM team_members WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async setPhoto(tx: Prisma.TransactionClient, type: PhotoEntityType, id: string, fileId: string | null) {
    if (type === 'user_photo') await tx.user.update({ where: { id }, data: { photoFileId: fileId } });
    else await tx.teamMember.update({ where: { id }, data: { photoFileId: fileId } });
  }

  /** Marks a replaced/removed photo deleted; its object is removed after the commit. */
  private async retire(tx: Prisma.TransactionClient, fileId: string): Promise<string | null> {
    const old = await tx.file.findUnique({ where: { id: fileId }, select: { storageKey: true, deletedAt: true } });
    if (!old || old.deletedAt) return null;
    await tx.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    return old.storageKey;
  }

  private async deleteObject(key: string): Promise<void> {
    await this.storage.delete(key).catch((err: unknown) =>
      // The row is already marked deleted; a leftover object is unreachable (no URL is ever issued).
      this.logger.warn(`Could not delete a replaced photo object: ${(err as Error).message}`),
    );
  }
}
