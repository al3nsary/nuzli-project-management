import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import type {
  importCommitSchema,
  ImportCommitResultDto,
  importJiraSchema,
  importProjectSchema,
  ImportPreviewDto,
  PermissionSubject,
} from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { ensureProjectCalendar } from '../projects/calendars.service';
import { PROJECT_SELECT } from '../projects/project-dto';
import { mapTaskDbError, ProjectStore, WRITE_TX_OPTIONS } from '../projects/project-store';
import { dateOf, minutesToHours, recompute, type StoredTask } from '../projects/task-engine';
import { rebaseTasks, topoOrder } from '../projects/templates.service';
import { StorageService } from '../storage/storage.service';
import { convertMpp } from './converter-client';
import { buildPreview, previewDepsDto, previewTasksDto, warn, type ImportDraft, type PreviewPayload } from './import-model';
import { fetchJiraIssues, issuesToDraft, parseJiraCsv } from './jira';
import { parseMspdi } from './mspdi';
import { decodeText, readCsv, readXlsx, tableToDraft } from './tabular';

type Viewer = PermissionSubject & { id: string };
type ImportFile = z.output<typeof importProjectSchema>;
type ImportJira = z.output<typeof importJiraSchema>;
type ImportCommit = z.output<typeof importCommitSchema>;

/** A preview lives one hour (owner brief), then it and its upload are deleted. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** Security review A9 L2: previews kept per admin; creating one more drops the oldest. */
export const MAX_PREVIEWS_PER_USER = 5;

/** Rows deleted per cleanup batch; the cron loops until nothing expired is left. */
export const CLEANUP_BATCH = 500;

/** The upload content types each format accepts. */
const FORMAT_TYPES: Record<ImportFile['format'], string[]> = {
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv'],
  'jira-csv': ['text/csv'],
  xml: ['application/xml', 'text/xml'],
  mpp: ['application/vnd.ms-project'],
};

/**
 * A9 project imports (ADR-110..112): file → draft (per format) → engine-checked preview kept in
 * `import_previews` for one hour → commit creates the project (calendar, tasks, dependencies,
 * engine run) in one transaction through the single write path, audited `project.imported`.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
    private readonly cfg: AppConfig,
  ) {}

  // ─────────────────────────────────────────── previews

  async previewFile(input: ImportFile, viewer: Viewer, ctx: RequestContext): Promise<ImportPreviewDto> {
    const file = await this.prisma.file.findUnique({ where: { id: input.fileId } });
    if (!file || file.deletedAt || file.status !== 'READY' || file.entityType !== 'import' || file.uploadedById !== viewer.id) {
      throw new AppError('NOT_FOUND');
    }
    if (!FORMAT_TYPES[input.format].includes(file.mimeType)) {
      throw new AppError('IMPORT_FORMAT_MISMATCH', { format: input.format, contentType: file.mimeType });
    }
    const bytes = Buffer.from(await this.storage.readAll(file.storageKey));
    const draft = await this.draftOf(input.format, bytes, input.options.dateOrder, input.options.sheetName);
    return this.savePreview(draft, { format: input.format, fileId: file.id, options: input.options }, viewer, ctx);
  }

  /** Parses one file. Exposed for tests (no storage involved). */
  async draftOf(format: ImportFile['format'], bytes: Buffer, dateOrder: 'DMY' | 'MDY' = 'DMY', sheetName?: string): Promise<ImportDraft> {
    switch (format) {
      case 'xlsx': {
        const { rows } = await readXlsx(bytes, sheetName);
        return tableToDraft(rows, { dateOrder });
      }
      case 'csv':
        return tableToDraft(readCsv(bytes), { dateOrder });
      case 'jira-csv':
        return parseJiraCsv(bytes, dateOrder);
      case 'xml':
        return parseMspdi(decodeText(bytes));
      case 'mpp': {
        const xml = await convertMpp(bytes, { url: this.cfg.CONVERTER_URL, token: this.cfg.CONVERTER_TOKEN, timeoutMs: this.cfg.CONVERTER_TIMEOUT_MS });
        return parseMspdi(xml);
      }
    }
  }

  /** Jira Cloud REST: the token is used for this call only — never stored, logged or audited. */
  async previewJira(input: ImportJira, viewer: Viewer, ctx: RequestContext): Promise<ImportPreviewDto> {
    const { issues, truncated, projectName } = await fetchJiraIssues(
      { siteUrl: input.siteUrl, email: input.email, apiToken: input.apiToken, jql: input.jql, projectKey: input.projectKey },
      { allowedHosts: this.cfg.JIRA_ALLOWED_HOSTS },
    );
    if (!issues.length) throw new AppError('IMPORT_NO_TASKS');
    const draft = issuesToDraft(issues, { projectName });
    if (truncated) warn(draft, 'JIRA_LIMIT', 'وصل الاستيراد إلى الحدّ الأعلى (٢٬٠٠٠ مهمة)؛ ضيّق استعلام JQL لاستيراد الباقي.');
    return this.savePreview(draft, { format: 'jira', fileId: null, options: input.options, site: new URL(input.siteUrl).hostname }, viewer, ctx);
  }

  private async savePreview(
    draft: ImportDraft,
    meta: { format: string; fileId: string | null; options: ImportFile['options']; site?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<ImportPreviewDto> {
    const payload = buildPreview(draft, {
      format: meta.format,
      fileId: meta.fileId,
      forcedUnit: meta.options.durationUnit,
      projectName: meta.options.projectName,
    });
    (payload as PreviewPayload & { calendarFromFile?: boolean }).calendarFromFile = !!draft.calendar;
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    await this.evictOldPreviews(viewer.id, meta.fileId);
    await this.prisma.importPreview.create({
      data: { id, createdById: viewer.id, format: meta.format, fileId: meta.fileId, payload: payload as unknown as Prisma.InputJsonValue, expiresAt },
    });
    await this.audit.logCtx(ctx, {
      action: AuditAction.PROJECT_IMPORT_PREVIEWED,
      entityType: 'import',
      entityId: id,
      after: { format: meta.format, tasks: payload.tasks.length, dependencies: payload.deps.length, durationUnit: payload.project.durationUnit, ...(meta.site ? { site: meta.site } : {}) },
    });
    return this.toDto(id, expiresAt, payload);
  }

  private async toDto(previewId: string, expiresAt: Date, p: PreviewPayload): Promise<ImportPreviewDto> {
    const counts = new Map<string, number>();
    for (const t of p.tasks) if (t.assigneeName) counts.set(t.assigneeName, (counts.get(t.assigneeName) ?? 0) + 1);
    const names = [...counts.keys()];
    const supervisors = names.length
      ? await this.prisma.user.findMany({ where: { role: 'SUPERVISOR', status: 'ACTIVE' }, select: { id: true, fullName: true } })
      : [];
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const byName = new Map<string, string | null>();
    for (const u of supervisors) {
      const k = norm(u.fullName);
      byName.set(k, byName.has(k) ? null : u.id); // two supervisors with one name → no suggestion
    }
    return {
      previewId,
      expiresAt: expiresAt.toISOString(),
      format: p.format as ImportPreviewDto['format'],
      project: p.project,
      tasks: previewTasksDto(p),
      dependencies: previewDepsDto(p),
      warnings: p.warnings,
      unmappedAssignees: names.sort().map((name) => ({ name, taskCount: counts.get(name)!, suggestedUserId: byName.get(norm(name)) ?? null })),
      stats: {
        taskCount: p.tasks.length,
        groupCount: p.tasks.filter((t) => t.type === 'GROUP').length,
        milestoneCount: p.tasks.filter((t) => t.type === 'MILESTONE').length,
        dependencyCount: p.deps.length,
      },
    };
  }

  // ─────────────────────────────────────────── commit

  /**
   * Creates the project from a preview in one transaction: the preview row is claimed (deleted)
   * first so a double click cannot import twice; the calendar is reused or created
   * (ensureProjectCalendar); tasks go through ProjectStore (engine run, task.created audits);
   * dependencies keep their type and lag; `project.imported` is audited. The upload is deleted.
   */
  async commit(input: ImportCommit, viewer: Viewer, ctx: RequestContext): Promise<ImportCommitResultDto> {
    const row = await this.prisma.importPreview.findUnique({ where: { id: input.previewId } });
    if (!row || row.createdById !== viewer.id || row.expiresAt.getTime() < Date.now()) throw new AppError('IMPORT_PREVIEW_EXPIRED');
    const payload = row.payload as unknown as PreviewPayload & { calendarFromFile?: boolean };

    // Assignees: only ACTIVE supervisors (the DB trigger enforces it as well).
    const mapped = Object.entries(input.assigneeMap).filter(([, id]) => !!id) as Array<[string, string]>;
    const ids = [...new Set(mapped.map(([, id]) => id))];
    if (ids.length) {
      const ok = await this.prisma.user.findMany({ where: { id: { in: ids }, role: 'SUPERVISOR', status: 'ACTIVE' }, select: { id: true } });
      if (ok.length !== ids.length) {
        const good = new Set(ok.map((u) => u.id));
        throw new AppError('ASSIGNEE_NOT_SUPERVISOR', { userIds: ids.filter((i) => !good.has(i)) });
      }
    }
    const assigneeOf = new Map(mapped);
    const name = input.name ?? payload.project.name;
    const unit = payload.project.durationUnit;
    const cal = payload.project.calendar;

    const result = await this.prisma
      .$transaction(async (tx) => {
        const claimed = await tx.importPreview.deleteMany({ where: { id: row.id } });
        if (claimed.count !== 1) throw new AppError('IMPORT_PREVIEW_EXPIRED');
        const calendar = await ensureProjectCalendar(
          tx,
          this.audit,
          ctx,
          payload.calendarFromFile
            ? { weekendDays: cal.weekendDays, workingHours: cal.workingHours, exceptions: cal.exceptions.length ? cal.exceptions : undefined, name: `تقويم ${name}` }
            : { name: `تقويم ${name}` },
        );
        const startDate = input.startDate ?? payload.project.startDate;
        const project = await tx.project.create({
          data: {
            name,
            startDate: dateOf(startDate),
            status: 'PLANNING',
            calendarId: calendar.id,
            autoSchedule: true,
            durationUnit: unit,
            ownerId: viewer.id,
            createdById: viewer.id,
          },
          select: PROJECT_SELECT,
        });
        const s = await this.store.lockAndLoad(tx, project.id);
        const idMap = new Map(payload.tasks.map((t) => [t.id, randomUUID() as string]));
        let copies: StoredTask[] = payload.tasks.map((t) => {
          const { sourceId: _s, assigneeName, ...rest } = t;
          void _s;
          return {
            ...rest,
            id: idMap.get(t.id)!,
            projectId: project.id,
            parentId: t.parentId ? (idMap.get(t.parentId) ?? null) : null,
            assigneeId: t.type === 'GROUP' || !assigneeName ? null : (assigneeOf.get(assigneeName) ?? null),
            wbsCache: '',
            version: 0,
            labelIds: [],
          };
        });
        if (input.startDate && input.startDate !== payload.project.startDate) {
          copies = rebaseTasks(copies, { start: payload.project.startDate, cal: s.cal }, { start: input.startDate, cal: s.cal }, unit);
        }
        const deps = payload.deps.map((d) => ({
          id: randomUUID() as string,
          predecessorId: idMap.get(d.predecessorId)!,
          successorId: idMap.get(d.successorId)!,
          type: d.type,
          lagDays: d.lagDays,
          lagMinutes: d.lagMinutes,
          ...(unit === 'HOUR' ? { lagHours: minutesToHours(d.lagMinutes) } : {}),
        }));
        const finals = recompute({ tasks: copies, dependencies: deps, calendar: s.cal, autoSchedule: true, durationUnit: unit });
        await this.store.persistDetailed(tx, s, finals, {
          ctx,
          insertedMany: topoOrder(copies),
          explicit: new Set(copies.map((c) => c.id)),
          explicitAction: AuditAction.TASK_CREATED,
          auditExtra: { imported: payload.format },
        });
        if (deps.length) {
          await tx.taskDependency.createMany({
            data: deps.map((d) => ({
              id: d.id,
              projectId: project.id,
              predecessorId: d.predecessorId,
              successorId: d.successorId,
              type: d.type,
              lagDays: d.lagDays,
              lagMinutes: unit === 'HOUR' ? d.lagMinutes : 0,
              createdById: ctx.actorId,
            })),
          });
        }
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.PROJECT_IMPORTED,
            entityType: 'project',
            entityId: project.id,
            after: {
              format: payload.format,
              name,
              durationUnit: unit,
              tasks: copies.length,
              dependencies: deps.length,
              calendarId: calendar.id,
              calendarCreated: calendar.created,
              assigneesMapped: mapped.length,
              warnings: payload.warnings.length,
            },
          },
          tx,
        );
        return { projectId: project.id, taskCount: copies.length, dependencyCount: deps.length, calendarId: calendar.id, calendarCreated: calendar.created };
      }, WRITE_TX_OPTIONS)
      .catch((err: unknown) => {
        throw mapTaskDbError(err);
      });
    if (payload.fileId) await this.deleteUpload(payload.fileId);
    return result;
  }

  private async deleteUpload(fileId: string): Promise<void> {
    const f = await this.prisma.file.findUnique({ where: { id: fileId }, select: { id: true, storageKey: true, deletedAt: true } });
    if (!f || f.deletedAt) return;
    await this.storage.delete(f.storageKey).catch((err: unknown) => this.logger.warn(`Could not delete import upload ${fileId}: ${(err as Error).message}`));
    await this.prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
  }

  /**
   * L2: at most MAX_PREVIEWS_PER_USER previews per admin (expired ones included); the oldest go
   * first, with their uploads unless the new preview reads the same upload.
   */
  private async evictOldPreviews(userId: string, keepFileId: string | null): Promise<void> {
    const mine = await this.prisma.importPreview.findMany({
      where: { createdById: userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, fileId: true },
    });
    const drop = mine.slice(0, Math.max(0, mine.length - (MAX_PREVIEWS_PER_USER - 1)));
    if (!drop.length) return;
    await this.prisma.importPreview.deleteMany({ where: { id: { in: drop.map((p) => p.id) } } });
    for (const p of drop) if (p.fileId && p.fileId !== keepFileId) await this.deleteUpload(p.fileId).catch(() => undefined);
  }

  /** Expired previews and their uploads are deleted every hour, in batches until none is left (L2). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'import-previews-cleanup' })
  async cleanupExpired(now = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const stale = await this.prisma.importPreview.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true, fileId: true },
        orderBy: { expiresAt: 'asc' },
        take: CLEANUP_BATCH,
      });
      if (!stale.length) break;
      await this.prisma.importPreview.deleteMany({ where: { id: { in: stale.map((p) => p.id) } } });
      for (const p of stale) if (p.fileId) await this.deleteUpload(p.fileId).catch(() => undefined);
      total += stale.length;
      if (stale.length < CLEANUP_BATCH) break;
    }
    return total;
  }
}
