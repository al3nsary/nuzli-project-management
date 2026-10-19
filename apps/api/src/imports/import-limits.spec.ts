import { Workbook } from 'exceljs';
import { AppError } from '../common/app-error';
import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS, readCsv, readXlsx, tableToDraft } from './tabular';

async function codeOf(fn: () => Promise<unknown> | unknown): Promise<{ code?: string; details?: unknown }> {
  try {
    await fn();
    return {};
  } catch (e) {
    return e instanceof AppError ? { code: e.code, details: e.details } : { code: String(e) };
  }
}

async function xlsx(build: (wb: Workbook) => void): Promise<Buffer> {
  const wb = new Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsx import limits (security review A9 M3)', () => {
  it('a far-right cell (XFD) does not multiply the work: only real cells are read, columns capped at 200', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('المهام');
      ws.addRow(['اسم المهمة', 'المدة']);
      for (let r = 2; r <= 3_000; r++) {
        ws.getCell(r, 1).value = `مهمة ${r}`;
        ws.getCell(r, 2).value = 2;
        ws.getCell(r, 16_384).value = 'x'; // XFD
      }
    });
    const started = Date.now();
    const { rows, sheet } = await readXlsx(buf);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(sheet).toBe('المهام');
    expect(rows).toHaveLength(3_000);
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(MAX_IMPORT_COLUMNS);
    expect(rows[1]!.slice(0, 2).map((c) => c.v)).toEqual(['مهمة 2', 2]);
    expect(tableToDraft(rows, { dateOrder: 'DMY' }).tasks).toHaveLength(2_999);
  }, 30_000);

  it('sheet choice, gaps and dates survive the worker: rows keep their spreadsheet numbers', async () => {
    const buf = await xlsx((wb) => {
      wb.addWorksheet('غلاف').addRow(['تقرير']);
      const ws = wb.addWorksheet('الخطة');
      ws.getCell(3, 1).value = 'المهمة';
      ws.getCell(3, 2).value = 'البداية';
      ws.getCell(6, 1).value = 'حفر';
      ws.getCell(6, 2).value = new Date('2026-10-11T00:00:00Z');
    });
    const { rows, sheet } = await readXlsx(buf);
    expect(sheet).toBe('الخطة');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual([]);
    expect(rows[5]![1]!.v).toBeInstanceOf(Date);
    expect((rows[5]![1]!.v as Date).toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect((await readXlsx(buf, 'غلاف')).sheet).toBe('غلاف');
  }, 30_000);

  it('more non-empty rows than the task limit allows → IMPORT_TOO_MANY_TASKS (no silent truncation)', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['task name']);
      for (let i = 0; i < 30; i++) ws.addRow([`t${i}`]);
    });
    expect((await codeOf(() => readXlsx(buf, undefined, { maxRows: 20 }))).code).toBe('IMPORT_TOO_MANY_TASKS');
    expect((await readXlsx(buf, undefined, { maxRows: 40 })).rows).toHaveLength(31);
    expect(MAX_IMPORT_ROWS).toBeGreaterThan(5_000);
  }, 30_000);

  it('the parser runs in a worker with a deadline: a timeout ends it with IMPORT_FILE_INVALID', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('S');
      for (let i = 0; i < 2_000; i++) ws.addRow([`t${i}`, i, 'x'.repeat(50)]);
    });
    expect(await codeOf(() => readXlsx(buf, undefined, { timeoutMs: 1 }))).toEqual({ code: 'IMPORT_FILE_INVALID', details: { reason: 'xlsx-timeout' } });
  }, 30_000);

  it('the worker heap is limited: running out of memory ends the worker, not the API process', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('S');
      for (let i = 0; i < 20_000; i++) ws.addRow([`task ${i} ${'y'.repeat(40)}`, i, i * 2, `note ${i}`]);
    });
    expect(await codeOf(() => readXlsx(buf, undefined, { maxOldGenerationSizeMb: 4, maxRows: 100_000 }))).toEqual({
      code: 'IMPORT_FILE_INVALID',
      details: { reason: 'xlsx-limits' },
    });
    // The process is still fine and the next parse works.
    expect((await readXlsx(buf, undefined, { maxRows: 100_000 })).rows.length).toBe(20_000);
  }, 60_000);

  it('a ZIP that is not a workbook, or a bomb, is refused before exceljs runs', async () => {
    expect((await codeOf(() => readXlsx(Buffer.from('PK\x03\x04 nothing', 'latin1')))).code).toBe('IMPORT_FILE_INVALID');
  });
});

describe('CSV import limits (security review A9 M3)', () => {
  it('very wide rows are cut at 200 columns; too many rows → IMPORT_TOO_MANY_TASKS', async () => {
    const wide = Buffer.from(`اسم المهمة,${Array.from({ length: 5_000 }, (_, i) => `c${i}`).join(',')}\nحفر,${'1,'.repeat(4_999)}1\n`);
    const rows = readCsv(wide);
    expect(rows.every((r) => r.length <= MAX_IMPORT_COLUMNS)).toBe(true);
    const tall = Buffer.from(['task name', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `t${i}`)].join('\n'));
    expect((await codeOf(() => readCsv(tall))).code).toBe('IMPORT_TOO_MANY_TASKS');
  });
});
