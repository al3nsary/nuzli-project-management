import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/** A9 project imports (Excel, CSV, MS Project XML/.mpp, Jira) — ADR-110..112. */
@Module({
  imports: [ProjectsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
