import { Injectable, OnModuleInit } from '@nestjs/common';
import type { File as FileRow } from '@prisma/client';
import {
  can,
  type ActivityDto,
  type CommentReadDto,
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
import { activeWorkspaceId } from '../prisma/workspace-context';
import { adminsOf, supervisorsOf } from '../users/user-dto';
import { mayActOnTask, mayWorkOnTask } from '../access/access-context';

type Viewer = PermissionSubject & { id: string; fullName?: string };
type CommentInput = z.output<typeof taskCommentSchema>;

export const ACTIVITY_LIMIT = 200;

const COMMENT_SELECT = {
  id: true,
  body: true,
  mentions: true,
  createdAt: true,
  author: { select: { id: true, fullName: true } },
  replyTo: { select: { id: true, body: true, author: { select: { fullName: true } } } },
} as const;

/** First characters of a comment for quotes and the hub (whitespace collapsed). */
export function preview(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Notification / e-mail preview: a 10-digit number starting with 1 or 2 (a national ID or
 * Iqama, Western or Arabic-Indic digits) is masked, since payloads and e-mails must never carry
 * national IDs (brief §13).
 */
export function notificationPreview(body: string): string {
  return preview(body, 120).replace(/(?<![0-9٠-٩])[12١٢][0-9٠-٩]{9}(?![0-9٠-٩])/g, '••••••••••');
}

type CommentRow = {
  id: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  author: { id: string; fullName: string };
  replyTo?: { id: string; body: string; author: { fullName: string } } | null;
};

function toCommentDto(r: CommentRow): TaskCommentDto {
  return {
    id: r.id,
    author: r.author,
    body: r.body,
    mentions: r.mentions,
    createdAt: r.createdAt.toISOString(),
    replyTo: r.replyTo ? { id: r.replyTo.id, authorName: r.replyTo.author.fullName, bodyPreview: preview(r.replyTo.body, 120) } : null,
  };
}

/**
 * Comments with @mentions (a flat, chat-style thread with optional quotes), the per-task
 * activity (read from the audit log) and attachments through the generic presign → PUT →
 * confirm flow with `entityType: 'task'` (brief §6.1 "Collaboration"). Since A9 (ADR-092) a
 * supervisor reaches all of it only for tasks assigned to them; admins for every task.
 * Comments need `tasks.comment`; uploads are for admins (`tasks.manage`) and the assignee.
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
    const rows = await this.prisma.taskComment.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' }, select: COMMENT_SELECT });
    return rows.map(toCommentDto);
  }

  /**
   * Users who can open the task and so may be mentioned (A9, ADR-092): active admins and the
   * task's assignee (an active supervisor). A12 round 2: also the project's participants and the
   * supervisors of the assignee's team(s) — everyone else would get a link they cannot open.
   */
  async mentionable(task: { assigneeId: string | null; projectId?: string }, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const ws = activeWorkspaceId();
    const peers = task.assigneeId
      ? await this.prisma.teamSupervisor.findMany({
          where: { validTo: null, team: { status: { not: 'ARCHIVED' }, supervisors: { some: { userId: task.assigneeId, validTo: null } } } },
          select: { userId: true },
        })
      : [];
    const participants = task.projectId
      ? await this.prisma.projectParticipant.findMany({ where: { projectId: task.projectId }, select: { userId: true } })
      : [];
    const rows = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        status: 'ACTIVE',
        // A12: the workspace's admins (and owners), and the assignee if a supervisor here.
        OR: [
          adminsOf(ws),
          ...(task.assigneeId ? [{ id: { in: [task.assigneeId, ...peers.map((p) => p.userId)] }, ...supervisorsOf(ws) }] : []),
          ...(participants.length ? [{ id: { in: participants.map((p) => p.userId) }, memberships: { some: { workspaceId: ws, archivedAt: null, status: 'ACTIVE' as const } } }] : []),
        ],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async addComment(taskId: string, input: CommentInput, viewer: Viewer, ctx: RequestContext): Promise<TaskCommentDto> {
    const task = await this.store.visibleTask(taskId, viewer);
    if (task.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    // A12 round 2: a viewer participant (مطّلع) reads only; the team's supervisors may reply.
    if (!mayActOnTask(viewer, task)) throw new AppError('FORBIDDEN');
    const mentions = [...new Set(input.mentions)];
    const allowed = await this.mentionable(task, mentions);
    const invalid = mentions.filter((m) => !allowed.has(m));
    if (invalid.length) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { mentions: ['يمكن الإشارة فقط إلى من يستطيع فتح هذه المهمة'] },
        userIds: invalid,
      });
    }
    const replyToId = input.replyToId ?? null;
    if (replyToId) {
      const quoted = await this.prisma.taskComment.findFirst({ where: { id: replyToId, taskId }, select: { id: true } });
      if (!quoted) throw new AppError('COMMENT_REPLY_INVALID');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.taskComment.create({
        data: { taskId, authorId: viewer.id, body: input.body, mentions, replyToId },
        select: COMMENT_SELECT,
      });
      // The author has read the thread up to their own comment.
      await tx.taskCommentRead.upsert({
        where: { userId_taskId: { userId: viewer.id, taskId } },
        create: { userId: viewer.id, taskId, lastReadAt: created.createdAt },
        update: { lastReadAt: created.createdAt },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.TASK_COMMENT_ADDED,
          entityType: 'task',
          entityId: taskId,
          after: { commentId: created.id, length: input.body.length, mentions: mentions.length, ...(replyToId ? { replyToId } : {}) },
        },
        tx,
      );
      return created;
    });
    const payload = {
      taskId,
      taskName: task.name,
      projectId: task.projectId,
      projectName: task.project.name,
      commentId: row.id,
      authorName: row.author.fullName,
      preview: notificationPreview(row.body),
    };
    const mentioned = mentions.filter((m) => m !== viewer.id);
    if (mentioned.length) this.notifications.safe(this.notifications.notify(mentioned, 'TASK_MENTIONED', payload));
    const followers = (await this.followers(task, viewer.id)).filter((u) => !mentioned.includes(u));
    if (followers.length) this.notifications.safe(this.notifications.notify(followers, 'TASK_COMMENTED', payload));
    return toCommentDto(row);
  }

  /**
   * A9 `TASK_COMMENTED` recipients: the assignee and everyone who commented before, minus the
   * author, limited to people who can still open the task (active admins, the assignee).
   */
  async followers(task: { id: string; assigneeId: string | null }, authorId: string): Promise<string[]> {
    const earlier = await this.prisma.taskComment.findMany({ where: { taskId: task.id }, select: { authorId: true }, distinct: ['authorId'] });
    const candidates = [...new Set([...(task.assigneeId ? [task.assigneeId] : []), ...earlier.map((c) => c.authorId)])].filter((u) => u !== authorId);
    if (!candidates.length) return [];
    return [...(await this.mentionable(task, candidates))];
  }

  /** `POST /tasks/:id/comments/read` — the viewer read the thread up to now. */
  async markRead(taskId: string, viewer: Viewer, now: Date = new Date()): Promise<CommentReadDto> {
    await this.store.visibleTask(taskId, viewer);
    const row = await this.prisma.taskCommentRead.upsert({
      where: { userId_taskId: { userId: viewer.id, taskId } },
      create: { userId: viewer.id, taskId, lastReadAt: now },
      update: { lastReadAt: now },
    });
    return { taskId, lastReadAt: row.lastReadAt.toISOString() };
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
    // A12 round 2: admins/editors, the assignee, or a contributor of the project.
    if (!mayWorkOnTask(user, task)) throw new AppError('FORBIDDEN');
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
