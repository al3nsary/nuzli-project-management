import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PublicWorkspaceDto, SystemInfoDto } from '@nuzli/shared';
import { CurrentUser, Public, WorkspaceOptional } from '../common/decorators';
import type { AuthUser } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';

/** A12: single-workspace mode flag and (for owners) the workspace list. */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(private readonly prisma: PrismaService) {}

  @WorkspaceOptional()
  @Get('info')
  @ApiOperation({ summary: 'عدد الأقسام ووضع القسم الواحد' })
  async info(@CurrentUser() user: AuthUser): Promise<SystemInfoDto> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, code: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      workspaceCount: workspaces.length,
      singleWorkspace: workspaces.length <= 1,
      ...(user.accountRole === 'OWNER' ? { workspaces } : {}),
    };
  }
}

/** A12: registration picks a workspace by name — names of ACTIVE workspaces only, nothing else. */
@ApiTags('public')
@Controller('public')
export class PublicWorkspacesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('workspaces')
  @ApiOperation({ summary: 'أسماء الأقسام النشطة (لنموذج التسجيل)' })
  async list(): Promise<PublicWorkspaceDto[]> {
    return this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
