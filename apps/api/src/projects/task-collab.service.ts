import { Injectable, OnModuleInit } from '@nestjs/common';
import type { File as FileRow } from '@prisma/client';
import {
  can,
  type ActivityDto,
  type PermissionSubject,
  type PresignUploadInput,
  type TaskAttachmentDto,
  type TaskCommentDto,
  type taskCommentSchema,
} from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { FilesService, type FileEntityHook } from '../storage/files.service';
import { StorageService } from '../storage/storage.service';
import { ProjectStore } from './project-store';

type Viewer = PermissionSubject & { id: string; fullName?: string };
type CommentInput = z.output<typeof taskCommentSchema>;

export const ACTIVITY_LIMIT = 200;

/**
 * Comments with @mentions, the per-task activity (read from the audit log) and attachments
 * through the generic presign → PUT → confirm flow with `entityType: 'task'` (brief §6.1
 * "Collaboration"). Everyone who can see the project reads; comments need `tasks.comment`;
 * uploads are for admins (`tasks.manage`) and the task's assignee.
 */
@Injectable()
export class TaskCollabService implements FileEntityHook, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.files.registerHook('task', this);
  }

  // ─────────────────────────────────────────── comments

  async comments(taskId: string, viewer: Viewer): Promise<TaskCommentDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, body: true, mentions: true, createdAt: true, author: { select: { id: true, fullName: true } } },
    });
    return rows.map((r) => ({ id: r.id, author: r.author, body: r.body, mentions: r.mentions, createdAt: r.createdAt.toISOString() }));
  }

  /** Users who may be mentioned: active admins, and supervisors who can see the project. */
  async mentionable(projectId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        status: 'ACTIVE',
        OR: [
          { role: 'ADMIN' },
          {
            role: 'SUPERVISOR',
            OR: [
              { projectAccess: { some: { projectId } } },
              { assignedTasks: { some: { projectId, archivedAt: null } } },
            ],
          },
        ],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async addComment(taskId: string, input: CommentInput, viewer: Viewer, ctx: RequestContext): Promise<TaskCommentDto> {
    const task = await this.store.visibleTask(taskId, viewer);
    if (task.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    const mentions = [...new Set(input.mentions)];
    const allowed = await this.mentionable(task.projectId, mentions);
    const invalid = mentions.filter((m) => !allowed.has(m));
    if (invalid.length) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { mentions: ['يمكن الإشارة فقط إلى من يملك صلاحية الوصول إلى المشروع'] },
        userIds: invalid,
      });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.taskComment.create({
        data: { taskId, authorId: viewer.id, body: input.body, mentions },
        select: { id: true, body: true, mentions: true, createdAt: true, author: { select: { id: true, fullName: true } } },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TASK_COMMENT_ADDED,
          entityType: 'task',
          entityId: taskId,
          after: { commentId: created.id, length: input.body.length, mentions: mentions.length },
        },
        tx,
      );
      return created;
    });
    const notify = mentions.filter((m) => m !== viewer.id);
    if (notify.length) {
      this.notifications.safe(
        this.notifications.notify(notify, 'TASK_MENTIONED', {
          taskId,
          taskName: task.name,
          projectId: task.projectId,
          projectName: task.project.name,
          commentId: row.id,
          authorName: row.author.fullName,
        }),
      );
    }
    return { id: row.id, author: row.author, body: row.body, mentions: row.mentions, createdAt: row.createdAt.toISOString() };
  }

  // ─────────────────────────────────────────── activity

  /** The task's own audit entries plus the dependency entries that name it, newest first. */
  async activity(taskId: string, viewer: Viewer): Promise<ActivityDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'task', entityId: taskId },
          { entityType: 'dependency', after: { path: ['predecessorId'], equals: taskId } },
          { entityType: 'dependency', after: { path: ['successorId'], equals: taskId } },
          { entityType: 'dependency', before: { path: ['predecessorId'], equals: taskId } },
          { entityType: 'dependency', before: { path: ['successorId'], equals: taskId } },
        ],
      },
      orderBy: { at: 'desc' },
      take: ACTIVITY_LIMIT,
      select: { id: true, action: true, at: true, before: true, after: true, actor: { select: { id: true, fullName: true } } },
    });
    return rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, at: r.at.toISOString(), before: r.before, after: r.after }));
  }

  // ─────────────────────────────────────────── attachments

  private async uploadableTask(taskId: string, user: AuthUser) {
    const task = await this.store.visibleTask(taskId, user);
    if (task.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    if (!can(user, 'tasks.manage') && task.assigneeId !== user.id) throw new AppError('FORBIDDEN');
    return task;
  }

  /** FileEntityHook: only admins and the assignee upload to a task they can see. */
  async beforePresign(input: PresignUploadInput, user: AuthUser): Promise<void> {
    if (!input.entityId) {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: { entityId: ['حدّد المهمة التي يتبع لها المرفق'] } });
    }
    if (input.kind && input.kind !== 'ATTACHMENT') {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: { kind: ['نوع الملف للمهمة: مرفق'] } });
    }
    await this.uploadableTask(input.entityId, user);
  }

  /** FileEntityHook: a confirmed upload is attached; audited once even if confirm repeats. */
  async onConfirmed(file: FileRow, user: AuthUser): Promise<void> {
    if (!file.entityId) return;
    await this.recordAttachment(file.entityId, file, user.id, null);
  }

  private async recordAttachment(taskId: string, file: Pick<FileRow, 'id' | 'mimeType' | 'sizeBytes'>, actorId: string, ctx: RequestContext | null) {
    const already = await this.prisma.auditLog.findFirst({
      where: { action: AuditAction.TASK_ATTACHMENT_ADDED, entityType: 'task', entityId: taskId, after: { path: ['fileId'], equals: file.id } },
      select: { id: true },
    });
    if (already) return;
    const entry = {
      action: AuditAction.TASK_ATTACHMENT_ADDED,
      entityType: 'task',
      entityId: taskId,
      after: { fileId: file.id, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
    };
    if (ctx) await this.audit.logCtx(ctx, entry);
    else await this.audit.log({ ...entry, actorId });
  }

  async attachments(taskId: string, viewer: Viewer): Promise<TaskAttachmentDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.file.findMany({
      where: { entityType: 'task', entityId: taskId, status: 'READY', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, mimeType: true, sizeBytes: true, uploadedById: true, createdAt: true },
    });
    const uploaderIds = [...new Set(rows.map((r) => r.uploadedById).filter((u): u is string => !!u))];
    const users = uploaderIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, fullName: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      uploadedBy: r.uploadedById ? (names.get(r.uploadedById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * `POST /tasks/:id/attachments { fileId }` — attaches a READY file the viewer uploaded with
   * `entityType: 'task'` (presigned with this task id, or without one). Idempotent.
   */
  async attach(taskId: string, fileId: string, viewer: AuthUser, ctx: RequestContext): Promise<TaskAttachmentDto> {
    await this.uploadableTask(taskId, viewer);
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt || file.uploadedById !== viewer.id || file.entityType !== 'task') throw new AppError('NOT_FOUND');
    if (file.status !== 'READY') throw new AppError('FILE_NOT_UPLOADED');
    if (file.entityId && file.entityId !== taskId) throw new AppError('NOT_FOUND');
    if (!file.entityId) await this.prisma.file.update({ where: { id: fileId }, data: { entityId: taskId, kind: 'ATTACHMENT' } });
    await this.recordAttachment(taskId, file, viewer.id, ctx);
    return {
      id: file.id,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      uploadedBy: { id: viewer.id, fullName: viewer.fullName },
      createdAt: file.createdAt.toISOString(),
    };
  }

  private async taskFile(taskId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, entityType: 'task', entityId: taskId, status: 'READY', deletedAt: null },
    });
    if (!file) throw new AppError('NOT_FOUND');
    return file;
  }

  /** Short-lived GET URL for anyone who can see the project (the generic route is narrower). */
  async attachmentUrl(taskId: string, fileId: string, viewer: Viewer): Promise<{ url: string; expiresAt: string }> {
    await this.store.visibleTask(taskId, viewer);
    const file = await this.taskFile(taskId, fileId);
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.presignGet(file.storageKey, ttl);
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Admins and the uploader remove an attachment (object deleted, row marked deleted). */
  async removeAttachment(taskId: string, fileId: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.store.visibleTask(taskId, viewer);
    const file = await this.taskFile(taskId, fileId);
    if (!can(viewer, 'tasks.manage') && file.uploadedById !== viewer.id) throw new AppError('FORBIDDEN');
    await this.storage.delete(file.storageKey).catch(() => undefined);
    await this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await this.audit.logCtx(ctx, {
      action: AuditAction.TASK_ATTACHMENT_REMOVED,
      entityType: 'task',
      entityId: taskId,
      before: { fileId, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
    });
  }
}
