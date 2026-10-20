import { Global, Module } from '@nestjs/common';
import { PRISMA_CLIENT_OPTIONS, PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    // Empty in production (DATABASE_URL); tests replace it with a PGlite driver adapter.
    { provide: PRISMA_CLIENT_OPTIONS, useValue: {} },
    PrismaService,
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
