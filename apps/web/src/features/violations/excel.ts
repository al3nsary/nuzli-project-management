import type { Severity, ViolationStatus } from '@nuzli/shared';
import type { Workbook, Worksheet } from 'exceljs';
import { RIYADH_OFFSET_MS } from './time';

/**
 * The demo adapter's copy of `GET /violations/export.xlsx` (apps/api violations-export.ts).
 * Brief §7.7 / ADR-019 — strict: every sheet right-to-left, **no freeze panes**, Arabic
 * headers, real date cells (Riyadh wall clock), fitted widths, masked national IDs only.
 */
export const STATUS_LABELS: Record<ViolationStatus, string> = {
  SUBMITTED: 'مُرسلة',
  UNDER_REVIEW: 'قيد المراجعة',
  CONFIRMED: 'مؤكَّدة',
  CANCELLED: 'ملغاة',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  LOW: 'منخفضة',
  MEDIUM: 'متوسطة',
  HIGH: 'عالية',
  CRITICAL: 'حرجة',
};

export interface ExportRow {
  id: string;
  capturedAt: Date;
  receivedAt: Date;
  memberName: string;
  nationalIdMasked: string;
  teamName: string | null;
  supervisorName: string | null;
  recordedByName: string;
  typeName: string;
  severity: Severity | null;
  status: ViolationStatus;
  description: string;
  notes: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  clockDriftSuspect: boolean;
  cancelReason: string | null;
  evidenceCount: number;
}

const DATE_FMT = 'yyyy-mm-dd hh:mm';

/** Excel has no time zones: shift the instant to Riyadh wall-clock time first. */
export function riyadhExcelDate(at: Date): Date {
  return new Date(at.getTime() + RIYADH_OFFSET_MS);
}

interface Column {
  header: string;
  value: (r: ExportRow) => string | number | Date | null;
  date?: boolean;
}

const COLUMNS: Column[] = [
  { header: 'تاريخ ووقت الرصد', value: (r) => riyadhExcelDate(r.capturedAt), date: true },
  { header: 'تاريخ ووقت الاستلام', value: (r) => riyadhExcelDate(r.receivedAt), date: true },
  { header: 'العضو', value: (r) => r.memberName },
  { header: 'رقم الهوية (مقنّع)', value: (r) => r.nationalIdMasked },
  { header: 'الفريق وقت المخالفة', value: (r) => r.teamName ?? 'دون فريق' },
  { header: 'المشرف وقت المخالفة', value: (r) => r.supervisorName ?? '—' },
  { header: 'المراقب', value: (r) => r.recordedByName },
  { header: 'نوع المخالفة', value: (r) => r.typeName },
  { header: 'الخطورة', value: (r) => (r.severity ? SEVERITY_LABELS[r.severity] : '—') },
  { header: 'الحالة', value: (r) => STATUS_LABELS[r.status] },
  { header: 'الوصف', value: (r) => r.description },
  { header: 'ملاحظات', value: (r) => r.notes ?? '' },
  { header: 'خط العرض', value: (r) => r.latitude },
  { header: 'خط الطول', value: (r) => r.longitude },
  { header: 'دقة الموقع (م)', value: (r) => Math.round(r.accuracyM) },
  { header: 'عدد صور المخالفة', value: (r) => r.evidenceCount },
  { header: 'اشتباه في ساعة الجهاز', value: (r) => (r.clockDriftSuspect ? 'نعم' : 'لا') },
  { header: 'سبب الإلغاء', value: (r) => r.cancelReason ?? '' },
  { header: 'المعرّف', value: (r) => r.id },
];

/** Every sheet gets exactly this view: right-to-left and nothing else (never `state: 'frozen'`). */
export const SHEET_VIEWS = [{ rightToLeft: true }] as const;

function fitWidths(ws: Worksheet, min = 10, max = 60): void {
  ws.columns.forEach((col) => {
    let longest = 0;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const len = v instanceof Date ? 16 : String(v ?? '').length;
      if (len > longest) longest = len;
    });
    col.width = Math.min(max, Math.max(min, longest + 2));
  });
}

export async function buildViolationsWorkbook(
  rows: ExportRow[],
  meta: { generatedAt: Date; filterLabels: Array<[string, string]> },
): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نزلي';
  wb.created = meta.generatedAt;
  const ws = wb.addWorksheet('المخالفات', { views: [...SHEET_VIEWS] });
  const header = ws.addRow(COLUMNS.map((c) => c.header));
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'right' };
  for (const r of rows) ws.addRow(COLUMNS.map((c) => c.value(r)));
  COLUMNS.forEach((c, i) => {
    if (c.date) ws.getColumn(i + 1).numFmt = DATE_FMT;
  });
  header.eachCell((cell) => {
    cell.numFmt = '@';
  });
  fitWidths(ws);

  const summary = wb.addWorksheet('ملخص', { views: [...SHEET_VIEWS] });
  summary.addRow(['البند', 'القيمة']).font = { bold: true };
  summary.addRow(['تاريخ التصدير', riyadhExcelDate(meta.generatedAt)]).getCell(2).numFmt = DATE_FMT;
  summary.addRow(['عدد المخالفات في الملف', rows.length]);
  summary.addRow(['المصدر', 'نسخة العرض — بيانات تجريبية']);
  for (const [label, value] of meta.filterLabels) summary.addRow([label, value]);
  summary.addRow(['التوقيت', 'التواريخ والأوقات بتوقيت الرياض']);
  fitWidths(summary);
  return wb;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function workbookToBlob(wb: Workbook): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf as ArrayBuffer], { type: XLSX_MIME });
}
