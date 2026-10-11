import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { presignUploadSchema, type PresignedUpload, type PresignUploadInput } from '@nuzli/shared';
import { CurrentUser, ReqCtx } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody } from '../common/zod-openapi';
import { FilesService } from './files.service';

/** Upload endpoints are rate limited (brief §13). Permissions depend on the entity → service. */
@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('presign')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'رابط رفع موقّع (PUT) قصير العمر' })
  presign(
    @ZodBody(presignUploadSchema) body: PresignUploadInput,
    @CurrentUser() user: AuthUser,
  ): Promise<PresignedUpload> {
    return this.files.presign(body, user);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'تأكيد الرفع: الحجم ونوع الملف من بصمته' })
  confirm(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.files.confirm(id, user);
  }

  @Get(':id/url')
  @ApiOperation({ summary: 'رابط تنزيل موقّع قصير العمر بعد التحقق من الصلاحية' })
  url(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.files.getUrl(id, user, ctx);
  }
}
