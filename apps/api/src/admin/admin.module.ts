import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { OwnersController, WorkspacesAdminController } from './admin.controller';
import { OwnersService } from './owners.service';
import { WorkspacesAdminService } from './workspaces-admin.service';

/** A12 round 2 — owners and workspace administration (ADR-148). */
@Module({
  imports: [UsersModule],
  controllers: [OwnersController, WorkspacesAdminController],
  providers: [OwnersService, WorkspacesAdminService],
})
export class AdminModule {}
