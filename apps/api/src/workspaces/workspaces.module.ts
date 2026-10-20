import { Global, Injectable, Module, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newStore, workspaceStorage } from '../prisma/workspace-context';
import { WorkspaceAccessService } from './workspace-access.service';
import { PublicWorkspacesController, SystemController } from './workspaces.controller';

/**
 * A12 (ADR-143): opens an empty workspace context for every HTTP request. JwtAuthGuard fills it
 * once the token's workspace is verified; until then only global tables are reachable.
 */
@Injectable()
export class WorkspaceContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    workspaceStorage.run(newStore(), () => next());
  }
}

@Global()
@Module({
  controllers: [SystemController, PublicWorkspacesController],
  providers: [WorkspaceAccessService, WorkspaceContextMiddleware],
  exports: [WorkspaceAccessService],
})
export class WorkspacesModule {}
