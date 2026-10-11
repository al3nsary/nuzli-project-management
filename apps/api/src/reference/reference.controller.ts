import { Controller, Delete, Get, HttpCode, Param, Patch, PipeTransform, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { referenceItemSchema, updateReferenceItemSchema, type ReferenceItemDto } from '@nuzli/shared';
import type { z } from 'zod';
import { AppError } from '../common/app-error';
import { CurrentUser, ReqCtx, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody } from '../common/zod-openapi';
import { REFERENCE_KINDS, ReferenceService, type DeleteResult, type ReferenceKind } from './reference.service';

/** `departments` | `job-titles` → entity kind; anything else is 404. */
class ReferenceKindPipe implements PipeTransform<string, ReferenceKind> {
  transform(value: string): ReferenceKind {
    const kind = REFERENCE_KINDS[value as keyof typeof REFERENCE_KINDS];
    if (!kind) throw new AppError('NOT_FOUND');
    return kind;
  }
}

const kindParam = ApiParam({ name: 'kind', enum: Object.keys(REFERENCE_KINDS) });

@ApiTags('reference')
@ApiBearerAuth()
@Controller('reference')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get(':kind')
  @kindParam
  @ApiOperation({ summary: 'الإدارات أو المسمّيات الوظيفية (لكل مستخدم نشط)' })
  list(@Param('kind', ReferenceKindPipe) kind: ReferenceKind, @CurrentUser() viewer: AuthUser): Promise<ReferenceItemDto[]> {
    return this.reference.list(kind, viewer);
  }

  @Post(':kind')
  @kindParam
  @RequirePermission('reference.manage')
  @ApiOperation({ summary: 'إضافة عنصر' })
  create(
    @Param('kind', ReferenceKindPipe) kind: ReferenceKind,
    @ZodBody(referenceItemSchema) body: z.output<typeof referenceItemSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ReferenceItemDto> {
    return this.reference.create(kind, body.name, ctx);
  }

  @Patch(':kind/:id')
  @kindParam
  @RequirePermission('reference.manage')
  @ApiOperation({ summary: 'تعديل الاسم أو التفعيل' })
  update(
    @Param('kind', ReferenceKindPipe) kind: ReferenceKind,
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateReferenceItemSchema) body: z.output<typeof updateReferenceItemSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ReferenceItemDto> {
    return this.reference.update(kind, id, body, ctx);
  }

  @Delete(':kind/:id')
  @HttpCode(200)
  @kindParam
  @RequirePermission('reference.manage')
  @ApiOperation({ summary: 'حذف (أو إيقاف إن كان مستخدمًا لدى أعضاء)' })
  remove(
    @Param('kind', ReferenceKindPipe) kind: ReferenceKind,
    @Param('id', UuidPipe) id: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<DeleteResult> {
    return this.reference.remove(kind, id, ctx);
  }
}
