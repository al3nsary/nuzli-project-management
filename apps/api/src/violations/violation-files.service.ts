import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { File as FileRow, Prisma } from '@prisma/client';
import { ALLOWED_IMAGE_TYPES, can, type PresignUploadInput } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { FilesService, type FileEntityHook } from '../storage/files.service';
import { StorageService } from '../storage/storage.service';

export const ID_CARD_LIMIT = 1;
const RETENTION_BATCH = 500;
const RETENTION_MAX_BATCHES = 200;

type Kind = 'ID_CARD' | 'EVIDENCE';

/**
 * Violation photos through the generic presign → PUT → confirm flow (brief §7.2, §7.4):
 *  - only the recorder (or someone with `violations.manage`) may upload, images only;
 *  - at most one ID-card photo and `VIOLATION_MAX_PHOTOS` evidence photos (`TOO_MANY_PHOTOS`);
 *  - confirm links the file to the violation (`violation_files`) idempotently, under a row
 *    lock on the violation so two concurrent confirms cannot exceed the limit.
 * Plus the retention job for `VIOLATION_PHOTO_RETENTION_DAYS` (brief §13).
 */
@Injectable()
export class ViolationFilesService implements FileEntityHook, OnModuleInit {
  private readonly logger = new Logger(ViolationFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.files.registerHook('violation', this);
  }

  async limitFor(kind: Kind): Promise<number> {
    return kind === 'ID_CARD' ? ID_CARD_LIMIT : this.settings.get('VIOLATION_MAX_PHOTOS');
  }

  private async violationFor(id: string, user: AuthUser) {
    const v = await this.prisma.violation.findUnique({ where: { id }, select: { id: true, recordedById: true } });
    // Someone else's violation answers 404, like every other out-of-scope read.
    if (!v || (v.recordedById !== user.id && !can(user, 'violations.manage'))) throw new AppError('NOT_FOUND');
    return v;
  }

  async beforePresign(input: PresignUploadInput, user: AuthUser): Promise<void> {
    const fieldErrors: Record<string, string[]> = {};
    if (!input.entityId) fieldErrors.entityId = ['حدّد المخالفة التي تتبع لها الصورة'];
    if (input.kind !== 'ID_CARD' && input.kind !== 'EVIDENCE') fieldErrors.kind = ['نوع الصورة: بطاقة الهوية أو صورة المخالفة'];
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType)) throw new AppError('FILE_TYPE_NOT_ALLOWED');
    const v = await this.violationFor(input.entityId!, user);
    const kind = input.kind as Kind;
    const limit = await this.limitFor(kind);
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    // Linked files plus uploads still in flight (URL not expired yet). An abandoned PENDING
    // upload stops counting once its URL expired, so an offline retry is never locked out.
    const [linked, inFlight] = await Promise.all([
      this.prisma.violationFile.count({ where: { violationId: v.id, kind, file: { deletedAt: null } } }),
      this.prisma.file.count({
        where: {
          entityType: 'violation',
          entityId: v.id,
          kind,
          status: 'PENDING',
          deletedAt: null,
          createdAt: { gt: new Date(Date.now() - ttl * 1000) },
        },
      }),
    ]);
    if (linked + inFlight >= limit) throw new AppError('TOO_MANY_PHOTOS', { kind, limit });
  }

  async onConfirmed(file: FileRow, user: AuthUser): Promise<void> {
    if (!file.entityId || (file.kind !== 'ID_CARD' && file.kind !== 'EVIDENCE')) return;
    const kind = file.kind as Kind;
    const violationId = file.entityId;
    await this.violationFor(violationId, user);
    const limit = await this.limitFor(kind);
    await this.prisma.$transaction(async (tx) => {
      // Serialises confirms of the same violation (READ COMMITTED + row lock, like ADR-030).
      await tx.$queryRaw`SELECT id FROM violations WHERE id = ${violationId}::uuid FOR UPDATE`;
      const existing = await tx.violationFile.findUnique({ where: { fileId: file.id }, select: { id: true } });
      if (existing) return;
      const count = await tx.violationFile.count({ where: { violationId, kind, file: { deletedAt: null } } });
      if (count >= limit) throw new AppError('TOO_MANY_PHOTOS', { kind, limit });
      await tx.violationFile.create({ data: { violationId, fileId: file.id, kind } });
    });
  }

  // ─────────────────────────────────────────── retention (brief §13)

  /**
   * Daily at 03:15 Riyadh time. With `VIOLATION_PHOTO_RETENTION_DAYS = 0` (default) photos are
   * kept. Otherwise every violation photo whose violation was captured before the cut-off
   * (or, for an unlinked upload, created before it) is deleted from the bucket and its `files`
   * row is marked deleted; the `violation_files` link stays, so the detail shows "removed".
   * One audit entry per run (system actor).
   */
  @Cron('0 15 3 * * *', { name: 'violation-photo-retention', timeZone: 'Asia/Riyadh' })
  async purgeExpiredPhotos(now = new Date()): Promise<number> {
    const days = await this.settings.get('VIOLATION_PHOTO_RETENTION_DAYS');
    if (!days || days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const where: Prisma.FileWhereInput = {
      entityType: 'violation',
      deletedAt: null,
      OR: [
        { violationFile: { is: { violation: { capturedAt: { lt: cutoff } } } } },
        { violationFile: { is: null }, createdAt: { lt: cutoff } },
      ],
    };
    let removed = 0;
    let failed = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      const rows = await this.prisma.file.findMany({
        where,
        select: { id: true, storageKey: true },
        orderBy: { createdAt: 'asc' },
        take: RETENTION_BATCH,
        // Rows that failed stay undeleted; skip past them instead of retrying them forever.
        skip: failed,
      });
      if (!rows.length) break;
      for (const f of rows) {
        try {
          await this.storage.delete(f.storageKey);
          await this.prisma.file.update({ where: { id: f.id }, data: { deletedAt: now } });
          removed++;
        } catch (err) {
          failed++;
          this.logger.warn(`Retention: could not delete file ${f.id}: ${(err as Error).message}`);
        }
      }
      if (rows.length < RETENTION_BATCH) break;
    }
    if (removed || failed) {
      await this.audit.log({
        actorId: null,
        action: AuditAction.VIOLATION_PHOTOS_PURGED,
        entityType: 'violation_file',
        after: { removed, failed, retentionDays: days, cutoff: cutoff.toISOString() },
      });
      this.logger.log(`Retention removed ${removed} violation photos (${failed} failed)`);
    }
    return removed;
  }
}
