import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  calendarExceptionSchema,
  calendarSchema,
  convertProjectSchema,
  createDependencySchema,
  createProjectSchema,
  createTaskSchema,
  grantProjectAccessSchema,
  projectExportQuerySchema,
  projectListQuerySchema,
  taskAttachmentSchema,
  taskBatchSchema,
  taskCommentSchema,
  updateCalendarSchema,
  updateProjectSchema,
  updateTaskSchema,
  type ActivityDto,
  type CreatedDependencyDto,
  type CreatedTaskDto,
  type GanttDto,
  type MyTaskDto,
  type ProjectAccessDto,
  type ProjectDto,
  type TaskArchiveResult,
  type TaskAttachmentDto,
  type TaskBatchResult,
  type TaskCommentDto,
  type TaskDto,
  type TaskUpdateResult,
} from '@nuzli/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentUser, ReqCtx, RequireAnyPermission, RequirePermission } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { CalendarsService, type CalendarWithDefault } from './calendars.service';
import { ProjectsService } from './projects.service';
import { TaskCollabService } from './task-collab.service';
import { TasksService } from './tasks.service';

const READ_ANY = ['projects.readAll', 'projects.readGranted'] as const;
/** A9 (ADR-092): a task and its thread, attachments, checklist and time log — admins, and supervisors for their own tasks (the service applies the scope). */
export const TASK_READ = ['projects.readAll', 'tasks.readAssigned'] as const;

/**
 * Phase 4 (brief §6, docs/API.md "Phase 4"). Guards check the permission from the shared
 * matrix; the services apply the scope. Since A9 (ADR-092) only admins reach projects (a
 * supervisor gets 403 here); supervisors reach the tasks assigned to them through /tasks.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
  ) {}

  @Get()
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'المشاريع (المدير؛ القوالب في /project-templates)' })
  list(@ZodQuery(projectListQuerySchema) q: z.output<typeof projectListQuerySchema>, @CurrentUser() viewer: AuthUser): Promise<ProjectDto[]> {
    return this.projects.list(q, viewer);
  }

  @Post()
  @RequirePermission('projects.create')
  @ApiOperation({ summary: 'إنشاء مشروع (التقويم الافتراضي عند عدم التحديد)' })
  create(
    @ZodBody(createProjectSchema) body: z.output<typeof createProjectSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    return this.projects.create(body, viewer, ctx);
  }

  @Get(':id')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'مشروع' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ProjectDto> {
    return this.projects.get(id, viewer);
  }

  @Patch(':id')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تعديل مشروع (تغيير التقويم أو تشغيل الجدولة التلقائية يعيد جدولة المهام)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateProjectSchema) body: z.output<typeof updateProjectSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    return this.projects.update(id, body, viewer, ctx);
  }

  @Delete(':id')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'أرشفة مشروع' })
  archive(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<ProjectDto> {
    return this.projects.archive(id, viewer, ctx);
  }

  @Get(':id/access')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'المشرفون الممنوحون صلاحية العرض' })
  access(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ProjectAccessDto[]> {
    return this.projects.listAccess(id, viewer);
  }

  @Post(':id/access')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'منح مشرف صلاحية عرض المشروع' })
  grant(
    @Param('id', UuidPipe) id: string,
    @ZodBody(grantProjectAccessSchema) body: z.output<typeof grantProjectAccessSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectAccessDto> {
    return this.projects.grantAccess(id, body, viewer, ctx);
  }

  @Delete(':id/access/:userId')
  @HttpCode(204)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'سحب صلاحية العرض' })
  async revoke(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.projects.revokeAccess(id, userId, viewer, ctx);
  }

  @Get(':id/gantt')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'المشروع ومهامه واعتمادياته وتقويمه في طلب واحد' })
  gantt(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<GanttDto> {
    return this.projects.gantt(id, viewer);
  }

  @Get(':id/export.xlsx')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'تصدير المهام إلى Excel (من اليمين لليسار، دون تجميد أجزاء)' })
  async exportXlsx(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.projects.exportXlsx(id, viewer, ctx);
    sendFile(res, out);
  }

  @Get(':id/export')
  @RequireAnyPermission(...READ_ANY)
  @ApiOperation({ summary: 'تصدير المشروع: xlsx (من اليمين لليسار دون تجميد) أو csv (UTF-8 مع BOM) أو xml (MS Project)' })
  async exportProject(
    @Param('id', UuidPipe) id: string,
    @ZodQuery(projectExportQuerySchema) q: z.output<typeof projectExportQuerySchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.projects.exportProject(id, q.format, viewer, ctx);
    sendFile(res, out);
  }

  @Post(':id/convert')
  @HttpCode(200)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تحويل وحدة المشروع بين الأيام والساعات (كل المهام في معاملة واحدة)' })
  convert(
    @Param('id', UuidPipe) id: string,
    @ZodBody(convertProjectSchema) body: z.output<typeof convertProjectSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    return this.projects.convert(id, body.durationUnit, viewer, ctx);
  }

  @Post(':id/tasks')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'إضافة مهمة (+ المجموعات الأم التي تغيّرت في affected)' })
  createTask(
    @Param('id', UuidPipe) id: string,
    @ZodBody(createTaskSchema) body: z.output<typeof createTaskSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CreatedTaskDto> {
    return this.tasks.create(id, body, viewer, ctx);
  }

  @Post(':id/tasks/batch')
  @HttpCode(200)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'دفعة تعديلات سحبة واحدة: معاملة واحدة، فحص كل النسخ، وإعادة الجدولة على الخادم' })
  batch(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskBatchSchema) body: z.output<typeof taskBatchSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskBatchResult> {
    return this.tasks.batch(id, body, viewer, ctx);
  }

  @Post(':id/dependencies')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'ربط مهمتين (انتهاء ← بداية) مع رفض الحلقات' })
  createDependency(
    @Param('id', UuidPipe) id: string,
    @ZodBody(createDependencySchema) body: z.output<typeof createDependencySchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CreatedDependencyDto> {
    return this.tasks.createDependency(id, body, viewer, ctx);
  }
}

function sendFile(res: Response, out: { filename: string; buffer: Buffer; contentType: string }): void {
  res.status(200);
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(out.buffer);
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly collab: TaskCollabService,
  ) {}

  @Get('mine')
  @RequirePermission('tasks.readAssigned')
  @ApiOperation({ summary: 'مهامي عبر المشاريع، بترتيب تاريخ النهاية، مع علامتي التأخر وقرب الاستحقاق' })
  mine(@CurrentUser() viewer: AuthUser): Promise<MyTaskDto[]> {
    return this.tasks.mine(viewer);
  }

  @Get(':id')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'مهمة' })
  get(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<TaskDto> {
    return this.tasks.get(id, viewer);
  }

  @Patch(':id')
  @RequireAnyPermission('tasks.manage', 'tasks.updateAssigned')
  @ApiOperation({ summary: 'تعديل مهمة (المشرف: الإنجاز والحالة لمهامه فقط) مع إعادة الجدولة' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateTaskSchema) body: z.output<typeof updateTaskSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskUpdateResult> {
    return this.tasks.update(id, body, viewer, ctx);
  }

  @Delete(':id')
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'أرشفة المهمة وفروعها وحذف اعتمادياتها' })
  archive(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<TaskArchiveResult> {
    return this.tasks.archive(id, viewer, ctx);
  }

  @Get(':id/comments')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'تعليقات المهمة' })
  comments(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<TaskCommentDto[]> {
    return this.collab.comments(id, viewer);
  }

  @Post(':id/comments')
  @RequirePermission('tasks.comment')
  @ApiOperation({ summary: 'إضافة تعليق مع الإشارة إلى مستخدمين لهم صلاحية الوصول' })
  addComment(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskCommentSchema) body: z.output<typeof taskCommentSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskCommentDto> {
    return this.collab.addComment(id, body, viewer, ctx);
  }

  @Get(':id/activity')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'سجل نشاط المهمة (من سجل التدقيق)' })
  activity(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<ActivityDto[]> {
    return this.collab.activity(id, viewer);
  }

  @Get(':id/attachments')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'مرفقات المهمة' })
  attachments(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser): Promise<TaskAttachmentDto[]> {
    return this.collab.attachments(id, viewer);
  }

  @Post(':id/attachments')
  @RequireAnyPermission('tasks.manage', 'tasks.updateAssigned')
  @ApiOperation({ summary: 'ربط ملف مرفوع (entityType: task) بالمهمة — المدير والمسند إليه' })
  attach(
    @Param('id', UuidPipe) id: string,
    @ZodBody(taskAttachmentSchema) body: z.output<typeof taskAttachmentSchema>,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<TaskAttachmentDto> {
    return this.collab.attach(id, body.fileId, viewer, ctx);
  }

  @Get(':id/attachments/:fileId/url')
  @RequireAnyPermission(...TASK_READ)
  @ApiOperation({ summary: 'رابط تنزيل مؤقت لمرفق' })
  attachmentUrl(
    @Param('id', UuidPipe) id: string,
    @Param('fileId', UuidPipe) fileId: string,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.collab.attachmentUrl(id, fileId, viewer);
  }

  @Delete(':id/attachments/:fileId')
  @HttpCode(204)
  @RequireAnyPermission('tasks.manage', 'tasks.updateAssigned')
  @ApiOperation({ summary: 'حذف مرفق (المدير أو من رفعه)' })
  async removeAttachment(
    @Param('id', UuidPipe) id: string,
    @Param('fileId', UuidPipe) fileId: string,
    @CurrentUser() viewer: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.collab.removeAttachment(id, fileId, viewer, ctx);
  }
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('dependencies')
export class DependenciesController {
  constructor(private readonly tasks: TasksService) {}

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('tasks.manage')
  @ApiOperation({ summary: 'حذف ربط بين مهمتين' })
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() viewer: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    await this.tasks.deleteDependency(id, viewer, ctx);
  }
}

/** Working calendars and holidays (brief §6.1, §10) — admin. */
@ApiTags('calendars')
@ApiBearerAuth()
@Controller('calendars')
export class CalendarsController {
  constructor(private readonly calendars: CalendarsService) {}

  @Get()
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'التقاويم مع استثناءاتها' })
  list(): Promise<CalendarWithDefault[]> {
    return this.calendars.list();
  }

  @Get(':id')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تقويم' })
  get(@Param('id', UuidPipe) id: string): Promise<CalendarWithDefault> {
    return this.calendars.get(id);
  }

  @Post()
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إنشاء تقويم' })
  create(@ZodBody(calendarSchema) body: z.output<typeof calendarSchema>, @ReqCtx() ctx: RequestContext): Promise<CalendarWithDefault> {
    return this.calendars.create(body, ctx);
  }

  @Patch(':id')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'تعديل تقويم (تغيير أيام العطلة يعيد جدولة مشاريعه)' })
  update(
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateCalendarSchema) body: z.output<typeof updateCalendarSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CalendarWithDefault> {
    return this.calendars.update(id, body, ctx);
  }

  @Post(':id/exceptions')
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'إضافة عطلة أو يوم عمل استثنائي (يعيد جدولة مشاريع التقويم)' })
  addException(
    @Param('id', UuidPipe) id: string,
    @ZodBody(calendarExceptionSchema) body: z.output<typeof calendarExceptionSchema>,
    @ReqCtx() ctx: RequestContext,
  ): Promise<CalendarWithDefault> {
    return this.calendars.addException(id, body, ctx);
  }

  @Delete(':id/exceptions/:exId')
  @HttpCode(204)
  @RequirePermission('projects.manage')
  @ApiOperation({ summary: 'حذف استثناء' })
  async deleteException(
    @Param('id', UuidPipe) id: string,
    @Param('exId', UuidPipe) exId: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.calendars.deleteException(id, exId, ctx);
  }
}
