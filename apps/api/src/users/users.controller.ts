import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveRegistrationSchema,
  changeRoleSchema,
  createUserSchema,
  paginationQuery,
  rejectRegistrationSchema,
  roleSchema,
  suspendUserSchema,
  userSearchSchema,
  type UserDto,
} from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { assertNoNationalIdInQuery } from '../common/search-term';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { UsersService } from './users.service';

const userListQuery = paginationQuery.extend({
  role: roleSchema.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
});
const searchQuery = z.object({ q: z.string().trim().max(100).optional() });

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'المستخدمون' })
  list(@ZodQuery(userListQuery) q: z.output<typeof userListQuery>, @CurrentUser() viewer: AuthUser) {
    assertNoNationalIdInQuery(q.q, '/api/v1/users/search');
    return this.users.list(q, viewer);
  }

  /** GET /users filters in the body: the only way to search by a full national ID (review L4). */
  @Post('search')
  @HttpCode(200)
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'بحث المستخدمين (يقبل رقم الهوية كاملًا في جسم الطلب)' })
  search(@ZodBody(userSearchSchema) body: z.output<typeof userSearchSchema>, @CurrentUser() viewer: AuthUser) {
    return this.users.list(body, viewer);
  }

  /** Declared before `:id` so the literal path wins. */
  @Get('supervisors')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'المشرفون النشطون (للقوائم المنسدلة)' })
  supervisors(@ZodQuery(searchQuery) q: z.output<typeof searchQuery>, @CurrentUser() viewer: AuthUser) {
    assertNoNationalIdInQuery(q.q, '/api/v1/users/search');
    return this.users.supervisors(q.q, viewer);
  }

  @Post()
  @RequirePermission('users.create')
  @ApiOperation({ summary: 'إنشاء مستخدم مباشرة (نشط، مع رابط إنشاء كلمة المرور)' })
  create(
    @ZodBody(createUserSchema) body: z.output<typeof createUserSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.create(body, viewer, ctx);
  }

  @Get(':id')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'مستخدم' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<UserDto> {
    return this.users.getById(id, viewer);
  }

  @Patch(':id/role')
  @RequirePermission('users.manageRoles')
  @ApiOperation({ summary: 'تغيير الصفة (يمنع إزالة آخر مدير)' })
  changeRole(
    @Param('id', UuidPipe) id: string,
    @ZodBody(changeRoleSchema) body: z.output<typeof changeRoleSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.changeRole(id, body.role, viewer, ctx);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  @ApiOperation({ summary: 'إيقاف الحساب وإنهاء جلساته' })
  suspend(
    @Param('id', UuidPipe) id: string,
    @ZodBody(suspendUserSchema) body: z.output<typeof suspendUserSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.suspend(id, body.reason, viewer, ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  @ApiOperation({ summary: 'إعادة تفعيل حساب موقوف' })
  reactivate(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.reactivate(id, viewer, ctx);
  }
}

@ApiTags('registrations')
@ApiBearerAuth()
@RequirePermission('registrations.review')
@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'طلبات التسجيل المعلّقة' })
  list(@ZodQuery(paginationQuery) q: z.output<typeof paginationQuery>, @CurrentUser() viewer: AuthUser) {
    return this.users.list({ ...q, sort: q.sort ?? 'createdAt:asc', status: 'PENDING' }, viewer);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'اعتماد طلب (مع تغيير الصفة اختياريًا)' })
  approve(
    @Param('id', UuidPipe) id: string,
    @ZodBody(approveRegistrationSchema) body: z.output<typeof approveRegistrationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.approve(id, body.role, viewer, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'رفض طلب (السبب مطلوب ويُرسل بالبريد)' })
  reject(
    @Param('id', UuidPipe) id: string,
    @ZodBody(rejectRegistrationSchema) body: z.output<typeof rejectRegistrationSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.users.reject(id, body.reason, viewer, ctx);
  }
}
