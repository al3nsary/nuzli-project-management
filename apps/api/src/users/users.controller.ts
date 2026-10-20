import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  allUsersQuery,
  changeUsernameSchema,
  createAccountSchema,
  setUserPasswordSchema,
  updateUserSchema,
  approveRegistrationSchema,
  changeRoleSchema,
  paginationQuery,
  rejectRegistrationSchema,
  roleSchema,
  suspendUserSchema,
  userSearchSchema,
  type UserDto,
} from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission, WorkspaceOptional } from '../common/decorators';
import { AccountsService } from './accounts.service';
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
const reactivateSchema = z.object({ scope: z.enum(['workspace', 'global']).optional() });

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly accounts: AccountsService,
  ) {}

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

  /** A12 round 2 — owners: every account of the system with its roles everywhere. Before `:id`. */
  @Get('all')
  @WorkspaceOptional()
  @ApiOperation({ summary: 'كل حسابات النظام (للمالك)' })
  all(@ZodQuery(allUsersQuery) q: z.output<typeof allUsersQuery>, @CurrentUser() viewer: AuthUser) {
    assertNoNationalIdInQuery(q.q, '/api/v1/users/search');
    return this.accounts.listAll(q, viewer);
  }

  /** Declared before `:id` so the literal path wins. */
  @Get('supervisors')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'المشرفون النشطون (للقوائم المنسدلة)' })
  supervisors(@ZodQuery(searchQuery) q: z.output<typeof searchQuery>, @CurrentUser() viewer: AuthUser) {
    assertNoNationalIdInQuery(q.q, '/api/v1/users/search');
    return this.users.supervisors(q.q, viewer);
  }

  /**
   * A12 round 2: username, password (+ must change), and initial memberships (owners: any
   * workspace; admins: theirs). Without a password the account gets the set-password e-mail.
   */
  @Post()
  @WorkspaceOptional()
  @RequirePermission('users.create')
  @ApiOperation({ summary: 'إنشاء مستخدم (اسم مستخدم، كلمة مرور أولى، أدوار في الأقسام)' })
  create(
    @ZodBody(createAccountSchema) body: z.output<typeof createAccountSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.accounts.create(body, viewer, ctx);
  }

  @Get(':id')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'مستخدم' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<UserDto> {
    return this.users.getById(id, viewer);
  }

  /** A12 round 2: account data (owners: anyone; admins: users only in their workspaces). */
  @Patch(':id')
  @WorkspaceOptional()
  @RequirePermission('users.edit')
  @ApiOperation({ summary: 'تعديل بيانات حساب (اسم المستخدم، الاسم، البريد، الجوال، الهوية)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateUserSchema) body: z.output<typeof updateUserSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.accounts.update(id, body, viewer, ctx);
  }

  @Post(':id/username')
  @HttpCode(200)
  @WorkspaceOptional()
  @RequirePermission('users.edit')
  @ApiOperation({ summary: 'تغيير اسم المستخدم' })
  changeUsername(
    @Param('id', UuidPipe) id: string,
    @ZodBody(changeUsernameSchema) body: z.output<typeof changeUsernameSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.accounts.changeUsername(id, body.username, viewer, ctx);
  }

  /** Nobody can read a password: this sets a new one and ends every session of the user. */
  @Post(':id/password')
  @HttpCode(200)
  @WorkspaceOptional()
  @RequirePermission('users.edit')
  @ApiOperation({ summary: 'تعيين كلمة مرور جديدة (مع إلزام التغيير عند الدخول)' })
  setPassword(
    @Param('id', UuidPipe) id: string,
    @ZodBody(setUserPasswordSchema) body: z.output<typeof setUserPasswordSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    return this.accounts.setPassword(id, body, viewer, ctx);
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
    // A12 round 2: scope 'global' (owners) suspends the account everywhere.
    if (body.scope === 'global') return this.accounts.suspendGlobal(id, body.reason, viewer, ctx);
    return this.users.suspend(id, body.reason, viewer, ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  @ApiOperation({ summary: 'إعادة تفعيل حساب موقوف' })
  reactivate(
    @Param('id', UuidPipe) id: string,
    @ZodBody(reactivateSchema) body: z.output<typeof reactivateSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UserDto> {
    if (body.scope === 'global') return this.accounts.reactivateGlobal(id, viewer, ctx);
    return this.users.reactivate(id, viewer, ctx);
  }
}

@ApiTags('registrations')
@ApiBearerAuth()
@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireAnyPermission('registrations.review', 'registrations.read')
  @ApiOperation({ summary: 'طلبات التسجيل المعلّقة' })
  list(@ZodQuery(paginationQuery) q: z.output<typeof paginationQuery>, @CurrentUser() viewer: AuthUser) {
    return this.users.list({ ...q, sort: q.sort ?? 'createdAt:asc', status: 'PENDING' }, viewer);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('registrations.review')
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
  @RequirePermission('registrations.review')
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
