import { Workbook } from 'exceljs';
import { WorkCalendar } from '@nuzli/scheduling';
import {
  applyScheduleEdit,
  diffTasks,
  dueFlags,
  needsRenumber,
  projectProgress,
  recompute,
  riyadhToday,
  sortOrderBetween,
  subtreeIds,
  type StoredTask,
} from './task-engine';
import { buildTasksWorkbook, compareWbs, type TaskExportRow } from './tasks-export';

const cal = new WorkCalendar({ weekendDays: [5, 6], exceptions: [{ date: '2026-10-20', isWorking: false }] });

function t(id: string, over: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    projectId: 'p',
    parentId: null,
    sortOrder: 1,
    wbsCache: '',
    name: id,
    type: 'TASK',
    startDate: '2026-10-11',
    endDate: '2026-10-11',
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeId: null,
    description: null,
    version: 0,
    plannedCost: 0,
    actualCost: 0,
    deadline: null,
    barColor: null,
    labelIds: [],
    ...over,
  };
}

describe('task-engine', () => {
  it('end dates are recomputed from start + working-day duration; an end alone becomes a duration', () => {
    // Thu 15 + 3 working days → Thu 15, Sun 18, Mon 19.
    expect(applyScheduleEdit(t('a'), { startDate: '2026-10-15', durationDays: 3 }, cal)).toMatchObject({ endDate: '2026-10-19', durationDays: 3 });
    // A Friday start snaps to Sunday.
    expect(applyScheduleEdit(t('a'), { startDate: '2026-10-16' }, cal)).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-18' });
    // End over the holiday: Sun 18 .. Wed 21 = 3 working days.
    expect(applyScheduleEdit(t('a', { startDate: '2026-10-18' }), { endDate: '2026-10-21' }, cal)).toMatchObject({ durationDays: 3, endDate: '2026-10-21' });
    // Milestone: duration 0, end = start.
    expect(applyScheduleEdit(t('m', { type: 'MILESTONE' }), { startDate: '2026-10-14', durationDays: 4 }, cal)).toMatchObject({
      durationDays: 0,
      endDate: '2026-10-14',
    });
  });

  it('recompute refreshes the WBS cache from parent + sort order and diff separates version bumps from WBS-only changes', () => {
    const before = [t('a', { sortOrder: 1, wbsCache: '1' }), t('b', { sortOrder: 2, wbsCache: '2' }), t('c', { sortOrder: 3, wbsCache: '3' })];
    const edited = before.map((x) => (x.id === 'c' ? { ...x, parentId: 'a' } : x));
    const finals = recompute({ tasks: edited, dependencies: [], calendar: cal, autoSchedule: true });
    expect(Object.fromEntries(finals.map((x) => [x.id, [x.wbsCache, x.type]]))).toEqual({ a: ['1', 'GROUP'], b: ['2', 'TASK'], c: ['1.1', 'TASK'] });
    const diff = diffTasks(new Map(before.map((x) => [x.id, x])), finals);
    expect(diff.versioned.map((v) => [v.after.id, v.fields])).toEqual([
      ['a', ['type']],
      ['c', ['parentId']],
    ]);
    expect(diff.wbsOnly).toEqual([]);
  });

  it('a dependency cycle from the engine becomes DEPENDENCY_CYCLE with the path', () => {
    expect(() =>
      recompute({
        tasks: [t('a'), t('b')],
        dependencies: [
          { predecessorId: 'a', successorId: 'b', type: 'FS', lagDays: 0 },
          { predecessorId: 'b', successorId: 'a', type: 'FS', lagDays: 0 },
        ],
        calendar: cal,
        autoSchedule: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'DEPENDENCY_CYCLE', details: { path: expect.arrayContaining(['a', 'b']) } }));
  });

  it('fractional sort keys, renumber detection, subtree and project progress', () => {
    expect(sortOrderBetween(null, null)).toBe(1);
    expect(sortOrderBetween(2, null)).toBe(3);
    expect(sortOrderBetween(null, 2)).toBe(1);
    expect(sortOrderBetween(1, 2)).toBe(1.5);
    expect(needsRenumber(1, 1 + 1e-12)).toBe(true);
    expect(subtreeIds([t('a'), t('b', { parentId: 'a' }), t('c', { parentId: 'b' }), t('d')], 'a')).toEqual(['a', 'b', 'c']);
    expect(projectProgress([{ type: 'TASK', durationDays: 3, progress: 100 }, { type: 'TASK', durationDays: 1, progress: 0 }, { type: 'MILESTONE', durationDays: 0, progress: 0 }])).toBe(75);
    expect(projectProgress([])).toBe(0);
  });

  it('due flags use Riyadh today and the working calendar', () => {
    expect(riyadhToday(new Date('2026-10-11T20:59:00Z'))).toBe('2026-10-11');
    expect(riyadhToday(new Date('2026-10-11T21:00:00Z'))).toBe('2026-10-12');
    // Today Sun 18; 2 working days ahead skips the Tue 20 holiday → Wed 21.
    expect(dueFlags({ endDate: '2026-10-21', status: 'IN_PROGRESS' }, '2026-10-18', cal)).toEqual({ overdue: false, dueSoon: true });
    expect(dueFlags({ endDate: '2026-10-22', status: 'IN_PROGRESS' }, '2026-10-18', cal)).toEqual({ overdue: false, dueSoon: false });
    expect(dueFlags({ endDate: '2026-10-17', status: 'IN_PROGRESS' }, '2026-10-18', cal)).toEqual({ overdue: true, dueSoon: false });
    expect(dueFlags({ endDate: '2026-10-17', status: 'DONE' }, '2026-10-18', cal)).toEqual({ overdue: false, dueSoon: false });
  });
});

describe('tasks Excel export (ADR-019)', () => {
  const rows: TaskExportRow[] = [
    { wbs: '1.10', name: 'فرعية عاشرة', type: 'TASK', startDate: '2026-10-11', endDate: '2026-10-12', durationDays: 2, progress: 40, status: 'IN_PROGRESS', priority: 'HIGH', assigneeName: 'مشرف', teamName: 'فريق', description: null },
    { wbs: '1', name: 'مرحلة', type: 'GROUP', startDate: '2026-10-11', endDate: '2026-10-15', durationDays: 4, progress: 50, status: 'IN_PROGRESS', priority: 'MEDIUM', assigneeName: null, teamName: null, description: null },
    { wbs: '1.2', name: 'فرعية', type: 'MILESTONE', startDate: '2026-10-15', endDate: '2026-10-15', durationDays: 0, progress: 0, status: 'NOT_STARTED', priority: 'LOW', assigneeName: null, teamName: null, description: 'وصف' },
  ];

  it('round-trips: RTL sheets, no frozen panes, Arabic headers, WBS order, real dates, indent by level', async () => {
    const buffer = await buildTasksWorkbook(
      {
        name: 'مشروع',
        status: 'ACTIVE',
        startDate: '2026-10-11',
        endDate: '2026-10-15',
        progress: 50,
        calendarName: 'افتراضي',
        autoSchedule: true,
        generatedAt: new Date('2026-10-12T05:00:00Z'),
      },
      rows,
    );
    const wb = new Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['المهام', 'المشروع']);
    for (const ws of wb.worksheets) {
      expect(ws.views.length).toBeGreaterThan(0);
      for (const v of ws.views) {
        expect(v.rightToLeft).toBe(true);
        expect(v.state).not.toBe('frozen');
        expect((v as { xSplit?: number }).xSplit ?? 0).toBe(0);
        expect((v as { ySplit?: number }).ySplit ?? 0).toBe(0);
      }
    }
    const ws = wb.getWorksheet('المهام')!;
    expect(ws.getRow(1).getCell(1).value).toBe('رقم WBS');
    expect(ws.getRow(1).getCell(2).value).toBe('المهمة');
    expect([2, 3, 4].map((r) => ws.getRow(r).getCell(1).value)).toEqual(['1', '1.2', '1.10']);
    const start = ws.getRow(2).getCell(4).value;
    expect(start).toBeInstanceOf(Date);
    expect((start as Date).toISOString().slice(0, 10)).toBe('2026-10-11');
    expect(ws.getRow(2).getCell(2).alignment?.indent ?? 0).toBe(0);
    expect(ws.getRow(3).getCell(2).alignment?.indent).toBe(1);
    expect(ws.getRow(2).getCell(7).value).toBe(0.5);
    expect(ws.getRow(3).getCell(3).value).toBe('معلَم');
  });

  it('compares WBS numerically', () => {
    expect(['1.10', '2', '1.2', '1'].sort(compareWbs)).toEqual(['1', '1.2', '1.10', '2']);
  });
});
