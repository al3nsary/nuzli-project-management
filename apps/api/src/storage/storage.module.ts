import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  controllers: [FilesController],
  providers: [StorageService, FilesService],
  exports: [StorageService, FilesService],
})
export class StorageModule {}
