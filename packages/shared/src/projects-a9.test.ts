import { describe, expect, it } from 'vitest';
import {
  can,
  createProjectSchema,
  createTaskSchema,
  normalizeCustomValue,
  putViewPrefSchema,
  taskBatchSchema,
  taskBulkSchema,
  updateProjectSchema,
  workloadQuerySchema,
} from './index';

describe('A9 — supervisors and the matrix (ADR-092)', () => {
  it('supervisors no longer read projects; they keep their own tasks and comments', () => {
    const s = { role: 'SUPERVISOR' as const, status: 'ACTIVE' };
    expect(can(s, 'projects.readGranted')).toBe(false);
    expect(can(s, 'projects.readAll')).toBe(false);
    expect(can(s, 'tasks.readAssigned')).toBe(true);
    expect(can(s, 'tasks.updateAssigned')).toBe(true);
    expect(can(s, 'tasks.comment')).toBe(true);
  });
});

describe('A9 — schemas', () => {
  it('money is rounded to 2 decimals and never negative', () => {
    const t = createTaskSchema.parse({ name: 'x', startDate: '2026-10-11', plannedCost: 10.005, actualCost: 3 });
    expect(t.plannedCost).toBe(10.01);
    expect(createTaskSchema.safeParse({ name: 'x', startDate: '2026-10-11', actualCost: -1 }).success).toBe(false);
  });

  it('projects take a budget and currency; fromTemplateId only on create', () => {
    const p = createProjectSchema.parse({ name: 'مشروع', startDate: '2026-10-11', budget: 1000, currency: 'SAR', fromTemplateId: '00000000-0000-4000-8000-000000000001' });
    expect(p).toMatchObject({ budget: 1000, currency: 'SAR' });
    expect(createProjectSchema.safeParse({ name: 'مشروع', startDate: '2026-10-11', currency: 'sar' }).success).toBe(false);
    expect('fromTemplateId' in updateProjectSchema.parse({ fromTemplateId: 'x' })).toBe(false);
  });

  it('the batch accepts the fields an inverse operation needs', () => {
    const r = taskBatchSchema.parse({
      changes: [{ id: '00000000-0000-4000-8000-000000000001', version: 2, priority: 'HIGH', assigneeId: null, barColor: '#303F9F', labelIds: [], deadline: null }],
    });
    expect(r.changes[0]).toMatchObject({ priority: 'HIGH', assigneeId: null, barColor: '#303F9F', labelIds: [] });
  });

  it('bulk needs at least one change', () => {
    const base = { ids: ['00000000-0000-4000-8000-000000000001'], versions: { '00000000-0000-4000-8000-000000000001': 0 } };
    expect(taskBulkSchema.safeParse({ ...base, patch: {} }).success).toBe(false);
    expect(taskBulkSchema.safeParse({ ...base, patch: { shiftWorkingDays: -2 } }).success).toBe(true);
  });

  it('view pref keys are dotted names', () => {
    expect(putViewPrefSchema.safeParse({ key: 'gantt.columns', value: [] }).success).toBe(true);
    expect(putViewPrefSchema.safeParse({ key: 'Gantt columns', value: [] }).success).toBe(false);
  });

  it('workload userIds is a comma list of uuids', () => {
    const q = workloadQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', userIds: '00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002' });
    expect(q.userIds).toHaveLength(2);
    expect(workloadQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', userIds: 'nope' }).success).toBe(false);
  });
});

describe('A9 — custom field values', () => {
  const dd = { type: 'DROPDOWN' as const, options: ['أ', 'ب'] };
  it.each([
    [{ type: 'TEXT' as const, options: [] }, '  نص  ', 'نص'],
    [{ type: 'TEXT' as const, options: [] }, '   ', null],
    [{ type: 'NUMBER' as const, options: [] }, '12.5', 12.5],
    [{ type: 'NUMBER' as const, options: [] }, 7, 7],
    [dd, 'ب', 'ب'],
    [{ type: 'DATE' as const, options: [] }, '2026-02-28', '2026-02-28'],
    [{ type: 'CHECKBOX' as const, options: [] }, true, true],
    [{ type: 'CHECKBOX' as const, options: [] }, null, null],
  ])('accepts %o %o', (field, raw, value) => {
    expect(normalizeCustomValue(field, raw)).toEqual({ ok: true, value });
  });

  it.each([
    [{ type: 'NUMBER' as const, options: [] }, 'abc'],
    [{ type: 'NUMBER' as const, options: [] }, Number.NaN],
    [dd, 'ج'],
    [{ type: 'DATE' as const, options: [] }, '2026-02-30'],
    [{ type: 'CHECKBOX' as const, options: [] }, 'yes'],
    [{ type: 'TEXT' as const, options: [] }, 5],
  ])('rejects %o %o', (field, raw) => {
    expect(normalizeCustomValue(field, raw).ok).toBe(false);
  });
});
