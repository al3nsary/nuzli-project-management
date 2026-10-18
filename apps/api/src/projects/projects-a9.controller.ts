import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  attachmentBrowseQuerySchema,
  calendarRangeQuerySchema,
  checklistItemSchema,
  checklistReorderSchema,
  customFieldSchema,
  customValueSchema,
  deleteViewPrefQuerySchema,
  duplicateTaskSchema,
  hubQuerySchema,
  labelSchema,
  portfolioProjectSchema,
  portfolioSchema,
  projectReportQuerySchema,
  putViewPrefSchema,
  saveAsTemplateSchema,
  taskBulkArchiveSchema,
  taskBulkSchema,
  taskLabelSchema,
  taskRestoreSchema,
  timeEntrySchema,
  timeRangeQuerySchema,
  updateChecklistItemSchema,
  updateCustomFieldSchema,
  updateLabelSchema,
  updatePortfolioSchema,
  updateTimeEntrySchema,
  viewPrefQuerySchema,
  workloadQuerySchema,
  type AttachmentBrowseDto,
  type BudgetReportDto,
  type ChecklistItemDto,
  type CommentReadDto,
  type CustomFieldDto,
  type CustomValueDto,
  type DuplicateTaskResult,
  type HubPageDto,
  type LabelDto,
  type Paginated,
  type PortfolioDto,
  type PortfolioSummaryDto,
  type ProjectCalendarDto,
  type ProjectDashboardDto,
  type ProjectDto,
  type ProjectPersonDto,
  type ProjectReportRow,
  type TaskBulkArchiveResult,
  type TaskBulkResult,
  type TaskDto,
  type TaskPreviousMap,
  type TaskRestoreResult,
  type TaskUpdateResult,
  type TimeEntryDto,
  type ViewPrefDto,
  type WorkloadDto,
} from '@nuzli/shared';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { HubService } from './hub.service';
import { ProjectReportsService } from './project-reports.service';
import { TASK_READ } from './projects.controller';
import { TaskCollabService } from './task-collab.service';
import { TaskDetailsService } from './task-details.service';
import { TasksService } from './tasks.service';
import { TemplatesService } from './templates.service';
import { TimeEntriesService } from './time-entries.service';
import { ViewPrefsService } from './view-prefs.service';

/** Write a task's time, or tick its checklist: admins, and the assignee (scope in the service). */
const TASK_WORK = ['tasks.manage', 'tasks.updateAssigned'] as const;

/** A9 project routes (admin): budget, people, dashboard, calendar, labels, fields, bulk, templates. */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsA9Controller {
  constructor(
    private readonly reports: ProjectReportsService,
    private readonly details: TaskDetailsService,
    private readonly tasks: TasksService,
    private readonly templates: TemplatesService,
  ) {}

  @Get(':id/budget')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'تقرير الميزانية: حسب المجموعة والمسند إليه والوسم، والمخطط مقابل الفعلي، والمهام المتجاوزة' })
  budget(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<BudgetReportDto> {
    return this.reports.budget(id, viewer);
  }

  @Get(':id/people')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'المسند إليهم في المشروع: عدد المهام والإنجاز والتأخر وحصة الميزانية والوقت المسجّل' })
  people(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ProjectPersonDto[]> {
    return this.reports.projectPeople(id, viewer);
  }

  @Get(':id/dashboard')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'لوحة المشروع: المؤشرات وتوزيع الحالات والمتأخرات واستهلاك الميزانية والمواعيد القريبة' })
  dashboard(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ProjectDashboardDto> {
    return this.reports.dashboard(id, viewer);
  }

  @Get(':id/calendar')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'بيانات تبويب التقويم: المهام والمعالم والمواعيد النهائية في المدى' })
  calendar(
    @Param('id', UuidPipe) id: string,
    @ZodQuery(calendarRangeQuerySchema) q: z.output<typeof calendarRangeQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<ProjectCalendarDto> {
    return this.reports.calendar(id, q, viewer);
  }

  @Get(':id/labels')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'وسوم المشروع' })
  labels(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<LabelDto[]> {
    return this.details.labels(id, viewer);
  }

  @Post(':id/labels')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إضافة وسم' })
  createLabel(
    @Param('id', UuidPipe) id: string,
    @ZodBody(labelSchema) body: z.output<typeof labelSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<LabelDto> {
    return this.details.createLabel(id, body, viewer, ctx);
  }

  @Get(':id/custom-fields')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'الحقول المخصّصة للمشروع' })
  fields(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<CustomFieldDto[]> {
    return this.details.fields(id, viewer);
  }

  @Post(':id/custom-fields')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إضافة حقل مخصّص (نص، رقم، قائمة، تاريخ، مربع اختيار)' })
  createField(
    @Param('id', UuidPipe) id: string,
    @ZodBody(customFieldSchema) body: z.output<typeof customFieldSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CustomFieldDto> {
    return this.details.createField(id, body, viewer, ctx);
  }

  @Post(':id/tasks/bulk')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'تعديل جماعي في معاملة واحدة مع فحص النسخ وإعادة الجدولة؛ يعيد previous للتراجع' })
  bulk(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskBulkSchema) body: z.output<typeof taskBulkSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskBulkResult> {
    return this.tasks.bulk(id, body, viewer, ctx);
  }

  @Post(':id/tasks/bulk-archive')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'أرشفة جماعية مع الفروع والاعتماديات' })
  bulkArchive(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskBulkArchiveSchema) body: z.output<typeof taskBulkArchiveSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskBulkArchiveResult> {
    return this.tasks.bulkArchive(id, body, viewer, ctx);
  }

  @Post(':id/tasks/restore')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'استرجاع مهام مؤرشفة (التراجع عن الأرشفة)' })
  restore(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskRestoreSchema) body: z.output<typeof taskRestoreSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskRestoreResult> {
    return this.tasks.restore(id, body, viewer, ctx);
  }

  @Post(':id/save-as-template')
  @RequirePermission('projects.create')
  @ApiOperation({ summary: 'حفظ المشروع قالبًا (الهيكل والمدد والاعتماديات والوسوم والحقول وقوائم التحقق)' })
  saveAsTemplate(
    @Param('id', UuidPipe) id: string,
    @ZodBody(saveAsTemplateSchema) body: z.output<typeof saveAsTemplateSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    return this.templates.saveAsTemplate(id, body, viewer, ctx);
  }
}

/** A9 task routes: duplicate, labels, custom values, checklist, time log, read state. */
@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksA9Controller {
  constructor(
    private readonly tasks: TasksService,
    private readonly details: TaskDetailsService,
    private readonly time: TimeEntriesService,
    private readonly collab: TaskCollabService,
  ) {}

  @Post(':id/duplicate')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'تكرار المهمة (مع فروعها افتراضيًّا) بعد الأصل مباشرة' })
  duplicate(
    @Param('id', UuidPipe) id: string,
    @ZodBody(duplicateTaskSchema) body: z.output<typeof duplicateTaskSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<DuplicateTaskResult> {
    return this.tasks.duplicate(id, body, viewer, ctx);
  }

  @Get(':id/labels')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'وسوم المهمة' })
  labels(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<LabelDto[]> {
    return this.details.taskLabels(id, viewer);
  }

  @Post(':id/labels')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'وضع وسم على المهمة' })
  addLabel(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskLabelSchema) body: z.output<typeof taskLabelSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskUpdateResult> {
    return this.details.setTaskLabel(id, body.labelId, true, viewer, ctx);
  }

  @Delete(':id/labels/:labelId')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إزالة وسم من المهمة' })
  removeLabel(
    @Param('id', UuidPipe) id: string,
    @Param('labelId', UuidPipe) labelId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskUpdateResult> {
    return this.details.setTaskLabel(id, labelId, false, viewer, ctx);
  }

  @Get(':id/custom-fields')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'حقول المشروع المخصّصة مع قيم هذه المهمة' })
  customFields(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<Array<CustomFieldDto & { value: unknown }>> {
    return this.details.taskFields(id, viewer);
  }

  @Put(':id/custom-values/:fieldId')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'تعيين قيمة حقل مخصّص (null يمسحها) بالتحقق من نوعه' })
  setValue(
    @Param('id', UuidPipe) id: string,
    @Param('fieldId', UuidPipe) fieldId: string,
    @ZodBody(customValueSchema) body: z.output<typeof customValueSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CustomValueDto> {
    return this.details.setValue(id, fieldId, body.value, viewer, ctx);
  }

  @Get(':id/checklist')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'قائمة التحقق' })
  checklist(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ChecklistItemDto[]> {
    return this.details.checklist(id, viewer);
  }

  @Post(':id/checklist')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إضافة بند' })
  addItem(
    @Param('id', UuidPipe) id: string,
    @ZodBody(checklistItemSchema) body: z.output<typeof checklistItemSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChecklistItemDto> {
    return this.details.addItem(id, body, viewer, ctx);
  }

  @Post(':id/checklist/reorder')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إعادة ترتيب البنود' })
  reorder(
    @Param('id', UuidPipe) id: string,
    @ZodBody(checklistReorderSchema) body: z.output<typeof checklistReorderSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChecklistItemDto[]> {
    return this.details.reorder(id, body.ids, viewer, ctx);
  }

  @Patch(':id/checklist/:itemId')
  @RequireAnyPermission(...TASK_WORK)
  @ApiOperation({ summary: 'تعديل بند (المشرف المسند إليه: إنجاز البند فقط)' })
  updateItem(
    @Param('id', UuidPipe) id: string,
    @Param('itemId', UuidPipe) itemId: string,
    @ZodBody(updateChecklistItemSchema) body: z.output<typeof updateChecklistItemSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChecklistItemDto> {
    return this.details.updateItem(id, itemId, body, viewer, ctx);
  }

  @Delete(':id/checklist/:itemId')
  @HttpCode(204)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'حذف بند' })
  async deleteItem(
    @Param('id', UuidPipe) id: string,
    @Param('itemId', UuidPipe) itemId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.details.deleteItem(id, itemId, viewer, ctx);
  }

  @Get(':id/time-entries')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'سجل الوقت على المهمة' })
  timeEntries(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<TimeEntryDto[]> {
    return this.time.forTask(id, viewer);
  }

  @Post(':id/time-entries')
  @RequireAnyPermission(...TASK_WORK)
  @ApiOperation({ summary: 'تسجيل وقت (المشرف على مهامه؛ المدير على أي مهمة ولأي مستخدم نشط)' })
  addTime(
    @Param('id', UuidPipe) id: string,
    @ZodBody(timeEntrySchema) body: z.output<typeof timeEntrySchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TimeEntryDto> {
    return this.time.create(id, body, viewer, ctx);
  }

  @Post(':id/comments/read')
  @HttpCode(200)
  @RequirePermission('tasks.comment')
  @ApiOperation({ summary: 'تعليم تعليقات المهمة مقروءة حتى الآن' })
  markRead(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<CommentReadDto> {
    return this.collab.markRead(id, viewer);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('labels')
export class LabelsController {
  constructor(private readonly details: TaskDetailsService) {}

  @Patch(':id')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'تعديل وسم' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateLabelSchema) body: z.output<typeof updateLabelSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<LabelDto> {
    return this.details.updateLabel(id, body, viewer, ctx);
  }

  @Delete(':id')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'حذف وسم (يُزال من مهامه بنسخة جديدة لكل مهمة)' })
  remove(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<{ affected: TaskDto[]; previous: TaskPreviousMap }> {
    return this.details.deleteLabel(id, viewer, ctx);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly details: TaskDetailsService) {}

  @Patch(':id')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'تعديل حقل مخصّص (الاسم والخيارات والترتيب؛ النوع ثابت)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateCustomFieldSchema) body: z.output<typeof updateCustomFieldSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CustomFieldDto> {
    return this.details.updateField(id, body, viewer, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'حذف حقل مخصّص وقيمه' })
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.details.deleteField(id, viewer, ctx);
  }
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly time: TimeEntriesService) {}

  @Patch(':id')
  @RequireAnyPermission(...TASK_WORK)
  @ApiOperation({ summary: 'تعديل قيد وقت (صاحبه أو المدير)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateTimeEntrySchema) body: z.output<typeof updateTimeEntrySchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TimeEntryDto> {
    return this.time.update(id, body, viewer, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAnyPermission(...TASK_WORK)
  @ApiOperation({ summary: 'حذف قيد وقت (صاحبه أو المدير)' })
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.time.remove(id, viewer, ctx);
  }
}

/** A9 personal routes under /me (the auth module owns GET/PATCH /me itself). */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeA9Controller {
  constructor(
    private readonly prefs: ViewPrefsService,
    private readonly time: TimeEntriesService,
  ) {}

  @Get('view-prefs')
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'إعدادات العرض المحفوظة (الأعمدة والعروض) — عامة أو لمشروع' })
  viewPrefs(@ZodQuery(viewPrefQuerySchema) q: z.output<typeof viewPrefQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<ViewPrefDto[]> {
    return this.prefs.list(viewer, q);
  }

  @Put('view-prefs')
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'حفظ إعداد عرض (٣٢ كيلوبايت كحد أعلى)' })
  putViewPref(@ZodBody(putViewPrefSchema) body: z.output<typeof putViewPrefSchema>, @CurrentUser() viewer: AuthUser): Promise<ViewPrefDto> {
    return this.prefs.put(viewer, body);
  }

  @Delete('view-prefs')
  @HttpCode(204)
  @RequirePermission('profile.update')
  @ApiOperation({ summary: 'حذف إعداد عرض' })
  async deleteViewPref(@ZodQuery(deleteViewPrefQuerySchema) q: z.output<typeof deleteViewPrefQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<void> {
    await this.prefs.remove(viewer, q);
  }

  @Get('time-entries')
  @RequireAnyPermission(...TASK_WORK)
  @ApiOperation({ summary: 'سجل وقتي (افتراضيًّا آخر ٣١ يومًا)' })
  myTime(@ZodQuery(timeRangeQuerySchema) q: z.output<typeof timeRangeQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<TimeEntryDto[]> {
    return this.time.mine(viewer, q);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller()
export class ProjectsOverviewController {
  constructor(
    private readonly reports: ProjectReportsService,
    private readonly templates: TemplatesService,
    private readonly hub: HubService,
  ) {}

  @Get('project-templates')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'قوالب المشاريع' })
  listTemplates(@CurrentUser() viewer: AuthUser): Promise<ProjectDto[]> {
    return this.templates.listTemplates(viewer);
  }

  @Get('reports/projects')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'تقرير المشاريع: الحالة والإنجاز والميزانية والمتأخرات' })
  projectsReport(@ZodQuery(projectReportQuerySchema) q: z.output<typeof projectReportQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<ProjectReportRow[]> {
    return this.reports.projectsReport(q.status, viewer);
  }

  @Get('workload')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'عبء العمل لكل مشرف يومًا بيوم: الساعات المسندة والمسجّلة (حتى ٩٢ يومًا)' })
  workload(@ZodQuery(workloadQuerySchema) q: z.output<typeof workloadQuerySchema>): Promise<WorkloadDto> {
    return this.reports.workload(q);
  }

  @Get('hub')
  @RequirePermission('tasks.comment')
  @ApiOperation({ summary: 'مركز التواصل: كل محادثات المهام التي تراها مع غير المقروء والتصفية والبحث' })
  hubPage(@ZodQuery(hubQuerySchema) q: z.output<typeof hubQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<HubPageDto> {
    return this.hub.hub(viewer, q);
  }

  @Get('attachments')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'متصفح المرفقات (المدير الكل؛ المشرف مرفقات مهامه)' })
  attachments(
    @ZodQuery(attachmentBrowseQuerySchema) q: z.output<typeof attachmentBrowseQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<AttachmentBrowseDto>> {
    return this.hub.attachments(viewer, q);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('portfolios')
export class PortfoliosController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'المحافظ' })
  list(): Promise<PortfolioDto[]> {
    return this.templates.listPortfolios();
  }

  @Post()
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إنشاء محفظة' })
  create(@ZodBody(portfolioSchema) body: z.output<typeof portfolioSchema>, @ReqCtx() ctx: RequestContext): Promise<PortfolioDto> {
    return this.templates.createPortfolio(body, ctx);
  }

  @Get(':id')
  @RequirePermission('projects.readAll')
  @ApiOperation({ summary: 'ملخص المحفظة: إنجاز كل مشروع وميزانيته وتواريخه وحالته والمجاميع' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<PortfolioSummaryDto> {
    return this.templates.portfolioSummary(id, viewer);
  }

  @Patch(':id')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تعديل محفظة (projectIds يستبدل القائمة)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updatePortfolioSchema) body: z.output<typeof updatePortfolioSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<PortfolioDto> {
    return this.templates.updatePortfolio(id, body, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'حذف محفظة (المشاريع تبقى)' })
  async remove(@Param('id', UuidPipe) id: string, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.templates.deletePortfolio(id, ctx);
  }

  @Post(':id/projects')
  @HttpCode(200)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إضافة مشروع إلى المحفظة' })
  addProject(
    @Param('id', UuidPipe) id: string,
    @ZodBody(portfolioProjectSchema) body: z.output<typeof portfolioProjectSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<PortfolioDto> {
    return this.templates.setPortfolioProject(id, body.projectId, true, ctx);
  }

  @Delete(':id/projects/:projectId')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إخراج مشروع من المحفظة' })
  removeProject(
    @Param('id', UuidPipe) id: string,
    @Param('projectId', UuidPipe) projectId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<PortfolioDto> {
    return this.templates.setPortfolioProject(id, projectId, false, ctx);
  }
}
