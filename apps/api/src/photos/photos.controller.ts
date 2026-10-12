import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PhotoUrlDto } from '@nuzli/shared';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { PhotosService } from './photos.service';

/**
 * Personal photos (owner request A8). Uploading uses `POST /files/presign` with
 * `entityType: 'user_photo' | 'member_photo'` and `entityId`, then `POST /files/:id/confirm`,
 * which links the photo and replaces the previous one. These routes read and remove.
 * The data scope is decided in PhotosService (photo-policy.ts).
 */
@ApiTags('photos')
@ApiBearerAuth()
@Controller()
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Get('me/photo-url')
  @ApiOperation({ summary: 'رابط مؤقت لصورتي الشخصية' })
  myPhotoUrl(@CurrentUser() user: AuthUser): Promise<PhotoUrlDto> {
    return this.photos.photoUrl('user_photo', user.id, user);
  }

  @Delete('me/photo')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'حذف صورتي الشخصية' })
  removeMyPhoto(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.photos.remove('user_photo', user.id, user, ctx);
  }

  @Get('users/:id/photo-url')
  @ApiOperation({ summary: 'رابط مؤقت لصورة مستخدم (المستخدمون النشطون يرون صور النشطين)' })
  userPhotoUrl(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser): Promise<PhotoUrlDto> {
    return this.photos.photoUrl('user_photo', id, user);
  }

  @Delete('users/:id/photo')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('users.manageRoles')
  @ApiOperation({ summary: 'حذف صورة مستخدم (المدير)' })
  removeUserPhoto(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.photos.remove('user_photo', id, user, ctx);
  }

  @Get('members/:id/photo-url')
  @RequireAnyPermission('teams.readAll', 'teams.readOwn', 'members.manage', 'violations.create')
  @ApiOperation({ summary: 'رابط مؤقت لصورة عضو (المدير، مشرف فريقه، المراقب للتحقق من الهوية)' })
  memberPhotoUrl(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser): Promise<PhotoUrlDto> {
    return this.photos.photoUrl('member_photo', id, user);
  }

  @Delete('members/:id/photo')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequireAnyPermission('members.manage', 'members.manageOwn')
  @ApiOperation({ summary: 'حذف صورة عضو (المدير أو مشرف فريقه الحالي)' })
  removeMemberPhoto(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.photos.remove('member_photo', id, user, ctx);
  }
}
