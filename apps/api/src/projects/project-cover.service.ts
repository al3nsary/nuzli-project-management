import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { File as FileRow } from '@prisma/client';
import { ALLOWED_IMAGE_TYPES, can, PROJECT_COVER_MAX_BYTES, type PermissionSubject, type PresignUploadInput } from '@nuzli/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { SettingsService } from '../settings/settings.service';
import { FilesService } from '../storage/files.service';
import { StorageService } from '../storage/storage.service';
import { ProjectStore } from './project-store';

type Viewer = PermissionSubject & { id: string };

export const CoverAction = { UPDATED: 'project.cover_updated', REMOVED: 'project.cover_removed' } as const;

function ctxOf(user: AuthUser, ctx?: RequestContext): RequestContext {
  return ctx ?? { actorId: user.id, ip: null, requestId: null, userAgent: null };
}

/**
 * A12 round 2 — the optional project cover image (mobile project cards):
 *  - upload through the generic flow: `POST /files/presign { entityType: 'project_cover',
 *    entityId: projectId, contentType: image/jpeg|png|webp, sizeBytes ≤ 3 MB }` → PUT → confirm;
 *    the confirm links it (projects.cover_file_id) under a row lock and drops the previous one;
 *  - who: admins and assistants with projects:edit (`projects.manage`), on a project they see;
 *  - `GET /projects/:id/cover-url`: anyone who sees the project; `DELETE /projects/:id/cover`;
 *  - without a cover the web draws the generated one in `ProjectDto.color`.
 */
@Injectable()
export class ProjectCoverService implements OnModuleInit {
  private readonly logger = new Logger(ProjectCoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.files.registerHook('project_cover', {
      beforePresign: (input, user) => this.beforePresign(input, user),
      onConfirmed: (file, user, ctx) => this.onConfirmed(file, user, ctx),
    });
  }

  private async writableProject(id: string, viewer: Viewer) {
    const p = await this.store.visibleProject(id, viewer);
    if (!can(viewer, 'projects.manage')) throw new AppError('FORBIDDEN');
    if (p.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    return p;
  }

  async beforePresign(input: PresignUploadInput, user: AuthUser): Promise<void> {
    if (!input.entityId) throw new AppError('VALIDATION_FAILED', { fieldErrors: { entityId: ['حدّد المشروع'] } });
    if (input.kind && input.kind !== 'PHOTO') throw new AppError('VALIDATION_FAILED', { fieldErrors: { kind: ['نوع الملف: صورة غلاف'] } });
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType)) throw new AppError('FILE_TYPE_NOT_ALLOWED');
    if (input.sizeBytes > PROJECT_COVER_MAX_BYTES) throw new AppError('FILE_TOO_LARGE', { maxBytes: PROJECT_COVER_MAX_BYTES });
    await this.writableProject(input.entityId, user);
  }

  /** Links a verified upload (idempotent). A refused link leaves an orphan the cleanup job removes. */
  async onConfirmed(file: FileRow, user: AuthUser, ctx?: RequestContext): Promise<void> {
    const id = file.entityId;
    if (!id) return;
    if (file.sizeBytes > PROJECT_COVER_MAX_BYTES || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED');
    }
    const oldKey = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${id}::uuid AND workspace_id = ${activeWorkspaceId()}::uuid FOR UPDATE`;
      const p = await this.store.visibleProject(id, user, tx);
      if (!can(user, 'projects.manage')) throw new AppError('FORBIDDEN');
      const current = await tx.project.findUniqueOrThrow({ where: { id }, select: { coverFileId: true } });
      if (current.coverFileId === file.id) return null;
      await tx.project.update({ where: { id }, data: { coverFileId: file.id } });
      let previousKey: string | null = null;
      if (current.coverFileId) {
        const prev = await tx.file.update({ where: { id: current.coverFileId }, data: { deletedAt: new Date() }, select: { storageKey: true } });
        previousKey = prev.storageKey;
      }
      await this.audit.logCtx(
        ctxOf(user, ctx),
        { action: CoverAction.UPDATED, entityType: 'project', entityId: p.id, before: { fileId: current.coverFileId }, after: { fileId: file.id } },
        tx,
      );
      return previousKey;
    });
    if (oldKey) await this.storage.delete(oldKey).catch((err: unknown) => this.logger.warn(`Old cover not deleted: ${(err as Error).message}`));
  }

  async url(projectId: string, viewer: Viewer): Promise<{ url: string; expiresAt: string }> {
    await this.store.visibleProject(projectId, viewer);
    const p = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { coverFileId: true } });
    if (!p.coverFileId) throw new AppError('NOT_FOUND');
    const file = await this.prisma.file.findFirst({ where: { id: p.coverFileId, status: 'READY', deletedAt: null }, select: { storageKey: true } });
    if (!file) throw new AppError('NOT_FOUND');
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    return { url: await this.storage.presignGet(file.storageKey, ttl), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async remove(projectId: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.writableProject(projectId, viewer);
    const key = await this.prisma.$transaction(async (tx) => {
      const p = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { coverFileId: true } });
      if (!p.coverFileId) return null;
      await tx.project.update({ where: { id: projectId }, data: { coverFileId: null } });
      const f = await tx.file.update({ where: { id: p.coverFileId }, data: { deletedAt: new Date() }, select: { storageKey: true } });
      await this.audit.logCtx(ctx, { action: CoverAction.REMOVED, entityType: 'project', entityId: projectId, before: { fileId: p.coverFileId } }, tx);
      return f.storageKey;
    });
    if (key) await this.storage.delete(key).catch(() => undefined);
  }
}
