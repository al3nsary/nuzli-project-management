import { Module } from '@nestjs/common';
import { ColorsModule } from '../colors/colors.module';
import { MembersModule } from '../members/members.module';
import { UsersModule } from '../users/users.module';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  imports: [UsersModule, ColorsModule, MembersModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
