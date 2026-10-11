/**
 * Saudi national ID / Iqama validation (brief §4.2).
 * 10 digits; first digit 1 (citizen) or 2 (resident); Luhn-variant check digit:
 * digits at even 0-based indexes are doubled (and their digits summed), the rest are
 * added as-is, and the total over all 10 digits must be a multiple of 10.
 */
export function isValidNationalId(value: string): boolean {
  const id = toWesternDigits(value).trim();
  if (!/^[12]\d{9}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const d = id.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += d;
    }
  }
  return sum % 10 === 0;
}

/** Computes the check digit for the first nine digits. Used by tests and demo seeding. */
export function nationalIdCheckDigit(first9: string): number {
  if (!/^\d{9}$/.test(first9)) throw new Error('expected 9 digits');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = first9.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += d;
    }
  }
  return (10 - (sum % 10)) % 10;
}

export type NationalIdKind = 'CITIZEN' | 'RESIDENT';
export function nationalIdKind(id: string): NationalIdKind | null {
  if (!isValidNationalId(id)) return null;
  return id.startsWith('1') ? 'CITIZEN' : 'RESIDENT';
}

/** `1•••••••23` — first digit, seven bullets, last two digits (brief §13). */
export function maskNationalId(id: string | null | undefined): string {
  if (!id) return '';
  const clean = toWesternDigits(id).trim();
  if (clean.length < 4) return '•'.repeat(clean.length);
  return `${clean[0]}${'•'.repeat(clean.length - 3)}${clean.slice(-2)}`;
}

/** Converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Western digits. */
export function toWesternDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}
