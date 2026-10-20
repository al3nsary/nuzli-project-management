import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  archiveMemberSchema,
  can,
  memberRequestListQuery,
  rejectMemberRequestSchema,
  type MemberRequestAcceptedDto,
  type MemberRequestDto,
  type Paginated,
} from '@nuzli/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { MemberRequestsService } from './member-requests.service';

/** Who may see the request list (approvers; supervisors see their own and their teams'). */
const REQUEST_READ = ['registrations.review', 'registrations.read', 'members.manage', 'members.manageOwn'] as const;

/** A12 round 2 — workers' add/remove requests (طلبات إضافة العمّال وإزالتهم). */
@ApiTags('member-requests')
@ApiBearerAuth()
@Controller('member-requests')
export class MemberRequestsController {
  constructor(private readonly requests: MemberRequestsService) {}

  @Get()
  @RequireAnyPermission(...REQUEST_READ)
  @ApiOperation({ summary: 'طلبات إضافة العمّال وإزالتهم' })
  list(@ZodQuery(memberRequestListQuery) q: z.output<typeof memberRequestListQuery>, @CurrentUser() viewer: AuthUser): Promise<Paginated<MemberRequestDto>> {
    return this.requests.list(q, viewer);
  }

  @Get(':id')
  @RequireAnyPermission(...REQUEST_READ)
  @ApiOperation({ summary: 'طلب' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<MemberRequestDto> {
    return this.requests.get(id, viewer);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('registrations.review')
  @ApiOperation({ summary: 'اعتماد الطلب (ينفَّذ: يضاف العامل أو يُزال)' })
  approve(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<MemberRequestDto> {
    return this.requests.approve(id, viewer, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('registrations.review')
  @ApiOperation({ summary: 'رفض الطلب (السبب مطلوب)' })
  reject(
    @Param('id', UuidPipe) id: string,
    @ZodBody(rejectMemberRequestSchema) body: z.output<typeof rejectMemberRequestSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<MemberRequestDto> {
    return this.requests.reject(id, body.reason, viewer, ctx);
  }
}

/** A12 round 2 — removing a worker: admins directly (200), a supervisor through a request (202). */
@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MemberArchiveController {
  constructor(private readonly requests: MemberRequestsService) {}

  @Post(':id/archive')
  @RequireAnyPermission('members.manage', 'members.manageOwn')
  @ApiOperation({ summary: 'إزالة عامل: مباشرة للمدير، وطلبًا ينتظر الاعتماد للمشرف (202)' })
  async archive(
    @Param('id', UuidPipe) id: string,
    @ZodBody(archiveMemberSchema) body: z.output<typeof archiveMemberSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ARCHIVED' } | MemberRequestAcceptedDto> {
    if (can(viewer, 'members.manage')) {
      await this.requests.archiveDirect(id, body.reason, viewer, ctx);
      res.status(200);
      return { status: 'ARCHIVED' };
    }
    const out = await this.requests.requestRemove(id, body.reason, viewer, ctx);
    res.status(202);
    return out;
  }
}
