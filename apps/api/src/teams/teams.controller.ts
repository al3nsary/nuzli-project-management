import { Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  archiveTeamSchema,
  changeSupervisorSchema,
  createTeamSchema,
  memberInputSchema,
  rejectTeamSchema,
  updateTeamSchema,
  violationVisibilitySchema,
  type MemberDto,
  type SupervisorHistoryDto,
  type TeamDetailDto,
  type TeamDto,
} from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { MembersService } from '../members/members.service';
import { TeamsService } from './teams.service';

const teamListQuery = z.object({
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED', 'ALL']).optional(),
  q: z.string().trim().max(100).optional(),
});

@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly members: MembersService,
  ) {}

  @Get()
  @RequireAnyPermission('teams.readAll', 'teams.readOwn')
  @ApiOperation({ summary: 'الفرق (المشرف يرى فرقه فقط). الافتراضي: النشطة والمعلّقة' })
  list(@ZodQuery(teamListQuery) q: z.output<typeof teamListQuery>, @CurrentUser() viewer: AuthUser): Promise<TeamDto[]> {
    return this.teams.list(q, viewer);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequireAnyPermission('teams.create', 'teams.createOwn')
  @ApiOperation({ summary: 'إنشاء فريق (المدير: نشط؛ المشرف: لنفسه، معلّق أو نشط حسب الإعداد)' })
  create(
    @ZodBody(createTeamSchema) body: z.output<typeof createTeamSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.create(body, viewer, ctx);
  }

  @Get(':id')
  @RequireAnyPermission('teams.readAll', 'teams.readOwn')
  @ApiOperation({ summary: 'فريق مع أعضائه الحاليين' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<TeamDetailDto> {
    return this.teams.get(id, viewer);
  }

  @Patch(':id')
  @RequireAnyPermission('teams.manageAll', 'teams.manageOwn')
  @ApiOperation({ summary: 'تعديل اسم الفريق أو لونه' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateTeamSchema) body: z.output<typeof updateTeamSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.update(id, body, viewer, ctx);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('teams.approve')
  @ApiOperation({ summary: 'اعتماد فريق معلّق' })
  approve(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.approve(id, viewer, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('teams.approve')
  @ApiOperation({ summary: 'رفض فريق معلّق (يُؤرشف ويُحرَّر لونه)' })
  reject(
    @Param('id', UuidPipe) id: string,
    @ZodBody(rejectTeamSchema) body: z.output<typeof rejectTeamSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.reject(id, body.reason, ctx);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireAnyPermission('teams.manageAll', 'teams.manageOwn')
  @ApiOperation({ summary: 'أرشفة فريق: يُحرَّر اللون وتُغلق العضويات المفتوحة' })
  archive(
    @Param('id', UuidPipe) id: string,
    @ZodBody(archiveTeamSchema) body: z.output<typeof archiveTeamSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.archive(id, body.reason, viewer, ctx);
  }

  @Post(':id/supervisor')
  @HttpCode(200)
  @RequirePermission('teams.manageAll')
  @ApiOperation({ summary: 'تغيير مشرف الفريق (يُسجَّل في السجل التاريخي)' })
  changeSupervisor(
    @Param('id', UuidPipe) id: string,
    @ZodBody(changeSupervisorSchema) body: z.output<typeof changeSupervisorSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.changeSupervisor(id, body, viewer, ctx);
  }

  @Get(':id/supervisor-history')
  @RequireAnyPermission('teams.readAll', 'teams.readOwn')
  @ApiOperation({ summary: 'سجل مشرفي الفريق' })
  supervisorHistory(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
  ): Promise<SupervisorHistoryDto[]> {
    return this.teams.supervisorHistory(id, viewer);
  }

  @Put(':id/violation-visibility')
  @RequirePermission('teams.manageAll')
  @ApiOperation({ summary: 'ظهور المخالفات لمشرف الفريق (يرث الإعداد العام أو يظهر أو يُخفى)' })
  setVisibility(
    @Param('id', UuidPipe) id: string,
    @ZodBody(violationVisibilitySchema) body: z.output<typeof violationVisibilitySchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamDto> {
    return this.teams.setVisibility(id, body.mode, viewer, ctx);
  }

  @Post(':id/members')
  // Review L7: slows down probing for existing national IDs through member creation.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequireAnyPermission('members.manage', 'members.manageOwn')
  @ApiOperation({ summary: 'إضافة عضو جديد إلى الفريق' })
  addMember(
    @Param('id', UuidPipe) id: string,
    @ZodBody(memberInputSchema) body: z.output<typeof memberInputSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MemberDto> {
    return this.members.createInTeam(id, body, viewer, ctx);
  }
}
