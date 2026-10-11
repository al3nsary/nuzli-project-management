import { Module } from '@nestjs/common';
import { CardsController, LogosController } from './cards.controller';
import { CardsService } from './cards.service';
import { PrintService } from './print.service';

@Module({
  controllers: [CardsController, LogosController],
  providers: [CardsService, PrintService],
  exports: [CardsService, PrintService],
})
export class CardsModule {}
