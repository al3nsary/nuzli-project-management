import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CardSizeDto, CardTemplateConfig, CardTemplateDto, LogoDto } from '@nuzli/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { TEMPLATE_SELECT, toSizeDto, toTemplateDto } from './card-data';

type Tx = Prisma.TransactionClient;

export interface TemplateInput {
  name: string;
  sizeId: string;
  orientation: 'LANDSCAPE' | 'PORTRAIT';
  layoutKey: 'CLASSIC_HORIZONTAL' | 'VERTICAL_BADGE' | 'COMPACT_LABEL';
  config: CardTemplateConfig;
  isDefault: boolean;
  logoId?: string | null;
}

const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Card sizes, templates and logos (brief §8.2–8.4). Admin-managed. */
@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  // ─────────────────────────────────────────── sizes

  async listSizes(): Promise<CardSizeDto[]> {
    const rows = await this.prisma.cardSize.findMany({
      orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toSizeDto);
  }

  async createSize(input: { name: string; widthMm: number; heightMm: number }, ctx: RequestContext): Promise<CardSizeDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.cardSize.create({
          data: { ...input, isBuiltin: false, createdById: ctx.actorId },
        });
        await this.audit.logCtx(
          ctx,
          { action: AuditAction.CARD_SIZE_CREATED, entityType: 'card_size', entityId: created.id, after: input },
          tx,
        );
        return created;
      }),
    );
    return toSizeDto(row);
  }

  async deleteSize(id: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const size = await tx.cardSize.findUnique({ where: { id } });
      if (!size) throw new AppError('NOT_FOUND');
      if (size.isBuiltin) throw new AppError('BUILTIN_LOCKED');
      const used = await tx.cardTemplate.count({ where: { sizeId: id } });
      if (used) throw new AppError('IN_USE', { templates: used });
      await tx.cardSize.delete({ where: { id } });
      await this.audit.logCtx(
        ctx,
        { action: AuditAction.CARD_SIZE_DELETED, entityType: 'card_size', entityId: id, before: toSizeDto(size) },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── templates

  async listTemplates(): Promise<CardTemplateDto[]> {
    const rows = await this.prisma.cardTemplate.findMany({
      where: { archivedAt: null },
      select: TEMPLATE_SELECT,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toTemplateDto);
  }

  async getTemplate(id: string, db: Tx | PrismaService = this.prisma) {
    const row = await db.cardTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
    if (!row || row.archivedAt) throw new AppError('NOT_FOUND');
    return row;
  }

  private async assertTemplateRefs(tx: Tx, sizeId?: string, logoId?: string | null): Promise<void> {
    const fieldErrors: Record<string, string[]> = {};
    if (sizeId && !(await tx.cardSize.findUnique({ where: { id: sizeId }, select: { id: true } }))) {
      fieldErrors.sizeId = ['المقاس غير موجود'];
    }
    if (logoId && !(await tx.logo.findUnique({ where: { id: logoId }, select: { id: true } }))) {
      fieldErrors.logoId = ['الشعار غير موجود'];
    }
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
  }

  /** One default template at a time (partial unique index `card_templates_one_default_uq`). */
  private async clearDefaultTemplate(tx: Tx, exceptId?: string): Promise<void> {
    await tx.cardTemplate.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  async createTemplate(input: TemplateInput, ctx: RequestContext): Promise<CardTemplateDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        await this.assertTemplateRefs(tx, input.sizeId, input.logoId);
        if (input.isDefault) await this.clearDefaultTemplate(tx);
        const created = await tx.cardTemplate.create({
          data: {
            name: input.name,
            sizeId: input.sizeId,
            orientation: input.orientation,
            layoutKey: input.layoutKey,
            config: input.config as Prisma.InputJsonValue,
            isDefault: input.isDefault,
            logoId: input.logoId ?? null,
            createdById: ctx.actorId,
          },
          select: TEMPLATE_SELECT,
        });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.CARD_TEMPLATE_CREATED,
            entityType: 'card_template',
            entityId: created.id,
            after: toTemplateDto(created),
          },
          tx,
        );
        return created;
      }),
    );
    return toTemplateDto(row);
  }

  async updateTemplate(id: string, patch: Partial<TemplateInput>, ctx: RequestContext): Promise<CardTemplateDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.getTemplate(id, tx);
        await this.assertTemplateRefs(tx, patch.sizeId, patch.logoId);
        if (patch.isDefault) await this.clearDefaultTemplate(tx, id);
        const data: Prisma.CardTemplateUncheckedUpdateInput = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sizeId !== undefined ? { sizeId: patch.sizeId } : {}),
          ...(patch.orientation !== undefined ? { orientation: patch.orientation } : {}),
          ...(patch.layoutKey !== undefined ? { layoutKey: patch.layoutKey } : {}),
          ...(patch.config !== undefined ? { config: patch.config as Prisma.InputJsonValue } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.logoId !== undefined ? { logoId: patch.logoId } : {}),
        };
        const after = await tx.cardTemplate.update({ where: { id }, data, select: TEMPLATE_SELECT });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.CARD_TEMPLATE_UPDATED,
            entityType: 'card_template',
            entityId: id,
            before: toTemplateDto(before),
            after: toTemplateDto(after),
          },
          tx,
        );
        return after;
      }),
    );
    return toTemplateDto(row);
  }

  /** Delete = archive: print batches keep pointing at it (and carry their own snapshot). */
  async archiveTemplate(id: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.getTemplate(id, tx);
      await tx.cardTemplate.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.CARD_TEMPLATE_ARCHIVED,
          entityType: 'card_template',
          entityId: id,
          before: { name: before.name, isDefault: before.isDefault },
        },
        tx,
      );
    });
  }

  // ─────────────────────────────────────────── logos

  async listLogos(): Promise<LogoDto[]> {
    const rows = await this.prisma.logo.findMany({
      include: { file: { select: { storageKey: true, deletedAt: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const ttl = await this.settings.get('PRESIGNED_URL_TTL_SECONDS');
    return Promise.all(
      rows.map(async (l) => {
        const dto: LogoDto = { id: l.id, name: l.name, fileId: l.fileId, isDefault: l.isDefault };
        if (!l.file.deletedAt) {
          try {
            dto.url = await this.storage.presignGet(l.file.storageKey, ttl);
          } catch (err) {
            this.logger.warn(`Logo URL failed for ${l.id}: ${(err as Error).message}`);
          }
        }
        return dto;
      }),
    );
  }

  async createLogo(input: { name: string; fileId: string; isDefault: boolean }, ctx: RequestContext): Promise<LogoDto> {
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const file = await tx.file.findUnique({ where: { id: input.fileId } });
        if (!file || file.deletedAt) throw new AppError('NOT_FOUND', { field: 'fileId' });
        if (file.status !== 'READY') throw new AppError('FILE_NOT_UPLOADED');
        if (file.entityType !== 'logo' || !LOGO_TYPES.has(file.mimeType)) throw new AppError('LOGO_FILE_INVALID');
        if (await tx.logo.findUnique({ where: { fileId: input.fileId }, select: { id: true } })) {
          throw new AppError('LOGO_FILE_INVALID', { reason: 'file already used by another logo' });
        }
        const first = (await tx.logo.count()) === 0;
        const isDefault = input.isDefault || first; // the first logo becomes the default
        if (isDefault) await tx.logo.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        const created = await tx.logo.create({
          data: { name: input.name, fileId: input.fileId, isDefault, createdById: ctx.actorId },
        });
        await tx.file.update({ where: { id: file.id }, data: { entityId: created.id, kind: file.kind ?? 'LOGO' } });
        await this.audit.logCtx(
          ctx,
          {
            action: AuditAction.LOGO_CREATED,
            entityType: 'logo',
            entityId: created.id,
            after: { name: created.name, fileId: created.fileId, isDefault },
          },
          tx,
        );
        return created;
      }),
    );
    return { id: row.id, name: row.name, fileId: row.fileId, isDefault: row.isDefault };
  }

  async setDefaultLogo(id: string, ctx: RequestContext): Promise<LogoDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const logo = await tx.logo.findUnique({ where: { id } });
      if (!logo) throw new AppError('NOT_FOUND');
      if (logo.isDefault) return logo;
      const previous = await tx.logo.findFirst({ where: { isDefault: true }, select: { id: true } });
      await tx.logo.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const after = await tx.logo.update({ where: { id }, data: { isDefault: true } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.LOGO_DEFAULT_SET,
          entityType: 'logo',
          entityId: id,
          before: { defaultLogoId: previous?.id ?? null },
          after: { defaultLogoId: id },
        },
        tx,
      );
      return after;
    });
    return { id: row.id, name: row.name, fileId: row.fileId, isDefault: row.isDefault };
  }

  /** Templates that pointed at the logo fall back to the default logo. The stored file is kept. */
  async deleteLogo(id: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const logo = await tx.logo.findUnique({ where: { id } });
      if (!logo) throw new AppError('NOT_FOUND');
      const detached = await tx.cardTemplate.updateMany({ where: { logoId: id }, data: { logoId: null } });
      await tx.logo.delete({ where: { id } });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.LOGO_DELETED,
          entityType: 'logo',
          entityId: id,
          before: { name: logo.name, fileId: logo.fileId, isDefault: logo.isDefault },
          after: { templatesDetached: detached.count },
        },
        tx,
      );
    });
  }
}
