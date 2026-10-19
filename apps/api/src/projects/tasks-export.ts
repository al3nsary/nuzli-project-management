import { Workbook, type Worksheet } from 'exceljs';
import type { CustomFieldType, Priority, ProjectStatus, TaskStatus, TaskType } from '@nuzli/shared';
import { dateOf, RIYADH_OFFSET_MS } from './task-engine';

/** Arabic labels used in exported files (the web app has its own i18n keys). */
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
  // A9 (optional for older callers): budget, deadline, labels, custom values, hours.
  plannedCost?: number;
  actualCost?: number;
  deadline?: string | null;
  /** Label names. */
  labels?: string[];
  /** Custom field id → value. */
  customValues?: Record<string, unknown>;
  /** HOUR projects: working hours (startDate/endDate are then local date-times). */
  durationHours?: number;
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
  /** A9 hours (default DAY). */
  durationUnit?: 'DAY' | 'HOUR';
  currency?: string;
  budget?: number | null;
  /** Custom field columns, in display order. */
  customFields?: Array<{ id: string; name: string; type: CustomFieldType }>;
}

/** A local date or date-time as an Excel cell value (wall time, written as UTC). */
export function cellDate(v: string): Date {
  return v.length > 10 ? new Date(`${v.slice(0, 16)}:00.000Z`) : dateOf(v);
}

/** One custom value as a cell (checkbox → نعم/لا, date → Date cell). */
export function customCell(type: CustomFieldType, v: unknown): string | number | Date {
  if (v === null || v === undefined) return '';
  if (type === 'CHECKBOX') return v === true ? 'نعم' : 'لا';
  if (type === 'NUMBER' && typeof v === 'number') return v;
  if (type === 'DATE' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return dateOf(v);
  return String(v);
}

/** The columns of the tasks sheet (also the CSV header). */
export function taskColumns(meta: Pick<ProjectExportMeta, 'durationUnit' | 'customFields'>): string[] {
  const hours = meta.durationUnit === 'HOUR';
  return [
    'رقم WBS',
    'المهمة',
    'النوع',
    'البداية',
    'النهاية',
    hours ? 'المدة (ساعات)' : 'المدة (أيام عمل)',
    'نسبة الإنجاز',
    'الحالة',
    'الأولوية',
    'المسند إليه',
    'الفريق',
    'الوصف',
    'التكلفة المخططة',
    'التكلفة الفعلية',
    'الموعد النهائي',
    'الوسوم',
    ...(hours ? ['أيام العمل'] : []),
    ...(meta.customFields ?? []).map((f) => f.name),
  ];
}

/** ADR-019 / brief §7.7: right-to-left, never a frozen view. */
export const SHEET_VIEWS = [{ rightToLeft: true }] as const;
const DATE_FMT = 'yyyy-mm-dd';
const DATETIME_FMT = 'yyyy-mm-dd hh:mm';

/** `1.10` after `1.9`: numeric comparison of WBS segments. */
export function compareWbs(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

export const levelOf = (wbs: string): number => (wbs ? wbs.split('.').length : 1);

function fitWidths(ws: Worksheet, min = 10, max = 60): void {
  // min 10: ExcelJS drops a width of exactly 9 (its default) when writing the file.
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

/**
 * Tasks of one project in WBS order: Arabic headers, real date cells, progress as a percentage
 * cell, the task name indented by its level (alignment indent — no leading spaces), RTL sheets
 * and no frozen panes.
 */
export async function buildTasksWorkbook(meta: ProjectExportMeta, rows: TaskExportRow[]): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'نزلي';
  wb.created = meta.generatedAt;

  const ws = wb.addWorksheet('المهام', { views: [...SHEET_VIEWS] });
  const hours = meta.durationUnit === 'HOUR';
  const fields = meta.customFields ?? [];
  const header = ws.addRow(taskColumns(meta));
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'right' };
  const sorted = [...rows].sort((a, b) => compareWbs(a.wbs, b.wbs));
  for (const r of sorted) {
    const row = ws.addRow([
      r.wbs,
      r.name,
      TASK_TYPE_LABELS[r.type],
      cellDate(r.startDate),
      cellDate(r.endDate),
      hours ? (r.durationHours ?? 0) : r.durationDays,
      r.progress / 100,
      TASK_STATUS_LABELS[r.status],
      PRIORITY_LABELS[r.priority],
      r.assigneeName ?? '',
      r.teamName ?? '',
      r.description ?? '',
      r.plannedCost ?? 0,
      r.actualCost ?? 0,
      r.deadline ? dateOf(r.deadline) : '',
      (r.labels ?? []).join('، '),
      ...(hours ? [r.durationDays] : []),
      ...fields.map((f) => customCell(f.type, r.customValues?.[f.id])),
    ]);
    const level = levelOf(r.wbs);
    row.getCell(2).alignment = { horizontal: 'right', indent: level - 1, readingOrder: 'rtl' };
    if (r.type === 'GROUP') row.getCell(2).font = { bold: true };
  }
  ws.getColumn(4).numFmt = hours ? DATETIME_FMT : DATE_FMT;
  ws.getColumn(5).numFmt = hours ? DATETIME_FMT : DATE_FMT;
  if (hours) ws.getColumn(6).numFmt = '0.##';
  ws.getColumn(7).numFmt = '0%';
  ws.getColumn(13).numFmt = '#,##0.00';
  ws.getColumn(14).numFmt = '#,##0.00';
  ws.getColumn(15).numFmt = DATE_FMT;
  const firstCustom = hours ? 18 : 17;
  fields.forEach((f, i) => {
    if (f.type === 'DATE') ws.getColumn(firstCustom + i).numFmt = DATE_FMT;
  });
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
  summary.addRow(['وحدة المدة', hours ? 'ساعات' : 'أيام']);
  if (meta.currency) summary.addRow(['العملة', meta.currency]);
  if (meta.budget !== undefined && meta.budget !== null) summary.addRow(['الميزانية', meta.budget]).getCell(2).numFmt = '#,##0.00';
  summary
    .addRow(['تاريخ التصدير', new Date(meta.generatedAt.getTime() + RIYADH_OFFSET_MS)])
    .getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
  summary.addRow([
    'ملاحظة',
    hours
      ? 'المدد بساعات العمل حسب تقويم المشروع، والأوقات بتوقيت الرياض'
      : 'المدد بأيام العمل حسب تقويم المشروع، والتواريخ أيام تقويمية',
  ]);
  fitWidths(summary);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** RFC 4180 field: quoted when needed; formulas neutralised (CSV injection: = + - @ at the start). */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The same columns as the Excel sheet as CSV: UTF-8 with a BOM (Excel then shows Arabic
 * correctly), CRLF line ends, dates `YYYY-MM-DD` (`YYYY-MM-DD HH:MM` in HOUR projects),
 * progress as a number 0–100.
 */
export function buildTasksCsv(meta: Pick<ProjectExportMeta, 'durationUnit' | 'customFields'>, rows: TaskExportRow[]): Buffer {
  const hours = meta.durationUnit === 'HOUR';
  const fields = meta.customFields ?? [];
  const text = (d: string) => (d.length > 10 ? d.slice(0, 16).replace('T', ' ') : d);
  const lines = [taskColumns(meta).map(csvField).join(',')];
  for (const r of [...rows].sort((a, b) => compareWbs(a.wbs, b.wbs))) {
    lines.push(
      [
        r.wbs,
        r.name,
        TASK_TYPE_LABELS[r.type],
        text(r.startDate),
        text(r.endDate),
        hours ? (r.durationHours ?? 0) : r.durationDays,
        r.progress,
        TASK_STATUS_LABELS[r.status],
        PRIORITY_LABELS[r.priority],
        r.assigneeName ?? '',
        r.teamName ?? '',
        r.description ?? '',
        r.plannedCost ?? 0,
        r.actualCost ?? 0,
        r.deadline ?? '',
        (r.labels ?? []).join('، '),
        ...(hours ? [r.durationDays] : []),
        ...fields.map((f) => {
          const v = r.customValues?.[f.id];
          return f.type === 'CHECKBOX' ? (v === true ? 'نعم' : v === false ? 'لا' : '') : (v ?? '');
        }),
      ]
        .map(csvField)
        .join(','),
    );
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}
