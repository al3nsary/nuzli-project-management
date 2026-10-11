import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MAX_UPLOAD_BYTES, type PresignedUpload, type PresignUploadInput } from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { sha256Hex } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { canReadFile, canUpload, ENTITY_FOLDERS } from './file-policy';
import { detectFileType, EXTENSIONS, MAGIC_PROBE_BYTES, type DetectedType } from './magic-bytes';
import { StorageService } from './storage.service';

export const PENDING_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `violations/2026/10/<uuid>.jpg` — never a name or a national ID (brief §3.2). */
export function buildObjectKey(folder: string, contentType: DetectedType, id: string, at = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${folder}/${yyyy}/${mm}/${id}.${EXTENSIONS[contentType]}`;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: register a PENDING file and hand out a short-lived PUT URL. */
  async presign(input: PresignUploadInput, user: AuthUser): Promise<PresignedUpload> {
    if (!canUpload(user, input.entityType, input.kind)) throw new AppError('FORBIDDEN');
    const id = randomUUID();
    const key = buildObjectKey(ENTITY_FOLDERS[input.entityType], input.contentType, id);
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

  /** Step 2: HEAD + size + magic bytes (+ sha256 when declared) → READY, else delete. */
  async confirm(id: string, user: AuthUser): Promise<{ id: string; status: 'READY' }> {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file || file.deletedAt || file.uploadedById !== user.id) throw new AppError('NOT_FOUND');
    if (file.status === 'READY') return { id, status: 'READY' };

    const head = await this.storage.head(file.storageKey);
    if (!head.exists) throw new AppError('FILE_NOT_UPLOADED');

    const reject = async (code: 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED' | 'FILE_NOT_UPLOADED') => {
      await this.storage.delete(file.storageKey).catch(() => undefined);
      await this.prisma.file.update({ where: { id }, data: { deletedAt: new Date() } });
      throw new AppError(code);
    };

    if (head.size > MAX_UPLOAD_BYTES || head.size > file.sizeBytes) await reject('FILE_TOO_LARGE');
    if (head.size !== file.sizeBytes) await reject('FILE_NOT_UPLOADED');

    const probe = await this.storage.readRange(file.storageKey, 0, MAGIC_PROBE_BYTES - 1);
    const detected = detectFileType(probe);
    if (!detected || detected !== file.mimeType) await reject('FILE_TYPE_NOT_ALLOWED');

    if (file.sha256) {
      const actual = sha256Hex(Buffer.from(await this.storage.readAll(file.storageKey)));
      if (actual !== file.sha256) await reject('FILE_NOT_UPLOADED');
    }

    await this.prisma.file.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'READY' } });
    return { id, status: 'READY' };
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
}
