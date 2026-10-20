import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  maskNationalId,
  maskNationalIdParts,
  nationalIdKind,
  type RegisterViolationMemberResultDto,
  type ViolationDto,
  type ViolationOcrDto,
  type ViolationSuggestionDto,
} from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { mapPrismaError } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { assertReferencesExist, hideDuplicateNationalId } from '../members/member-writes';
import { PrismaService } from '../prisma/prisma.service';
import { activeWorkspaceId } from '../prisma/workspace-context';
import { displayRole, memberOf, ROLE_VIEW_SELECT } from '../users/user-dto';
import { SettingsService } from '../settings/settings.service';
import { buildObjectKey } from '../storage/files.service';
import { EXTENSIONS, type DetectedType } from '../storage/magic-bytes';
import { StorageService } from '../storage/storage.service';
import {
  canManageMemberIn,
  MEMBER_SELECT,
  OPEN_LEADERS,
  toMemberDto,
  toTeamSummary,
  type Viewer,
} from '../teams/team-dto';
import { rankByName } from './ocr/name-similarity';
import { OcrQueueService } from './ocr/ocr-queue.service';
import { VIOLATION_SELECT } from './violation-dto';
import { EMPTY_SNAPSHOT, ViolationsService } from './violations.service';

type Tx = Prisma.TransactionClient;

/** How many active members the name matcher compares at most (field-team sizes). */
export const NAME_MATCH_POOL = 5000;

export interface RegisterMemberData {
  fullName: string;
  nationalId: string;
  teamId?: string;
  jobTitleId?: string;
  jobTitleText?: string;
  departmentId?: string;
  departmentText?: string;
  usePersonPhoto: boolean;
}

/**
 * Violations recorded without a person (owner request A9, ADR-103/104): the OCR suggestions,
 * assigning a member later, un-assigning, and registering a new member from the card.
 *
 *  - Assigning resolves the team and supervisors **at captured_at** with the same SQL as create.
 *  - Who: the recorder (any time) or an admin assigns; only an admin un-assigns; an admin — or a
 *    supervisor leading the chosen team — registers a member (a supervisor reaches the violation
 *    only through this route: unassigned violations are never in their scope).
 *  - Every step is audited; OCR views too (`violation.ocr_viewed`, `fullNationalId` flag).
 */
@Injectable()
export class ViolationAssignService {
  private readonly logger = new Logger(ViolationAssignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly violations: ViolationsService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly ocr: OcrQueueService,
    private readonly settings: SettingsService,
  ) {}

  /** The recorder or an admin; anyone else → 404 (existence not revealed). */
  private async loadForAssign(id: string, viewer: Viewer) {
    const row = await this.violations.findScoped(id, viewer);
    if (!can(viewer, 'violations.manage') && row.recordedById !== viewer.id) throw new AppError('NOT_FOUND');
    return row;
  }

  // ─────────────────────────────────────────── OCR view + suggestions

  async ocrView(id: string, viewer: Viewer, ctx: RequestContext): Promise<ViolationOcrDto> {
    const v = await this.loadForAssign(id, viewer);
    const job = await this.prisma.violationOcr.findUnique({ where: { violationId: id } });
    const empty: ViolationOcrDto['fields'] = {
      nationalId: null,
      name: null,
      nameLatin: null,
      birthDate: null,
      expiryDate: null,
      nationality: null,
    };
    if (!job) return { status: 'NONE', attempts: 0, extractedAt: null, fields: empty, suggestedMembers: [], suggestedUsers: [] };
    const stored = job.status === 'DONE' ? this.ocr.read(job) : null;
    const full = can(viewer, 'nationalIds.readFull');
    const f = stored?.fields;
    const fields: ViolationOcrDto['fields'] = f
      ? {
          nationalId: f.nationalId
            ? {
                value: full ? f.nationalId.value : maskNationalId(f.nationalId.value),
                masked: maskNationalId(f.nationalId.value),
                full,
                confidence: f.nationalId.confidence,
                kind: nationalIdKind(f.nationalId.value) ?? 'RESIDENT',
              }
            : null,
          name: f.name,
          nameLatin: f.nameLatin,
          birthDate: f.birthDate,
          expiryDate: f.expiryDate,
          nationality: f.nationality,
        }
      : empty;

    const suggestedMembers: ViolationSuggestionDto[] = [];
    let suggestedUsers: ViolationOcrDto['suggestedUsers'] = [];
    if (stored && !v.memberId) {
      if (job.idNumberHash) {
        const exact = await this.prisma.teamMember.findMany({
          where: { nationalIdHash: job.idNumberHash, archivedAt: null },
          select: MEMBER_SELECT,
        });
        for (const m of exact) suggestedMembers.push(this.suggestion(m, 'NATIONAL_ID', 1));
        // Users (a supervisor or monitor on the card) are shown to admins only, for information.
        if (can(viewer, 'violations.manage')) {
          suggestedUsers = (
            await this.prisma.user.findMany({
              // A12: users of this workspace only.
              where: { nationalIdHash: job.idNumberHash, archivedAt: null, ...memberOf(activeWorkspaceId()) },
              select: { id: true, fullName: true, ...ROLE_VIEW_SELECT },
            })
          ).map((u) => ({ id: u.id, fullName: u.fullName, role: displayRole(u, activeWorkspaceId()) }));
        }
      }
      if (f?.name) {
        const pool = await this.prisma.teamMember.findMany({
          where: { archivedAt: null, status: 'ACTIVE', id: { notIn: suggestedMembers.map((s) => s.memberId) } },
          select: { id: true, fullName: true },
          take: NAME_MATCH_POOL,
        });
        const ranked = rankByName(f.name.value, pool, { threshold: 0.45, limit: 5 });
        if (ranked.length) {
          const rows = await this.prisma.teamMember.findMany({
            where: { id: { in: ranked.map((r) => r.id) } },
            select: MEMBER_SELECT,
          });
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const r of ranked) {
            const m = byId.get(r.id);
            if (m) suggestedMembers.push(this.suggestion(m, 'NAME', r.score));
          }
        }
      }
    }

    // Like ID-card photo views (ADR-050): every view is audited, flagged when the full ID was returned.
    await this.audit.logCtx(ctx, {
      action: AuditAction.VIOLATION_OCR_VIEWED,
      entityType: 'violation',
      entityId: id,
      after: { status: job.status, fullNationalId: full && !!f?.nationalId, suggestions: suggestedMembers.length },
    });
    return {
      status: job.status,
      attempts: job.attempts,
      extractedAt: job.extractedAt?.toISOString() ?? null,
      error: job.status === 'FAILED' ? job.error : null,
      fields,
      suggestedMembers,
      suggestedUsers,
    };
  }

  private suggestion(
    m: Prisma.TeamMemberGetPayload<{ select: typeof MEMBER_SELECT }>,
    match: 'NATIONAL_ID' | 'NAME',
    score: number,
  ): ViolationSuggestionDto {
    const team = m.memberships[0]?.team;
    return {
      memberId: m.id,
      fullName: m.fullName,
      nationalIdMasked: maskNationalIdParts(m.nationalIdFirst, m.nationalIdLast4),
      team: team ? toTeamSummary(team) : null,
      hasPhoto: !!m.photoFileId,
      match,
      score,
    };
  }

  /** Admin: run the OCR again (after a FAILED job or a poor read). */
  async retryOcr(id: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.violations.findScoped(id, viewer);
    await this.ocr.retry(id);
    // Security review A9 L7: a new read yields new national-ID data, so the retry is audited.
    await this.audit.logCtx(ctx, { action: AuditAction.VIOLATION_OCR_RETRIED, entityType: 'violation', entityId: id });
  }

  // ─────────────────────────────────────────── assign / unassign

  async assign(id: string, memberId: string, viewer: Viewer, ctx: RequestContext): Promise<ViolationDto> {
    const current = await this.loadForAssign(id, viewer);
    if (current.memberId === memberId) return this.violations.toDto(current, viewer);
    if (current.memberId) throw new AppError('VIOLATION_ALREADY_ASSIGNED');
    const member = await this.prisma.teamMember.findUnique({ where: { id: memberId }, select: { archivedAt: true } });
    if (!member || member.archivedAt) {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: { memberId: ['العضو غير موجود'] } });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await this.assignInTx(tx, id, memberId, viewer, ctx, 'assign');
      return tx.violation.findUniqueOrThrow({ where: { id }, select: VIOLATION_SELECT });
    });
    return this.violations.toDto(row, viewer);
  }

  /**
   * Links the member and resolves the snapshot at captured_at, under a row lock so two people
   * cannot assign the same violation at once.
   */
  private async assignInTx(
    tx: Tx,
    id: string,
    memberId: string,
    viewer: Viewer,
    ctx: RequestContext,
    via: 'assign' | 'register',
  ): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ member_id: string | null; captured_at: Date }>>`
      SELECT member_id, captured_at FROM violations WHERE id = ${id}::uuid AND workspace_id = ${activeWorkspaceId()}::uuid FOR UPDATE`;
    const v = locked[0];
    if (!v) throw new AppError('NOT_FOUND');
    if (v.member_id) {
      if (v.member_id === memberId) return;
      throw new AppError('VIOLATION_ALREADY_ASSIGNED');
    }
    const snap = await this.violations.resolveSnapshot(tx, memberId, new Date(v.captured_at));
    await tx.violation.update({
      where: { id },
      data: {
        memberId,
        teamIdSnapshot: snap.teamId,
        supervisorIdSnapshot: snap.supervisorId,
        supervisorIdsSnapshot: snap.supervisorIds,
        assignedAt: new Date(),
        assignedById: viewer.id,
      },
    });
    await this.audit.logCtx(
      ctx,
      {
        action: AuditAction.VIOLATION_ASSIGNED,
        entityType: 'violation',
        entityId: id,
        before: { memberId: null },
        after: {
          memberId,
          via,
          teamIdSnapshot: snap.teamId,
          supervisorIdSnapshot: snap.supervisorId,
          supervisorIdsSnapshot: snap.supervisorIds,
        },
      },
      tx,
    );
  }

  /** Admin: back to "unassigned" (wrong person); the snapshot is cleared with the member. */
  async unassign(id: string, reason: string | undefined, viewer: Viewer, ctx: RequestContext): Promise<ViolationDto> {
    const current = await this.violations.findScoped(id, viewer);
    if (!current.memberId) return this.violations.toDto(current, viewer);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM violations WHERE id = ${id}::uuid AND workspace_id = ${activeWorkspaceId()}::uuid FOR UPDATE`;
      await tx.violation.update({
        where: { id },
        data: {
          memberId: null,
          teamIdSnapshot: EMPTY_SNAPSHOT.teamId,
          supervisorIdSnapshot: EMPTY_SNAPSHOT.supervisorId,
          supervisorIdsSnapshot: [],
          assignedAt: null,
          assignedById: null,
        },
      });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.VIOLATION_UNASSIGNED,
          entityType: 'violation',
          entityId: id,
          before: {
            memberId: current.memberId,
            teamIdSnapshot: current.teamIdSnapshot,
            supervisorIdsSnapshot: current.supervisorIdsSnapshot,
          },
          after: { memberId: null, reason: reason ?? null },
        },
        tx,
      );
      return tx.violation.findUniqueOrThrow({ where: { id }, select: VIOLATION_SELECT });
    });
    return this.violations.toDto(row, viewer);
  }

  // ─────────────────────────────────────────── register a new member from the card

  /**
   * Creates the member from the (OCR-confirmed) card data, copies the violation's PERSON photo to
   * a new member-photo object, then assigns the violation. With `teamId` the membership starts at
   * captured_at (the person was evidently on that team when recorded), so the snapshot resolves
   * to that team; without one the member is created unassigned.
   *
   * Security review A9 M1 (ADR-118): admins only (the route requires `members.manage`, and the
   * service checks it again), so only an admin ever copies a PERSON photo into a member photo.
   * The backdated membership is bounded: with a team, captured_at must lie within the last
   * `VIOLATION_REGISTER_MAX_AGE_DAYS` days and not in the future (beyond the clock-drift threshold).
   */
  async registerMember(
    id: string,
    input: RegisterMemberData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<RegisterViolationMemberResultDto> {
    if (!can(viewer, 'members.manage')) throw new AppError('FORBIDDEN');
    const v = await this.violations.findScoped(id, viewer);
    if (v.memberId) throw new AppError('VIOLATION_ALREADY_ASSIGNED');
    if (input.teamId) await this.assertRegisterWindow(v.capturedAt);

    // The person photo is copied before the transaction (S3 is not transactional); a failed
    // transaction deletes the copy again.
    const photo = input.usePersonPhoto ? await this.copyPersonPhoto(id) : null;
    try {
      const memberRow = await hideDuplicateNationalId(viewer, this.audit, ctx, { via: 'violations.register_member', violationId: id }, () =>
        this.withErrors(() =>
          this.prisma.$transaction(async (tx) => {
            if (input.teamId) {
              const team = await tx.team.findUnique({
                where: { id: input.teamId },
                select: { status: true, supervisors: OPEN_LEADERS },
              });
              if (!team) throw new AppError('NOT_FOUND', { field: 'teamId' });
              if (!canManageMemberIn(viewer, team)) throw new AppError('FORBIDDEN');
              if (team.status === 'ARCHIVED') throw new AppError('TEAM_ARCHIVED');
            }
            await assertReferencesExist(tx, [input]);
            const p = this.crypto.protectNationalId(input.nationalId);
            const dup = await tx.teamMember.findFirst({ where: { nationalIdHash: p.hash }, select: { id: true } });
            if (dup) {
              // Admins learn which member holds the ID (assign that one instead).
              throw new AppError('NATIONAL_ID_TAKEN', {
                fieldErrors: { nationalId: ['رقم الهوية مسجّل لعضو آخر'] },
                existingMemberId: dup.id,
              });
            }
            const now = new Date();
            const memberId = randomUUID();
            if (photo) {
              await tx.file.create({
                data: {
                  id: photo.fileId,
                  storageKey: photo.key,
                  bucket: this.storage.bucket,
                  mimeType: photo.mimeType,
                  sizeBytes: photo.sizeBytes,
                  sha256: photo.sha256,
                  status: 'READY',
                  uploadedById: viewer.id,
                  entityType: 'member_photo',
                  entityId: memberId,
                  kind: 'PHOTO',
                },
              });
            }
            await tx.teamMember.create({
              data: {
                id: memberId,
                fullName: input.fullName,
                nationalIdEnc: p.enc,
                nationalIdHash: p.hash,
                nationalIdFirst: p.first,
                nationalIdLast4: p.last4,
                jobTitleId: input.jobTitleId ?? null,
                jobTitleText: input.jobTitleId ? null : (input.jobTitleText ?? null),
                departmentId: input.departmentId ?? null,
                departmentText: input.departmentId ? null : (input.departmentText ?? null),
                photoFileId: photo?.fileId ?? null,
                createdById: viewer.id,
              },
            });
            if (input.teamId) {
              const from = v.capturedAt < now ? v.capturedAt : now;
              await tx.teamMembership.create({
                data: { memberId, teamId: input.teamId, validFrom: from, movedById: viewer.id, reason: 'تسجيل من مخالفة' },
              });
            }
            await this.audit.logCtx(
              ctx,
              {
                action: AuditAction.MEMBER_CREATED,
                entityType: 'member',
                entityId: memberId,
                after: {
                  fullName: input.fullName,
                  nationalIdMasked: maskNationalIdParts(p.first, p.last4),
                  teamId: input.teamId ?? null,
                  fromViolationId: id,
                },
              },
              tx,
            );
            if (photo) {
              await this.audit.logCtx(
                ctx,
                {
                  action: AuditAction.MEMBER_PHOTO_UPDATED,
                  entityType: 'member',
                  entityId: memberId,
                  before: { photoFileId: null },
                  after: { photoFileId: photo.fileId, fromViolationId: id },
                },
                tx,
              );
            }
            await this.audit.logCtx(
              ctx,
              {
                action: AuditAction.VIOLATION_MEMBER_REGISTERED,
                entityType: 'violation',
                entityId: id,
                after: { memberId, teamId: input.teamId ?? null, photoCopied: !!photo },
              },
              tx,
            );
            await this.assignInTx(tx, id, memberId, viewer, ctx, 'register');
            return tx.teamMember.findUniqueOrThrow({ where: { id: memberId }, select: MEMBER_SELECT });
          }),
        ),
      );
      let violation: ViolationDto | null = null;
      try {
        violation = await this.violations.toDto(await this.violations.findScoped(id, viewer), viewer);
      } catch {
        violation = null; // e.g. a supervisor whose team hides violations
      }
      return { member: toMemberDto(memberRow, { viewer, full: true, crypto: this.crypto }), violation };
    } catch (err) {
      if (photo) await this.storage.delete(photo.key).catch(() => undefined);
      throw err;
    }
  }

  /**
   * M1: a membership backdated to captured_at is allowed only for a recent capture. Older (or
   * future-dated, beyond the drift threshold) captures are refused: register the member from the
   * team page (membership from today) and assign the violation afterwards.
   */
  private async assertRegisterWindow(capturedAt: Date, now = new Date()): Promise<void> {
    const [maxAgeDays, driftMinutes] = await Promise.all([
      this.settings.get('VIOLATION_REGISTER_MAX_AGE_DAYS'),
      this.settings.get('CLOCK_DRIFT_THRESHOLD_MINUTES'),
    ]);
    const age = now.getTime() - capturedAt.getTime();
    if (age > maxAgeDays * 86_400_000 || age < -driftMinutes * 60_000) {
      throw new AppError('VIOLATION_TOO_OLD_TO_REGISTER', { maxAgeDays, capturedAt: capturedAt.toISOString() });
    }
  }

  /** Server-side copy of the violation's PERSON photo to a fresh member-photo key. */
  private async copyPersonPhoto(
    violationId: string,
  ): Promise<{ fileId: string; key: string; mimeType: string; sizeBytes: number; sha256: string | null } | null> {
    const link = await this.prisma.violationFile.findFirst({
      where: { violationId, kind: 'PERSON', file: { status: 'READY', deletedAt: null } },
      select: { file: { select: { storageKey: true, mimeType: true, sizeBytes: true, sha256: true } } },
    });
    if (!link || !(link.file.mimeType in EXTENSIONS)) return null;
    const fileId = randomUUID();
    const key = buildObjectKey('member-photos', link.file.mimeType as DetectedType, fileId);
    try {
      await this.storage.copy(link.file.storageKey, key);
    } catch (err) {
      this.logger.warn(`Person photo copy failed for violation ${violationId}: ${(err as Error).name}`);
      return null;
    }
    return { fileId, key, mimeType: link.file.mimeType, sizeBytes: link.file.sizeBytes, sha256: link.file.sha256 };
  }

  private async withErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw (err instanceof AppError ? err : mapPrismaError(err)) ?? err;
    }
  }
}

