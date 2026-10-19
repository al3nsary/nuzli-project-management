import type { ProjectReportRow } from '@nuzli/shared';
import type { Workbook, Worksheet } from 'exceljs';
import { t, tKey } from '../../i18n';
import { RIYADH_OFFSET_MS } from '../projects/today';

/**
 * «التقارير» export (brief §7.7 / ADR-019 — strict): every sheet right-to-left, **no freeze
 * panes**, Arabic headers, real number / date / percentage cells, auto-fitted widths. Built in the
 * browser from the rows on screen; exceljs is loaded on demand.
 */
export const REPORT_SHEET_VIEWS = [{ rightToLeft: true }] as const;
const DATE_FMT = 'yyyy-mm-dd';
const MONEY_FMT = '#,##0.00';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const dateCell = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00.000Z`) : null);

function fitWidths(ws: Worksheet, min = 10, max = 60): void {
  ws.columns.forEach((col) => {
    let longest = 0;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const len = v instanceof Date ? 12 : typeof v === 'number' ? String(Math.round(v * 100) / 100).length + 3 : String(v ?? '').length;
      if (len > longest) longest = len;
    });
    col.width = Math.min(max, Math.max(min, longest + 2));
  });
}

export const reportFileName = (today: string) => `reports-${today}.xlsx`;

export async function buildProjectsReportWorkbook(
  rows: readonly ProjectReportRow[],
  opts: { generatedAt: Date; filterLabel: string },
): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نزلي';
  wb.created = opts.generatedAt;

  const ws = wb.addWorksheet(t('a9r.xl.sheetProjects'), { views: [...REPORT_SHEET_VIEWS] });
  const header = ws.addRow([
    t('a9r.col.project'),
    t('a9r.col.status'),
    t('a9r.col.progress'),
    t('a9r.col.start'),
    t('a9r.col.end'),
    t('a9r.col.leaf'),
    t('a9r.col.done'),
    t('a9r.col.overdue'),
    t('a9r.col.deadlinePassed'),
    t('a9r.col.milestones'),
    t('a9r.col.budget'),
    t('a9r.col.planned'),
    t('a9r.col.actual'),
    t('a9r.col.used'),
    t('a9r.col.currency'),
  ]);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'right' };

  for (const r of rows) {
    const p = r.project;
    const row = ws.addRow([
      p.name,
      tKey(`projectStatus.${p.status}`, 'common.none'),
      (p.progress ?? 0) / 100,
      dateCell(p.startDate),
      dateCell(p.endDate),
      r.leafCount,
      r.doneCount,
      r.overdueCount,
      r.deadlinePassedCount,
      r.milestoneCount,
      p.budget ?? null,
      p.plannedCost ?? 0,
      p.actualCost ?? 0,
      p.budgetUsedPct === null || p.budgetUsedPct === undefined ? null : p.budgetUsedPct / 100,
      p.currency ?? 'SAR',
    ]);
    row.getCell(1).alignment = { horizontal: 'right', readingOrder: 'rtl' };
    if ((p.budgetUsedPct ?? 0) > 100) row.getCell(14).font = { bold: true, color: { argb: 'FFC62828' } };
  }
  ws.getColumn(3).numFmt = '0%';
  ws.getColumn(4).numFmt = DATE_FMT;
  ws.getColumn(5).numFmt = DATE_FMT;
  for (const c of [11, 12, 13]) ws.getColumn(c).numFmt = MONEY_FMT;
  ws.getColumn(14).numFmt = '0.0%';
  header.eachCell((cell) => {
    cell.numFmt = '@';
  });
  fitWidths(ws);

  const sum = (f: (r: ProjectReportRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const summary = wb.addWorksheet(t('a9r.xl.sheetSummary'), { views: [...REPORT_SHEET_VIEWS] });
  summary.addRow([t('a9r.xl.item'), t('a9r.xl.value')]).font = { bold: true };
  summary.addRow([t('a9r.xl.filter'), opts.filterLabel]);
  summary.addRow([t('a9r.xl.projectCount'), rows.length]);
  summary.addRow([t('a9r.col.leaf'), sum((r) => r.leafCount)]);
  summary.addRow([t('a9r.col.done'), sum((r) => r.doneCount)]);
  summary.addRow([t('a9r.col.overdue'), sum((r) => r.overdueCount)]);
  summary.addRow([t('a9r.col.deadlinePassed'), sum((r) => r.deadlinePassedCount)]);
  summary.addRow([t('a9r.col.budget'), sum((r) => r.project.budget ?? 0)]).getCell(2).numFmt = MONEY_FMT;
  summary.addRow([t('a9r.col.planned'), sum((r) => r.project.plannedCost ?? 0)]).getCell(2).numFmt = MONEY_FMT;
  summary.addRow([t('a9r.col.actual'), sum((r) => r.project.actualCost ?? 0)]).getCell(2).numFmt = MONEY_FMT;
  summary
    .addRow([t('a9r.xl.generatedAt'), new Date(opts.generatedAt.getTime() + RIYADH_OFFSET_MS)])
    .getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
  fitWidths(summary);
  return wb;
}

export async function workbookBlob(wb: Workbook): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf as ArrayBuffer], { type: XLSX_MIME });
}

export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
