import { Module } from '@nestjs/common';
import { OCR_ENGINE, TesseractEngine } from './ocr/ocr-engine';
import { OcrQueueService } from './ocr/ocr-queue.service';
import { ViolationAssignService } from './violation-assign.service';
import { ViolationFilesService } from './violation-files.service';
import { ViolationTypesService } from './violation-types.service';
import { ViolationsController, ViolationTypesController } from './violations.controller';
import { ViolationsService } from './violations.service';

/** Phase 3 — violations (brief §7). Storage, settings, audit and notifications are global. */
@Module({
  controllers: [ViolationsController, ViolationTypesController],
  providers: [
    ViolationsService,
    ViolationTypesService,
    ViolationFilesService,
    ViolationAssignService,
    OcrQueueService,
    // A9 (ADR-104): the OCR engine is created lazily on the first job (WASM worker thread).
    { provide: OCR_ENGINE, useFactory: () => new TesseractEngine() },
  ],
  exports: [ViolationsService],
})
export class ViolationsModule {}
