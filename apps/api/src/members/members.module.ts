import { Module } from '@nestjs/common';
import { MemberArchiveController, MemberRequestsController } from './member-requests.controller';
import { MemberRequestsService } from './member-requests.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [MembersController, MemberArchiveController, MemberRequestsController],
  providers: [MembersService, MemberRequestsService],
  exports: [MembersService, MemberRequestsService],
})
export class MembersModule {}
