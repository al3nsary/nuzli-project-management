/**
 * DemoApi A9 imports (docs/API.md «A9 — imports, exports, hours», ADR-110..112, ADR-117): the same
 * flow and rules as `ImportsService`, with the parsing done in the browser by the ported parsers
 * (`features/imports`). Upload = presign `entityType: 'import'` → PUT into IndexedDB → confirm
 * (structure check); `preview` parses the file and runs the engine, keeping the preview one hour
 * (in memory — the demo has no server); `commit` claims the preview first, reuses or creates the
 * calendar, creates the project (PLANNING, auto-schedule on, the detected unit) and its tasks and
 * links through the one write path, maps assignee names to ACTIVE supervisors only, may re-base to
 * a new start, audits `project.imported` and deletes the upload.
 *
 * Two things need the server and answer like an API without them: `.mpp` (the MPXJ converter) →
 * 501 MPP_CONVERTER_NOT_CONFIGURED, and Jira Cloud REST (a server-side fetch with the SSRF guard;
 * a browser could not reach Jira anyway) → after the same input and site checks, 502
 * JIRA_REQUEST_FAILED with `details.reason = 'demo'`, so the wizard offers Jira CSV instead.
 */
import {
  importCommitSchema,
  importJiraSchema,
  importProjectSchema,
  type ImportCommitResultDto,
  type ImportPreviewDto,
} from '@nuzli/shared';
import type { ApiClient } from '../client';
import type { DemoDependency, DemoProject, DemoTask } from './db';
import type { DemoInternals } from './phase2';
import type { ProjectsCore } from './phase4';
import { ensureProjectCalendar } from './calendars';
import { rebaseTasks, topoOrder } from './phaseA9';
import { fail, newId, validate } from './util';
import { draftOf, FORMAT_FILE } from '../../features/imports/files';
import { assertJiraSite } from '../../features/imports/jira';
import {
  buildPreview,
  importError,
  previewDepsDto,
  previewTasksDto,
  warn,
  type ImportDraft,
  type PreviewPayload,
} from '../../features/imports/model';
import { minutesToHours, recompute, workCalendarOf } from '../../features/projects/engine';
import { ApiError } from '../errors';

/** A preview lives one hour (owner brief), then it and its upload are deleted. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;
/** Security review A9 L2: previews kept per admin; creating one more drops the oldest. */
export const MAX_PREVIEWS_PER_USER = 5;

interface StoredPreview {
  id: string;
  createdById: string;
  expiresAt: number;
  payload: PreviewPayload;
}

export type ImportsApi = ApiClient['imports'] & {
  /** @internal tests: age a preview. */
  expirePreview(id: string): void;
};

export function createImports(
  api: DemoInternals & { files: ApiClient['files'] },
  core: ProjectsCore,
): ImportsApi {
  const db = api.db;
  const previews = new Map<string, StoredPreview>();

  const sweep = async (now = Date.now()) => {
    for (const [id, p] of previews) {
      if (p.expiresAt < now) {
        previews.delete(id);
        if (p.payload.fileId) await deleteUpload(p.payload.fileId);
      }
    }
  };

  async function deleteUpload(fileId: string) {
    const f = await db.files.get(fileId);
    if (!f || f.deletedAt) return;
    await db.objects.delete(fileId);
    await db.files.update(fileId, { deletedAt: new Date().toISOString() });
  }

  async function toDto(
    previewId: string,
    expiresAt: number,
    p: PreviewPayload,
  ): Promise<ImportPreviewDto> {
    const counts = new Map<string, number>();
    for (const t of p.tasks)
      if (t.assigneeName) counts.set(t.assigneeName, (counts.get(t.assigneeName) ?? 0) + 1);
    const names = [...counts.keys()];
    const supervisors = names.length
      ? (await db.users.toArray()).filter((u) => u.role === 'SUPERVISOR' && u.status === 'ACTIVE')
      : [];
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const byName = new Map<string, string | null>();
    for (const u of supervisors) {
      const k = norm(u.fullName);
      byName.set(k, byName.has(k) ? null : u.id); // two supervisors with one name → no suggestion
    }
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      format: p.format as ImportPreviewDto['format'],
      project: p.project,
      tasks: previewTasksDto(p),
      dependencies: previewDepsDto(p),
      warnings: p.warnings,
      unmappedAssignees: names.sort().map((name) => ({
        name,
        taskCount: counts.get(name)!,
        suggestedUserId: byName.get(norm(name)) ?? null,
      })),
      stats: {
        taskCount: p.tasks.length,
        groupCount: p.tasks.filter((t) => t.type === 'GROUP').length,
        milestoneCount: p.tasks.filter((t) => t.type === 'MILESTONE').length,
        dependencyCount: p.deps.length,
      },
    };
  }

  async function savePreview(
    draft: ImportDraft,
    meta: {
      format: string;
      fileId: string | null;
      options: { durationUnit?: 'DAY' | 'HOUR'; projectName?: string };
      site?: string;
    },
    actorId: string,
  ): Promise<ImportPreviewDto> {
    const payload = buildPreview(draft, {
      format: meta.format,
      fileId: meta.fileId,
      forcedUnit: meta.options.durationUnit,
      projectName: meta.options.projectName,
    });
    payload.calendarFromFile = !!draft.calendar;
    const id = newId();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    // Security review A9 L2: at most MAX_PREVIEWS_PER_USER per admin — the oldest go first, with
    // their uploads unless the new preview reads the same upload (its id then answers 410).
    const mine = [...previews.values()].filter((p) => p.createdById === actorId);
    for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_PREVIEWS_PER_USER - 1)))) {
      previews.delete(old.id);
      if (old.payload.fileId && old.payload.fileId !== meta.fileId)
        await deleteUpload(old.payload.fileId);
    }
    previews.set(id, { id, createdById: actorId, expiresAt, payload });
    await api.writeAudit({
      actorId,
      action: 'project.import_previewed',
      entityType: 'import',
      entityId: id,
      before: null,
      after: {
        format: meta.format,
        tasks: payload.tasks.length,
        dependencies: payload.deps.length,
        durationUnit: payload.project.durationUnit,
        ...(meta.site ? { site: meta.site } : {}),
      },
    });
    return toDto(id, expiresAt, payload);
  }

  return {
    upload: async (file, contentType, opts) => {
      const presigned = await api.files.presign({
        entityType: 'import',
        contentType,
        sizeBytes: file.size,
      });
      await api.files.upload(presigned, new Blob([file], { type: contentType }), opts);
      opts?.onProgress?.(1);
      await api.files.confirm(presigned.fileId);
      return { fileId: presigned.fileId };
    },

    preview: async (input) => {
      const viewer = await api.actor('projects.create');
      const data = validate(importProjectSchema, input);
      await sweep();
      const file = await db.files.get(data.fileId);
      if (
        !file ||
        file.deletedAt ||
        file.status !== 'READY' ||
        file.entityType !== 'import' ||
        file.createdById !== viewer.id
      )
        fail('NOT_FOUND');
      const accepted =
        data.format === 'xml'
          ? ['application/xml', 'text/xml']
          : [FORMAT_FILE[data.format].contentType];
      if (!accepted.includes(file.mimeType))
        throw importError('IMPORT_FORMAT_MISMATCH', {
          format: data.format,
          contentType: file.mimeType,
        });
      const obj = await db.objects.get(file.id);
      if (!obj) fail('NOT_FOUND');
      const draft = await draftOf(
        data.format,
        new Uint8Array(obj.data),
        data.options.dateOrder,
        data.options.sheetName,
      );
      return savePreview(
        draft,
        { format: data.format, fileId: file.id, options: data.options },
        viewer.id,
      );
    },

    jira: async (input) => {
      await api.actor('projects.create');
      const data = validate(importJiraSchema, input);
      assertJiraSite(data.siteUrl);
      // The REST call runs on the server only (one-time token, DNS-pinned SSRF guard, ADR-112).
      throw importError('JIRA_REQUEST_FAILED', { reason: 'demo' });
    },

    commit: async (input) => {
      const viewer = await api.actor('projects.create');
      const data = validate(importCommitSchema, input);
      const row = previews.get(data.previewId);
      if (!row || row.createdById !== viewer.id || row.expiresAt < Date.now())
        throw importError('IMPORT_PREVIEW_EXPIRED');
      const payload = row.payload;

      // Assignees: only ACTIVE supervisors.
      const mapped = Object.entries(data.assigneeMap).filter(([, id]) => !!id) as Array<
        [string, string]
      >;
      const ids = [...new Set(mapped.map(([, id]) => id))];
      if (ids.length) {
        const users = await db.users.bulkGet(ids);
        const bad = ids.filter(
          (id, i) => !users[i] || users[i]!.role !== 'SUPERVISOR' || users[i]!.status !== 'ACTIVE',
        );
        if (bad.length) fail('ASSIGNEE_NOT_SUPERVISOR', { userIds: bad });
      }
      const assigneeOf = new Map(mapped);
      const name = data.name ?? payload.project.name;
      const unit = payload.project.durationUnit;
      const cal = payload.project.calendar;

      let result!: ImportCommitResultDto;
      await core.tx(async () => {
        // Claim the preview first: a double click cannot import twice.
        if (!previews.delete(row.id)) throw importError('IMPORT_PREVIEW_EXPIRED');
        const calendar = await ensureProjectCalendar(
          api,
          viewer.id,
          payload.calendarFromFile
            ? {
                weekendDays: cal.weekendDays,
                workingHours: cal.workingHours,
                exceptions: cal.exceptions.length ? cal.exceptions : undefined,
                name: `تقويم ${name}`,
              }
            : { name: `تقويم ${name}` },
        );
        const startDate = data.startDate ?? payload.project.startDate;
        const project: DemoProject = {
          id: newId(),
          name,
          description: null,
          startDate,
          status: 'PLANNING',
          calendarId: calendar.id,
          autoSchedule: true,
          ownerId: viewer.id,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          budget: null,
          currency: 'SAR',
          isTemplate: false,
          templateOfId: null,
          durationUnit: unit,
        };
        await db.projects.add(project);
        const s = await core.load(project.id);
        const idMap = new Map(payload.tasks.map((t) => [t.id, newId()]));
        const now = new Date().toISOString();
        let copies: DemoTask[] = payload.tasks.map((t) => {
          const { sourceId: _s, assigneeName, ...rest } = t;
          void _s;
          return {
            ...rest,
            id: idMap.get(t.id)!,
            projectId: project.id,
            parentId: t.parentId ? (idMap.get(t.parentId) ?? null) : null,
            assigneeId:
              t.type === 'GROUP' || !assigneeName ? null : (assigneeOf.get(assigneeName) ?? null),
            wbsCache: '',
            version: 0,
            labelIds: [],
            customValues: {},
            archivedAt: null,
            dueSoonNotifiedAt: null,
            overdueNotifiedAt: null,
            deadlineNotifiedAt: null,
            createdAt: now,
            createdById: viewer.id,
          } as DemoTask;
        });
        if (data.startDate && data.startDate !== payload.project.startDate) {
          copies = rebaseTasks<DemoTask>(
            copies,
            { start: payload.project.startDate, cal: s.cal },
            { start: data.startDate, cal: s.cal, unit },
          );
        }
        const deps: DemoDependency[] = payload.deps.map((d) => ({
          id: newId(),
          projectId: project.id,
          predecessorId: idMap.get(d.predecessorId)!,
          successorId: idMap.get(d.successorId)!,
          type: d.type,
          lagDays: d.lagDays,
          ...(unit === 'HOUR' ? { lagMinutes: d.lagMinutes } : {}),
          createdAt: now,
        }));
        const finals = recompute({
          tasks: copies,
          dependencies: deps.map((d) =>
            unit === 'HOUR' ? { ...d, lagHours: minutesToHours(d.lagMinutes ?? 0) } : d,
          ),
          calendar: workCalendarOf((await db.calendars.get(calendar.id))!),
          autoSchedule: true,
          durationUnit: unit,
        });
        await core.persist(s, finals, {
          actorId: viewer.id,
          insertedMany: topoOrder(copies),
          explicit: new Set(copies.map((c) => c.id)),
          explicitAction: 'task.created',
          auditExtra: { imported: payload.format },
        });
        if (deps.length) await db.dependencies.bulkAdd(deps);
        await api.writeAudit({
          actorId: viewer.id,
          action: 'project.imported',
          entityType: 'project',
          entityId: project.id,
          before: null,
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
        });
        result = {
          projectId: project.id,
          taskCount: copies.length,
          dependencyCount: deps.length,
          calendarId: calendar.id,
          calendarCreated: calendar.created,
        };
      });
      if (payload.fileId) await deleteUpload(payload.fileId);
      return result;
    },

    expirePreview: (id) => {
      const p = previews.get(id);
      if (p) p.expiresAt = Date.now() - 1000;
    },
  };
}

/** `true` when the error is the demo's «Jira Cloud needs the server» answer. */
export const isDemoJiraError = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.code === 'JIRA_REQUEST_FAILED' &&
  (err.details as { reason?: string } | undefined)?.reason === 'demo';

void warn;
