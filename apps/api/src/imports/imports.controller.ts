import { Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  importCommitSchema,
  importJiraSchema,
  importProjectSchema,
  type ImportCommitResultDto,
  type ImportPreviewDto,
} from '@nuzli/shared';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { ZodBody } from '../common/zod-openapi';
import { ImportsService } from './imports.service';

/**
 * A9 project imports (owner decision 3; docs/API.md "A9 — imports, exports, hours").
 * Admin only (`projects.create`). Parsing is CPU-bound, so the routes are rate limited.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/import')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission('projects.create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'معاينة استيراد ملف (Excel أو CSV أو MS Project XML أو ‎.mpp أو CSV من Jira) — تبقى ساعة' })
  preview(
    @ZodBody(importProjectSchema) body: z.output<typeof importProjectSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ImportPreviewDto> {
    return this.imports.previewFile(body, viewer, ctx);
  }

  @Post('jira')
  @HttpCode(200)
  @RequirePermission('projects.create')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'معاينة استيراد من Jira Cloud (الرمز يُستعمل لهذا الطلب فقط ولا يُحفظ)' })
  previewJira(
    @ZodBody(importJiraSchema) body: z.output<typeof importJiraSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ImportPreviewDto> {
    return this.imports.previewJira(body, viewer, ctx);
  }

  @Post('commit')
  @RequirePermission('projects.create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'اعتماد المعاينة: إنشاء المشروع وتقويمه ومهامه واعتمادياته في معاملة واحدة' })
  commit(
    @ZodBody(importCommitSchema) body: z.output<typeof importCommitSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ImportCommitResultDto> {
    return this.imports.commit(body, viewer, ctx);
  }
}
