/**
 * A9 project-page logic: undo/redo inverse operations (ADR-095/101, 409 ends the chain), column
 * preferences, the multi-select bulk payload, duplicate, row reorder, HOUR drag snapping, the
 * filter/grouping and cascade sorting, budget roll-up display.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskDto } from '@nuzli/shared';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { ApiError } from '../../api/errors';
import { archiveOp, inverseOf, rootsOf, useUndoStore } from './undo';
import {
  DEFAULT_COLUMNS,
  addColumn,
  availableColumns,
  moveColumn,
  normalizeColumns,
  removeColumn,
  resizeColumn,
} from '../gantt/columns';
import { buildRows, dragDeltaMinutes, dragDeltaDays, fitZoom } from '../gantt/geometry';
import { overdueDays, reorderChange } from '../gantt/Gantt';
import { EMPTY_FILTER, NONE, cascadeChanges, groupFn, matchTask } from './filters';
import { formatMoney } from '../../i18n';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-a9-web-${Date.now()}-${n++}` });
});
const SUP1_ID = '00000000-0000-4000-8000-000000000003';

async function admin() {
  const s = await api.auth.login({ identifier: 'admin1@demo.nuzli.example', password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
}

async function project() {
  await admin();
  const p = await api.projects.create({ name: 'اختبار الواجهة', startDate: '2026-11-01' });
  const g = await api.tasks.create(p.id, { name: 'مجموعة', type: 'GROUP', startDate: '2026-11-01' });
  await api.tasks.create(p.id, { name: 'أ', parentId: g.id, startDate: '2026-11-01', durationDays: 2, plannedCost: 100 });
  await api.tasks.create(p.id, { name: 'ب', parentId: g.id, startDate: '2026-11-03', durationDays: 1, plannedCost: 50.25 });
  return { p, g: await api.projects.gantt(p.id) };
}

describe('undo / redo (ADR-095)', () => {
  it('inverseOf sends previous back with the versions of the same answer; description goes through PATCH', () => {
    const op = inverseOf(
      { a: { startDate: '2026-11-01', type: 'TASK' }, b: { description: 'قديم' }, c: { name: 'x' } },
      [
        { id: 'a', version: 4 },
        { id: 'b', version: 2 },
      ],
    );
    expect(op).toEqual({ kind: 'batch', changes: [{ id: 'a', version: 4, startDate: '2026-11-01' }, { id: 'b', version: 2 }], descriptions: [{ id: 'b', description: 'قديم' }] });
    expect(inverseOf({}, [])).toBeNull();
  });

  it('undo then redo round-trips through the batch endpoint; a concurrent edit makes the redo 409', async () => {
    const { p, g } = await project();
    const a = g.tasks.find((x) => x.name === 'أ')!;
    const fwd = await api.tasks.update(a.id, { version: a.version, priority: 'URGENT', startDate: '2026-11-04' });
    const undo = inverseOf(fwd.previous, [fwd.task, ...fwd.affected])!;
    expect(undo.kind).toBe('batch');
    const back = await api.tasks.batch(p.id, { changes: (undo as unknown as { changes: never[] }).changes });
    expect(back.tasks.find((x) => x.id === a.id)).toMatchObject({ priority: 'MEDIUM', startDate: '2026-11-01' });
    const redo = inverseOf(back.previous, back.tasks)!;
    // Someone edits the task before the redo: the redo answers 409 (the UI ends the chain).
    const cur = back.tasks.find((x) => x.id === a.id)!;
    await api.tasks.update(a.id, { version: cur.version, name: 'تعديل آخر' });
    const err = await api.tasks.batch(p.id, { changes: (redo as unknown as { changes: never[] }).changes }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT_VERSION');
  });

  it('a create is undone by archiving the new roots; the store keeps undo and redo apart', () => {
    const created = [
      { id: 'r', parentId: 'g', version: 0 },
      { id: 'c', parentId: 'r', version: 0 },
    ];
    expect(rootsOf(created)).toEqual(['r']);
    expect(archiveOp(created)).toEqual({ kind: 'archive', ids: ['r'], versions: { r: 0 } });
    const s = useUndoStore.getState();
    s.clear('p');
    s.record('p', { label: 'أ', op: archiveOp(created) });
    expect(useUndoStore.getState().byProject.p!.undo).toHaveLength(1);
    const e = useUndoStore.getState().popUndo('p')!;
    useUndoStore.getState().pushRedo('p', e);
    expect(useUndoStore.getState().byProject.p!.redo).toHaveLength(1);
    useUndoStore.getState().clearRedo('p');
    expect(useUndoStore.getState().byProject.p!.redo).toHaveLength(0);
    useUndoStore.getState().record('p', e);
    expect(useUndoStore.getState().byProject.p!.redo).toHaveLength(0);
  });
});

describe('column preferences (gantt.columns, list.columns)', () => {
  it('normalizes stored values: name first, unknown and deleted fields dropped, widths clamped', () => {
    const fields = [{ id: 'f1' }];
    const cols = normalizeColumns(
      [{ id: 'status', width: 2000 }, { id: 'nope', width: 10 }, { id: 'cf:gone', width: 100 }, { id: 'cf:f1', width: 10 }, { id: 'name', width: 300 }, { id: 'status', width: 99 }],
      fields,
    );
    expect(cols.map((c) => c.id)).toEqual(['name', 'status', 'cf:f1']);
    expect(cols[1]!.width).toBe(600);
    expect(cols[2]!.width).toBe(80);
    expect(normalizeColumns(null, fields)).toEqual(DEFAULT_COLUMNS);
  });

  it('add, hide, move and resize; name cannot move or hide', () => {
    let cols = addColumn(DEFAULT_COLUMNS, 'deadline');
    expect(cols.map((c) => c.id)).toEqual(['name', 'assignee', 'status', 'deadline']);
    cols = moveColumn(cols, 3, 1);
    expect(cols.map((c) => c.id)).toEqual(['name', 'deadline', 'assignee', 'status']);
    expect(moveColumn(cols, 0, 2)).toEqual(cols);
    expect(removeColumn(cols, 'name')).toEqual(cols);
    cols = resizeColumn(removeColumn(cols, 'assignee'), 'deadline', 150);
    expect(cols).toEqual([{ id: 'name', width: 280 }, { id: 'deadline', width: 150 }, { id: 'status', width: 128 }]);
    expect(availableColumns(cols, [{ id: 'f', projectId: 'p', name: 'حقل', type: 'TEXT', options: [], sort: 1 }])).toContain('cf:f');
  });

  it('persist per user per project through /me/view-prefs', async () => {
    const { p } = await project();
    const cols = addColumn(DEFAULT_COLUMNS, 'plannedCost');
    await api.viewPrefs.put({ projectId: p.id, key: 'gantt.columns', value: cols });
    await api.viewPrefs.put({ projectId: p.id, key: 'list.columns', value: [{ id: 'name', width: 300 }] });
    const prefs = await api.viewPrefs.list({ projectId: p.id });
    expect(normalizeColumns(prefs.find((x) => x.key === 'gantt.columns')!.value, [])).toEqual(cols);
    expect(prefs.map((x) => x.key).sort()).toEqual(['gantt.columns', 'list.columns']);
  });
});

describe('multi-select bulk and duplicate', () => {
  it('sends one bulk request with a version per selected id', async () => {
    const { p, g } = await project();
    const ids = g.tasks.filter((x) => x.type !== 'GROUP').map((x) => x.id);
    const versions = Object.fromEntries(ids.map((id) => [id, g.tasks.find((x) => x.id === id)!.version]));
    const res = await api.tasks.bulk(p.id, { ids, versions, patch: { status: 'DONE', progress: 100, assigneeId: SUP1_ID } });
    expect(res.tasks.filter((x) => ids.includes(x.id)).every((x) => x.status === 'DONE' && x.assignee?.id === SUP1_ID)).toBe(true);
    // The group rolls up to 100 % and is part of the answer (and of the undo).
    expect(res.tasks.find((x) => x.type === 'GROUP')?.progress).toBe(100);
    expect(Object.keys(res.previous)).toEqual(expect.arrayContaining(ids));
  });

  it('duplicate copies the subtree after the original and is undone by archiving the copy root', async () => {
    const { p, g } = await project();
    const group = g.tasks.find((x) => x.type === 'GROUP')!;
    const d = await api.tasks.duplicate(group.id);
    const op = archiveOp(d.tasks);
    expect(op).toMatchObject({ kind: 'archive', ids: [d.idMap[group.id]] });
    const arch = await api.tasks.bulkArchive(p.id, { ids: (op as unknown as { ids: string[] }).ids, versions: (op as unknown as { versions: Record<string, number> }).versions });
    expect(arch.archivedIds).toHaveLength(3);
    expect((await api.projects.gantt(p.id)).tasks).toHaveLength(3);
  });
});

describe('Gantt rows, reorder and HOUR snapping', () => {
  const base = (id: string, parentId: string | null, sortOrder: number, wbs: string, extra: Partial<TaskDto> = {}): TaskDto => ({
    id,
    projectId: 'p',
    parentId,
    sortOrder,
    wbs,
    name: id,
    type: 'TASK',
    startDate: '2026-11-01',
    endDate: '2026-11-01',
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assignee: null,
    description: null,
    version: 1,
    commentCount: 0,
    attachmentCount: 0,
    ...extra,
  });
  const tasks = [base('g', null, 1, '1', { type: 'GROUP' }), base('a', 'g', 1, '1.1'), base('b', 'g', 2, '1.2'), base('c', null, 2, '2')];

  it('inline add lines end each expanded group and the project', () => {
    const rows = buildRows(tasks, new Set(), { addRows: true });
    expect(rows.map((r) => r.kind === 'add' ? `+${r.addParentId ?? 'root'}` : r.id)).toEqual(['g', 'a', 'b', '+g', 'c', '+root']);
    expect(buildRows(tasks, new Set(['g']), { addRows: true }).map((r) => r.id)).toEqual(['g', 'c', 'add:root']);
  });

  it('a filter keeps ancestors; grouping flattens leaves under headers', () => {
    const rows = buildRows(tasks, new Set(), { visible: (t) => t.id === 'b' });
    expect(rows.map((r) => r.id)).toEqual(['g', 'b']);
    const grouped = buildRows(tasks, new Set(), { groupBy: (t) => [{ key: t.status, label: t.status }] });
    expect(grouped.map((r) => r.kind ?? 'task')).toEqual(['header', 'task', 'task', 'task']);
  });

  it('reorder: before a sibling, as first child of an expanded group, at the end via the add line', () => {
    const rows = buildRows(tasks, new Set(), { addRows: true });
    expect(reorderChange(tasks, rows, new Set(), 'c', 1, false)).toEqual({ id: 'c', parentId: 'g', sortOrder: 0 });
    expect(reorderChange(tasks, rows, new Set(), 'c', 2, false)).toEqual({ id: 'c', parentId: 'g', sortOrder: 1.5 });
    expect(reorderChange(tasks, rows, new Set(), 'c', 0, true)).toEqual({ id: 'c', parentId: 'g', sortOrder: 0 });
    expect(reorderChange(tasks, rows, new Set(), 'a', 5, false)).toEqual({ id: 'a', parentId: null, sortOrder: 3 });
  });

  it('HOUR drags snap to 15 minutes; DAY drags to whole days; left is later (RTL)', () => {
    // 192 px per day (8 px an hour): 12 px left ≈ 90 minutes later → snapped to 90.
    expect(dragDeltaMinutes(-12, 192)).toBe(90);
    expect(dragDeltaMinutes(-13, 192)).toBe(105);
    expect(dragDeltaMinutes(-15, 192)).toBe(120);
    expect(dragDeltaMinutes(1, 192)).toBe(0);
    expect(dragDeltaDays(-28, 14)).toBe(2);
    expect(fitZoom([{ startDate: '2026-11-01', endDate: '2026-11-03' }], 900)).toBe('day');
    expect(fitZoom([{ startDate: '2026-11-01T09:00', endDate: '2026-11-02T18:00' }], 1200, 'HOUR')).toBe('day');
  });

  it('overdue days after the end date, never for done tasks or groups', () => {
    expect(overdueDays({ endDate: '2026-10-12', status: 'IN_PROGRESS', type: 'TASK' }, '2026-10-19')).toBe(7);
    expect(overdueDays({ endDate: '2026-10-12', status: 'DONE', type: 'TASK' }, '2026-10-19')).toBe(0);
    expect(overdueDays({ endDate: '2026-10-12', status: 'IN_PROGRESS', type: 'GROUP' }, '2026-10-19')).toBe(0);
  });
});

describe('filters, grouping, cascade sorting and money', () => {
  const t1 = { id: '1', name: 'تسوية', wbs: '1.1', status: 'IN_PROGRESS', priority: 'HIGH', assignee: { id: 'u', fullName: 'فهد', teamName: 'الصقور', teamColor: '#123456' }, labelIds: ['l1'], customValues: { f: 'أ' } } as unknown as TaskDto;
  const t2 = { id: '2', name: 'تبليط', wbs: '1.2', status: 'DONE', priority: 'LOW', assignee: null, labelIds: [], customValues: {} } as unknown as TaskDto;
  it('matches every active criterion; «none» buckets work', () => {
    expect(matchTask(t1, { ...EMPTY_FILTER, statuses: ['IN_PROGRESS'], labels: ['l1'] })).toBe(true);
    expect(matchTask(t2, { ...EMPTY_FILTER, assignees: [NONE], labels: [NONE] })).toBe(true);
    expect(matchTask(t2, { ...EMPTY_FILTER, q: 'تسو' })).toBe(false);
    const fields = new Map([['f', { id: 'f', projectId: 'p', name: 'م', type: 'DROPDOWN' as const, options: ['أ'], sort: 1 }]]);
    expect(matchTask(t1, { ...EMPTY_FILTER, field: { id: 'f', value: 'أ' } }, fields)).toBe(true);
    expect(matchTask(t2, { ...EMPTY_FILTER, field: { id: 'f', value: 'أ' } }, fields)).toBe(false);
  });
  it('groups by team with the team colour', () => {
    const fn = groupFn('team', {
      labels: new Map(),
      fields: new Map(),
      statusLabel: (s) => s,
      priorityLabel: (p) => p,
      words: { unassigned: 'غ', noLabel: 'ب', noTeam: 'لا فريق', noValue: '—', yes: 'نعم', no: 'لا' },
    })!;
    expect(fn(t1)).toEqual([{ key: 't:الصقور', label: 'الصقور', color: '#123456', order: 0 }]);
    expect(fn(t2)[0]!.label).toBe('لا فريق');
  });
  it('cascade sorting orders siblings by start date', () => {
    const mk = (id: string, sortOrder: number, startDate: string) => ({ id, parentId: 'g', sortOrder, startDate, endDate: startDate, version: 1 }) as unknown as TaskDto;
    expect(cascadeChanges([mk('a', 1, '2026-11-05'), mk('b', 2, '2026-11-01')])).toEqual([
      { id: 'b', version: 1, sortOrder: 1 },
      { id: 'a', version: 1, sortOrder: 2 },
    ]);
    expect(cascadeChanges([mk('a', 1, '2026-11-01'), mk('b', 2, '2026-11-05')])).toEqual([]);
  });
  it('budget roll-up display: groups sum their children; SAR with Western digits', async () => {
    const { g } = await project();
    expect(g.tasks.find((x) => x.type === 'GROUP')!.plannedCost).toBe(150.25);
    expect(formatMoney(150.25)).toBe('150.25 ر.س');
    expect(formatMoney(520000)).toBe('520,000 ر.س');
  });
});
