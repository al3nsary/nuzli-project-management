import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  HUB_FILTERS,
  type AttachmentBrowseDto,
  type AttachmentKindGroup,
  type attachmentBrowseQuerySchema,
  type HubFilter,
  type HubItemDto,
  type HubPageDto,
  type hubQuerySchema,
  type Paginated,
  type PermissionSubject,
} from '@nuzli/shared';
import type { z } from 'zod';
import { paginate } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { taskScopeWhere } from './project-dto';
import { preview } from './task-collab.service';
import { addCalendarDaysIso } from './task-engine';

type Viewer = PermissionSubject & { id: string };
type HubQuery = z.output<typeof hubQuerySchema>;
type AttachmentQuery = z.output<typeof attachmentBrowseQuerySchema>;

export interface HubStat {
  taskId: string;
  assigneeId: string | null;
  createdById: string | null;
  commentCount: number;
  unreadCount: number;
  mentioned: boolean;
  lastAt: number;
  lastCommentId: string | null;
}

/**
 * Per-task hub figures from the comments and the viewer's read mark (pure; unit-tested):
 * unread = comments by others after `last_read_at` (all of them when never read).
 */
export function hubStats(
  tasks: ReadonlyArray<{ id: string; assigneeId: string | null; createdById: string | null }>,
  comments: ReadonlyArray<{ id: string; taskId: string; authorId: string; createdAt: Date; mentions: string[] }>,
  reads: ReadonlyMap<string, Date>,
  viewerId: string,
): HubStat[] {
  const stats = new Map<string, HubStat>(
    tasks.map((t) => [t.id, { taskId: t.id, assigneeId: t.assigneeId, createdById: t.createdById, commentCount: 0, unreadCount: 0, mentioned: false, lastAt: 0, lastCommentId: null }]),
  );
  for (const c of comments) {
    const s = stats.get(c.taskId);
    if (!s) continue;
    s.commentCount++;
    const at = c.createdAt.getTime();
    if (at >= s.lastAt) {
      s.lastAt = at;
      s.lastCommentId = c.id;
    }
    const read = reads.get(c.taskId);
    if (c.authorId !== viewerId && (!read || at > read.getTime())) s.unreadCount++;
    if (c.mentions.includes(viewerId)) s.mentioned = true;
  }
  return [...stats.values()].filter((s) => s.commentCount > 0);
}

export function matchesFilter(s: HubStat, filter: HubFilter, viewerId: string): boolean {
  switch (filter) {
    case 'new':
      return s.unreadCount > 0;
    case 'mentioned':
      return s.mentioned;
    case 'assigned':
      return s.assigneeId === viewerId;
    case 'created':
      return s.createdById === viewerId;
    default:
      return true;
  }
}

export function kindGroup(mimeType: string): AttachmentKindGroup {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

/** Start of a Riyadh calendar day as an instant. */
const riyadhStart = (iso: string): Date => new Date(`${iso}T00:00:00+03:00`);

/**
 * A9 communication hub (every comment thread the viewer can open, with unread counts and
 * filters) and the attachments browser. Supervisors see only tasks assigned to them
 * (`taskScopeWhere`, ADR-092); admins every task of non-template projects.
 */
@Injectable()
export class HubService {
  constructor(private readonly prisma: PrismaService) {}

  private scope(viewer: Viewer, extra: Prisma.TaskWhereInput): Prisma.TaskWhereInput {
    return { AND: [{ archivedAt: null, project: { isTemplate: false } }, taskScopeWhere(viewer), extra] };
  }

  async hub(viewer: Viewer, q: HubQuery): Promise<HubPageDto> {
    const term = q.q?.trim();
    const tasks = await this.prisma.task.findMany({
      where: this.scope(viewer, {
        comments: { some: {} },
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(term
          ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { comments: { some: { body: { contains: term, mode: 'insensitive' } } } }] }
          : {}),
      }),
      select: {
        id: true,
        name: true,
        wbsCache: true,
        type: true,
        status: true,
        parentId: true,
        assigneeId: true,
        createdById: true,
        assignee: { select: { id: true, fullName: true } },
        project: { select: { id: true, name: true } },
      },
    });
    const ids = tasks.map((t) => t.id);
    const [comments, reads] = ids.length
      ? await Promise.all([
          this.prisma.taskComment.findMany({ where: { taskId: { in: ids } }, select: { id: true, taskId: true, authorId: true, createdAt: true, mentions: true } }),
          this.prisma.taskCommentRead.findMany({ where: { userId: viewer.id, taskId: { in: ids } }, select: { taskId: true, lastReadAt: true } }),
        ])
      : [[], []];
    const readMap = new Map(reads.map((r) => [r.taskId, r.lastReadAt]));
    const stats = hubStats(tasks, comments, readMap, viewer.id);
    const counts = Object.fromEntries(HUB_FILTERS.map((f) => [f, stats.filter((s) => matchesFilter(s, f, viewer.id)).length])) as Record<HubFilter, number>;
    const unreadTotal = stats.reduce((n, s) => n + s.unreadCount, 0);
    const filtered = stats.filter((s) => matchesFilter(s, q.filter, viewer.id)).sort((a, b) => b.lastAt - a.lastAt || (a.taskId < b.taskId ? -1 : 1));
    const page = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const lastIds = page.map((s) => s.lastCommentId).filter((x): x is string => !!x);
    const [lasts, names] = await Promise.all([
      lastIds.length
        ? this.prisma.taskComment.findMany({ where: { id: { in: lastIds } }, select: { id: true, body: true, createdAt: true, author: { select: { id: true, fullName: true } } } })
        : Promise.resolve([]),
      this.ancestors(page.map((s) => byId.get(s.taskId)!.parentId).filter((p): p is string => !!p)),
    ]);
    const lastById = new Map(lasts.map((c) => [c.id, c]));
    const pathOf = (parentId: string | null): string[] => {
      const out: string[] = [];
      for (let cur = parentId, guard = 0; cur && guard < 100; guard++) {
        const n = names.get(cur);
        if (!n) break;
        out.unshift(n.name);
        cur = n.parentId;
      }
      return out;
    };
    const items: HubItemDto[] = page.map((s) => {
      const t = byId.get(s.taskId)!;
      const last = s.lastCommentId ? lastById.get(s.lastCommentId) : undefined;
      return {
        task: { id: t.id, name: t.name, wbs: t.wbsCache, type: t.type, status: t.status, assignee: t.assignee },
        project: t.project,
        path: pathOf(t.parentId),
        commentCount: s.commentCount,
        unreadCount: s.unreadCount,
        lastReadAt: readMap.get(t.id)?.toISOString() ?? null,
        lastComment: last ? { id: last.id, author: last.author, bodyPreview: preview(last.body), createdAt: last.createdAt.toISOString() } : null,
      };
    });
    return { items, total: filtered.length, page: q.page, pageSize: q.pageSize, counts, unreadTotal };
  }

  /** Names and parents of the given tasks and all their ancestors. */
  private async ancestors(start: string[]): Promise<Map<string, { name: string; parentId: string | null }>> {
    const out = new Map<string, { name: string; parentId: string | null }>();
    let todo = [...new Set(start)];
    for (let depth = 0; todo.length && depth < 50; depth++) {
      const rows = await this.prisma.task.findMany({ where: { id: { in: todo } }, select: { id: true, name: true, parentId: true } });
      for (const r of rows) out.set(r.id, { name: r.name, parentId: r.parentId });
      todo = [...new Set(rows.map((r) => r.parentId).filter((p): p is string => !!p && !out.has(p)))];
    }
    return out;
  }

  // ─────────────────────────────────────────── attachments browser

  async attachments(viewer: Viewer, q: AttachmentQuery): Promise<Paginated<AttachmentBrowseDto>> {
    const term = q.q?.trim();
    const tasks = await this.prisma.task.findMany({
      where: this.scope(viewer, {
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(term
          ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { project: { name: { contains: term, mode: 'insensitive' } } }] }
          : {}),
      }),
      select: { id: true, name: true, wbsCache: true, project: { select: { id: true, name: true } } },
    });
    if (!tasks.length) return paginate([], 0, q.page, q.pageSize);
    const typeWhere: Prisma.FileWhereInput =
      q.type === 'image'
        ? { mimeType: { startsWith: 'image/' } }
        : q.type === 'pdf'
          ? { mimeType: 'application/pdf' }
          : q.type === 'other'
            ? { NOT: [{ mimeType: { startsWith: 'image/' } }, { mimeType: 'application/pdf' }] }
            : {};
    const where: Prisma.FileWhereInput = {
      AND: [
        { entityType: 'task', entityId: { in: tasks.map((t) => t.id) }, status: 'READY', deletedAt: null },
        typeWhere,
        q.uploadedBy ? { uploadedById: q.uploadedBy } : {},
        q.from || q.to
          ? { createdAt: { ...(q.from ? { gte: riyadhStart(q.from) } : {}), ...(q.to ? { lt: riyadhStart(addCalendarDaysIso(q.to, 1)) } : {}) } }
          : {},
      ],
    };
    const [total, files] = await Promise.all([
      this.prisma.file.count({ where }),
      this.prisma.file.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, mimeType: true, sizeBytes: true, uploadedById: true, createdAt: true, entityId: true },
      }),
    ]);
    const uploaderIds = [...new Set(files.map((f) => f.uploadedById).filter((u): u is string => !!u))];
    const users = uploaderIds.length ? await this.prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, fullName: true } }) : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    return paginate(
      files.map((f) => {
        const t = taskById.get(f.entityId!)!;
        return {
          id: f.id,
          mimeType: f.mimeType,
          type: kindGroup(f.mimeType),
          sizeBytes: f.sizeBytes,
          uploadedBy: f.uploadedById ? (userById.get(f.uploadedById) ?? null) : null,
          createdAt: f.createdAt.toISOString(),
          task: { id: t.id, name: t.name, wbs: t.wbsCache },
          project: t.project,
        };
      }),
      total,
      q.page,
      q.pageSize,
    );
  }
}
