import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  cardPreviewSchema,
  cardSizeSchema,
  cardTemplateSchema,
  logoInputSchema,
  paginationQuery,
  printBatchSchema,
  updateCardTemplateSchema,
  type CardPreviewDto,
  type CardSizeDto,
  type CardTemplateDto,
  type LogoDto,
  type Paginated,
  type PrintBatchCreatedDto,
  type PrintBatchDetailDto,
  type PrintBatchDto,
} from '@nuzli/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { CardsService } from './cards.service';
import { PrintService } from './print.service';

@ApiTags('cards')
@ApiBearerAuth()
@Controller('cards')
export class CardsController {
  constructor(
    private readonly cards: CardsService,
    private readonly print: PrintService,
  ) {}

  // ─────────────── sizes

  @Get('sizes')
  @RequireAnyPermission('cards.print', 'cards.manageTemplates', 'cards.read')
  @ApiOperation({ summary: 'مقاسات الكروت' })
  sizes(): Promise<CardSizeDto[]> {
    return this.cards.listSizes();
  }

  @Post('sizes')
  @RequirePermission('cards.manageTemplates')
  @ApiOperation({ summary: 'إضافة مقاس مخصّص (مم)' })
  createSize(
    @ZodBody(cardSizeSchema) body: z.output<typeof cardSizeSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CardSizeDto> {
    return this.cards.createSize(body, ctx);
  }

  @Delete('sizes/:id')
  @HttpCode(204)
  @RequirePermission('cards.manageTemplates')
  @ApiOperation({ summary: 'حذف مقاس مخصّص (المقاسات المدمجة لا تُحذف)' })
  deleteSize(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.cards.deleteSize(id, ctx);
  }

  // ─────────────── templates

  @Get('templates')
  @RequireAnyPermission('cards.print', 'cards.manageTemplates', 'cards.read')
  @ApiOperation({ summary: 'قوالب الكروت' })
  templates(): Promise<CardTemplateDto[]> {
    return this.cards.listTemplates();
  }

  @Post('templates')
  @RequirePermission('cards.manageTemplates')
  @ApiOperation({ summary: 'إنشاء قالب' })
  createTemplate(
    @ZodBody(cardTemplateSchema) body: z.output<typeof cardTemplateSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CardTemplateDto> {
    return this.cards.createTemplate(body, ctx);
  }

  @Patch('templates/:id')
  @RequirePermission('cards.manageTemplates')
  @ApiOperation({ summary: 'تعديل قالب' })
  updateTemplate(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateCardTemplateSchema) body: z.output<typeof updateCardTemplateSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CardTemplateDto> {
    return this.cards.updateTemplate(id, body, ctx);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @RequirePermission('cards.manageTemplates')
  @ApiOperation({ summary: 'أرشفة قالب' })
  archiveTemplate(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.cards.archiveTemplate(id, ctx);
  }

  // ─────────────── preview & print

  @Post('preview')
  @HttpCode(200)
  // Security review M3: a preview may decrypt up to 1,000 full IDs — rate limited and audited.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('cards.print')
  @ApiOperation({ summary: 'معاينة الكروت لفرق أو أعضاء (مع المشرفين)' })
  preview(
    @ZodBody(cardPreviewSchema) body: z.output<typeof cardPreviewSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CardPreviewDto> {
    return this.print.preview(body, viewer, ctx);
  }

  @Post('batches')
  @RequirePermission('cards.print')
  @ApiOperation({
    summary: 'تسجيل دفعة طباعة (تكرار المفتاح نفسه يعيد الدفعة الأصلية بـ 200)',
    description: 'The answer carries `cards` for this print run (full national IDs only here, when the template prints them).',
  })
  async createBatch(
    @ZodBody(printBatchSchema) body: z.output<typeof printBatchSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrintBatchCreatedDto> {
    const { created, batch } = await this.print.createBatch(body, viewer, ctx);
    res.status(created ? 201 : 200);
    return batch;
  }

  @Get('batches')
  @RequireAnyPermission('cards.print', 'cards.read')
  @ApiOperation({ summary: 'سجل الطباعة' })
  batches(@ZodQuery(paginationQuery) q: z.output<typeof paginationQuery>): Promise<Paginated<PrintBatchDto>> {
    return this.print.listBatches(q);
  }

  @Get('batches/:id')
  @RequireAnyPermission('cards.print', 'cards.read')
  @ApiOperation({ summary: 'دفعة طباعة بكروتها' })
  batch(@Param('id', UuidPipe) id: string): Promise<PrintBatchDetailDto> {
    return this.print.getBatch(id);
  }

  @Get('batches/:id/pdf')
  @RequirePermission('cards.print')
  @ApiOperation({ summary: 'ملف PDF من الخادم بمقاسات دقيقة (501 حتى تُضبط خدمة PDF)' })
  pdf(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext, @Res() res: Response): Promise<void> {
    return this.print.streamPdf(id, res, ctx);
  }
}

@ApiTags('cards')
@ApiBearerAuth()
@Controller('logos')
export class LogosController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  @RequireAnyPermission('cards.print', 'logos.manage', 'cards.read')
  @ApiOperation({ summary: 'الشعارات (مع رابط عرض مؤقت)' })
  list(): Promise<LogoDto[]> {
    return this.cards.listLogos();
  }

  @Post()
  @RequirePermission('logos.manage')
  @ApiOperation({ summary: 'إضافة شعار من ملف مرفوع (entityType=logo)' })
  create(@ZodBody(logoInputSchema) body: z.output<typeof logoInputSchema>, @ReqCtx() ctx: RequestContext): Promise<LogoDto> {
    return this.cards.createLogo(body, ctx);
  }

  @Post(':id/default')
  @HttpCode(200)
  @RequirePermission('logos.manage')
  @ApiOperation({ summary: 'جعل الشعار افتراضيًّا' })
  setDefault(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<LogoDto> {
    return this.cards.setDefaultLogo(id, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('logos.manage')
  @ApiOperation({ summary: 'حذف شعار (القوالب المرتبطة تعود إلى الشعار الافتراضي)' })
  remove(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.cards.deleteLogo(id, ctx);
  }
}
