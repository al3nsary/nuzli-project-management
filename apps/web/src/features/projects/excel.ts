import type { Priority, ProjectStatus, TaskStatus, TaskType } from '@nuzli/shared';
import type { Workbook, Worksheet } from 'exceljs';
import { RIYADH_OFFSET_MS, compareWbs } from './engine';

/**
 * The demo adapter's copy of `GET /projects/:id/export.xlsx` (apps/api tasks-export.ts, ADR-059).
 * Brief §7.7 / ADR-019 — strict: every sheet right-to-left, **no freeze panes**, Arabic headers,
 * real date cells, progress as a percentage cell, task names indented by level.
 */
export const TASK_TYPE_LABELS: Record<TaskType, string> = { TASK: 'مهمة', GROUP: 'مجموعة', MILESTONE: 'معلَم' };
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  NOT_STARTED: 'لم تبدأ',
  IN_PROGRESS: 'قيد التنفيذ',
  DONE: 'مكتملة',
  ON_HOLD: 'معلّقة',
};
export const PRIORITY_LABELS: Record<Priority, string> = { LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'عالية', URGENT: 'عاجلة' };
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PLANNING: 'تخطيط',
  ACTIVE: 'نشط',
  ON_HOLD: 'معلّق',
  COMPLETED: 'مكتمل',
  ARCHIVED: 'مؤرشف',
};

export interface TaskExportRow {
  wbs: string;
  name: string;
  type: TaskType;
  startDate: string;
  endDate: string;
  durationDays: number;
  progress: number;
  status: TaskStatus;
  priority: Priority;
  assigneeName: string | null;
  teamName: string | null;
  description: string | null;
}

export interface ProjectExportMeta {
  name: string;
  status: ProjectStatus;
  startDate: string;
  endDate: string | null;
  progress: number;
  calendarName: string;
  autoSchedule: boolean;
  generatedAt: Date;
}

export const SHEET_VIEWS = [{ rightToLeft: true }] as const;
const DATE_FMT = 'yyyy-mm-dd';
const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const levelOf = (wbs: string) => (wbs ? wbs.split('.').length : 1);

function fitWidths(ws: Worksheet, min = 10, max = 60): void {
  ws.columns.forEach((col) => {
    let longest = 0;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const indent = cell.alignment?.indent ?? 0;
      const len = (v instanceof Date ? 12 : String(v ?? '').length) + indent * 2;
      if (len > longest) longest = len;
    });
    col.width = Math.min(max, Math.max(min, longest + 2));
  });
}

export async function buildTasksWorkbook(meta: ProjectExportMeta, rows: TaskExportRow[]): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نزلي';
  wb.created = meta.generatedAt;

  const ws = wb.addWorksheet('المهام', { views: [...SHEET_VIEWS] });
  const header = ws.addRow([
    'رقم WBS',
    'المهمة',
    'النوع',
    'البداية',
    'النهاية',
    'المدة (أيام عمل)',
    'نسبة الإنجاز',
    'الحالة',
    'الأولوية',
    'المسند إليه',
    'الفريق',
    'الوصف',
  ]);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'right' };
  for (const r of [...rows].sort((a, b) => compareWbs(a.wbs, b.wbs))) {
    const row = ws.addRow([
      r.wbs,
      r.name,
      TASK_TYPE_LABELS[r.type],
      dateOf(r.startDate),
      dateOf(r.endDate),
      r.durationDays,
      r.progress / 100,
      TASK_STATUS_LABELS[r.status],
      PRIORITY_LABELS[r.priority],
      r.assigneeName ?? '',
      r.teamName ?? '',
      r.description ?? '',
    ]);
    row.getCell(2).alignment = { horizontal: 'right', indent: levelOf(r.wbs) - 1, readingOrder: 'rtl' };
    if (r.type === 'GROUP') row.getCell(2).font = { bold: true };
  }
  ws.getColumn(4).numFmt = DATE_FMT;
  ws.getColumn(5).numFmt = DATE_FMT;
  ws.getColumn(7).numFmt = '0%';
  header.eachCell((cell) => {
    cell.numFmt = '@';
  });
  fitWidths(ws);

  const summary = wb.addWorksheet('المشروع', { views: [...SHEET_VIEWS] });
  summary.addRow(['البند', 'القيمة']).font = { bold: true };
  summary.addRow(['المشروع', meta.name]);
  summary.addRow(['الحالة', PROJECT_STATUS_LABELS[meta.status]]);
  summary.addRow(['تاريخ البداية', dateOf(meta.startDate)]).getCell(2).numFmt = DATE_FMT;
  if (meta.endDate) summary.addRow(['تاريخ النهاية', dateOf(meta.endDate)]).getCell(2).numFmt = DATE_FMT;
  summary.addRow(['نسبة الإنجاز', meta.progress / 100]).getCell(2).numFmt = '0%';
  summary.addRow(['عدد المهام', rows.length]);
  summary.addRow(['التقويم', meta.calendarName]);
  summary.addRow(['الجدولة التلقائية', meta.autoSchedule ? 'مفعّلة' : 'متوقفة']);
  summary
    .addRow(['تاريخ التصدير', new Date(meta.generatedAt.getTime() + RIYADH_OFFSET_MS)])
    .getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
  summary.addRow(['ملاحظة', 'المدد بأيام العمل حسب تقويم المشروع، والتواريخ أيام تقويمية']);
  fitWidths(summary);
  return wb;
}
