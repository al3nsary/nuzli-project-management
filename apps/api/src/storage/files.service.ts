import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MAX_IMPORT_BYTES, MAX_UPLOAD_BYTES, type PresignedUpload, type PresignUploadInput } from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { sha256Hex } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { File as FileRow } from '@prisma/client';
import { canReadFile, canUpload, ENTITY_FOLDERS, HOOKED_ENTITIES, type FileEntity } from './file-policy';
import { detectFileType, MAGIC_PROBE_BYTES, STORED_EXTENSIONS, verifyImportBytes, type ImportType, type StoredType } from './magic-bytes';
import { StorageService } from './storage.service';

export const PENDING_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** READY logos / user and member photos that nothing links to are removed after this (review L3, A8). */
export const ORPHAN_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Prefix of upload keys: the only keys that ever get a presigned PUT (review M1). */
export const PENDING_PREFIX = 'pending/';

/** `violations/2026/10/<uuid>.jpg` — never a name or a national ID (brief §3.2). */
export function buildObjectKey(folder: string, contentType: StoredType, id: string, at = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${folder}/${yyyy}/${mm}/${id}.${STORED_EXTENSIONS[contentType]}`;
}

/** `pending/<uuid>.jpg` — where the browser PUTs; copied to the final key on confirm. */
export function buildPendingKey(contentType: StoredType, id: string): string {
  return `${PENDING_PREFIX}${id}.${STORED_EXTENSIONS[contentType]}`;
}

/**
 * Entity-specific upload rules, registered by the module that owns the entity (violations
 * register theirs on start-up), so StorageModule never imports a feature module.
 */
export interface FileEntityHook {
  /** Runs before a PENDING row is created; throws an AppError to refuse the upload. */
  beforePresign(input: PresignUploadInput, user: AuthUser): Promise<void>;
  /**
   * Runs after the bytes were verified and the file is READY, and again on a repeated
   * confirm, so it must be idempotent. Throwing `TOO_MANY_PHOTOS` discards the upload.
   * `ctx` is the request context of the confirm call (for audit entries), when known.
   */
  onConfirmed(file: FileRow, user: AuthUser, ctx?: RequestContext): Promise<void>;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly hooks = new Map<FileEntity, FileEntityHook>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  registerHook(entity: FileEntity, hook: FileEntityHook): void {
    this.hooks.set(entity, hook);
  }

  /** Step 1: register a PENDING file and hand out a short-lived PUT URL. */
  async presign(input: PresignUploadInput, user: AuthUser): Promise<PresignedUpload> {
    if (!canUpload(user, input.entityType, input.kind, input.entityId)) throw new AppError('FORBIDDEN');
    const hook = this.hooks.get(input.entityType);
    if (!hook && HOOKED_ENTITIES.has(input.entityType)) throw new AppError('FORBIDDEN');
    await hook?.beforePresign(input, user);
    const id = randomUUID();
    const key = buildPendingKey(input.contentType, id);
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    await this.prisma.file.create({
      data: {
        id,
        storageKey: key,
        bucket: this.storage.bucket,
        mimeType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256 ?? null,
        status: 'PENDING',
        uploadedById: user.id,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        kind: input.kind ?? null,
      },
    });
    const url = await this.storage.presignPut(key, input.contentType, input.sizeBytes, ttl);
    return {
      fileId: id,
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  /**
   * Step 2 (security review M1, ADR-065): the upload is copied server-side from its `pending/`
   * key to the final key (`violations/yyyy/mm/<uuid>.jpg`), which never had a presigned PUT,
   * and the COPY is verified (HEAD + size + magic bytes + sha256). The pending object is then
   * deleted, so re-using the old PUT URL cannot change what was verified. The sha256 of the
   * final bytes is always recorded. Any failure deletes both objects.
   */
  async confirm(id: string, user: AuthUser, ctx?: RequestContext): Promise<{ id: string; status: 'READY' }> {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file || file.deletedAt || file.uploadedById !== user.id) throw new AppError('NOT_FOUND');
    const hook = this.hooks.get(file.entityType as FileEntity);
    if (file.status === 'READY') {
      // A retried confirm (e.g. the client lost the first answer) still links the file.
      await hook?.onConfirmed(file, user, ctx);
      return { id, status: 'READY' };
    }

    const pendingKey = file.storageKey;
    const head = await this.storage.head(pendingKey);
    if (!head.exists) throw new AppError('FILE_NOT_UPLOADED');
    // Cheap pre-checks on the pending object before copying anything.
    // A9 imports (ADR-110) may be up to 20 MB; every other upload up to 10 MB.
    const maxBytes = file.entityType === 'import' ? MAX_IMPORT_BYTES : MAX_UPLOAD_BYTES;
    if (head.size > maxBytes || head.size > file.sizeBytes) await this.reject(id, [pendingKey], 'FILE_TOO_LARGE');

    const finalKey = buildObjectKey(
      ENTITY_FOLDERS[file.entityType as FileEntity] ?? 'files',
      file.mimeType as StoredType,
      file.id,
      file.createdAt,
    );
    try {
      await this.storage.copy(pendingKey, finalKey);
    } catch (err) {
      // A concurrent confirm may have finished first and removed the pending object.
      const again = await this.prisma.file.findUnique({ where: { id } });
      if (again?.status === 'READY' && !again.deletedAt) {
        await hook?.onConfirmed(again, user, ctx);
        return { id, status: 'READY' };
      }
      throw err;
    }
    const both = [finalKey, pendingKey];

    // Everything below reads the FINAL object: a PUT to the old URL cannot reach it.
    const final = await this.storage.head(finalKey);
    if (!final.exists) await this.reject(id, both, 'FILE_NOT_UPLOADED');
    if (final.size > maxBytes || final.size > file.sizeBytes) await this.reject(id, both, 'FILE_TOO_LARGE');
    if (final.size !== file.sizeBytes) await this.reject(id, both, 'FILE_NOT_UPLOADED');

    const bytes = Buffer.from(await this.storage.readAll(finalKey));
    if (file.entityType === 'import') {
      // Spreadsheets, CSV, XML and .mpp have no single magic number: check their structure.
      if (!verifyImportBytes(bytes, file.mimeType as ImportType)) await this.reject(id, both, 'FILE_TYPE_NOT_ALLOWED');
    } else {
      const detected = detectFileType(bytes.subarray(0, MAGIC_PROBE_BYTES));
      if (!detected || detected !== file.mimeType) await this.reject(id, both, 'FILE_TYPE_NOT_ALLOWED');
    }
    const actual = sha256Hex(bytes);
    if (file.sha256 && actual !== file.sha256) await this.reject(id, both, 'FILE_NOT_UPLOADED');

    await this.storage.delete(pendingKey).catch((err: unknown) =>
      this.logger.warn(`Could not delete pending object of file ${id}: ${(err as Error).message}`),
    );
    const updated = await this.prisma.file.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'READY', storageKey: finalKey, sha256: actual },
    });
    if (updated.count !== 1) {
      // Lost a race with another confirm of the same file: keep the winner's state.
      const again = await this.prisma.file.findUnique({ where: { id } });
      if (again?.status === 'READY' && !again.deletedAt) {
        await hook?.onConfirmed(again, user, ctx);
        return { id, status: 'READY' };
      }
      throw new AppError('FILE_NOT_UPLOADED');
    }
    if (hook) {
      try {
        await hook.onConfirmed({ ...file, status: 'READY', storageKey: finalKey, sha256: actual }, user, ctx);
      } catch (err) {
        if (err instanceof AppError && err.code === 'TOO_MANY_PHOTOS') {
          await this.storage.delete(finalKey).catch(() => undefined);
          await this.prisma.file.update({ where: { id }, data: { deletedAt: new Date() } });
        }
        throw err;
      }
    }
    return { id, status: 'READY' };
  }

  /** Deletes the objects, marks the row deleted and throws `code`. */
  private async reject(
    id: string,
    keys: string[],
    code: 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED' | 'FILE_NOT_UPLOADED',
  ): Promise<never> {
    for (const key of keys) await this.storage.delete(key).catch(() => undefined);
    await this.prisma.file.update({ where: { id }, data: { deletedAt: new Date() } });
    throw new AppError(code);
  }

  /** Short-lived GET URL after a permission check. ID-card photo views are audited (§13). */
  async getUrl(id: string, user: AuthUser, ctx: RequestContext): Promise<{ url: string; expiresAt: string }> {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file || file.deletedAt || file.status !== 'READY') throw new AppError('NOT_FOUND');
    if (!canReadFile(user, file)) throw new AppError('FORBIDDEN');
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.presignGet(file.storageKey, ttl);
    if (file.kind === 'ID_CARD') {
      await this.audit.logCtx(ctx, {
        action: AuditAction.ID_CARD_URL_ISSUED,
        entityType: 'file',
        entityId: file.id,
        after: { entityType: file.entityType, entityId: file.entityId, ttlSeconds: ttl },
      });
    }
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Unconfirmed uploads older than 24 h are removed from the bucket (ADR-012). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'files-cleanup' })
  async cleanupPending(now = new Date()): Promise<number> {
    const stale = await this.prisma.file.findMany({
      where: {
        status: 'PENDING',
        deletedAt: null,
        createdAt: { lt: new Date(now.getTime() - PENDING_FILE_MAX_AGE_MS) },
      },
      select: { id: true, storageKey: true },
      take: 500,
    });
    let removed = 0;
    for (const f of stale) {
      try {
        await this.storage.delete(f.storageKey);
        await this.prisma.file.update({ where: { id: f.id }, data: { deletedAt: now } });
        removed++;
      } catch (err) {
        this.logger.warn(`Cleanup failed for file ${f.id}: ${(err as Error).message}`);
      }
    }
    if (removed) this.logger.log(`Removed ${removed} unconfirmed uploads`);
    return removed;
  }

  /**
   * Security review L3: confirmed logos and member photos that nothing links to after 24 h
   * (an upload whose `POST /logos` never came) are deleted. Owner request A8: the same for user
   * photos — a photo whose confirm was refused (scope changed) or that lost a replace race.
   * Violation and task files are linked by their hooks at confirm time.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'files-orphans' })
  async cleanupOrphans(now = new Date()): Promise<number> {
    const stale = await this.prisma.file.findMany({
      where: {
        status: 'READY',
        deletedAt: null,
        createdAt: { lt: new Date(now.getTime() - ORPHAN_FILE_MAX_AGE_MS) },
        OR: [
          { entityType: 'logo', logo: { is: null } },
          { entityType: 'member_photo', memberPhotos: { none: {} } },
          { entityType: 'user_photo', userPhotos: { none: {} } },
          // A9 imports: a preview lives one hour; the upload is never needed after a day.
          { entityType: 'import' },
        ],
      },
      select: { id: true, storageKey: true },
      take: 500,
    });
    let removed = 0;
    for (const f of stale) {
      try {
        await this.storage.delete(f.storageKey);
        await this.prisma.file.update({ where: { id: f.id }, data: { deletedAt: now } });
        removed++;
      } catch (err) {
        this.logger.warn(`Orphan cleanup failed for file ${f.id}: ${(err as Error).message}`);
      }
    }
    if (removed) this.logger.log(`Removed ${removed} unlinked logo/photo files`);
    return removed;
  }
}
