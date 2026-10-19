/**
 * Arabic labels of the calendar tab, built with Intl (Gregorian by default, Umm al-Qura Hijri
 * when the user asked for it, digits per the display preference). Days are ISO dates formatted
 * at noon UTC with `timeZone: 'UTC'` so the label is the stored day whatever the device zone.
 */
import type { Digits } from '../../i18n/format';
import { startOfWeek, addDays, type IsoDay } from './calendarMath';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(cal: 'gregory' | 'islamic-umalqura', digits: Digits, opts: Intl.DateTimeFormatOptions) {
  const key = `${cal}|${digits}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(`ar-SA-u-ca-${cal}-nu-${digits}`, { timeZone: 'UTC', ...opts });
    cache.set(key, f);
  }
  return f;
}
const noon = (day: IsoDay) => new Date(`${day.slice(0, 10)}T12:00:00Z`);

/** «أكتوبر 2026». */
export const monthTitle = (day: IsoDay, digits: Digits) => fmt('gregory', digits, { month: 'long', year: 'numeric' }).format(noon(day));

/** «18 أكتوبر» (with the year when `year`). */
export const shortDate = (day: IsoDay, digits: Digits, year = false) =>
  fmt('gregory', digits, year ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' }).format(noon(day));

/** «الأحد 18 أكتوبر». */
export const longDay = (day: IsoDay, digits: Digits) =>
  fmt('gregory', digits, { weekday: 'long', day: 'numeric', month: 'long' }).format(noon(day));

/** The day of month, e.g. «18». */
export const dayNumber = (day: IsoDay, digits: Digits) => fmt('gregory', digits, { day: 'numeric' }).format(noon(day));

/** Sunday-first weekday names. */
export function weekdayNames(style: 'long' | 'short' | 'narrow', digits: Digits): string[] {
  const s = startOfWeek('2026-01-01');
  return Array.from({ length: 7 }, (_, i) => fmt('gregory', digits, { weekday: style }).format(noon(addDays(s, i))));
}

/** The Hijri day in a cell: «7», or «1 جمادى الأولى» on the first of a Hijri month. */
export function hijriDay(day: IsoDay, digits: Digits): string {
  const parts = fmt('islamic-umalqura', digits, { day: 'numeric', month: 'long' }).formatToParts(noon(day));
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const latin = d.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  return Number(latin) === 1 ? `${d} ${m}` : d;
}

/** «ربيع الآخر – جمادى الأولى 1448» for a range of days; both years when it crosses a Hijri year. */
export function hijriSpan(from: IsoDay, to: IsoDay, digits: Digits): string {
  const f = fmt('islamic-umalqura', digits, { month: 'long', year: 'numeric' });
  const a = f.format(noon(from));
  const b = f.format(noon(to));
  if (a === b) return a;
  // Calculations audit L2: the short form only within one Hijri year; across years both are shown
  // («ذو الحجة 1447 هـ – محرم 1448 هـ»).
  const year = fmt('islamic-umalqura', digits, { year: 'numeric' });
  if (year.format(noon(from)) !== year.format(noon(to))) return `${a} – ${b}`;
  const m = fmt('islamic-umalqura', digits, { month: 'long' }).format(noon(from));
  return `${m} – ${b}`;
}
