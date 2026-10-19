/**
 * Number and date formatting that honours the user's preferences (brief §12):
 * Western digits by default (Arabic-Indic optional), Gregorian by default (Hijri
 * Umm al-Qura optional), always displayed in Asia/Riyadh. Storage stays UTC.
 */
import { ar } from './ar';
import { plural } from './plural';

export type Digits = 'latn' | 'arab';

export interface DisplayPrefs {
  digits: Digits;
  showHijri: boolean;
}

export const TIME_ZONE = 'Asia/Riyadh';

let current: DisplayPrefs = { digits: 'latn', showHijri: false };

/** Called when the signed-in user's preferences change. */
export function setDisplayPrefs(prefs: Partial<DisplayPrefs>) {
  current = { ...current, ...prefs };
}

export function getDisplayPrefs(): DisplayPrefs {
  return current;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(digits: Digits, opts: Intl.NumberFormatOptions = {}) {
  const key = `n|${digits}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(`ar-SA-u-nu-${digits}`, opts);
    cache.set(key, f);
  }
  return f;
}

function dateFormat(
  digits: Digits,
  calendar: 'gregory' | 'islamic-umalqura',
  opts: Intl.DateTimeFormatOptions,
) {
  const key = `d|${digits}|${calendar}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(`ar-SA-u-ca-${calendar}-nu-${digits}`, {
      timeZone: TIME_ZONE,
      ...opts,
    });
    cache.set(key, f);
  }
  return f;
}

export function formatNumber(value: number, prefs: Partial<DisplayPrefs> = {}): string {
  const digits = prefs.digits ?? current.digits;
  return numberFormat(digits).format(value);
}

/** Replaces Western digits in an already formatted string (e.g. a masked ID) if the user asked for Arabic-Indic. */
export function localizeDigits(text: string, prefs: Partial<DisplayPrefs> = {}): string {
  const digits = prefs.digits ?? current.digits;
  if (digits === 'latn') return text;
  return text.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** A zone-less local date-time (HOUR projects store Asia/Riyadh wall time: `YYYY-MM-DDTHH:MM`). */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * A string or Date as an instant. A zone-less local date-time is Riyadh wall time, so it is read
 * with `+03:00` (calculations audit L3: `new Date('…T18:00')` would use the DEVICE zone and show
 * the 23rd in New York); a bare `YYYY-MM-DD` is UTC midnight, the same day in Riyadh.
 */
function toDate(value: string | Date): Date | null {
  const d = typeof value === 'string' ? new Date(LOCAL_DATE_TIME.test(value) ? `${value}+03:00` : value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "١١ أكتوبر ٢٠٢٦" (+ the Hijri date when enabled). */
export function formatDate(
  value: string | Date | null | undefined,
  prefs: Partial<DisplayPrefs> = {},
): string {
  if (!value) return '';
  const d = toDate(value);
  if (!d) return '';
  const p = { ...current, ...prefs };
  const greg = dateFormat(p.digits, 'gregory', DATE_OPTS).format(d);
  if (!p.showHijri) return greg;
  return `${greg} (${formatHijri(d, p)})`;
}

export function formatDateTime(
  value: string | Date | null | undefined,
  prefs: Partial<DisplayPrefs> = {},
): string {
  if (!value) return '';
  const d = toDate(value);
  if (!d) return '';
  const p = { ...current, ...prefs };
  const greg = dateFormat(p.digits, 'gregory', {
    ...DATE_OPTS,
    month: 'short',
    ...TIME_OPTS,
  })
    .format(d)
    // A9 QA: a no-break space keeps «ص/م» with its clock instead of wrapping onto a line alone.
    .replace(/ (ص|م)$/u, '\u00A0$1');
  if (!p.showHijri) return greg;
  return `${greg} (${formatHijri(d, p)})`;
}

export function formatHijri(value: string | Date, prefs: Partial<DisplayPrefs> = {}): string {
  const d = toDate(value);
  if (!d) return '';
  const digits = prefs.digits ?? current.digits;
  return dateFormat(digits, 'islamic-umalqura', DATE_OPTS).format(d);
}

/** `YYYY-MM-DD` of an instant in Asia/Riyadh (for date filters). */
export function riyadhDay(value: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(value);
}

// ---------------------------------------------------------------- A9: money, durations, clock


/**
 * Money in the project currency (A9 budget): Western digits by default, up to two decimals, the
 * SAR sign «ر.س» after the amount («١٢٬٥٠٠ ر.س» with Arabic-Indic digits). Other ISO codes are
 * shown as their code. `compact` gives «١٢٫٥ ألف» for chart axes.
 */
export function formatMoney(
  value: number | null | undefined,
  currency = 'SAR',
  opts: { compact?: boolean; prefs?: Partial<DisplayPrefs> } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const digits = opts.prefs?.digits ?? current.digits;
  const n = opts.compact
    ? numberFormat(digits, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : numberFormat(digits, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  const sign = currency === 'SAR' ? ar['money.sar'] : currency;
  return `${n} ${sign}`;
}

/** Minutes as «٣ س ١٥ د» (or «٤٥ د», «٢ س»). */
export function formatMinutes(minutes: number, prefs: Partial<DisplayPrefs> = {}): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const f = (v: number) => formatNumber(v, prefs);
  if (!h) return ar['duration.m'].replace('{m}', f(r));
  if (!r) return ar['duration.h'].replace('{h}', f(h));
  return ar['duration.hm'].replace('{h}', f(h)).replace('{m}', f(r));
}

/** Working hours as «٢٫٥ ساعة». */
export function formatHours(hours: number, prefs: Partial<DisplayPrefs> = {}): string {
  const v = Math.round(hours * 100) / 100;
  const forms = { one: ar['duration.hours.one'], two: ar['duration.hours.two'], few: ar['duration.hours.few'], many: ar['duration.hours.many'], other: ar['duration.hours'] };
  return plural(v, forms).replace('{n}', numberFormat(prefs.digits ?? current.digits, { maximumFractionDigits: 2 }).format(v));
}

/** `HH:MM` (24 h wall clock, `24:00` allowed) as «٩:٠٠ ص» / «١:٠٠ م» (Arabic-friendly 12 h). */
export function formatClock(hm: string, prefs: Partial<DisplayPrefs> = {}): string {
  const [hs, ms] = hm.split(':');
  const h = Number(hs);
  const m = Number(ms);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hm;
  const pm = h >= 12 && h < 24;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const digits = prefs.digits ?? current.digits;
  const mm = numberFormat(digits, { minimumIntegerDigits: 2 }).format(m);
  return `${numberFormat(digits).format(h12)}:${mm}\u00A0${pm ? ar['time.pm'] : ar['time.am']}`;
}

/** The clock part of a local `YYYY-MM-DDTHH:MM` (HOUR projects). */
export function formatLocalTime(local: string, prefs: Partial<DisplayPrefs> = {}): string {
  return local.length > 10 ? formatClock(local.slice(11, 16), prefs) : '';
}
