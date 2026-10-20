/**
 * A12 verification D6 (docs/A12-verification.md): an export made by someone without budget.read
 * leaves the cost columns out (Excel, CSV) and the cost tags out (MS Project XML) — zeros would
 * read as «this costs nothing».
 */
import { Workbook } from 'exceljs';
import { buildTasksCsv, buildTasksWorkbook, taskColumns, type ProjectExportMeta, type TaskExportRow } from './tasks-export';
import { writeMspdi } from '../imports/mspdi';

const row: TaskExportRow = {
  wbs: '1',
  name: 'تسوية الأرض',
  type: 'TASK',
  startDate: '2026-10-19',
  endDate: '2026-10-25',
  durationDays: 5,
  progress: 20,
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  assigneeName: null,
  teamName: null,
  description: null,
  plannedCost: 123457,
  actualCost: 98761,
  deadline: '2026-10-26',
  labels: [],
  customValues: {},
};
const meta = (money?: boolean): ProjectExportMeta => ({
  name: 'مشروع',
  status: 'ACTIVE',
  startDate: '2026-10-19',
  endDate: null,
  progress: 20,
  calendarName: 'تقويم',
  autoSchedule: true,
  generatedAt: new Date('2026-10-20T07:00:00Z'),
  ...(money === undefined ? {} : { money }),
});

describe('exports without budget.read', () => {
  it('taskColumns drops only the two cost columns', () => {
    const all = taskColumns(meta());
    const none = taskColumns(meta(false));
    expect(all).toContain('التكلفة المخططة');
    expect(none).not.toContain('التكلفة المخططة');
    expect(none).not.toContain('التكلفة الفعلية');
    expect(none.length).toBe(all.length - 2);
  });

  it('CSV: no cost header, rows as wide as the header, the deadline still in its column', () => {
    const csv = buildTasksCsv(meta(false), [row]).toString('utf8').replace(/^﻿/, '');
    const [head, line] = csv.trim().split('\r\n');
    expect(head).not.toMatch(/التكلفة/);
    expect(line!.split(',').length).toBe(head!.split(',').length);
    expect(line).not.toMatch(/123457|98761/);
    expect(line!.split(',')[head!.split(',').indexOf('الموعد النهائي')]).toBe('2026-10-26');
    expect(buildTasksCsv(meta(), [row]).toString('utf8')).toMatch(/123457/);
  });

  it('Excel: no cost header and the deadline is a date cell under its header', async () => {
    const wb = new Workbook();
    await wb.xlsx.load(await buildTasksWorkbook(meta(false), [row]));
    const ws = wb.getWorksheet('المهام')!;
    const head = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    expect(head).not.toContain('التكلفة المخططة');
    const col = head.indexOf('الموعد النهائي') + 1;
    expect(ws.getRow(2).getCell(col).value).toBeInstanceOf(Date);
    expect(ws.getColumn(col).numFmt).toBe('yyyy-mm-dd');
  });

  it('MS Project XML: no Cost / ActualCost tags when the costs are absent', () => {
    const base = {
      name: 'مشروع',
      startDate: '2026-10-19',
      unit: 'DAY' as const,
      calendar: { name: 'تقويم', weekendDays: [5, 6], workingHours: [{ start: '09:00', end: '17:00' }], exceptions: [] },
      deps: [],
    };
    const task = { id: 't1', parentId: null, wbs: '1', name: 'تسوية الأرض', type: 'TASK' as const, startDate: '2026-10-19', endDate: '2026-10-25', durationDays: 5, progress: 20, deadline: null, notes: null, assigneeName: null };
    expect(writeMspdi({ ...base, tasks: [task] } as never)).not.toMatch(/<Cost>|<ActualCost>/);
    expect(writeMspdi({ ...base, tasks: [{ ...task, plannedCost: 10, actualCost: 5 }] } as never)).toMatch(/<Cost>1000<\/Cost>/);
  });
});
