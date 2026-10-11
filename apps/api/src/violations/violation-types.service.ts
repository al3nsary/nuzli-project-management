import { Injectable } from '@nestjs/common';
import { can, type Severity, type ViolationTypeDto } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import type { Viewer } from '../teams/team-dto';
import { toTypeDto, VIOLATION_TYPE_SELECT } from './violation-dto';

export interface ViolationTypeInput {
  name: string;
  severity: Severity | null;
  isActive: boolean;
}

/**
 * The admin-managed catalogue (brief §7.2). The system seed creates no types (the owner
 * provides them); demo placeholders come only from `npm run seed:demo`. Types are never
 * deleted — deactivate them so past violations keep their type.
 */
@Injectable()
export class ViolationTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Viewers who cannot manage the catalogue always get the active types only. */
  async list(activeRequested: boolean, viewer: Viewer): Promise<ViolationTypeDto[]> {
    const activeOnly = activeRequested || !can(viewer, 'violations.manage');
    const rows = await this.prisma.violationType.findMany({
      where: activeOnly ? { isActive: true } : {},
      select: VIOLATION_TYPE_SELECT,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toTypeDto);
  }

  async create(input: ViolationTypeInput, ctx: RequestContext): Promise<ViolationTypeDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.violationType.create({
          data: { name: input.name, severity: input.severity, isActive: input.isActive, createdById: ctx.actorId },
          select: VIOLATION_TYPE_SELECT,
        });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.VIOLATION_TYPE_CREATED, entityType: 'violation_type', entityId: created.id, after: created },
          tx,
        );
        return created;
      }),
    );
    return toTypeDto(row);
  }

  async update(id: string, patch: Partial<ViolationTypeInput>, ctx: RequestContext): Promise<ViolationTypeDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.violationType.findUnique({ where: { id }, select: VIOLATION_TYPE_SELECT });
        if (!before) throw new AppError('NOT_FOUND');
        const after = await tx.violationType.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
          select: VIOLATION_TYPE_SELECT,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.VIOLATION_TYPE_UPDATED,
            entityType: 'violation_type',
            entityId: id,
            before: { name: before.name, severity: before.severity, isActive: before.isActive },
            after: { name: after.name, severity: after.severity, isActive: after.isActive },
          },
          tx,
        );
        return after;
      }),
    );
    return toTypeDto(row);
  }
}
