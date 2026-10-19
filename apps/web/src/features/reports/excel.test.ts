import { describe, expect, it } from 'vitest';
import type { ProjectDto, ProjectReportRow } from '@nuzli/shared';
import { blobToArrayBuffer } from '../../lib/bytes';
import { buildProjectsReportWorkbook, reportFileName, workbookBlob } from './excel';

const project = (over: Partial<ProjectDto>): ProjectDto => ({
  id: 'p1',
  name: 'تأهيل حديقة الحي الشمالي',
  description: null,
  startDate: '2026-09-29',
  endDate: '2026-12-13',
  status: 'ACTIVE',
  calendarId: 'c',
  autoSchedule: true,
  owner: { id: 'u', fullName: 'مدير' },
  progress: 25,
  taskCount: 60,
  createdAt: '2026-09-01T00:00:00Z',
  budget: 520000,
  currency: 'SAR',
  plannedCost: 652800,
  actualCost: 95950,
  budgetUsedPct: 18.45,
  ...over,
});

const ROWS: ProjectReportRow[] = [
  { project: project({}), leafCount: 47, doneCount: 7, overdueCount: 3, deadlinePassedCount: 2, milestoneCount: 3 },
  {
    project: project({ id: 'p2', name: 'تركيب ري — ساعات', endDate: '2026-10-20T17:45', budget: 1000, actualCost: 1500, plannedCost: 900, budgetUsedPct: 150 }),
    leafCount: 7,
    doneCount: 2,
    overdueCount: 0,
    deadlinePassedCount: 0,
    milestoneCount: 1,
  },
  { project: project({ id: 'p3', name: 'بلا ميزانية', budget: null, budgetUsedPct: null, endDate: null }), leafCount: 1, doneCount: 0, overdueCount: 0, deadlinePassedCount: 0, milestoneCount: 0 },
];

async function roundTrip() {
  const wb = await buildProjectsReportWorkbook(ROWS, { generatedAt: new Date('2026-10-19T09:00:00Z'), filterLabel: 'كل غير المؤرشفة' });
  const blob = await workbookBlob(wb);
  const ExcelJS = (await import('exceljs')).default;
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await blobToArrayBuffer(blob));
  return back;
}

describe('reports Excel export', () => {
  it('names the file reports-YYYY-MM-DD.xlsx', () => {
    expect(reportFileName('2026-10-19')).toBe('reports-2026-10-19.xlsx');
  });

  it('is right-to-left on every sheet with no frozen panes', async () => {
    const wb = await roundTrip();
    expect(wb.worksheets.map((w) => w.name)).toEqual(['المشاريع', 'الملخص']);
    for (const ws of wb.worksheets) {
      expect(ws.views[0]?.rightToLeft).toBe(true);
      expect(ws.views.some((v) => v.state === 'frozen')).toBe(false);
    }
  });

  it('writes Arabic headers and real number, percentage and date cells', async () => {
    const ws = (await roundTrip()).getWorksheet('المشاريع')!;
    expect(ws.getRow(1).getCell(1).value).toBe('المشروع');
    expect(ws.getRow(1).getCell(14).value).toBe('نسبة الاستهلاك');
    const r = ws.getRow(2);
    expect(r.getCell(1).value).toBe('تأهيل حديقة الحي الشمالي');
    expect(r.getCell(2).value).toBe('نشط');
    expect(r.getCell(3).value).toBe(0.25);
    expect(r.getCell(3).numFmt).toBe('0%');
    expect(r.getCell(4).value).toBeInstanceOf(Date);
    expect((r.getCell(4).value as Date).toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(r.getCell(6).value).toBe(47);
    expect(typeof r.getCell(11).value).toBe('number');
    expect(r.getCell(11).value).toBe(520000);
    expect(r.getCell(13).value).toBe(95950);
    expect(r.getCell(14).value).toBeCloseTo(0.1845, 6);
    // HOUR project end (local date-time) → the day; over-budget % is red.
    const r2 = ws.getRow(3);
    expect((r2.getCell(5).value as Date).toISOString().slice(0, 10)).toBe('2026-10-20');
    expect(r2.getCell(14).value).toBe(1.5);
    expect(r2.getCell(14).font?.color?.argb).toBe('FFC62828');
    // No budget → empty cells, not zeros.
    const r3 = ws.getRow(4);
    expect(r3.getCell(11).value ?? null).toBeNull();
    expect(r3.getCell(14).value ?? null).toBeNull();
    expect(r3.getCell(5).value ?? null).toBeNull();
    expect(ws.getColumn(1).width).toBeGreaterThan(10);
  });

  it('adds a summary sheet with numeric totals', async () => {
    const ws = (await roundTrip()).getWorksheet('الملخص')!;
    const byLabel = new Map<string, unknown>();
    ws.eachRow((row) => byLabel.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(byLabel.get('عدد المشاريع')).toBe(3);
    expect(byLabel.get('المهام')).toBe(55);
    expect(byLabel.get('الميزانية')).toBe(521000);
    expect(byLabel.get('التصفية')).toBe('كل غير المؤرشفة');
  });
});
