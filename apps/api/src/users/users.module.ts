import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { MembershipsService } from './memberships.service';
import { RegistrationsController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, RegistrationsController],
  // A12 round 2: account administration and memberships (used by the admin module too).
  providers: [UsersService, AccountsService, MembershipsService],
  exports: [UsersService, AccountsService, MembershipsService],
})
export class UsersModule {}
