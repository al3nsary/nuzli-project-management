import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectStore } from './project-store';
import { TaskDetailsService } from './task-details.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const SUP = { id: 'sup1', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const, fullName: 'مشرف' };
const P = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';

async function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
}

function setup() {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [] }],
    projects: [
      { id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' },
      { id: P2, name: 'آخر', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' },
    ],
    tasks: [
      task({ id: A, projectId: P, assigneeId: 'sup1', sortOrder: 1, wbsCache: '1' }),
      task({ id: B, projectId: P, sortOrder: 2, wbsCache: '2', startDate: d('2026-10-12'), endDate: d('2026-10-12') }),
    ],
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const service = new TaskDetailsService(fake.db as never, store, audit);
  return { fake, service };
}

describe('A9 labels', () => {
  it('create (names unique per project), assign through the versioned path, list per task', async () => {
    const { fake, service } = setup();
    const l = await service.createLabel(P, { name: 'كهرباء', color: '#303f9f' }, ADMIN, ctx);
    expect(l).toMatchObject({ projectId: P, name: 'كهرباء', color: '#303F9F' });
    expect(await code(service.createLabel(P, { name: 'كهرباء', color: '#000000' }, ADMIN, ctx))).toBe('NAME_TAKEN');
    // Same name in another project is fine.
    const other = await service.createLabel(P2, { name: 'كهرباء', color: '#000000' }, ADMIN, ctx);

    const res = await service.setTaskLabel(A, l.id, true, ADMIN, ctx);
    expect(res.task).toMatchObject({ labelIds: [l.id], version: 1 });
    expect(res.previous).toEqual({ [A]: { labelIds: [] } });
    expect(fake.labelsOf(A)).toEqual([l.id]);
    expect((await service.taskLabels(A, SUP)).map((x) => x.name)).toEqual(['كهرباء']);
    // A label of another project is refused.
    expect(await code(service.setTaskLabel(A, other.id, true, ADMIN, ctx))).toBe('LABEL_NOT_IN_PROJECT');
    // Removing twice is harmless (no version bump the second time).
    await service.setTaskLabel(A, l.id, false, ADMIN, ctx);
    const again = await service.setTaskLabel(A, l.id, false, ADMIN, ctx);
    expect(again.task.version).toBe(2);
    expect(fake.data.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['label.created', 'task.updated']));
  });

  it('deleting a label takes it off its tasks with a version bump each', async () => {
    const { fake, service } = setup();
    const l = await service.createLabel(P, { name: 'سباكة', color: '#00897B' }, ADMIN, ctx);
    await service.setTaskLabel(A, l.id, true, ADMIN, ctx);
    await service.setTaskLabel(B, l.id, true, ADMIN, ctx);
    const res = await service.deleteLabel(l.id, ADMIN, ctx);
    expect(res.affected.map((t) => [t.id, t.version, t.labelIds])).toEqual([
      [A, 2, []],
      [B, 2, []],
    ]);
    expect(fake.data.labels).toHaveLength(0);
    expect(fake.data.taskLabels).toHaveLength(0);
    expect(fake.data.audit.some((a) => a.action === 'label.deleted')).toBe(true);
  });
});

describe('A9 custom fields', () => {
  it('a dropdown needs options; other types store none; the type is fixed', async () => {
    const { service } = setup();
    expect(await code(service.createField(P, { name: 'المرحلة', type: 'DROPDOWN', options: ['  '] }, ADMIN, ctx))).toBe('CUSTOM_FIELD_OPTIONS_REQUIRED');
    const f = await service.createField(P, { name: 'المرحلة', type: 'DROPDOWN', options: ['أ', 'ب', 'أ'] }, ADMIN, ctx);
    expect(f).toMatchObject({ type: 'DROPDOWN', options: ['أ', 'ب'], sort: 1 });
    const n = await service.createField(P, { name: 'الكمية', type: 'NUMBER', options: ['x'] }, ADMIN, ctx);
    expect(n).toMatchObject({ options: [], sort: 2 });
    expect(await code(service.createField(P, { name: 'الكمية', type: 'TEXT' }, ADMIN, ctx))).toBe('NAME_TAKEN');
  });

  it('values are validated by type; null clears; a field of another project is 404', async () => {
    const { fake, service } = setup();
    const dd = await service.createField(P, { name: 'المرحلة', type: 'DROPDOWN', options: ['أ', 'ب'] }, ADMIN, ctx);
    const num = await service.createField(P, { name: 'الكمية', type: 'NUMBER' }, ADMIN, ctx);
    const date = await service.createField(P, { name: 'الاستلام', type: 'DATE' }, ADMIN, ctx);
    const chk = await service.createField(P, { name: 'معتمد', type: 'CHECKBOX' }, ADMIN, ctx);
    const foreign = await service.createField(P2, { name: 'خارجي', type: 'TEXT' }, ADMIN, ctx);

    expect(await code(service.setValue(A, dd.id, 'ج', ADMIN, ctx))).toBe('CUSTOM_FIELD_VALUE_INVALID');
    expect(await code(service.setValue(A, num.id, 'كثير', ADMIN, ctx))).toBe('CUSTOM_FIELD_VALUE_INVALID');
    expect(await code(service.setValue(A, date.id, '2026-02-30', ADMIN, ctx))).toBe('CUSTOM_FIELD_VALUE_INVALID');
    expect(await code(service.setValue(A, chk.id, 'نعم', ADMIN, ctx))).toBe('CUSTOM_FIELD_VALUE_INVALID');
    expect(await code(service.setValue(A, foreign.id, 'x', ADMIN, ctx))).toBe('NOT_FOUND');

    expect(await service.setValue(A, dd.id, 'ب', ADMIN, ctx)).toEqual({ taskId: A, fieldId: dd.id, value: 'ب' });
    expect((await service.setValue(A, num.id, '12.5', ADMIN, ctx)).value).toBe(12.5);
    await service.setValue(A, chk.id, true, ADMIN, ctx);
    expect(fake.data.customValues).toHaveLength(3);
    await service.setValue(A, chk.id, null, ADMIN, ctx);
    expect(fake.data.customValues).toHaveLength(2);
    const fields = await service.taskFields(A, SUP);
    expect(fields.find((f) => f.id === dd.id)?.value).toBe('ب');
    expect(fields.find((f) => f.id === chk.id)?.value).toBeNull();
    // Deleting a field drops its values.
    await service.deleteField(dd.id, ADMIN, ctx);
    expect(fake.data.customValues.map((v) => v.fieldId)).toEqual([num.id]);
  });
});

describe('A9 checklist', () => {
  it('admins add (also after an item) and reorder; the assigned supervisor only ticks', async () => {
    const { fake, service } = setup();
    const one = await service.addItem(A, { text: 'تركيب' }, ADMIN, ctx);
    const three = await service.addItem(A, { text: 'تسليم' }, ADMIN, ctx);
    const two = await service.addItem(A, { text: 'فحص', afterId: one.id }, ADMIN, ctx);
    expect((await service.checklist(A, SUP)).map((i) => i.text)).toEqual(['تركيب', 'فحص', 'تسليم']);

    const ticked = await service.updateItem(A, two.id, { done: true }, SUP, { ...ctx, actorId: 'sup1' });
    expect(ticked).toMatchObject({ done: true, doneBy: { id: 'sup1', fullName: 'مشرف' } });
    expect(ticked.doneAt).not.toBeNull();
    expect(await code(service.updateItem(A, two.id, { text: 'تغيير' }, SUP, ctx))).toBe('FORBIDDEN');
    expect(await code(service.addItem(B, { text: 'x' }, SUP, ctx))).toBe('NOT_FOUND');

    const order = await service.reorder(A, [three.id, one.id, two.id], ADMIN, ctx);
    expect(order.map((i) => [i.text, i.sort])).toEqual([
      ['تسليم', 1],
      ['تركيب', 2],
      ['فحص', 3],
    ]);
    expect(await code(service.reorder(A, [three.id, one.id], ADMIN, ctx))).toBe('VALIDATION_FAILED');

    const untick = await service.updateItem(A, two.id, { done: false }, ADMIN, ctx);
    expect(untick).toMatchObject({ done: false, doneBy: null, doneAt: null });
    await service.deleteItem(A, one.id, ADMIN, ctx);
    expect(fake.data.checklist).toHaveLength(2);
    expect(fake.data.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['checklist_item.created', 'checklist_item.updated', 'task.checklist_reordered', 'checklist_item.deleted']),
    );
  });
});
