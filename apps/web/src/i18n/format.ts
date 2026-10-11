/**
 * Number and date formatting that honours the user's preferences (brief §12):
 * Western digits by default (Arabic-Indic optional), Gregorian by default (Hijri
 * Umm al-Qura optional), always displayed in Asia/Riyadh. Storage stays UTC.
 */
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

function toDate(value: string | Date): Date | null {
  const d = typeof value === 'string' ? new Date(value) : value;
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
  }).format(d);
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
