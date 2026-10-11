import { Module } from '@nestjs/common';
import { ColorsController } from './colors.controller';
import { ColorsService } from './colors.service';

@Module({ controllers: [ColorsController], providers: [ColorsService], exports: [ColorsService] })
export class ColorsModule {}
