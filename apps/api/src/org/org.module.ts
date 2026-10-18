import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

/** A9 organisational structure (ADR-102). Prisma and audit are global. */
@Module({
  controllers: [OrgController],
  providers: [OrgService],
})
export class OrgModule {}
