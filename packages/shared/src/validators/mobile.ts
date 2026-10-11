import { toWesternDigits } from './national-id';

/**
 * Normalises a Saudi mobile number to E.164 (`+9665XXXXXXXX`).
 * Accepts `05XXXXXXXX`, `5XXXXXXXX`, `9665XXXXXXXX`, `009665XXXXXXXX` and `+9665XXXXXXXX`,
 * with optional spaces or dashes. Returns null when the value is not a Saudi mobile.
 */
export function normalizeSaudiMobile(value: string): string | null {
  const digits = toWesternDigits(value).replace(/[\s\-()]/g, '');
  let local: string | null = null;
  if (/^05\d{8}$/.test(digits)) local = digits.slice(1);
  else if (/^5\d{8}$/.test(digits)) local = digits;
  else if (/^\+9665\d{8}$/.test(digits)) local = digits.slice(4);
  else if (/^9665\d{8}$/.test(digits)) local = digits.slice(3);
  else if (/^009665\d{8}$/.test(digits)) local = digits.slice(5);
  return local ? `+966${local}` : null;
}

export function isValidSaudiMobile(value: string): boolean {
  return normalizeSaudiMobile(value) !== null;
}

/** `+966512345678` → `0512345678` for display. */
export function formatSaudiMobileLocal(e164: string): string {
  return e164.startsWith('+966') ? `0${e164.slice(4)}` : e164;
}
