import { Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { updateSettingsSchema, type Settings } from '@nuzli/shared';
import { ReqCtx, RequirePermission } from '../common/decorators';
import type { RequestContext } from '../common/request';
import { ZodBody } from '../common/zod-openapi';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Any active user may read the settings (the UI needs them); only admins write. */
  @Get()
  @ApiOperation({ summary: 'إعدادات النظام' })
  get(): Promise<Settings> {
    return this.settings.getAll();
  }

  @Patch()
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'تعديل إعدادات النظام' })
  update(
    @ZodBody(updateSettingsSchema) body: Partial<Settings>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<Settings> {
    return this.settings.update(body, ctx);
  }
}
