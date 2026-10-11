import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  importMembersSchema,
  memberSearchSchema,
  moveMembersSchema,
  paginationQuery,
  updateMemberSchema,
  uuid,
  type ImportMembersResultDto,
  type MemberDto,
  type MembershipHistoryDto,
  type Paginated,
} from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { assertNoNationalIdInQuery } from '../common/search-term';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { MembersService } from './members.service';

const memberListQuery = paginationQuery.extend({
  teamId: uuid.optional(),
  unassigned: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequireAnyPermission('teams.readAll', 'teams.readOwn', 'members.manage')
  @ApiOperation({ summary: 'الأعضاء: بحث بالاسم أو آخر ٤ أرقام من الهوية (الرقم الكامل عبر POST /members/search)' })
  list(
    @ZodQuery(memberListQuery) q: z.output<typeof memberListQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<MemberDto>> {
    assertNoNationalIdInQuery(q.q, '/api/v1/members/search');
    return this.members.list(q, viewer);
  }

  /** Same filters as GET /members, in the body, so a full national ID stays out of URLs. */
  @Post('search')
  @HttpCode(200)
  @RequireAnyPermission('teams.readAll', 'teams.readOwn', 'members.manage')
  @ApiOperation({ summary: 'بحث الأعضاء (يقبل رقم الهوية كاملًا في جسم الطلب)' })
  search(
    @ZodBody(memberSearchSchema) body: z.output<typeof memberSearchSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<MemberDto>> {
    return this.members.list(body, viewer);
  }

  @Post('move')
  @HttpCode(200)
  @RequirePermission('members.move')
  @ApiOperation({ summary: 'نقل أعضاء إلى فريق (معاملة واحدة ولحظة واحدة للإغلاق والفتح)' })
  move(
    @ZodBody(moveMembersSchema) body: z.output<typeof moveMembersSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MemberDto[]> {
    return this.members.move(body, viewer, ctx);
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermission('members.import')
  @ApiOperation({ summary: 'استيراد أعضاء: معاينة (commit=false) ثم حفظ الصفوف السليمة' })
  import(
    @ZodBody(importMembersSchema) body: z.output<typeof importMembersSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ImportMembersResultDto> {
    return this.members.import(body, viewer, ctx);
  }

  @Get(':id')
  @RequireAnyPermission('teams.readAll', 'teams.readOwn', 'members.manage')
  @ApiOperation({ summary: 'عضو (رقم الهوية كاملًا لمن يملك الصلاحية)' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<MemberDto> {
    return this.members.get(id, viewer);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequireAnyPermission('members.manage', 'members.manageOwn')
  @ApiOperation({ summary: 'تعديل بيانات عضو' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateMemberSchema) body: z.output<typeof updateMemberSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MemberDto> {
    return this.members.update(id, body, viewer, ctx);
  }

  @Get(':id/history')
  @RequireAnyPermission('teams.readAll', 'teams.readOwn', 'members.manage')
  @ApiOperation({ summary: 'سجل عضويات العضو في الفرق' })
  history(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<MembershipHistoryDto[]> {
    return this.members.history(id, viewer);
  }
}
