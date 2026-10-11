import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  can,
  isClockDriftSuspect,
  maskNationalIdParts,
  type Paginated,
  type RosterResponse,
  type ViolationDto,
  type ViolationFilter,
  type ViolationStats,
  type ViolationStatus,
} from '@nuzli/shared';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { paginate, parseSort } from '../common/pagination';
import { pdfServiceHeaders } from '../common/pdf-service';
import { mapPrismaError, targetText } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import type { Viewer } from '../teams/team-dto';
import {
  sanitizeDeviceInfo,
  toViolationDto,
  VIOLATION_LIST_SELECT,
  VIOLATION_SELECT,
  editableUntil,
} from './violation-dto';
import {
  NOTHING,
  riyadhDate,
  scopeNeedsVisibilitySetting,
  violationFilterWhere,
  violationScopeWhere,
} from './violation-scope';
import { assembleStats, statsQueries, type StatsRows } from './violation-stats';
import { buildViolationsWorkbook, SEVERITY_LABELS, STATUS_LABELS, type ExportRow } from './violations-export';

/** Rows in one Excel export; beyond it the summary sheet says the file was truncated. */
export const MAX_EXPORT_ROWS = 50_000;

export interface CreateViolationData {
  clientUuid: string;
  memberId: string;
  typeId: string;
  description: string;
  notes?: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
  clientSentAt?: string;
  deviceInfo: Record<string, unknown>;
  expectedIdPhotos: number;
  expectedEvidencePhotos: number;
}

export type ListQuery = ViolationFilter & { page: number; pageSize: number; sort?: string; q?: string };

export interface Snapshot {
  teamId: string | null;
  supervisorId: string | null;
}

/**
 * Team and supervisor of a member at instant `t` (brief §7.3, ADR-013/014): both histories are
 * half-open intervals [valid_from, valid_to), so the row valid at `t` satisfies
 * `valid_from <= t AND (valid_to IS NULL OR valid_to > t)`.
 */
export function snapshotSql(memberId: string, at: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT m.team_id, h.supervisor_id
      FROM team_memberships m
      LEFT JOIN team_supervisor_history h
        ON h.team_id = m.team_id
       AND h.valid_from <= ${at}::timestamptz
       AND (h.valid_to IS NULL OR h.valid_to > ${at}::timestamptz)
     WHERE m.member_id = ${memberId}::uuid
       AND m.valid_from <= ${at}::timestamptz
       AND (m.valid_to IS NULL OR m.valid_to > ${at}::timestamptz)
     ORDER BY m.valid_from DESC, h.valid_from DESC NULLS LAST
     LIMIT 1`;
}

/** Labels for the export summary sheet. */
function filterLabels(f: ViolationFilter, names: Record<string, string | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (f.from) out.push(['من تاريخ', f.from]);
  if (f.to) out.push(['إلى تاريخ', f.to]);
  if (f.teamId) out.push(['الفريق', names.team ?? f.teamId]);
  if (f.memberId) out.push(['العضو', names.member ?? f.memberId]);
  if (f.recordedBy) out.push(['المراقب', names.recorder ?? f.recordedBy]);
  if (f.typeId) out.push(['نوع المخالفة', names.type ?? f.typeId]);
  if (f.status) out.push(['الحالة', STATUS_LABELS[f.status]]);
  if (f.severity) out.push(['الخطورة', SEVERITY_LABELS[f.severity]]);
  if (f.bbox) out.push(['منطقة على الخريطة', f.bbox]);
  return out;
}

@Injectable()
export class ViolationsService {
  private readonly logger = new Logger(ViolationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly cfg: AppConfig,
  ) {}

  // ─────────────────────────────────────────── scope

  /** The viewer's data scope as a Prisma where (enforced in every query, never after fetching). */
  async scope(viewer: Viewer): Promise<Prisma.ViolationWhereInput> {
    const visible = scopeNeedsVisibilitySetting(viewer)
      ? await this.settings.get('SUPERVISORS_CAN_SEE_VIOLATIONS')
      : false;
    return violationScopeWhere(viewer, visible);
  }

  private async findScoped(id: string, viewer: Viewer) {
    const scope = await this.scope(viewer);
    if (scope === NOTHING) throw new AppError('NOT_FOUND');
    const row = await this.prisma.violation.findFirst({ where: { AND: [{ id }, scope] }, select: VIOLATION_SELECT });
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  // ─────────────────────────────────────────── roster (brief §7.4)

  /** Minimal list for the monitor's device: active members with their current team. */
  async roster(): Promise<RosterResponse> {
    const generatedAt = new Date();
    const rows = await this.prisma.teamMember.findMany({
      where: {
        archivedAt: null,
        status: 'ACTIVE',
        memberships: { some: { validTo: null, team: { status: { not: 'ARCHIVED' } } } },
      },
      select: {
        id: true,
        fullName: true,
        nationalIdFirst: true,
        nationalIdLast4: true,
        memberships: {
          where: { validTo: null },
          take: 1,
          select: { team: { select: { id: true, name: true, color: { select: { hex: true } } } } },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    return {
      generatedAt: generatedAt.toISOString(),
      items: rows.map((m) => {
        const team = m.memberships[0]?.team ?? null;
        return {
          memberId: m.id,
          fullName: m.fullName,
          nationalIdMasked: maskNationalIdParts(m.nationalIdFirst, m.nationalIdLast4),
          nationalIdTail: m.nationalIdLast4,
          teamId: team?.id ?? null,
          teamName: team?.name ?? null,
          teamColor: team?.color.hex ?? null,
        };
      }),
    };
  }

  // ─────────────────────────────────────────── create (idempotent by clientUuid)

  async resolveSnapshot(db: Prisma.TransactionClient | PrismaService, memberId: string, at: Date): Promise<Snapshot> {
    const rows = await db.$queryRaw<Array<{ team_id: string; supervisor_id: string | null }>>(snapshotSql(memberId, at));
    const row = rows[0];
    return { teamId: row?.team_id ?? null, supervisorId: row?.supervisor_id ?? null };
  }

  private async existing(clientUuid: string, viewer: Viewer): Promise<ViolationDto | null> {
    const row = await this.prisma.violation.findUnique({ where: { clientUuid }, select: VIOLATION_SELECT });
    if (!row) return null;
    // Another user's record: never revealed; a UUID collision is practically impossible.
    if (row.recordedById !== viewer.id && !can(viewer, 'violations.manage')) {
      throw new AppError('CONFLICT_VERSION', { field: 'clientUuid' });
    }
    return toViolationDto(row, { viewer, editWindowMinutes: await this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES') });
  }

  /**
   * A retry with the same `clientUuid` returns the stored violation (`created = false`, HTTP 200)
   * and changes nothing. Two concurrent first attempts race on the unique index; the loser
   * catches P2002 and returns the winner's row.
   */
  async create(
    input: CreateViolationData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ created: boolean; violation: ViolationDto }> {
    void ctx;
    const prior = await this.existing(input.clientUuid, viewer);
    if (prior) return { created: false, violation: prior };

    const [member, type, maxPhotos, threshold, editWindow] = await Promise.all([
      this.prisma.teamMember.findUnique({
        where: { id: input.memberId },
        select: { id: true, status: true, archivedAt: true },
      }),
      this.prisma.violationType.findUnique({ where: { id: input.typeId }, select: { id: true, isActive: true } }),
      this.settings.get('VIOLATION_MAX_PHOTOS'),
      this.settings.get('CLOCK_DRIFT_THRESHOLD_MINUTES'),
      this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES'),
    ]);
    const fieldErrors: Record<string, string[]> = {};
    if (!member || member.archivedAt || member.status !== 'ACTIVE') fieldErrors.memberId = ['العضو غير موجود أو غير نشط'];
    if (!type || !type.isActive) fieldErrors.typeId = ['نوع المخالفة غير موجود أو موقوف'];
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
    if (input.expectedEvidencePhotos > maxPhotos) {
      throw new AppError('TOO_MANY_PHOTOS', { kind: 'EVIDENCE', limit: maxPhotos });
    }

    const capturedAt = new Date(input.capturedAt);
    const receivedAt = new Date();
    const clientSentAt = input.clientSentAt ? new Date(input.clientSentAt) : null;
    const drift = isClockDriftSuspect({ capturedAt, receivedAt, clientSentAt, thresholdMinutes: threshold });

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const snap = await this.resolveSnapshot(tx, input.memberId, capturedAt);
        const created = await tx.violation.create({
          data: {
            clientUuid: input.clientUuid,
            memberId: input.memberId,
            teamIdSnapshot: snap.teamId,
            supervisorIdSnapshot: snap.supervisorId,
            recordedById: viewer.id,
            typeId: input.typeId,
            description: input.description,
            notes: input.notes ?? null,
            latitude: input.latitude,
            longitude: input.longitude,
            accuracyM: input.accuracyM,
            capturedAt,
            receivedAt,
            clientSentAt,
            clockDriftSuspect: drift,
            deviceInfo: sanitizeDeviceInfo(input.deviceInfo),
            expectedIdPhotos: input.expectedIdPhotos,
            expectedEvidence: input.expectedEvidencePhotos,
            createdById: viewer.id,
          },
          select: { id: true },
        });
        return tx.violation.findUniqueOrThrow({ where: { id: created.id }, select: VIOLATION_SELECT });
      });
      return { created: true, violation: toViolationDto(row, { viewer, editWindowMinutes: editWindow }) };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        /client_uuid|clientUuid/.test(targetText(err))
      ) {
        const winner = await this.existing(input.clientUuid, viewer);
        if (winner) return { created: false, violation: winner };
      }
      throw (err instanceof AppError ? err : mapPrismaError(err)) ?? err;
    }
  }

  // ─────────────────────────────────────────── read

  async list(q: ListQuery, viewer: Viewer, opts: { mine?: boolean } = {}): Promise<Paginated<ViolationDto>> {
    const scope = await this.scope(viewer);
    if (scope === NOTHING) return paginate([], 0, q.page, q.pageSize);
    const where: Prisma.ViolationWhereInput = {
      AND: [scope, violationFilterWhere(q), ...(opts.mine ? [{ recordedById: viewer.id }] : [])],
    };
    const order = parseSort(q.sort, ['capturedAt', 'receivedAt', 'status'] as const, { capturedAt: 'desc' });
    const [rows, total, editWindow] = await Promise.all([
      this.prisma.violation.findMany({
        where,
        select: VIOLATION_LIST_SELECT,
        orderBy: [order, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.violation.count({ where }),
      this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES'),
    ]);
    return paginate(
      rows.map((r) => toViolationDto(r, { viewer, editWindowMinutes: editWindow })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async get(id: string, viewer: Viewer): Promise<ViolationDto> {
    const row = await this.findScoped(id, viewer);
    return toViolationDto(row, { viewer, editWindowMinutes: await this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES') });
  }

  /**
   * Presigned GET for one photo of a violation the viewer may see. ID-card photos also need
   * `violations.viewIdPhoto` (supervisors never get them) and every issued URL is audited
   * (`violation.id_photo_viewed`). Evidence photos carry no identity document and are not
   * audited, to keep the log readable (ADR-050).
   */
  async fileUrl(
    id: string,
    fileId: string,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ url: string; expiresAt: string }> {
    const v = await this.findScoped(id, viewer);
    const link = v.files.find((f) => f.file.id === fileId);
    if (!link || link.file.status !== 'READY' || link.file.deletedAt) throw new AppError('NOT_FOUND');
    if (link.kind === 'ID_CARD' && !can(viewer, 'violations.viewIdPhoto')) throw new AppError('FORBIDDEN');
    const file = await this.prisma.file.findUnique({ where: { id: fileId }, select: { storageKey: true } });
    if (!file) throw new AppError('NOT_FOUND');
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.presignGet(file.storageKey, ttl);
    if (link.kind === 'ID_CARD') {
      await this.audit.logCtx(ctx, {
        action: AuditAction.VIOLATION_ID_PHOTO_VIEWED,
        entityType: 'violation',
        entityId: v.id,
        after: { fileId, ttlSeconds: ttl },
      });
    }
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  // ─────────────────────────────────────────── changes

  /**
   * Recorder within `VIOLATION_EDIT_WINDOW_MINUTES` after `received_at`; afterwards only
   * `violations.manage` (ADMIN). Audited with the changed fields before/after.
   */
  async update(
    id: string,
    patch: { typeId?: string; description?: string; notes?: string },
    viewer: Viewer,
    ctx: RequestContext,
    now = new Date(),
  ): Promise<ViolationDto> {
    const current = await this.findScoped(id, viewer);
    const window = await this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES');
    const isAdmin = can(viewer, 'violations.manage');
    if (!isAdmin) {
      if (current.recordedById !== viewer.id) throw new AppError('NOT_FOUND');
      if (now >= editableUntil(current.receivedAt, window)) throw new AppError('EDIT_WINDOW_CLOSED');
    }
    const data: Prisma.ViolationUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (patch.typeId !== undefined && patch.typeId !== current.typeId) {
      const type = await this.prisma.violationType.findUnique({ where: { id: patch.typeId }, select: { isActive: true } });
      if (!type || !type.isActive) {
        throw new AppError('VALIDATION_FAILED', { fieldErrors: { typeId: ['نوع المخالفة غير موجود أو موقوف'] } });
      }
      data.typeId = patch.typeId;
      before.typeId = current.typeId;
      after.typeId = patch.typeId;
    }
    if (patch.description !== undefined && patch.description !== current.description) {
      data.description = patch.description;
      before.description = current.description;
      after.description = patch.description;
    }
    if (patch.notes !== undefined && patch.notes !== current.notes) {
      data.notes = patch.notes;
      before.notes = current.notes;
      after.notes = patch.notes;
    }
    if (!Object.keys(data).length) return toViolationDto(current, { viewer, editWindowMinutes: window });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.violation.update({ where: { id }, data });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.VIOLATION_UPDATED, entityType: 'violation', entityId: id, before, after },
        tx,
      );
      return tx.violation.findUniqueOrThrow({ where: { id }, select: VIOLATION_SELECT });
    });
    return toViolationDto(row, { viewer, editWindowMinutes: window });
  }

  /** ADMIN. CANCELLED needs a reason (also a CHECK constraint); leaving CANCELLED clears it. */
  async changeStatus(
    id: string,
    input: { status: ViolationStatus; reason?: string },
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<ViolationDto> {
    if (input.status === 'CANCELLED' && (!input.reason || input.reason.trim().length < 3)) {
      throw new AppError('CANCEL_REASON_REQUIRED', { fieldErrors: { reason: ['اكتب سبب الإلغاء'] } });
    }
    const current = await this.findScoped(id, viewer);
    const window = await this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES');
    const cancelReason = input.status === 'CANCELLED' ? input.reason!.trim() : null;
    if (current.status === input.status && current.cancelReason === cancelReason) {
      return toViolationDto(current, { viewer, editWindowMinutes: window });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.violation.update({ where: { id }, data: { status: input.status, cancelReason } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.VIOLATION_STATUS_CHANGED,
          entityType: 'violation',
          entityId: id,
          before: { status: current.status, cancelReason: current.cancelReason },
          after: { status: input.status, cancelReason },
        },
        tx,
      );
      return tx.violation.findUniqueOrThrow({ where: { id }, select: VIOLATION_SELECT });
    });
    return toViolationDto(row, { viewer, editWindowMinutes: window });
  }

  /**
   * A supervisor's response or objection (brief §7.6): only on a violation visible to them
   * (scope = own team + visibility SHOW). Admins are notified (`VIOLATION_OBJECTION`).
   */
  async respond(id: string, body: string, viewer: Viewer, ctx: RequestContext): Promise<ViolationDto> {
    const current = await this.findScoped(id, viewer);
    const window = await this.settings.get('VIOLATION_EDIT_WINDOW_MINUTES');
    const { row, responseId } = await this.prisma.$transaction(async (tx) => {
      const response = await tx.violationResponse.create({
        data: { violationId: id, supervisorId: viewer.id, body },
        select: { id: true },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.VIOLATION_RESPONSE_ADDED,
          entityType: 'violation',
          entityId: id,
          after: { responseId: response.id, length: body.length },
        },
        tx,
      );
      const fresh = await tx.violation.findUniqueOrThrow({ where: { id }, select: VIOLATION_SELECT });
      return { row: fresh, responseId: response.id };
    });
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE', id: { not: viewer.id } },
      select: { id: true },
    });
    const author = row.responses.find((r) => r.id === responseId)?.supervisor.fullName ?? '';
    this.notifications.safe(
      this.notifications.notify(
        admins.map((a) => a.id),
        'VIOLATION_OBJECTION',
        {
          violationId: id,
          responseId,
          supervisorName: author,
          teamName: current.team?.name ?? '',
          typeName: current.type.name,
          memberName: current.member.fullName,
        },
      ),
    );
    return toViolationDto(row, { viewer, editWindowMinutes: window });
  }

  // ─────────────────────────────────────────── statistics (ADMIN)

  async stats(f: ViolationFilter, now = new Date()): Promise<ViolationStats> {
    const q = statsQueries(f, now);
    const run = <T>(sql: Prisma.Sql) => this.prisma.$queryRaw<T>(sql);
    const [totals, byTeam, topMembers, byMonitor, byType, bySeverity, trend, heatmap, points] = await Promise.all([
      run<StatsRows['totals']>(q.totals),
      run<StatsRows['byTeam']>(q.byTeam),
      run<StatsRows['topMembers']>(q.topMembers),
      run<StatsRows['byMonitor']>(q.byMonitor),
      run<StatsRows['byType']>(q.byType),
      run<StatsRows['bySeverity']>(q.bySeverity),
      run<StatsRows['trend']>(q.trend),
      run<StatsRows['heatmap']>(q.heatmap),
      run<StatsRows['points']>(q.points),
    ]);
    return assembleStats(
      { totals, byTeam, topMembers, byMonitor, byType, bySeverity, trend, heatmap, points },
      f,
      now,
    );
  }

  // ─────────────────────────────────────────── exports

  /** Excel per ADR-019 (RTL, no freeze panes); audited `violations.exported`. */
  async exportXlsx(
    f: ViolationFilter,
    viewer: Viewer,
    ctx: RequestContext,
    now = new Date(),
  ): Promise<{ buffer: Buffer; filename: string; count: number }> {
    const scope = await this.scope(viewer);
    const where: Prisma.ViolationWhereInput = { AND: [scope, violationFilterWhere(f)] };
    const rows = await this.prisma.violation.findMany({
      where,
      orderBy: [{ capturedAt: 'desc' }, { id: 'asc' }],
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        capturedAt: true,
        receivedAt: true,
        description: true,
        notes: true,
        latitude: true,
        longitude: true,
        accuracyM: true,
        clockDriftSuspect: true,
        status: true,
        cancelReason: true,
        member: { select: { fullName: true, nationalIdFirst: true, nationalIdLast4: true } },
        team: { select: { name: true } },
        supervisor: { select: { fullName: true } },
        recordedBy: { select: { fullName: true } },
        type: { select: { name: true, severity: true } },
        _count: { select: { files: { where: { kind: 'EVIDENCE' } } } },
      },
    });
    const truncated = rows.length > MAX_EXPORT_ROWS;
    const data: ExportRow[] = rows.slice(0, MAX_EXPORT_ROWS).map((r) => ({
      id: r.id,
      capturedAt: r.capturedAt,
      receivedAt: r.receivedAt,
      memberName: r.member.fullName,
      nationalIdMasked: maskNationalIdParts(r.member.nationalIdFirst, r.member.nationalIdLast4),
      teamName: r.team?.name ?? null,
      supervisorName: r.supervisor?.fullName ?? null,
      recordedByName: r.recordedBy.fullName,
      typeName: r.type.name,
      severity: r.type.severity,
      status: r.status,
      description: r.description,
      notes: r.notes,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyM: r.accuracyM,
      clockDriftSuspect: r.clockDriftSuspect,
      cancelReason: r.cancelReason,
      evidenceCount: r._count.files,
    }));
    const names = await this.filterNames(f);
    const buffer = await buildViolationsWorkbook(data, {
      filters: f,
      generatedAt: now,
      truncated,
      filterLabels: filterLabels(f, names),
    });
    await this.audit.logCtx(ctx, {
      action: AuditAction.VIOLATIONS_EXPORTED,
      entityType: 'violation',
      after: { count: data.length, truncated, filters: f },
    });
    return { buffer, filename: `violations-${riyadhDate(now)}.xlsx`, count: data.length };
  }

  private async filterNames(f: ViolationFilter): Promise<Record<string, string | undefined>> {
    const [team, member, recorder, type] = await Promise.all([
      f.teamId ? this.prisma.team.findUnique({ where: { id: f.teamId }, select: { name: true } }) : null,
      f.memberId ? this.prisma.teamMember.findUnique({ where: { id: f.memberId }, select: { fullName: true } }) : null,
      f.recordedBy ? this.prisma.user.findUnique({ where: { id: f.recordedBy }, select: { fullName: true } }) : null,
      f.typeId ? this.prisma.violationType.findUnique({ where: { id: f.typeId }, select: { name: true } }) : null,
    ]);
    return { team: team?.name, member: member?.fullName, recorder: recorder?.fullName, type: type?.name };
  }

  /**
   * Dashboard PDF through the optional pdf service (ADR-043 pattern): 501 until
   * `PDF_SERVICE_URL` is set. Sends `{ kind, filters, stats, generatedAt }` to
   * `POST {PDF_SERVICE_URL}/render/violations-dashboard`; audited `violations.dashboard_exported`.
   */
  async streamDashboardPdf(f: ViolationFilter, res: Response, ctx: RequestContext, now = new Date()): Promise<void> {
    const base = this.cfg.PDF_SERVICE_URL;
    if (!base) throw new AppError('PDF_NOT_CONFIGURED');
    const stats = await this.stats(f, now);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${base.replace(/\/$/, '')}/render/violations-dashboard`, {
        method: 'POST',
        headers: pdfServiceHeaders(this.cfg.PDF_SERVICE_TOKEN),
        body: JSON.stringify({ kind: 'violations-dashboard', filters: f, stats, generatedAt: now.toISOString() }),
        signal: AbortSignal.timeout(this.cfg.PDF_SERVICE_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`PDF service unreachable: ${(err as Error).message}`);
      throw new AppError('PDF_FAILED');
    }
    if (!upstream.ok || !upstream.body) {
      this.logger.warn(`PDF service answered ${upstream.status}`);
      throw new AppError('PDF_FAILED');
    }
    await this.audit.logCtx(ctx, {
      action: AuditAction.VIOLATIONS_DASHBOARD_EXPORTED,
      entityType: 'violation',
      after: { total: stats.total, filters: f },
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="violations-dashboard-${riyadhDate(now)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  }
}
