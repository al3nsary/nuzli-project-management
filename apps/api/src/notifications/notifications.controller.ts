import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { paginationQuery } from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../common/decorators';
import type { AuthUser } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodQuery } from '../common/zod-openapi';
import { NotificationsService } from './notifications.service';

const listQuery = paginationQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

@ApiTags('notifications')
@ApiBearerAuth()
@RequirePermission('notifications.read')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'إشعاراتي' })
  list(@CurrentUser() user: AuthUser, @ZodQuery(listQuery) q: z.infer<typeof listQuery>) {
    return this.notifications.list(user.id, q);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'عدد غير المقروء' })
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post('read-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'تعليم الكل كمقروء' })
  async readAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'تعليم إشعار كمقروء' })
  async read(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }
}
