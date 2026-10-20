import { Module } from '@nestjs/common';
import { CalendarsService } from './calendars.service';
import { HubService } from './hub.service';
import { CalendarsController, DependenciesController, ProjectsController, TasksController } from './projects.controller';
import {
  CustomFieldsController,
  LabelsController,
  MeA9Controller,
  PortfoliosController,
  ProjectsA9Controller,
  ProjectsOverviewController,
  TasksA9Controller,
  TimeEntriesController,
} from './projects-a9.controller';
import { MeParticipationsController, ProjectParticipantsController } from './participants.controller';
import { ParticipantsService } from './participants.service';
import { ProjectCoverService } from './project-cover.service';
import { ProjectReportsService } from './project-reports.service';
import { ProjectStore } from './project-store';
import { ProjectsService } from './projects.service';
import { TaskCollabService } from './task-collab.service';
import { TaskDetailsService } from './task-details.service';
import { TaskDueService } from './task-due.service';
import { TasksService } from './tasks.service';
import { TemplatesService } from './templates.service';
import { TimeEntriesService } from './time-entries.service';
import { ViewPrefsService } from './view-prefs.service';

/**
 * Phase 4 — projects, tasks, dependencies, calendars (brief §6) and owner request A9 —
 * budget, labels, custom fields, checklists, duplicate, bulk, templates, portfolios, time log,
 * reports, workload, communication hub and attachments. Storage, audit and notifications are global.
 */
@Module({
  controllers: [
    ProjectsController,
    TasksController,
    DependenciesController,
    CalendarsController,
    ProjectsA9Controller,
    TasksA9Controller,
    LabelsController,
    CustomFieldsController,
    TimeEntriesController,
    MeA9Controller,
    ProjectsOverviewController,
    PortfoliosController,
    // A12 round 2
    ProjectParticipantsController,
    MeParticipationsController,
  ],
  providers: [
    ProjectStore,
    ProjectsService,
    TasksService,
    CalendarsService,
    TaskCollabService,
    TaskDueService,
    TaskDetailsService,
    ProjectReportsService,
    TemplatesService,
    TimeEntriesService,
    ViewPrefsService,
    HubService,
    ParticipantsService,
    ProjectCoverService,
  ],
  exports: [ProjectStore],
})
export class ProjectsModule {}
