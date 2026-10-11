import { Module } from '@nestjs/common';
import { RegistrationsController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, RegistrationsController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
