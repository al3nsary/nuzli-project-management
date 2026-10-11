import { Module } from '@nestjs/common';
import { ViolationFilesService } from './violation-files.service';
import { ViolationTypesService } from './violation-types.service';
import { ViolationsController, ViolationTypesController } from './violations.controller';
import { ViolationsService } from './violations.service';

/** Phase 3 — violations (brief §7). Storage, settings, audit and notifications are global. */
@Module({
  controllers: [ViolationsController, ViolationTypesController],
  providers: [ViolationsService, ViolationTypesService, ViolationFilesService],
  exports: [ViolationsService],
})
export class ViolationsModule {}
