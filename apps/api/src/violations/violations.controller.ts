import { Controller, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignViolationSchema,
  changeViolationStatusSchema,
  createViolationSchema,
  paginationQuery,
  registerViolationMemberSchema,
  unassignViolationSchema,
  updateViolationSchema,
  updateViolationTypeSchema,
  violationFilterSchema,
  violationResponseSchema,
  violationTypeSchema,
  type Paginated,
  type RegisterViolationMemberResultDto,
  type RosterResponse,
  type ViolationDto,
  type ViolationOcrDto,
  type ViolationStats,
  type ViolationTypeDto,
} from '@nuzli/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { ViolationAssignService } from './violation-assign.service';
import { ViolationTypesService } from './violation-types.service';
import { ViolationsService } from './violations.service';

export const violationListQuery = paginationQuery.merge(violationFilterSchema);

const typesQuery = z.object({
  active: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

const READ_ANY = ['violations.readAll', 'violations.readRecorded', 'violations.readOwnTeams'] as const;

/**
 * Violations (brief §7, docs/API.md "Phase 3"). Guards check the permission; the service
 * applies the data scope inside every query (ADR-040 pattern). Static paths come before `:id`.
 */
@ApiTags('violations')
@ApiBearerAuth()
@Controller('violations')
export class ViolationsController {
  constructor(
    private readonly violations: ViolationsService,
    private readonly assignments: ViolationAssignService,
  ) {}

  @Get('roster')
  @RequirePermission('violations.create')
  @ApiOperation({ summary: 'قائمة الأعضاء المختصرة لجهاز المراقب (هوية مقنّعة وآخر ٤ أرقام)' })
  roster(@Res({ passthrough: true }) res: Response): Promise<RosterResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.violations.roster();
  }

  @Post()
  @RequirePermission('violations.create')
  @ApiOperation({ summary: 'تسجيل مخالفة (تكرار clientUuid نفسه يعيد المخالفة الأصلية بـ 200)' })
  async create(
    @ZodBody(createViolationSchema) body: z.output<typeof createViolationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViolationDto> {
    const { created, violation } = await this.violations.create(body, viewer, ctx);
    res.status(created ? 201 : 200);
    return violation;
  }

  @Get()
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'المخالفات حسب النطاق والمرشّحات' })
  list(
    @ZodQuery(violationListQuery) q: z.output<typeof violationListQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<ViolationDto>> {
    return this.violations.list(q, viewer);
  }

  @Get('mine')
  @RequirePermission('violations.create')
  @ApiOperation({ summary: 'المخالفات التي سجّلتُها' })
  mine(
    @ZodQuery(violationListQuery) q: z.output<typeof violationListQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<ViolationDto>> {
    return this.violations.list(q, viewer, { mine: true });
  }

  @Get('stats')
  @RequirePermission('violations.stats')
  @ApiOperation({ summary: 'إحصاءات لوحة المخالفات بالمرشّحات نفسها' })
  stats(@ZodQuery(violationFilterSchema) f: z.output<typeof violationFilterSchema>): Promise<ViolationStats> {
    return this.violations.stats(f);
  }

  @Get('export.xlsx')
  @RequirePermission('violations.export')
  @ApiOperation({ summary: 'تصدير القائمة المصفّاة إلى Excel (من اليمين لليسار، دون تجميد أجزاء)' })
  async exportXlsx(
    @ZodQuery(violationFilterSchema) f: z.output<typeof violationFilterSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.violations.exportXlsx(f, viewer, ctx);
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(out.buffer);
  }

  @Get('dashboard.pdf')
  @RequirePermission('violations.export')
  @ApiOperation({ summary: 'لوحة المخالفات PDF (501 حتى تُضبط خدمة PDF)' })
  dashboardPdf(
    @ZodQuery(violationFilterSchema) f: z.output<typeof violationFilterSchema>,
    @ReqCtx() ctx: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    return this.violations.streamDashboardPdf(f, res, ctx);
  }

  @Get(':id')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'مخالفة بصورها وردودها' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ViolationDto> {
    return this.violations.get(id, viewer);
  }

  @Get(':id/files/:fileId/url')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'رابط عرض مؤقت لصورة (عرض صورة الهوية يُسجَّل في التدقيق)' })
  fileUrl(
    @Param('id', UuidPipe) id: string,
    @Param('fileId', UuidPipe) fileId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.violations.fileUrl(id, fileId, viewer, ctx);
  }

  @Patch(':id')
  @RequireAnyPermission('violations.create', 'violations.manage')
  @ApiOperation({ summary: 'تعديل مخالفة (المراقب خلال المهلة، ثم المدير فقط)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateViolationSchema) body: z.output<typeof updateViolationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationDto> {
    return this.violations.update(id, body, viewer, ctx);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('violations.manage')
  @ApiOperation({ summary: 'تغيير حالة المخالفة (الإلغاء يتطلب سببًا)' })
  status(
    @Param('id', UuidPipe) id: string,
    @ZodBody(changeViolationStatusSchema) body: z.output<typeof changeViolationStatusSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationDto> {
    return this.violations.changeStatus(id, body, viewer, ctx);
  }

  // ─────────────────────────────────────────── A9: without a person, OCR, assign later (ADR-103/104)

  @Get(':id/ocr')
  @RequireAnyPermission('violations.manage', 'violations.create')
  @ApiOperation({ summary: 'بيانات بطاقة الهوية المقروءة آليًّا مع الأعضاء المقترحين (المدير والمسجِّل؛ يُسجَّل العرض)' })
  ocr(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViolationOcrDto> {
    res.setHeader('Cache-Control', 'no-store');
    return this.assignments.ocrView(id, viewer, ctx);
  }

  @Post(':id/ocr/retry')
  @HttpCode(202)
  @RequirePermission('violations.manage')
  @ApiOperation({ summary: 'إعادة قراءة بطاقة الهوية آليًّا' })
  async retryOcr(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<{ queued: true }> {
    await this.assignments.retryOcr(id, viewer, ctx);
    return { queued: true };
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequireAnyPermission('violations.manage', 'violations.create')
  @ApiOperation({ summary: 'إسناد المخالفة إلى عضو (المسجِّل أو المدير؛ اللقطة عند وقت الرصد)' })
  assign(
    @Param('id', UuidPipe) id: string,
    @ZodBody(assignViolationSchema) body: z.output<typeof assignViolationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationDto> {
    return this.assignments.assign(id, body.memberId, viewer, ctx);
  }

  @Post(':id/unassign')
  @HttpCode(200)
  @RequirePermission('violations.manage')
  @ApiOperation({ summary: 'إلغاء إسناد المخالفة (المدير)' })
  unassign(
    @Param('id', UuidPipe) id: string,
    @ZodBody(unassignViolationSchema) body: z.output<typeof unassignViolationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationDto> {
    return this.assignments.unassign(id, body.reason, viewer, ctx);
  }

  @Post(':id/register-member')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  // Security review A9 M1 (ADR-118): admins only.
  @RequirePermission('members.manage')
  @ApiOperation({ summary: '(المدير) تسجيل عضو جديد من بيانات البطاقة وصورة الشخص ثم إسناد المخالفة إليه' })
  registerMember(
    @Param('id', UuidPipe) id: string,
    @ZodBody(registerViolationMemberSchema) body: z.output<typeof registerViolationMemberSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<RegisterViolationMemberResultDto> {
    return this.assignments.registerMember(id, body, viewer, ctx);
  }

  @Post(':id/responses')
  @RequirePermission('violations.respond')
  @ApiOperation({ summary: 'ردّ أو اعتراض المشرف (يُشعر المديرين)' })
  respond(
    @Param('id', UuidPipe) id: string,
    @ZodBody(violationResponseSchema) body: z.output<typeof violationResponseSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationDto> {
    return this.violations.respond(id, body.body, viewer, ctx);
  }
}

@ApiTags('violations')
@ApiBearerAuth()
@Controller('violation-types')
export class ViolationTypesController {
  constructor(private readonly types: ViolationTypesService) {}

  @Get()
  @ApiOperation({ summary: 'أنواع المخالفات (active=true للنشطة؛ غير المدير يرى النشطة دائمًا)' })
  list(
    @ZodQuery(typesQuery) q: z.output<typeof typesQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<ViolationTypeDto[]> {
    return this.types.list(q.active, viewer);
  }

  @Post()
  @RequirePermission('violations.manage')
  @ApiOperation({ summary: 'إضافة نوع مخالفة' })
  create(
    @ZodBody(violationTypeSchema) body: z.output<typeof violationTypeSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationTypeDto> {
    return this.types.create(body, ctx);
  }

  @Patch(':id')
  @RequirePermission('violations.manage')
  @ApiOperation({ summary: 'تعديل نوع مخالفة أو إيقافه' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateViolationTypeSchema) body: z.output<typeof updateViolationTypeSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ViolationTypeDto> {
    return this.types.update(id, body, ctx);
  }
}
