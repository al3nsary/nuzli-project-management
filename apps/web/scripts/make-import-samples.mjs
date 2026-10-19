#!/usr/bin/env node
/**
 * Writes public/samples/nuzli-sample.xlsx — the Excel sample of the import wizard (ADR-117,
 * «جرّب بملف نموذجي»). Clearly marked demo data. Two sheets: «تعليمات» (no task-name column,
 * so the importer must pick the next one) and «الخطة» (outline by cell indentation, real date
 * cells, a percent column, costs, a deadline). RTL sheets, no frozen panes (brief §7.7).
 * The CSV, MS Project XML and Jira CSV samples are plain text files next to it.
 * Usage: node scripts/make-import-samples.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'nuzli-sample.xlsx');
const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

const wb = new ExcelJS.Workbook();
wb.creator = 'نزلي (بيانات تجريبية)';
wb.created = new Date('2026-10-19T08:00:00Z');

const help = wb.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
help.addRow(['ملف نموذجي (بيانات تجريبية) لاستيراد مشروع في نُزلي']).font = { bold: true };
help.addRow(['المهام في ورقة «الخطة». المهام الفرعية مُزاحة داخل الخلية، والمدة بأيام العمل.']);
help.getColumn(1).width = 80;

const ws = wb.addWorksheet('الخطة', { views: [{ rightToLeft: true }] });
const header = ws.addRow(['اسم المهمة', 'البداية', 'المدة', 'المسؤول', 'نسبة الإنجاز', 'السابقة', 'التكلفة', 'الموعد النهائي', 'ملاحظات']);
header.font = { bold: true };
// [name, indent, start, duration, assignee, progress, predecessors (row numbers among tasks), cost, deadline, notes]
const rows = [
  ['تجهيز قاعة المؤتمرات (تجريبي)', 0, '2026-11-08', null, null, null, null, null, null, 'بيانات تجريبية'],
  ['تنظيف القاعة', 1, '2026-11-08', 1, 'فهد بن خالد الدوسري', 1, null, 800, null, null],
  ['ترتيب المقاعد', 1, null, 2, 'سارة بنت عبدالعزيز الشهري', 0.5, '2', 1500, null, '300 مقعد'],
  ['تركيب الشاشات', 1, null, 2, 'ماجد بن علي الغامدي', 0, '2', 7200, '2026-11-12', null],
  ['التجهيزات الفنية', 0, null, null, null, null, null, null, null, null],
  ['اختبار الصوت', 1, null, 1, 'ماجد بن علي الغامدي', 0, '4', 600, null, null],
  ['اختبار البث', 1, null, 1, 'ماجد بن علي الغامدي', 0, '6', 900, null, null],
  ['جاهزية القاعة', 0, null, 0, null, null, '3;7', null, '2026-11-16', 'معلَم'],
];
for (const [name, indent, start, duration, assignee, progress, preds, cost, deadline, notes] of rows) {
  const r = ws.addRow([name, start ? d(start) : null, duration, assignee, progress, preds, cost, deadline ? d(deadline) : null, notes]);
  r.getCell(1).alignment = { horizontal: 'right', indent, readingOrder: 'rtl' };
  if (indent === 0) r.getCell(1).font = { bold: true };
}
ws.getColumn(2).numFmt = 'yyyy-mm-dd';
ws.getColumn(5).numFmt = '0%';
ws.getColumn(7).numFmt = '#,##0';
ws.getColumn(8).numFmt = 'yyyy-mm-dd';
[34, 13, 8, 28, 12, 10, 10, 14, 18].forEach((w, i) => (ws.getColumn(i + 1).width = w));

await wb.xlsx.writeFile(out);
console.log(`written ${out}`);
