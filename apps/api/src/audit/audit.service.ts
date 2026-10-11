import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditEntryDto, Paginated } from '@nuzli/shared';
import { paginate } from '../common/pagination';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { sanitizeForAudit } from './audit-sanitize';

/**
 * Audit actions (string column; keep them stable). The first nine are the Phase 1
 * vocabulary agreed with the web app (ADR-028); the rest are API-only additions.
 */
export const AuditAction = {
  REGISTRATION_REQUESTED: 'registration.requested',
  REGISTRATION_APPROVED: 'registration.approved',
  REGISTRATION_REJECTED: 'registration.rejected',
  USER_CREATED: 'user.created',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  SETTINGS_UPDATED: 'settings.updated',
  PASSWORD_CHANGED: 'auth.password_changed',
  // API-only additions (labelled «إجراء آخر» by the web until it adds them):
  PASSWORD_RESET: 'auth.password_reset',
  REFRESH_REUSE_DETECTED: 'auth.refresh_reuse_detected',
  BOOTSTRAP_ADMIN_CREATED: 'user.bootstrap_admin_created',
  ID_CARD_URL_ISSUED: 'file.id_card_url_issued',
  // Phase 2 — teams, members, reference data, cards (ADR-039):
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  TEAM_APPROVED: 'team.approved',
  TEAM_REJECTED: 'team.rejected',
  TEAM_ARCHIVED: 'team.archived',
  TEAM_SUPERVISOR_CHANGED: 'team.supervisor_changed',
  TEAM_VISIBILITY_CHANGED: 'team.visibility_changed',
  MEMBER_CREATED: 'member.created',
  MEMBER_UPDATED: 'member.updated',
  MEMBERS_MOVED: 'members.moved',
  MEMBERS_IMPORTED: 'members.imported',
  COLOR_CREATED: 'color.created',
  COLOR_UPDATED: 'color.updated',
  REFERENCE_CREATED: 'reference.created',
  REFERENCE_UPDATED: 'reference.updated',
  REFERENCE_DELETED: 'reference.deleted',
  CARD_TEMPLATE_CREATED: 'card_template.created',
  CARD_TEMPLATE_UPDATED: 'card_template.updated',
  CARD_TEMPLATE_ARCHIVED: 'card_template.archived',
  CARD_SIZE_CREATED: 'card_size.created',
  CARD_SIZE_DELETED: 'card_size.deleted',
  LOGO_CREATED: 'logo.created',
  LOGO_DELETED: 'logo.deleted',
  LOGO_DEFAULT_SET: 'logo.default_set',
  CARDS_PRINTED: 'cards.printed',
  CARDS_PDF_EXPORTED: 'cards.pdf_exported',
  // Phase 3 — violations (ADR-050):
  VIOLATION_TYPE_CREATED: 'violation_type.created',
  VIOLATION_TYPE_UPDATED: 'violation_type.updated',
  VIOLATION_UPDATED: 'violation.updated',
  VIOLATION_STATUS_CHANGED: 'violation.status_changed',
  VIOLATION_RESPONSE_ADDED: 'violation.response_added',
  VIOLATION_ID_PHOTO_VIEWED: 'violation.id_photo_viewed',
  VIOLATIONS_EXPORTED: 'violations.exported',
  VIOLATIONS_DASHBOARD_EXPORTED: 'violations.dashboard_exported',
  VIOLATION_PHOTOS_PURGED: 'violations.photos_purged',
} as const;

export interface AuditEntryInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  entityType?: string;
  actorId?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

/** A bare date as `to` means the end of that day. */
export function endOf(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
}

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const clean = sanitizeForAudit(value);
  return clean === null || clean === undefined ? Prisma.DbNull : (clean as Prisma.InputJsonValue);
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one entry. Pass the transaction client so the entry commits (or rolls back)
   * together with the change it describes.
   */
  async log(entry: AuditEntryInput, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /** Convenience: fills actor/ip/requestId from the request context. */
  logCtx(
    ctx: RequestContext,
    entry: Omit<AuditEntryInput, 'actorId' | 'ip' | 'requestId'>,
    db: Db = this.prisma,
  ): Promise<void> {
    return this.log({ ...entry, actorId: ctx.actorId, ip: ctx.ip, requestId: ctx.requestId }, db);
  }

  async list(q: AuditQuery): Promise<Paginated<AuditEntryDto>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to
        ? {
            at: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: endOf(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { id: true, fullName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(
      rows.map((r) => ({
        id: r.id,
        actor: r.actor ? { id: r.actor.id, fullName: r.actor.fullName } : null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        at: r.at.toISOString(),
      })),
      total,
      q.page,
      q.pageSize,
    );
  }
}
