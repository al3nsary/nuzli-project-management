import { Module } from '@nestjs/common';
import { CalendarsService } from './calendars.service';
import { CalendarsController, DependenciesController, ProjectsController, TasksController } from './projects.controller';
import { ProjectStore } from './project-store';
import { ProjectsService } from './projects.service';
import { TaskCollabService } from './task-collab.service';
import { TaskDueService } from './task-due.service';
import { TasksService } from './tasks.service';

/** Phase 4 — projects, tasks, dependencies, calendars (brief §6). Storage, audit and notifications are global. */
@Module({
  controllers: [ProjectsController, TasksController, DependenciesController, CalendarsController],
  providers: [ProjectStore, ProjectsService, TasksService, CalendarsService, TaskCollabService, TaskDueService],
  exports: [ProjectStore],
})
export class ProjectsModule {}
