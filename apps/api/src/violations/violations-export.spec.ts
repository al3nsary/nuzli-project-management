import { Workbook } from 'exceljs';
import { buildViolationsWorkbook, riyadhExcelDate, type ExportRow } from './violations-export';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  capturedAt: new Date('2026-10-12T06:30:00Z'),
  receivedAt: new Date('2026-10-12T07:00:00Z'),
  memberName: 'عامر سالم',
  nationalIdMasked: '1•••••1234',
  teamName: 'فريق الصيانة',
  supervisorName: 'مشرف',
  recordedByName: 'مراقب',
  typeName: 'نوع',
  severity: 'HIGH',
  status: 'SUBMITTED',
  description: 'وصف المخالفة بالتفصيل',
  notes: null,
  latitude: 24.7136,
  longitude: 46.6753,
  accuracyM: 12.4,
  clockDriftSuspect: false,
  cancelReason: null,
  evidenceCount: 2,
  ...over,
});

async function load(buffer: Buffer): Promise<Workbook> {
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('violations Excel export (ADR-019, brief §7.7)', () => {
  it('every sheet is right-to-left and has NO frozen view', async () => {
    const buffer = await buildViolationsWorkbook([row(), row({ teamName: null, status: 'CANCELLED', cancelReason: 'خطأ' })], {
      filters: {},
      generatedAt: new Date('2026-10-12T08:00:00Z'),
      truncated: false,
      filterLabels: [],
    });
    const wb = await load(buffer);
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(2);
    wb.eachSheet((ws) => {
      expect(ws.views.length).toBeGreaterThan(0);
      for (const view of ws.views) {
        expect(view.rightToLeft).toBe(true);
        expect(view.state).not.toBe('frozen');
        expect((view as { ySplit?: number }).ySplit ?? 0).toBe(0);
        expect((view as { xSplit?: number }).xSplit ?? 0).toBe(0);
      }
    });
  });

  it('Arabic headers, real date cells in Riyadh time, masked national IDs, fitted widths', async () => {
    const buffer = await buildViolationsWorkbook([row()], {
      filters: { status: 'SUBMITTED' },
      generatedAt: new Date('2026-10-12T08:00:00Z'),
      truncated: true,
      filterLabels: [['الحالة', 'مُرسلة']],
    });
    const wb = await load(buffer);
    const ws = wb.getWorksheet('المخالفات')!;
    const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    expect(headers[0]).toBe('تاريخ ووقت الرصد');
    expect(headers.every((h) => /[؀-ۿ]/.test(h))).toBe(true);

    const captured = ws.getRow(2).getCell(1);
    expect(captured.value).toBeInstanceOf(Date);
    // 06:30Z is 09:30 in Riyadh: Excel shows the wall-clock time.
    expect((captured.value as Date).toISOString()).toBe(riyadhExcelDate(new Date('2026-10-12T06:30:00Z')).toISOString());
    expect((captured.value as Date).getUTCHours()).toBe(9);
    expect(captured.numFmt).toBe('yyyy-mm-dd hh:mm');

    const all = JSON.stringify((ws.getRow(2).values as unknown[]).slice(1));
    expect(all).toContain('1•••••1234');
    expect(all).not.toMatch(/\b[12]\d{9}\b/); // never a full 10-digit national ID

    ws.columns.forEach((c) => {
      expect(c.width).toBeGreaterThanOrEqual(10);
      expect(c.width).toBeLessThanOrEqual(60);
    });
    const summary = JSON.stringify(wb.getWorksheet('ملخص')!.getSheetValues());
    expect(summary).toContain('تجاوزت النتائج الحد الأعلى');
    expect(summary).toContain('مُرسلة');
  });
});
