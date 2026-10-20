import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addOwnerSchema,
  addWorkspaceAdminSchema,
  addWorkspaceMemberSchema,
  createWorkspaceSchema,
  renameWorkspaceSchema,
  updateMembershipSchema,
  workspaceListQuery,
  type OwnerDto,
  type WorkspaceAdminDto,
  type WorkspaceCountsDto,
  type WorkspaceMemberDto,
} from '@nuzli/shared';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequirePermission, WorkspaceOptional } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { MembershipsService } from '../users/memberships.service';
import { OwnersService, type AddOwnerData } from './owners.service';
import { WorkspacesAdminService } from './workspaces-admin.service';

/**
 * A12 round 2 — owners (ملّاك). Every route is for owners only (403 otherwise) and works without
 * an active workspace (an owner may manage the system before choosing one).
 */
@ApiTags('owners')
@ApiBearerAuth()
@WorkspaceOptional()
@Controller('owners')
export class OwnersController {
  constructor(private readonly owners: OwnersService) {}

  @Get()
  @ApiOperation({ summary: 'الملّاك' })
  list(@CurrentUser() viewer: AuthUser): Promise<OwnerDto[]> {
    return this.owners.list(viewer);
  }

  @Post()
  @ApiOperation({ summary: 'إضافة مالك (حساب موجود أو حساب جديد)' })
  add(@ZodBody(addOwnerSchema) body: z.output<typeof addOwnerSchema>, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<OwnerDto> {
    return this.owners.add(body as AddOwnerData, viewer, ctx);
  }

  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'إزالة مالك (لا يبقى النظام بلا مالك)' })
  remove(@Param('userId', UuidPipe) userId: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.owners.remove(userId, viewer, ctx);
  }
}

/**
 * A12 round 2 — workspaces (أقسام). CRUD, archive/restore, summary and admins: owners only.
 * Members (`/workspaces/:id/members`): owners for any workspace, admins for the workspace of
 * their session (another id → 403 WORKSPACE_FORBIDDEN).
 */
@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesAdminController {
  constructor(
    private readonly workspaces: WorkspacesAdminService,
    private readonly memberships: MembershipsService,
  ) {}

  @Get()
  @WorkspaceOptional()
  @ApiOperation({ summary: 'الأقسام مع عدد المديرين والأعضاء (للمالك)' })
  list(@ZodQuery(workspaceListQuery) q: z.output<typeof workspaceListQuery>, @CurrentUser() viewer: AuthUser): Promise<WorkspaceAdminDto[]> {
    return this.workspaces.list(q.status, viewer);
  }

  @Post()
  @WorkspaceOptional()
  @ApiOperation({ summary: 'إنشاء قسم جديد فارغ بإعداداته المحايدة (للمالك)' })
  create(@ZodBody(createWorkspaceSchema) body: z.output<typeof createWorkspaceSchema>, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<WorkspaceAdminDto> {
    return this.workspaces.create(body, viewer, ctx);
  }

  @Patch(':id')
  @WorkspaceOptional()
  @ApiOperation({ summary: 'إعادة تسمية قسم (للمالك)' })
  rename(
    @Param('id', UuidPipe) id: string,
    @ZodBody(renameWorkspaceSchema) body: z.output<typeof renameWorkspaceSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<WorkspaceAdminDto> {
    return this.workspaces.rename(id, body.name, viewer, ctx);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @WorkspaceOptional()
  @ApiOperation({ summary: 'أرشفة قسم (لا يُحذف شيء؛ تنتهي جلساته)' })
  archive(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<WorkspaceAdminDto> {
    return this.workspaces.archive(id, viewer, ctx);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @WorkspaceOptional()
  @ApiOperation({ summary: 'استعادة قسم مؤرشف' })
  restore(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<WorkspaceAdminDto> {
    return this.workspaces.restore(id, viewer, ctx);
  }

  @Get(':id/summary')
  @WorkspaceOptional()
  @ApiOperation({ summary: 'أعداد القسم (للمالك)' })
  summary(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<WorkspaceCountsDto> {
    return this.workspaces.summary(id, viewer);
  }

  @Get(':id/admins')
  @WorkspaceOptional()
  @ApiOperation({ summary: 'مديرو النظام في القسم (للمالك)' })
  admins(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<WorkspaceMemberDto[]> {
    return this.workspaces.admins(id, viewer);
  }

  @Post(':id/admins')
  @WorkspaceOptional()
  @ApiOperation({ summary: 'تعيين مدير نظام للقسم (للمالك)' })
  addAdmin(
    @Param('id', UuidPipe) id: string,
    @ZodBody(addWorkspaceAdminSchema) body: z.output<typeof addWorkspaceAdminSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<WorkspaceMemberDto> {
    return this.workspaces.addAdmin(id, body, viewer, ctx);
  }

  @Delete(':id/admins/:userId')
  @HttpCode(204)
  @WorkspaceOptional()
  @ApiOperation({ summary: 'إزالة مدير نظام من القسم (للمالك)' })
  removeAdmin(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.workspaces.removeAdmin(id, userId, viewer, ctx);
  }

  // ─────────────────────────────── members (owners: any workspace; admins: their own)

  @Get(':id/members')
  @WorkspaceOptional()
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'أعضاء القسم وأدوارهم' })
  members(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<WorkspaceMemberDto[]> {
    return this.memberships.list(id, viewer);
  }

  @Post(':id/members')
  @WorkspaceOptional()
  @RequirePermission('users.manageRoles')
  @ApiOperation({ summary: 'إضافة حساب موجود إلى القسم بدور (مع تأكيد الصلاحية المزدوجة)' })
  addMember(
    @Param('id', UuidPipe) id: string,
    @ZodBody(addWorkspaceMemberSchema) body: z.output<typeof addWorkspaceMemberSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<WorkspaceMemberDto> {
    return this.memberships.add(id, body, viewer, ctx);
  }

  @Patch(':id/members/:membershipId')
  @WorkspaceOptional()
  @RequirePermission('users.manageRoles')
  @ApiOperation({ summary: 'تعديل المنصب ووحدات المساعد ونطاقه' })
  updateMember(
    @Param('id', UuidPipe) id: string,
    @Param('membershipId', UuidPipe) membershipId: string,
    @ZodBody(updateMembershipSchema) body: z.output<typeof updateMembershipSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<WorkspaceMemberDto> {
    return this.memberships.update(id, membershipId, body, viewer, ctx);
  }

  @Delete(':id/members/:membershipId')
  @HttpCode(204)
  @WorkspaceOptional()
  @RequirePermission('users.manageRoles')
  @ApiOperation({ summary: 'إنهاء دور في القسم (أرشفة، لا حذف)' })
  removeMember(
    @Param('id', UuidPipe) id: string,
    @Param('membershipId', UuidPipe) membershipId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.memberships.remove(id, membershipId, viewer, ctx);
  }
}
