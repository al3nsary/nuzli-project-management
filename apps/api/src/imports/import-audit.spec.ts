/**
 * Calculations audit 2026-10, L7/L8 (imp.ts): import parser edge cases.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { utcCellToLocal } from './ganttpro';
import { buildPreview, emptyDraft, fromExcelSerial, parseDateValue, parseDuration, parseMoney, parseNumber, parsePredecessors, previewDepsDto } from './import-model';
import { parseMspdi } from './mspdi';

const fx = (n: string): string => readFileSync(join(__dirname, '../../test/fixtures/imports', n), 'utf8');

describe('L8 — dates', () => {
  it("'24:00' is 00:00 of the next day (was 23:00)", () => {
    expect(parseDateValue('2026-10-19 24:00')).toBe('2026-10-20T00:00');
    expect(parseDateValue('19/10/2026 24:00')).toBe('2026-10-20T00:00');
    expect(parseDateValue('2026-10-19 24:30')).toBe('2026-10-19');
  });

  it('ISO text with Z / an offset is converted to Riyadh wall time (was read as Riyadh)', () => {
    expect(parseDateValue('2026-10-19T22:30:00Z')).toBe('2026-10-20T01:30');
    expect(parseDateValue('2026-10-19T22:30:00+03:00')).toBe('2026-10-19T22:30');
    expect(parseDateValue('2026-10-19T10:00:00+0100')).toBe('2026-10-19T12:00');
    expect(parseDateValue('2026-10-19T21:00:00Z')).toBe('2026-10-20');
    // GanttPRO text cells with an explicit zone are not shifted twice.
    expect(utcCellToLocal('2026-10-19T21:30:00Z')).toBe('2026-10-20T00:30');
    expect(utcCellToLocal(new Date('2026-10-19T21:30:00Z'))).toBe('2026-10-20T00:30');
  });

  it('Excel 1900 serials below 61 are corrected for the fictitious 1900-02-29', () => {
    expect(fromExcelSerial(1)).toBe('1900-01-01');
    expect(fromExcelSerial(59)).toBe('1900-02-28');
    expect(fromExcelSerial(60)).toBe('1900-03-01');
    expect(fromExcelSerial(61)).toBe('1900-03-01');
    expect(fromExcelSerial(45000)).toBe('2023-03-15');
    expect(fromExcelSerial(45000.75)).toBe('2023-03-15T18:00');
  });
});

describe('L8 — numbers and money', () => {
  it.each([
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['12,5', 12.5],
    ['1,234', 1234],
    ['1,234,567', 1234567],
    ['1.234.567', 1234567],
    ['1.5', 1.5],
    ['١٢٬٥٠٠٫٧٥', 12500.75],
    ['1 234', 1234],
    ['SAR 1,000', 1000],
    ['-5,5', -5.5],
  ])('%s → %d', (s, n) => {
    expect(parseNumber(s)).toBe(n);
  });
  it('European money is no longer 0', () => {
    expect(parseMoney('1.234,50')).toBe(1234.5);
  });
});

describe('L8 — elapsed units', () => {
  it("'2 edays' and friends parse as calendar minutes", () => {
    expect(parseDuration('2 edays')).toEqual({ elapsedMinutes: 2880 });
    expect(parseDuration('3eh')).toEqual({ elapsedMinutes: 180 });
    expect(parseDuration('1ew')).toEqual({ elapsedMinutes: 10080 });
    expect(parseDuration('2d')).toEqual({ days: 2 });
    expect(parsePredecessors('3FS+2 edays').items).toEqual([{ ref: '3', type: 'FS', lagElapsedMinutes: 2880 }]);
  });

  it('an elapsed predecessor lag counts only working time on the calendar (Fri/Sat weekend)', () => {
    const draft = emptyDraft();
    draft.tasks = [
      { key: 'a', sourceId: '1', name: 'أ', parentKey: null, start: '2026-10-21', end: null, durationDays: 2, progress: 0, status: null, assigneeName: null, plannedCost: 0, actualCost: 0, deadline: null, notes: null },
      { key: 'b', sourceId: '2', name: 'ب', parentKey: null, start: '2026-10-21', end: null, durationDays: 1, progress: 0, status: null, assigneeName: null, plannedCost: 0, actualCost: 0, deadline: null, notes: null },
    ];
    // a: Wed 21 – Thu 22. +3 elapsed days = Fri, Sat, Sun → one working day (Sunday).
    draft.deps = [{ predKey: 'a', succKey: 'b', type: 'FS', lagElapsedMinutes: 3 * 1440 }];
    const p = buildPreview(draft, { format: 'csv', fileId: null, today: '2026-10-19' });
    expect(previewDepsDto(p)[0]).toMatchObject({ lagDays: 1 });
    expect(p.tasks.find((t) => t.id === 'b')).toMatchObject({ startDate: '2026-10-26' });
  });

  it('an elapsed task duration becomes the working days inside it', () => {
    const draft = emptyDraft();
    draft.tasks = [{ key: 'a', sourceId: '1', name: 'أ', parentKey: null, start: '2026-10-22', end: null, durationElapsedMinutes: 4 * 1440, progress: 0, status: null, assigneeName: null, plannedCost: 0, actualCost: 0, deadline: null, notes: null }];
    // Thu 22 + 4 calendar days = Thu, Fri, Sat, Sun → 2 working days.
    const p = buildPreview(draft, { format: 'csv', fileId: null, today: '2026-10-19' });
    expect(p.tasks[0]).toMatchObject({ startDate: '2026-10-22', durationDays: 2, endDate: '2026-10-25' });
  });

  it('MSPDI LagFormat 8 (elapsed days) is calendar time, not 3 working days per day', () => {
    // Foundations Mon 12 – Wed 14 (Sat/Sun weekend). 4 elapsed days = Thu, Fri, Sat, Sun → 2 working days.
    const xml = fx('mspdi-days.xml').replace('<LinkLag>4800</LinkLag><LagFormat>7</LagFormat>', '<LinkLag>57600</LinkLag><LagFormat>8</LagFormat>');
    const draft = parseMspdi(xml);
    expect(draft.deps[0]).toMatchObject({ lagElapsedMinutes: 5760 });
    const p = buildPreview(draft, { format: 'xml', fileId: null });
    expect(previewDepsDto(p)[0]).toMatchObject({ lagDays: 2 });
  });
});

describe('L7 — symmetric lag rounding in imports', () => {
  it('−0.5 d and +0.5 d round away from zero', () => {
    const draft = emptyDraft();
    const t = (key: string) => ({ key, sourceId: key, name: key, parentKey: null, start: '2026-10-18', end: null, durationDays: 1, progress: 0, status: null, assigneeName: null, plannedCost: 0, actualCost: 0, deadline: null, notes: null });
    draft.tasks = [t('a'), t('b'), t('c')];
    draft.deps = [
      { predKey: 'a', succKey: 'b', type: 'FS', lagMinutes: 240 },
      { predKey: 'a', succKey: 'c', type: 'FS', lagMinutes: -240 },
    ];
    const p = buildPreview(draft, { format: 'csv', fileId: null, today: '2026-10-19' });
    expect(previewDepsDto(p).map((x) => x.lagDays)).toEqual([1, -1]);
  });
});
