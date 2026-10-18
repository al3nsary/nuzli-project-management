import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createOrgPositionSchema,
  createOrgUnitSchema,
  moveOrgPositionSchema,
  moveOrgUnitSchema,
  orgTreeQuerySchema,
  updateOrgPositionSchema,
  updateOrgUnitSchema,
  type OrgPositionDto,
  type OrgTreeDto,
  type OrgUnitDto,
} from '@nuzli/shared';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { OrgService } from './org.service';

/** A9 organisational structure (ADR-102): `org.read` (admins, supervisors) reads; `org.manage` (admins) writes. */
@ApiTags('org')
@ApiBearerAuth()
@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get()
  @RequirePermission('org.read')
  @ApiOperation({ summary: 'الهيكل الإداري كاملًا: الوحدات والمناصب وشاغلوها والفرق المرتبطة' })
  tree(@ZodQuery(orgTreeQuerySchema) q: z.output<typeof orgTreeQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<OrgTreeDto> {
    return this.org.tree(viewer, q.includeArchived);
  }

  @Post('units')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'إضافة وحدة تنظيمية' })
  createUnit(
    @ZodBody(createOrgUnitSchema) body: z.output<typeof createOrgUnitSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgUnitDto> {
    return this.org.createUnit(body, ctx);
  }

  @Patch('units/:id')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'تعديل وحدة أو أرشفتها أو استعادتها' })
  updateUnit(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateOrgUnitSchema) body: z.output<typeof updateOrgUnitSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgUnitDto> {
    return this.org.updateUnit(id, body, ctx);
  }

  @Post('units/:id/move')
  @HttpCode(200)
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'نقل وحدة تحت وحدة أخرى أو إعادة ترتيبها (يُرفض ما يصنع حلقة)' })
  moveUnit(
    @Param('id', UuidPipe) id: string,
    @ZodBody(moveOrgUnitSchema) body: z.output<typeof moveOrgUnitSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgUnitDto> {
    return this.org.moveUnit(id, body, ctx);
  }

  @Delete('units/:id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'حذف وحدة فارغة' })
  deleteUnit(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.org.deleteUnit(id, ctx);
  }

  @Post('positions')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'إضافة منصب (يشغله مستخدم أو عضو أو يبقى شاغرًا)' })
  createPosition(
    @ZodBody(createOrgPositionSchema) body: z.output<typeof createOrgPositionSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgPositionDto> {
    return this.org.createPosition(body, ctx);
  }

  @Patch('positions/:id')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'تعديل منصب أو شاغله أو تبعيته' })
  updatePosition(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateOrgPositionSchema) body: z.output<typeof updateOrgPositionSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgPositionDto> {
    return this.org.updatePosition(id, body, ctx);
  }

  @Post('positions/:id/move')
  @HttpCode(200)
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'نقل منصب إلى وحدة أو تبعية أخرى أو إعادة ترتيبه' })
  movePosition(
    @Param('id', UuidPipe) id: string,
    @ZodBody(moveOrgPositionSchema) body: z.output<typeof moveOrgPositionSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<OrgPositionDto> {
    return this.org.movePosition(id, body, ctx);
  }

  @Delete('positions/:id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'حذف منصب (المناصب التابعة له تصبح دون تبعية)' })
  deletePosition(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.org.deletePosition(id, ctx);
  }
}
