import { Injectable } from '@nestjs/common';
import { can, type ReferenceItemDto } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import type { Viewer } from '../teams/team-dto';

/** URL segment → entity. Departments and job titles share one implementation (brief §10). */
export const REFERENCE_KINDS = {
  departments: 'department',
  'job-titles': 'job_title',
} as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[keyof typeof REFERENCE_KINDS];

interface Row {
  id: string;
  name: string;
  isActive: boolean;
}

/** The two Prisma delegates have the same shape; this narrows them to what we use. */
interface Delegate {
  findMany(args: object): Promise<Row[]>;
  findUnique(args: object): Promise<Row | null>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
}

const SELECT = { id: true, name: true, isActive: true };

export type DeleteResult = { result: 'DELETED' | 'DEACTIVATED'; item: ReferenceItemDto };

function toDto(r: Row): ReferenceItemDto {
  return { id: r.id, name: r.name, isActive: r.isActive };
}

@Injectable()
export class ReferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private delegate(kind: ReferenceKind, db: Db = this.prisma): Delegate {
    return (kind === 'department' ? db.department : db.jobTitle) as unknown as Delegate;
  }

  private async usage(kind: ReferenceKind, id: string, db: Db): Promise<number> {
    return db.teamMember.count({ where: kind === 'department' ? { departmentId: id } : { jobTitleId: id } });
  }

  /** Admins see inactive entries too (to restore them); everyone else gets the active list. */
  async list(kind: ReferenceKind, viewer: Viewer): Promise<ReferenceItemDto[]> {
    const all = can(viewer, 'reference.manage');
    const rows = await this.delegate(kind).findMany({
      where: all ? {} : { isActive: true },
      select: SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toDto);
  }

  async create(kind: ReferenceKind, name: string, ctx: RequestContext): Promise<ReferenceItemDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await this.delegate(kind, tx).create({
          data: { name, createdById: ctx.actorId },
          select: SELECT,
        });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.REFERENCE_CREATED, entityType: kind, entityId: created.id, after: created },
          tx,
        );
        return created;
      }),
    );
    return toDto(row);
  }

  async update(
    kind: ReferenceKind,
    id: string,
    patch: { name?: string; isActive?: boolean },
    ctx: RequestContext,
  ): Promise<ReferenceItemDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const d = this.delegate(kind, tx);
        const before = await d.findUnique({ where: { id }, select: SELECT });
        if (!before) throw new AppError('NOT_FOUND');
        const after = await d.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
          select: SELECT,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.REFERENCE_UPDATED,
            entityType: kind,
            entityId: id,
            before: { name: before.name, isActive: before.isActive },
            after: { name: after.name, isActive: after.isActive },
          },
          tx,
        );
        return after;
      }),
    );
    return toDto(row);
  }

  /** Delete when unused; when members reference it, deactivate instead (history stays intact). */
  async remove(kind: ReferenceKind, id: string, ctx: RequestContext): Promise<DeleteResult> {
    return this.prisma.$transaction(async (tx) => {
      const d = this.delegate(kind, tx);
      const before = await d.findUnique({ where: { id }, select: SELECT });
      if (!before) throw new AppError('NOT_FOUND');
      const used = await this.usage(kind, id, tx);
      const result: DeleteResult['result'] = used > 0 ? 'DEACTIVATED' : 'DELETED';
      const row =
        result === 'DELETED'
          ? await d.delete({ where: { id }, select: SELECT })
          : await d.update({ where: { id }, data: { isActive: false }, select: SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.REFERENCE_DELETED,
          entityType: kind,
          entityId: id,
          before: { name: before.name, isActive: before.isActive },
          after: { result, membersUsing: used },
        },
        tx,
      );
      return { result, item: toDto(result === 'DELETED' ? row : { ...row, isActive: false }) };
    });
  }
}
