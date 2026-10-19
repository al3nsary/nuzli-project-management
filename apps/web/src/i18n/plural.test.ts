/**
 * Calculations audit M5/L1: Arabic number agreement for every count message.
 * CLDR ar: 0 zero · 1 one · 2 two · 3–10 few · 11–99 many · 100–102 other · 103–110 few …
 */
import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { formatHours, plural, pluralCategory, setDisplayPrefs, tCount } from './index';
import { overdueText } from '../features/reports/parts';
import { overdueLabel } from '../features/gantt/Gantt';

setDisplayPrefs({ digits: 'latn', showHijri: false });

describe('plural()', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [3, 'few'],
    [10, 'few'],
    [11, 'many'],
    [99, 'many'],
    [100, 'other'],
    [101, 'other'],
    [102, 'other'],
    [103, 'few'],
    [110, 'few'],
    [111, 'many'],
    [1.5, 'other'],
    [-3, 'few'],
  ])('%d → %s', (n, cat) => {
    expect(pluralCategory(n)).toBe(cat);
  });

  it('falls back to "other" when a category has no form', () => {
    expect(plural(0, { other: 'x', one: 'o' })).toBe('x');
    expect(plural(1, { other: 'x', one: 'o' })).toBe('o');
  });
});

describe('tCount() — the audit\'s examples', () => {
  const cases: Array<[number, string]> = [
    [0, 'لا مهام'],
    [1, 'مهمة واحدة'],
    [2, 'مهمتان'],
    [3, '3 مهام'],
    [10, '10 مهام'],
    [11, '11 مهمة'],
    [100, '100 مهمة'],
    [101, '101 مهمة'],
    [103, '103 مهام'],
    [110, '110 مهام'],
  ];
  it.each(cases)('projects.taskCount %d → %s', (n, text) => {
    expect(tCount('projects.taskCount', n)).toBe(text);
  });

  it('«أُعيدت جدولة ٥ مهمة» → «٥ مهام»; «٥ يوم» → «٥ أيام»; «٥ ساعة» → «٥ ساعات»; «(١ مهام)» → «(مهمة واحدة)»', () => {
    expect(tCount('gantt.linkAdded', 5)).toBe('أُضيف الربط، وأُعيدت جدولة 5 مهام.');
    expect(tCount('gantt.linkAdded', 0)).toBe('أُضيف الربط.');
    expect(tCount('task.savedShifted', 2)).toBe('حُفظت المهمة، وأُعيدت جدولة مهمتين أخريين.');
    expect(tCount('duration.days', 5)).toBe('5 أيام');
    expect(tCount('duration.days', 11)).toBe('11 يومًا');
    expect(tCount('duration.hours', 5)).toBe('5 ساعات');
    expect(tCount('duration.hours', 1)).toBe('ساعة واحدة');
    expect(tCount('grid.duplicated', 1, { name: 'أ' })).toBe('كُرّرت «أ» (مهمة واحدة).');
    expect(tCount('bulk.done', 3)).toBe('عُدّلت 3 مهام.');
    expect(tCount('import.preview.links', 7)).toBe('7 روابط');
    expect(tCount('vlist.lead', 1)).toBe('مخالفة واحدة حسب المرشّحات الحالية');
    expect(tCount('cards.printN', 5)).toBe('طباعة 5 كروت');
  });

  it('fractional hours use the "other" form', () => {
    expect(formatHours(2.5)).toBe('2.5 ساعة');
    expect(formatHours(3)).toBe('3 ساعات');
  });

  it('Arabic-Indic digits do not change the form (the number, not the string, decides)', () => {
    setDisplayPrefs({ digits: 'arab' });
    expect(tCount('projects.taskCount', 9)).toBe('٩ مهام');
    setDisplayPrefs({ digits: 'latn' });
  });
});

describe('L1 — overdue days: the Gantt and the dashboard share one wording', () => {
  it.each([
    [1, 'متأخرة يومًا واحدًا'],
    [2, 'متأخرة يومين'],
    [3, 'متأخرة 3 أيام'],
    [10, 'متأخرة 10 أيام'],
    [11, 'متأخرة 11 يومًا'],
    [100, 'متأخرة 100 يوم'],
    [101, 'متأخرة 101 يوم'],
    [103, 'متأخرة 103 أيام'],
    [110, 'متأخرة 110 أيام'],
  ])('%d → %s', (n, text) => {
    expect(overdueText(n)).toBe(text);
    expect(overdueLabel(n)).toBe(text);
  });
});

describe('every count message has its forms', () => {
  it('a key with plural forms has one, two, few and many, and keeps the number in few/many', () => {
    const dict = ar as Record<string, string>;
    const bases = Object.keys(dict).filter((k) => dict[`${k}.few`] !== undefined);
    expect(bases.length).toBeGreaterThanOrEqual(50);
    for (const k of bases) {
      for (const f of ['one', 'two', 'few', 'many']) expect(dict[`${k}.${f}`], `${k}.${f}`).toBeTruthy();
      expect(dict[`${k}.few`], `${k}.few`).toMatch(/\{(count|n)\}/);
      expect(dict[`${k}.many`], `${k}.many`).toMatch(/\{(count|n)\}/);
    }
  });
});
