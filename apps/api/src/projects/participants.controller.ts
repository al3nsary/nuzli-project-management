import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { addParticipantSchema, participantCandidatesQuery, updateParticipantSchema, type MyParticipationDto, type ParticipantCandidateDto, type ParticipantDto } from '@nuzli/shared';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { ParticipantsService } from './participants.service';
import { ProjectCoverService } from './project-cover.service';

/** A12 round 2 — project participants (محرّر / مساهم / مطّلع) and the project cover image. */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectParticipantsController {
  constructor(
    private readonly participants: ParticipantsService,
    private readonly covers: ProjectCoverService,
  ) {}

  @Get(':id/participants')
  @RequireAnyPermission('projects.readAll', 'projects.readGranted')
  @ApiOperation({ summary: 'المشاركون في المشروع ومناصبهم ومستوياتهم' })
  list(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ParticipantDto[]> {
    return this.participants.list(id, viewer);
  }

  @Get(':id/participant-candidates')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'من يمكن إضافته مشاركًا: أعضاء القسم النشطون غير المشاركين (اسم، اسم مستخدم، صفة) — لمن يدير المشاركين' })
  candidates(
    @Param('id', UuidPipe) id: string,
    @ZodQuery(participantCandidatesQuery) q: z.output<typeof participantCandidatesQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<ParticipantCandidateDto[]> {
    return this.participants.candidates(id, q.q, viewer);
  }

  @Post(':id/participants')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إضافة مشارك (منصب + محرّر/مساهم/مطّلع)' })
  add(
    @Param('id', UuidPipe) id: string,
    @ZodBody(addParticipantSchema) body: z.output<typeof addParticipantSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ParticipantDto> {
    return this.participants.add(id, body, viewer, ctx);
  }

  @Patch(':id/participants/:userId')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تعديل منصب المشارك أو مستواه' })
  update(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @ZodBody(updateParticipantSchema) body: z.output<typeof updateParticipantSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ParticipantDto> {
    return this.participants.update(id, userId, body, viewer, ctx);
  }

  @Delete(':id/participants/:userId')
  @HttpCode(204)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إزالة مشارك' })
  remove(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.participants.remove(id, userId, viewer, ctx);
  }

  @Get(':id/cover-url')
  @RequireAnyPermission('projects.readAll', 'projects.readGranted')
  @ApiOperation({ summary: 'رابط مؤقت لصورة غلاف المشروع (404 بلا غلاف)' })
  coverUrl(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<{ url: string; expiresAt: string }> {
    return this.covers.url(id, viewer);
  }

  @Delete(':id/cover')
  @HttpCode(204)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إزالة صورة الغلاف (يعود الغلاف المولَّد)' })
  removeCover(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.covers.remove(id, viewer, ctx);
  }
}

/** A12 round 2 — the caller's own project grants (the web shows the matching buttons). */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeParticipationsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get('participations')
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'مشاركاتي في المشاريع (المشروع، المنصب، المستوى)' })
  mine(@CurrentUser() viewer: AuthUser): Promise<MyParticipationDto[]> {
    return this.participants.mine(viewer);
  }
}
