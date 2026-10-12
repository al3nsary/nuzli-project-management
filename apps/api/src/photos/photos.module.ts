import { Module } from '@nestjs/common';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

/** Personal photos of users and team members (owner request A8). */
@Module({ controllers: [PhotosController], providers: [PhotosService], exports: [PhotosService] })
export class PhotosModule {}
