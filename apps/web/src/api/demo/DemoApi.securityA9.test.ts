/**
 * DemoApi parity with the A9 security review (docs/API.md «A9 security review — behaviour
 * changes», ADR-117..120): the supervisor's task updates and hub rows carry nothing beyond their
 * own task, time-entry dates are bounded and lost tasks hide their entries, view preferences are
 * capped, and imports keep at most five previews per admin and cap CSV rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_PREF_MAX_COUNT } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { riyadhToday, addCalendarDaysIso } from '../../features/projects/engine';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-sec-${Date.now()}-${n++}` });
});
afterEach(() => vi.useRealTimers());

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const SUP2_ID = '00000000-0000-4000-8000-000000000004';

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
}
async function errOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** A group with two children; the first is the supervisor's. */
async function project() {
  await loginAs(ADMIN);
  const today = riyadhToday();
  const p = await api.projects.create({ name: 'مراجعة أمنية', startDate: today });
  const g = await api.tasks.create(p.id, { name: 'مجموعة', type: 'GROUP', startDate: today });
  const a = await api.tasks.create(p.id, { name: 'أ', parentId: g.id, startDate: today, durationDays: 2, assigneeId: SUP1_ID });
  await api.tasks.create(p.id, { name: 'ب', parentId: g.id, startDate: today, durationDays: 3 });
  return { p, g, a };
}

describe('supervisor scope (ADR-117)', () => {
  it('PATCH /tasks/:id answers only the own task: affected [] and previous of that task; admins unchanged', async () => {
    const { a, g } = await project();
    await loginAs(SUP1);
    const res = await api.tasks.update(a.id, { version: a.version, progress: 50 });
    expect(res.task.progress).toBe(50);
    expect(res.affected).toEqual([]);
    expect(Object.keys(res.previous ?? {})).toEqual([a.id]);
    // The roll-up still happened.
    await loginAs(ADMIN);
    expect((await api.tasks.get(g.id)).progress).toBeGreaterThan(0);
    const again = await api.tasks.update(a.id, { version: res.task.version, progress: 100 });
    expect(again.affected.map((x) => x.id)).toContain(g.id);
  });

  it('GET /hub: the parent path is empty for supervisors, kept for admins', async () => {
    const { a } = await project();
    await loginAs(ADMIN);
    await api.tasks.addComment(a.id, { body: 'ملاحظة' });
    expect((await api.hub.list({})).items.find((i) => i.task.id === a.id)!.path).toEqual(['مجموعة']);
    await loginAs(SUP1);
    const mine = (await api.hub.list({})).items.find((i) => i.task.id === a.id)!;
    expect(mine.path).toEqual([]);
    expect(mine.project.name).toBe('مراجعة أمنية');
  });
});

describe('time entries (L3)', () => {
  it('dates within today − 366 … today + 7; a reassigned task hides the supervisor’s own entry (404)', async () => {
    const { a } = await project();
    await loginAs(SUP1);
    const today = riyadhToday();
    const tooLate = await errOf(api.tasks.addTimeEntry(a.id, { date: addCalendarDaysIso(today, 8), minutes: 30 }));
    expect(tooLate.code).toBe('VALIDATION_FAILED');
    expect((tooLate.details as { fieldErrors: Record<string, string[]> }).fieldErrors.date![0]).toContain('سنة مضت');
    expect((await errOf(api.tasks.addTimeEntry(a.id, { date: addCalendarDaysIso(today, -367), minutes: 30 }))).code).toBe('VALIDATION_FAILED');
    const e = await api.tasks.addTimeEntry(a.id, { date: addCalendarDaysIso(today, 7), minutes: 30 });
    expect((await errOf(api.timeEntries.update(e.id, { date: addCalendarDaysIso(today, 9) }))).code).toBe('VALIDATION_FAILED');
    await loginAs(ADMIN);
    const cur = await api.tasks.get(a.id);
    await api.tasks.update(a.id, { version: cur.version, assigneeId: SUP2_ID });
    await loginAs(SUP1);
    expect((await errOf(api.timeEntries.update(e.id, { minutes: 45 }))).code).toBe('NOT_FOUND');
    expect((await errOf(api.timeEntries.remove(e.id))).code).toBe('NOT_FOUND');
  });
});

describe('view preferences (L1)', () => {
  it('at most VIEW_PREF_MAX_COUNT keys per user: a new key beyond → 409 VIEW_PREF_LIMIT; updating an existing key still works', async () => {
    await loginAs(ADMIN);
    const existing = (await api.viewPrefs.list()).length;
    for (let i = existing; i < VIEW_PREF_MAX_COUNT; i++) await api.viewPrefs.put({ key: `qa.k${i}`, value: i });
    const err = await errOf(api.viewPrefs.put({ key: 'qa.one-more', value: 1 }));
    expect([err.code, err.status]).toEqual(['VIEW_PREF_LIMIT', 409]);
    expect((await api.viewPrefs.put({ key: `qa.k${VIEW_PREF_MAX_COUNT - 1}`, value: 'x' })).value).toBe('x');
  });
});

describe('imports (L2, M3)', () => {
  const csv = (text: string) => api.imports.upload(new Blob([new TextEncoder().encode(text)]), 'text/csv');

  it('a sixth preview evicts the oldest (410 on commit); the others still commit', async () => {
    await loginAs(ADMIN);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { fileId } = await csv(`اسم المهمة,المدة\nمهمة ${i},1\n`);
      ids.push((await api.imports.preview({ fileId, format: 'csv' })).previewId);
    }
    const gone = await errOf(api.imports.commit({ previewId: ids[0]! }));
    expect([gone.code, gone.status]).toEqual(['IMPORT_PREVIEW_EXPIRED', 410]);
    expect((await api.imports.commit({ previewId: ids[5]! })).taskCount).toBe(1);
  });

  it('CSV rows are capped at the task limit (413) and columns beyond 200 are ignored', async () => {
    await loginAs(ADMIN);
    const many = await csv(`اسم المهمة\n${Array.from({ length: 5017 }, (_, i) => `م${i}`).join('\n')}\n`);
    const err = await errOf(api.imports.preview({ fileId: many.fileId, format: 'csv' }));
    expect([err.code, err.status]).toEqual(['IMPORT_TOO_MANY_TASKS', 413]);
    const wide = await csv(`${Array.from({ length: 205 }, (_, i) => `x${i}`).join(',')},اسم المهمة\n${Array.from({ length: 205 }, () => '1').join(',')},مهمة\n`);
    // The task-name column is beyond column 200, so it is not read.
    expect((await errOf(api.imports.preview({ fileId: wide.fileId, format: 'csv' }))).code).toBe('IMPORT_NO_TASKS');
  });
});
