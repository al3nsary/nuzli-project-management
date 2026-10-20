import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  can,
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
import { activeWorkspaceId, activeWorkspaceIdOrNull } from '../prisma/workspace-context';
import { preview } from './task-collab.service';
import { addCalendarDaysIso } from './task-engine';
import { participantProjectIds, peerIds, projectLimit } from '../access/access-context';

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
 * Per-task hub figures from the comments and the viewer's read mark (pure; unit-tested, and the
 * reference the SQL aggregation `hubStatsSql` must agree with):
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

/** `%term%` for ILIKE … ESCAPE '\' with the user's `%`, `_` and `\` taken literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The task scope of ADR-092 in SQL, over `tasks t JOIN projects p` (security review A9 L4: the
 * scope is a join, never a list of ids). ADMIN (`projects.readAll`): every live task of a
 * non-template project (A12 round 2: an assistant limited to some projects — those). SUPERVISOR
 * (`tasks.readAssigned`): the live tasks assigned to them or to a supervisor of the same team(s),
 * in non-archived projects; a project participant: every task of their projects. Anyone else: nothing.
 */
export function taskScopeSql(viewer: Viewer, workspaceId: string | null = activeWorkspaceIdOrNull()): Prisma.Sql {
  // A12 (ADR-143): raw SQL carries the workspace filter itself — no workspace, no rows.
  if (!workspaceId) return Prisma.sql`FALSE`;
  const base = Prisma.sql`t.workspace_id = ${workspaceId}::uuid AND p.workspace_id = ${workspaceId}::uuid AND t.archived_at IS NULL AND p.is_template = false`;
  if (can(viewer, 'projects.readAll')) {
    // A12 round 2: an assistant limited to some projects.
    const limit = projectLimit(viewer);
    if (!limit) return base;
    if (!limit.length) return Prisma.sql`FALSE`;
    return Prisma.sql`${base} AND t.project_id IN (${Prisma.join(limit.map((id) => Prisma.sql`${id}::uuid`))})`;
  }
  // A12 round 2: own tasks + the team's supervisors' tasks (owner rule) OR the participant's projects.
  const grants: Prisma.Sql[] = [];
  if (can(viewer, 'tasks.readAssigned')) {
    const peers = peerIds(viewer);
    grants.push(
      peers.length === 1
        ? Prisma.sql`t.assignee_id = ${peers[0]}::uuid`
        : Prisma.sql`t.assignee_id IN (${Prisma.join(peers.map((id) => Prisma.sql`${id}::uuid`))})`,
    );
  }
  const part = participantProjectIds(viewer);
  if (part.length) grants.push(Prisma.sql`t.project_id IN (${Prisma.join(part.map((id) => Prisma.sql`${id}::uuid`))})`);
  if (!grants.length) return Prisma.sql`FALSE`;
  if (grants.length === 1) return Prisma.sql`${base} AND ${grants[0]!} AND p.archived_at IS NULL`;
  return Prisma.sql`${base} AND (${Prisma.join(grants, ' OR ')}) AND p.archived_at IS NULL`;
}

/** One aggregated row per comment thread in the viewer's scope (hub; L4). */
export interface HubStatRow {
  taskId: string;
  assigneeId: string | null;
  createdById: string | null;
  commentCount: number;
  unreadCount: number;
  mentioned: boolean;
  lastAt: Date;
}

/**
 * Hub figures aggregated in PostgreSQL (security review A9 L4): one row per thread, no comment
 * rows leave the database. Same rules as `hubStats`.
 */
export function hubStatsSql(viewer: Viewer, q: Pick<HubQuery, 'projectId' | 'q'>): Prisma.Sql {
  const parts: Prisma.Sql[] = [taskScopeSql(viewer)];
  if (q.projectId) parts.push(Prisma.sql`t.project_id = ${q.projectId}::uuid`);
  const term = q.q?.trim();
  if (term) {
    const like = likePattern(term);
    parts.push(
      Prisma.sql`(t.name ILIKE ${like} ESCAPE '\\' OR EXISTS (SELECT 1 FROM task_comments c2 WHERE c2.task_id = t.id AND c2.workspace_id = t.workspace_id AND c2.body ILIKE ${like} ESCAPE '\\'))`,
    );
  }
  return Prisma.sql`
    SELECT t.id AS "taskId", t.assignee_id AS "assigneeId", t.created_by AS "createdById",
           count(c.id)::int AS "commentCount",
           (count(c.id) FILTER (WHERE c.author_id <> ${viewer.id}::uuid AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)))::int AS "unreadCount",
           coalesce(bool_or(${viewer.id}::uuid = ANY (c.mentions)), false) AS "mentioned",
           max(c.created_at) AS "lastAt"
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      JOIN task_comments c ON c.task_id = t.id AND c.workspace_id = t.workspace_id
      LEFT JOIN task_comment_reads r ON r.task_id = t.id AND r.workspace_id = t.workspace_id AND r.user_id = ${viewer.id}::uuid
     WHERE ${Prisma.join(parts, ' AND ')}
     GROUP BY t.id, t.assignee_id, t.created_by, r.last_read_at`;
}

/** WHERE of the attachments browser over `files f JOIN tasks t JOIN projects p` (L4). */
export function attachmentWhereSql(viewer: Viewer, q: Omit<AttachmentQuery, 'page' | 'pageSize'>): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`f.entity_type = 'task' AND f.status = 'READY'::"FileStatus" AND f.deleted_at IS NULL`,
    taskScopeSql(viewer),
  ];
  if (q.projectId) parts.push(Prisma.sql`t.project_id = ${q.projectId}::uuid`);
  if (q.type === 'image') parts.push(Prisma.sql`f.mime_type LIKE 'image/%'`);
  if (q.type === 'pdf') parts.push(Prisma.sql`f.mime_type = 'application/pdf'`);
  if (q.type === 'other') parts.push(Prisma.sql`NOT (f.mime_type LIKE 'image/%' OR f.mime_type = 'application/pdf')`);
  if (q.uploadedBy) parts.push(Prisma.sql`f.uploaded_by = ${q.uploadedBy}::uuid`);
  if (q.from) parts.push(Prisma.sql`f.created_at >= ${riyadhStart(q.from)}::timestamptz`);
  if (q.to) parts.push(Prisma.sql`f.created_at < ${riyadhStart(addCalendarDaysIso(q.to, 1))}::timestamptz`);
  const term = q.q?.trim();
  if (term) {
    const like = likePattern(term);
    parts.push(Prisma.sql`(t.name ILIKE ${like} ESCAPE '\\' OR p.name ILIKE ${like} ESCAPE '\\')`);
  }
  return Prisma.join(parts, ' AND ');
}

const ATTACHMENT_FROM = Prisma.sql`files f JOIN tasks t ON t.id = f.entity_id AND t.workspace_id = f.workspace_id JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id`;

/**
 * A9 communication hub (every comment thread the viewer can open, with unread counts and
 * filters) and the attachments browser. Supervisors see only tasks assigned to them (ADR-092);
 * admins every task of non-template projects. Since the A9 security review (ADR-117) the scope
 * and the aggregation run in SQL, and a supervisor gets no ancestor path (`path: []`).
 */
@Injectable()
export class HubService {
  constructor(private readonly prisma: PrismaService) {}

  /** Aggregated thread figures (SQL; replaced by an in-memory oracle in unit tests). */
  protected async threadStats(viewer: Viewer, q: HubQuery): Promise<HubStat[]> {
    const rows = await this.prisma.$queryRaw<HubStatRow[]>(hubStatsSql(viewer, q));
    return rows.map((r) => ({
      taskId: r.taskId,
      assigneeId: r.assigneeId,
      createdById: r.createdById,
      commentCount: Number(r.commentCount),
      unreadCount: Number(r.unreadCount),
      mentioned: !!r.mentioned,
      lastAt: new Date(r.lastAt).getTime(),
      lastCommentId: null,
    }));
  }

  async hub(viewer: Viewer, q: HubQuery): Promise<HubPageDto> {
    const stats = await this.threadStats(viewer, q);
    const counts = Object.fromEntries(HUB_FILTERS.map((f) => [f, stats.filter((s) => matchesFilter(s, f, viewer.id)).length])) as Record<HubFilter, number>;
    const unreadTotal = stats.reduce((n, s) => n + s.unreadCount, 0);
    const filtered = stats.filter((s) => matchesFilter(s, q.filter, viewer.id)).sort((a, b) => b.lastAt - a.lastAt || (a.taskId < b.taskId ? -1 : 1));
    const page = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const pageIds = page.map((s) => s.taskId);
    if (!pageIds.length) return { items: [], total: filtered.length, page: q.page, pageSize: q.pageSize, counts, unreadTotal };

    const [tasks, lasts, reads] = await Promise.all([
      this.prisma.task.findMany({
        where: { id: { in: pageIds } },
        select: {
          id: true,
          name: true,
          wbsCache: true,
          type: true,
          status: true,
          parentId: true,
          assignee: { select: { id: true, fullName: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      // The last comment of each thread on this page only (at most pageSize small queries).
      Promise.all(
        pageIds.map((taskId) =>
          this.prisma.taskComment.findFirst({
            where: { taskId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, body: true, createdAt: true, author: { select: { id: true, fullName: true } } },
          }),
        ),
      ),
      this.prisma.taskCommentRead.findMany({ where: { userId: viewer.id, taskId: { in: pageIds } }, select: { taskId: true, lastReadAt: true } }),
    ]);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const readMap = new Map(reads.map((r) => [r.taskId, r.lastReadAt]));
    // L4 (ADR-117): parent groups are not assigned to a supervisor, so their names are not shown.
    const showPath = can(viewer, 'projects.readAll');
    const names = showPath ? await this.ancestors(tasks.map((t) => t.parentId).filter((p): p is string => !!p)) : new Map();
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
    const items: HubItemDto[] = [];
    page.forEach((s, i) => {
      const t = byId.get(s.taskId);
      if (!t) return; // deleted between the two reads
      const last = lasts[i];
      items.push({
        task: { id: t.id, name: t.name, wbs: t.wbsCache, type: t.type, status: t.status, assignee: t.assignee },
        project: t.project,
        path: showPath ? pathOf(t.parentId) : [],
        commentCount: s.commentCount,
        unreadCount: s.unreadCount,
        lastReadAt: readMap.get(t.id)?.toISOString() ?? null,
        lastComment: last ? { id: last.id, author: last.author, bodyPreview: preview(last.body), createdAt: last.createdAt.toISOString() } : null,
      });
    });
    return { items, total: filtered.length, page: q.page, pageSize: q.pageSize, counts, unreadTotal };
  }

  /** Names and parents of the given tasks and all their ancestors (admins only). */
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

  /** One page of matching file ids (newest first) and the total, scoped in SQL (L4). */
  protected async attachmentPage(viewer: Viewer, q: AttachmentQuery): Promise<{ ids: string[]; total: number }> {
    const where = attachmentWhereSql(viewer, q);
    const [countRows, idRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM ${ATTACHMENT_FROM} WHERE ${where}`),
      this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT f.id FROM ${ATTACHMENT_FROM} WHERE ${where} ORDER BY f.created_at DESC, f.id ASC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      ),
    ]);
    return { ids: idRows.map((r) => r.id), total: Number(countRows[0]?.total ?? 0) };
  }

  async attachments(viewer: Viewer, q: AttachmentQuery): Promise<Paginated<AttachmentBrowseDto>> {
    const { ids, total } = await this.attachmentPage(viewer, q);
    if (!ids.length) return paginate([], total, q.page, q.pageSize);
    const files = await this.prisma.file.findMany({
      where: { id: { in: ids } },
      select: { id: true, mimeType: true, sizeBytes: true, uploadedById: true, createdAt: true, entityId: true },
    });
    const taskIds = [...new Set(files.map((f) => f.entityId).filter((x): x is string => !!x))];
    const uploaderIds = [...new Set(files.map((f) => f.uploadedById).filter((u): u is string => !!u))];
    const [tasks, users] = await Promise.all([
      this.prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, name: true, wbsCache: true, project: { select: { id: true, name: true } } } }),
      uploaderIds.length ? this.prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
    ]);
    const fileById = new Map(files.map((f) => [f.id, f]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const items: AttachmentBrowseDto[] = [];
    for (const id of ids) {
      const f = fileById.get(id);
      const t = f?.entityId ? taskById.get(f.entityId) : undefined;
      if (!f || !t) continue;
      items.push({
        id: f.id,
        mimeType: f.mimeType,
        type: kindGroup(f.mimeType),
        sizeBytes: f.sizeBytes,
        uploadedBy: f.uploadedById ? (userById.get(f.uploadedById) ?? null) : null,
        createdAt: f.createdAt.toISOString(),
        task: { id: t.id, name: t.name, wbs: t.wbsCache },
        project: t.project,
      });
    }
    return paginate(items, total, q.page, q.pageSize);
  }
}
