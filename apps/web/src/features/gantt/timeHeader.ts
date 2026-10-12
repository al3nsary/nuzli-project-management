/**
 * Header segments for the timeline: Gregorian (default) and an optional Hijri row
 * (`Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura')`, brief §6.1). Day numbers are UTC days,
 * so formatting uses `timeZone: 'UTC'` (no Riyadh shift for calendar dates).
 */
import { fromDayNumber, weekdayOf } from '@nuzli/scheduling';
import type { Digits } from '../../i18n/format';
import { t } from '../../i18n';
import type { Zoom } from './geometry';

export interface Segment {
  fromDay: number;
  toDay: number;
  label: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(calendar: 'gregory' | 'islamic-umalqura', digits: Digits, opts: Intl.DateTimeFormatOptions) {
  const key = `${calendar}|${digits}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(`ar-SA-u-ca-${calendar}-nu-${digits}`, { timeZone: 'UTC', ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

const dateOfDay = (day: number) => new Date(day * 86_400_000);

interface Parts {
  year: number;
  month: number;
  day: number;
}

const partsCache = new Map<string, Parts>();
function partsOf(day: number, calendar: 'gregory' | 'islamic-umalqura'): Parts {
  const key = `${calendar}|${day}`;
  let p = partsCache.get(key);
  if (!p) {
    const f = fmt(calendar, 'latn', { year: 'numeric', month: 'numeric', day: 'numeric' });
    const parts = f.formatToParts(dateOfDay(day));
    const num = (type: string) => Number(parts.find((x) => x.type === type)?.value.replace(/\D/g, '') ?? 0);
    p = { year: num('year'), month: num('month'), day: num('day') };
    if (partsCache.size > 20_000) partsCache.clear();
    partsCache.set(key, p);
  }
  return p;
}

/** Groups consecutive days that share `keyOf`. */
function segments(fromDay: number, toDay: number, keyOf: (day: number) => string, label: (day: number) => string): Segment[] {
  const out: Segment[] = [];
  let start = fromDay;
  let key = keyOf(fromDay);
  for (let d = fromDay + 1; d <= toDay + 1; d++) {
    const k = d <= toDay ? keyOf(d) : '\u0000end';
    if (k !== key) {
      out.push({ fromDay: start, toDay: d - 1, label: label(start) });
      start = d;
      key = k;
    }
  }
  return out;
}

const weekStart = (day: number) => day - weekdayOf(day); // weeks start on Sunday

export function gregorianRows(fromDay: number, toDay: number, zoom: Zoom, digits: Digits): { top: Segment[]; bottom: Segment[] } {
  const ym = (d: number) => {
    const p = partsOf(d, 'gregory');
    return `${p.year}-${p.month}`;
  };
  const monthYear = (d: number) => fmt('gregory', digits, { month: 'long', year: 'numeric' }).format(dateOfDay(d));
  const year = (d: number) => fmt('gregory', digits, { year: 'numeric' }).format(dateOfDay(d));
  switch (zoom) {
    case 'day':
      return {
        top: segments(fromDay, toDay, ym, monthYear),
        bottom: segments(fromDay, toDay, String, (d) => fmt('gregory', digits, { day: 'numeric' }).format(dateOfDay(d))),
      };
    case 'week':
      return {
        top: segments(fromDay, toDay, ym, monthYear),
        bottom: segments(fromDay, toDay, (d) => String(weekStart(d)), (d) =>
          fmt('gregory', digits, { day: 'numeric', month: 'short' }).format(dateOfDay(weekStart(d))),
        ),
      };
    case 'month':
      return {
        top: segments(fromDay, toDay, (d) => String(partsOf(d, 'gregory').year), year),
        bottom: segments(fromDay, toDay, ym, (d) => fmt('gregory', digits, { month: 'short' }).format(dateOfDay(d))),
      };
    case 'quarter':
    default: {
      const q = (d: number) => {
        const p = partsOf(d, 'gregory');
        return `${p.year}-Q${Math.ceil(p.month / 3)}`;
      };
      return {
        top: segments(fromDay, toDay, (d) => String(partsOf(d, 'gregory').year), year),
        bottom: segments(fromDay, toDay, q, (d) => quarterLabel(Math.ceil(partsOf(d, 'gregory').month / 3), digits)),
      };
    }
  }
}

const quarterLabel = (q: number, _digits: Digits) => t(`gantt.quarter.${q}` as 'gantt.quarter.1');

/** Hijri (Umm al-Qura) month segments. */
function hijriMonths(fromDay: number, toDay: number, zoom: Zoom, digits: Digits): Segment[] {
  return segments(
    fromDay,
    toDay,
    (d) => {
      const p = partsOf(d, 'islamic-umalqura');
      return `${p.year}-${p.month}`;
    },
    (d) => fmt('islamic-umalqura', digits, { month: zoom === 'quarter' ? 'short' : 'long', year: 'numeric' }).format(dateOfDay(d)),
  );
}

/**
 * The optional Hijri rows (brief §6.1): month names, plus the Hijri day numbers at day zoom
 * (two rows there, so neither label is cut).
 */
export function hijriRows(fromDay: number, toDay: number, zoom: Zoom, digits: Digits): Segment[][] {
  const months = hijriMonths(fromDay, toDay, zoom, digits);
  if (zoom !== 'day') return [months];
  const days = segments(fromDay, toDay, String, (d) => fmt('islamic-umalqura', digits, { day: 'numeric' }).format(dateOfDay(d)));
  return [days, months];
}

/** Number of header rows: Gregorian (2) + Hijri (0, 1 or 2 at day zoom). */
export const headerRowCount = (showHijri: boolean, zoom: Zoom): number => 2 + (showHijri ? (zoom === 'day' ? 2 : 1) : 0);

/** Full Arabic date of a calendar day, for tooltips and the task grid. */
export function dayLabel(iso: string, digits: Digits): string {
  return fmt('gregory', digits, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
}

export function hijriLabel(iso: string, digits: Digits): string {
  return fmt('islamic-umalqura', digits, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
}

export { fromDayNumber };
