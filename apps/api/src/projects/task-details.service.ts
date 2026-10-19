import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  can,
  normalizeCustomValue,
  type ChecklistItemDto,
  type checklistItemSchema,
  type CustomFieldDto,
  type customFieldSchema,
  type CustomFieldType,
  type CustomValueDto,
  type LabelDto,
  type labelSchema,
  type PermissionSubject,
  type TaskDto,
  type TaskPreviousMap,
  type TaskUpdateResult,
  type updateChecklistItemSchema,
  type updateCustomFieldSchema,
  type updateLabelSchema,
} from '@nuzli/shared';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { withPrismaErrors } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { mapTaskDbError, ProjectStore, WRITE_TX_OPTIONS } from './project-store';
import { sortOrderBetween } from './task-engine';
import { scopeUpdateResult } from './tasks.service';

type Viewer = PermissionSubject & { id: string; fullName?: string };

export const LABEL_SELECT = { id: true, projectId: true, name: true, color: true } as const;
export const FIELD_SELECT = { id: true, projectId: true, name: true, type: true, options: true, sort: true } as const;
const ITEM_SELECT = {
  id: true,
  taskId: true,
  text: true,
  done: true,
  sort: true,
  doneAt: true,
  doneBy: { select: { id: true, fullName: true } },
} as const;

export function toLabelDto(l: { id: string; projectId: string; name: string; color: string }): LabelDto {
  return { id: l.id, projectId: l.projectId, name: l.name, color: l.color.toUpperCase() };
}

export function optionsOf(v: Prisma.JsonValue | unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function toFieldDto(f: { id: string; projectId: string; name: string; type: CustomFieldType; options: unknown; sort: number }): CustomFieldDto {
  return { id: f.id, projectId: f.projectId, name: f.name, type: f.type, options: optionsOf(f.options), sort: f.sort };
}

function toItemDto(i: {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  sort: number;
  doneAt: Date | null;
  doneBy: { id: string; fullName: string } | null;
}): ChecklistItemDto {
  return { id: i.id, taskId: i.taskId, text: i.text, done: i.done, sort: i.sort, doneBy: i.doneBy, doneAt: i.doneAt?.toISOString() ?? null };
}

/** DROPDOWN options: trimmed, unique, at least one. Other types store []. */
function cleanOptions(type: CustomFieldType, options: string[] | undefined): string[] {
  if (type !== 'DROPDOWN') return [];
  const unique = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (!unique.length) throw new AppError('CUSTOM_FIELD_OPTIONS_REQUIRED');
  return unique;
}

/**
 * A9 task details: project labels (assigned through the versioned task write path), custom
 * fields and their per-task values (validated by type), and checklists. Admins manage all of
 * it; a supervisor ticks checklist items of a task assigned to them (ADR-093).
 */
@Injectable()
export class TaskDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ProjectStore,
    private readonly audit: AuditService,
  ) {}

  private async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, WRITE_TX_OPTIONS);
    } catch (err) {
      throw mapTaskDbError(err);
    }
  }

  private async writableProject(projectId: string, viewer: Viewer) {
    const p = await this.store.visibleProject(projectId, viewer);
    if (p.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    return p;
  }

  private async writableTask(taskId: string, viewer: Viewer, db: Db = this.prisma) {
    const t = await this.store.visibleTask(taskId, viewer, db);
    if (t.project.archivedAt) throw new AppError('PROJECT_ARCHIVED');
    return t;
  }

  // ─────────────────────────────────────────── labels

  async labels(projectId: string, viewer: Viewer): Promise<LabelDto[]> {
    await this.store.visibleProject(projectId, viewer);
    const rows = await this.prisma.projectLabel.findMany({ where: { projectId }, select: LABEL_SELECT, orderBy: { name: 'asc' } });
    return rows.map(toLabelDto);
  }

  /** The labels of one task (for a supervisor, who cannot list the project's labels). */
  async taskLabels(taskId: string, viewer: Viewer): Promise<LabelDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.taskLabel.findMany({ where: { taskId }, select: { label: { select: LABEL_SELECT } } });
    return rows.map((r) => toLabelDto(r.label)).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  async createLabel(projectId: string, input: z.output<typeof labelSchema>, viewer: Viewer, ctx: RequestContext): Promise<LabelDto> {
    await this.writableProject(projectId, viewer);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.projectLabel.create({
          data: { projectId, name: input.name, color: input.color.toUpperCase(), createdById: ctx.actorId },
          select: LABEL_SELECT,
        });
        await this.audit.logCtx(ctx, { action: AuditAction.LABEL_CREATED, entityType: 'project', entityId: projectId, after: { labelId: created.id, name: created.name, color: created.color } }, tx);
        return created;
      }),
    );
    return toLabelDto(row);
  }

  async updateLabel(id: string, input: z.output<typeof updateLabelSchema>, viewer: Viewer, ctx: RequestContext): Promise<LabelDto> {
    const cur = await this.prisma.projectLabel.findUnique({ where: { id }, select: LABEL_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    await this.writableProject(cur.projectId, viewer);
    const data = { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.color !== undefined ? { color: input.color.toUpperCase() } : {}) };
    if (!Object.keys(data).length) return toLabelDto(cur);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const updated = await tx.projectLabel.update({ where: { id }, data, select: LABEL_SELECT });
        await this.audit.logCtx(ctx, { action: AuditAction.LABEL_UPDATED, entityType: 'project', entityId: cur.projectId, before: { labelId: id, name: cur.name, color: cur.color }, after: { labelId: id, ...data } }, tx);
        return updated;
      }),
    );
    return toLabelDto(row);
  }

  /**
   * Deleting a label takes it off its tasks through the versioned write path (each task gets
   * `version + 1` and a `task.updated` entry), then removes the label.
   */
  async deleteLabel(id: string, viewer: Viewer, ctx: RequestContext): Promise<{ affected: TaskDto[]; previous: TaskPreviousMap }> {
    const cur = await this.prisma.projectLabel.findUnique({ where: { id }, select: LABEL_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    await this.writableProject(cur.projectId, viewer);
    const out = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, cur.projectId);
      const finals = s.tasks.map((t) => (t.labelIds.includes(id) ? { ...t, labelIds: t.labelIds.filter((l) => l !== id) } : t));
      const touched = finals.filter((t, i) => t !== s.tasks[i]).map((t) => t.id);
      const res = await this.store.persistDetailed(tx, s, finals, {
        ctx,
        explicit: new Set(touched),
        explicitAction: AuditAction.TASK_UPDATED,
        auditExtra: { cause: 'label.deleted', labelId: id },
      });
      await tx.projectLabel.delete({ where: { id } });
      await this.audit.logCtx(ctx, { action: AuditAction.LABEL_DELETED, entityType: 'project', entityId: cur.projectId, before: { labelId: id, name: cur.name, color: cur.color, tasks: touched.length } }, tx);
      return res;
    });
    return { affected: await this.store.taskDtos(out.ids), previous: out.previous };
  }

  /** Adds or removes one label on one task (versioned write path; no client version needed). */
  async setTaskLabel(taskId: string, labelId: string, on: boolean, viewer: Viewer, ctx: RequestContext): Promise<TaskUpdateResult> {
    const visible = await this.writableTask(taskId, viewer);
    const out = await this.tx(async (tx) => {
      const s = await this.store.lockAndLoad(tx, visible.projectId);
      if (on) await this.store.assertLabels(tx, visible.projectId, [labelId]);
      const cur = s.before.get(taskId);
      if (!cur) throw new AppError('NOT_FOUND');
      const set = new Set(cur.labelIds);
      if (on) set.add(labelId);
      else set.delete(labelId);
      const next = { ...cur, labelIds: [...set].sort() };
      return this.store.persistDetailed(tx, s, s.tasks.map((t) => (t.id === taskId ? next : t)), {
        ctx,
        explicit: new Set([taskId]),
        explicitAction: AuditAction.TASK_UPDATED,
      });
    });
    const [task] = await this.store.taskDtos([taskId]);
    return scopeUpdateResult({ task: task!, affected: [], previous: out.previous }, viewer);
  }

  // ─────────────────────────────────────────── custom fields

  async fields(projectId: string, viewer: Viewer): Promise<CustomFieldDto[]> {
    await this.store.visibleProject(projectId, viewer);
    const rows = await this.prisma.customField.findMany({ where: { projectId }, select: FIELD_SELECT, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return rows.map(toFieldDto);
  }

  /** The fields of the task's project with this task's values (supervisors included). */
  async taskFields(taskId: string, viewer: Viewer): Promise<Array<CustomFieldDto & { value: unknown }>> {
    const t = await this.store.visibleTask(taskId, viewer);
    const [fields, values] = await Promise.all([
      this.prisma.customField.findMany({ where: { projectId: t.projectId }, select: FIELD_SELECT, orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      this.prisma.taskCustomValue.findMany({ where: { taskId }, select: { fieldId: true, value: true } }),
    ]);
    const byField = new Map(values.map((v) => [v.fieldId, v.value]));
    return fields.map((f) => ({ ...toFieldDto(f), value: byField.get(f.id) ?? null }));
  }

  async createField(projectId: string, input: z.output<typeof customFieldSchema>, viewer: Viewer, ctx: RequestContext): Promise<CustomFieldDto> {
    await this.writableProject(projectId, viewer);
    const options = cleanOptions(input.type, input.options);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        let sort = input.sort;
        if (sort === undefined) {
          const last = await tx.customField.findFirst({ where: { projectId }, orderBy: { sort: 'desc' }, select: { sort: true } });
          sort = (last?.sort ?? 0) + 1;
        }
        const created = await tx.customField.create({
          data: { projectId, name: input.name, type: input.type, options, sort, createdById: ctx.actorId },
          select: FIELD_SELECT,
        });
        await this.audit.logCtx(ctx, { action: AuditAction.CUSTOM_FIELD_CREATED, entityType: 'project', entityId: projectId, after: { fieldId: created.id, name: created.name, type: created.type, options: options.length } }, tx);
        return created;
      }),
    );
    return toFieldDto(row);
  }

  /** Name, options (DROPDOWN) and order. Removing an option leaves stored values as they are. */
  async updateField(id: string, input: z.output<typeof updateCustomFieldSchema>, viewer: Viewer, ctx: RequestContext): Promise<CustomFieldDto> {
    const cur = await this.prisma.customField.findUnique({ where: { id }, select: FIELD_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    await this.writableProject(cur.projectId, viewer);
    const data: Prisma.CustomFieldUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.sort !== undefined) data.sort = input.sort;
    if (input.options !== undefined) data.options = cleanOptions(cur.type, input.options);
    if (!Object.keys(data).length) return toFieldDto(cur);
    const row = await withPrismaErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const updated = await tx.customField.update({ where: { id }, data, select: FIELD_SELECT });
        await this.audit.logCtx(ctx, { action: AuditAction.CUSTOM_FIELD_UPDATED, entityType: 'project', entityId: cur.projectId, before: { fieldId: id, name: cur.name, options: optionsOf(cur.options) }, after: { fieldId: id, ...input } }, tx);
        return updated;
      }),
    );
    return toFieldDto(row);
  }

  async deleteField(id: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    const cur = await this.prisma.customField.findUnique({ where: { id }, select: FIELD_SELECT });
    if (!cur) throw new AppError('NOT_FOUND');
    await this.writableProject(cur.projectId, viewer);
    await this.prisma.$transaction(async (tx) => {
      const values = await tx.taskCustomValue.count({ where: { fieldId: id } });
      await tx.customField.delete({ where: { id } });
      await this.audit.logCtx(ctx, { action: AuditAction.CUSTOM_FIELD_DELETED, entityType: 'project', entityId: cur.projectId, before: { fieldId: id, name: cur.name, type: cur.type, values } }, tx);
    });
  }

  /** Sets (or clears with `null`) a task's value for a field of the same project. */
  async setValue(taskId: string, fieldId: string, raw: unknown, viewer: Viewer, ctx: RequestContext): Promise<CustomValueDto> {
    const task = await this.writableTask(taskId, viewer);
    const field = await this.prisma.customField.findUnique({ where: { id: fieldId }, select: FIELD_SELECT });
    if (!field || field.projectId !== task.projectId) throw new AppError('NOT_FOUND');
    const norm = normalizeCustomValue({ type: field.type, options: optionsOf(field.options) }, raw);
    if (!norm.ok) throw new AppError('CUSTOM_FIELD_VALUE_INVALID', { fieldErrors: { value: [norm.message] }, fieldId });
    const value = norm.value;
    const audited = (v: unknown) => (field.type === 'TEXT' && typeof v === 'string' ? `${v.length} حرفًا` : v);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.taskCustomValue.findUnique({ where: { taskId_fieldId: { taskId, fieldId } }, select: { value: true } });
      if (value === null) await tx.taskCustomValue.deleteMany({ where: { taskId, fieldId } });
      else {
        await tx.taskCustomValue.upsert({
          where: { taskId_fieldId: { taskId, fieldId } },
          create: { taskId, fieldId, value, updatedById: ctx.actorId },
          update: { value, updatedById: ctx.actorId },
        });
      }
      await this.audit.logCtx(ctx, { action: AuditAction.TASK_CUSTOM_VALUE_SET, entityType: 'task', entityId: taskId, before: { fieldId, value: audited(before?.value ?? null) }, after: { fieldId, value: audited(value) } }, tx);
    });
    return { taskId, fieldId, value };
  }

  // ─────────────────────────────────────────── checklist

  async checklist(taskId: string, viewer: Viewer): Promise<ChecklistItemDto[]> {
    await this.store.visibleTask(taskId, viewer);
    const rows = await this.prisma.taskChecklistItem.findMany({ where: { taskId }, select: ITEM_SELECT, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toItemDto);
  }

  async addItem(taskId: string, input: z.output<typeof checklistItemSchema>, viewer: Viewer, ctx: RequestContext): Promise<ChecklistItemDto> {
    await this.writableTask(taskId, viewer);
    const row = await this.prisma.$transaction(async (tx) => {
      const items = await tx.taskChecklistItem.findMany({ where: { taskId }, select: { id: true, sort: true }, orderBy: { sort: 'asc' } });
      let sort: number;
      if (input.afterId) {
        const i = items.findIndex((x) => x.id === input.afterId);
        if (i < 0) throw new AppError('VALIDATION_FAILED', { fieldErrors: { afterId: ['البند المرجعي ليس في هذه المهمة'] } });
        sort = sortOrderBetween(items[i]!.sort, items[i + 1]?.sort ?? null);
      } else sort = sortOrderBetween(items.at(-1)?.sort ?? null, null);
      const created = await tx.taskChecklistItem.create({ data: { taskId, text: input.text, sort, createdById: ctx.actorId }, select: ITEM_SELECT });
      await this.audit.logCtx(ctx, { action: AuditAction.CHECKLIST_ITEM_CREATED, entityType: 'task', entityId: taskId, after: { itemId: created.id, length: input.text.length } }, tx);
      return created;
    });
    return toItemDto(row);
  }

  private async item(taskId: string, itemId: string) {
    const item = await this.prisma.taskChecklistItem.findFirst({ where: { id: itemId, taskId }, select: { ...ITEM_SELECT, doneById: true } });
    if (!item) throw new AppError('NOT_FOUND');
    return item;
  }

  /** Admins edit anything; the assignee (a supervisor) only ticks or unticks (ADR-093). */
  async updateItem(taskId: string, itemId: string, input: z.output<typeof updateChecklistItemSchema>, viewer: Viewer, ctx: RequestContext): Promise<ChecklistItemDto> {
    const task = await this.writableTask(taskId, viewer);
    if (!can(viewer, 'tasks.manage')) {
      if (task.assigneeId !== viewer.id || input.text !== undefined) throw new AppError('FORBIDDEN', input.text !== undefined ? { fields: ['text'] } : undefined);
    }
    const cur = await this.item(taskId, itemId);
    const data: Prisma.TaskChecklistItemUncheckedUpdateInput = {};
    if (input.text !== undefined && input.text !== cur.text) data.text = input.text;
    if (input.done !== undefined && input.done !== cur.done) {
      data.done = input.done;
      data.doneById = input.done ? viewer.id : null;
      data.doneAt = input.done ? new Date() : null;
    }
    if (!Object.keys(data).length) return toItemDto(cur);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.taskChecklistItem.update({ where: { id: itemId }, data, select: ITEM_SELECT });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.CHECKLIST_ITEM_UPDATED,
          entityType: 'task',
          entityId: taskId,
          before: { itemId, ...(data.done !== undefined ? { done: cur.done } : {}), ...(data.text !== undefined ? { length: cur.text.length } : {}) },
          after: { itemId, ...(data.done !== undefined ? { done: data.done } : {}), ...(data.text !== undefined ? { length: input.text!.length } : {}) },
        },
        tx,
      );
      return updated;
    });
    return toItemDto(row);
  }

  async deleteItem(taskId: string, itemId: string, viewer: Viewer, ctx: RequestContext): Promise<void> {
    await this.writableTask(taskId, viewer);
    const cur = await this.item(taskId, itemId);
    await this.prisma.$transaction(async (tx) => {
      await tx.taskChecklistItem.delete({ where: { id: itemId } });
      await this.audit.logCtx(ctx, { action: AuditAction.CHECKLIST_ITEM_DELETED, entityType: 'task', entityId: taskId, before: { itemId, done: cur.done, length: cur.text.length } }, tx);
    });
  }

  /** `ids` must be exactly the task's items, in the new order (sort = 1..n). */
  async reorder(taskId: string, ids: string[], viewer: Viewer, ctx: RequestContext): Promise<ChecklistItemDto[]> {
    await this.writableTask(taskId, viewer);
    await this.prisma.$transaction(async (tx) => {
      const items = await tx.taskChecklistItem.findMany({ where: { taskId }, select: { id: true } });
      const have = new Set(items.map((i) => i.id));
      if (new Set(ids).size !== ids.length || ids.length !== have.size || ids.some((i) => !have.has(i))) {
        throw new AppError('VALIDATION_FAILED', { fieldErrors: { ids: ['أرسل كل بنود القائمة مرة واحدة بالترتيب الجديد'] } });
      }
      for (const [i, id] of ids.entries()) await tx.taskChecklistItem.update({ where: { id }, data: { sort: i + 1 } });
      await this.audit.logCtx(ctx, { action: AuditAction.TASK_CHECKLIST_REORDERED, entityType: 'task', entityId: taskId, after: { ids } }, tx);
    });
    return this.checklist(taskId, viewer);
  }
}
