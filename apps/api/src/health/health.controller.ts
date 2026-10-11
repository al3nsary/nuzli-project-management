import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Liveness: the process answers. No dependencies checked. */
  @Get('health')
  @ApiOperation({ summary: 'liveness' })
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Readiness: database and object storage reachable. 503 otherwise. */
  @Get('ready')
  @ApiOperation({ summary: 'readiness (database + storage)' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, storage] = await Promise.all([this.prisma.ping(), this.storage.ping()]);
    const ok = db && storage;
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ready' : 'not_ready', checks: { db, storage } };
  }
}
