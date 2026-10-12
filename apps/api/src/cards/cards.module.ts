import { Module } from '@nestjs/common';
import { CardsController, LogosController } from './cards.controller';
import { CardsService } from './cards.service';
import { PrintService } from './print.service';
import { PhotosModule } from '../photos/photos.module';

@Module({
  imports: [PhotosModule],
  controllers: [CardsController, LogosController],
  providers: [CardsService, PrintService],
  exports: [CardsService, PrintService],
})
export class CardsModule {}
