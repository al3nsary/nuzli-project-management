import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isoDate, isoDateTime, paginationQuery, uuid } from '@nuzli/shared';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../common/decorators';
import type { AuthUser } from '../common/request';
import { ZodQuery } from '../common/zod-openapi';
import { AuditService } from './audit.service';

const auditQuery = paginationQuery.extend({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  actorId: uuid.optional(),
  entityId: uuid.optional(),
  /** `YYYY-MM-DD` (whole day, UTC) or an ISO instant. */
  from: z.union([isoDate, isoDateTime]).optional(),
  to: z.union([isoDate, isoDateTime]).optional(),
  /** Security review A12 M1: `account` = account-level entries (owners only). */
  scope: z.enum(['workspace', 'account']).optional(),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'سجل التدقيق' })
  list(@ZodQuery(auditQuery) q: z.infer<typeof auditQuery>, @CurrentUser() viewer: AuthUser) {
    return this.audit.list(q, viewer);
  }
}
