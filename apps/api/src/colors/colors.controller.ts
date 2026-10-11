import { Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  teamColorSchema,
  updateTeamColorSchema,
  uuid,
  type TeamColorDto,
  type TeamColorPaletteDto,
} from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { ColorsService } from './colors.service';

const availableQuery = z.object({ excludeTeamId: uuid.optional() });

@ApiTags('colors')
@ApiBearerAuth()
@Controller('colors')
export class ColorsController {
  constructor(private readonly colors: ColorsService) {}

  @Get('available')
  @RequireAnyPermission('teams.create', 'teams.createOwn', 'teams.manageAll', 'teams.manageOwn')
  @ApiOperation({ summary: 'الألوان المتاحة للفريق (المحجوزة لا تظهر أبدًا)' })
  available(
    @ZodQuery(availableQuery) q: z.output<typeof availableQuery>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<TeamColorDto[]> {
    return this.colors.available(q.excludeTeamId, viewer);
  }

  @Get()
  @RequirePermission('colors.manage')
  @ApiOperation({ summary: 'لوحة الألوان كاملة مع الفريق الذي يستخدم كل لون' })
  list(): Promise<TeamColorPaletteDto[]> {
    return this.colors.list();
  }

  @Post()
  @RequirePermission('colors.manage')
  @ApiOperation({ summary: 'إضافة لون إلى اللوحة' })
  create(
    @ZodBody(teamColorSchema) body: z.output<typeof teamColorSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamColorDto> {
    return this.colors.create(body, ctx);
  }

  @Patch(':id')
  @RequirePermission('colors.manage')
  @ApiOperation({ summary: 'تسمية لون أو إيقافه أو إعادته' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateTeamColorSchema) body: z.output<typeof updateTeamColorSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TeamColorDto> {
    return this.colors.update(id, body, ctx);
  }
}
