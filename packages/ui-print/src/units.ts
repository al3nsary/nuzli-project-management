/** 1 typographic point in millimetres (1pt = 1/72 in = 25.4/72 mm). */
export const MM_PER_PT = 25.4 / 72;

/** Formats a number for CSS without float noise or trailing zeros: 85.6 → "85.6", 54 → "54". */
export function num(value: number, digits = 3): string {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A CSS length in millimetres. Every card length goes through this (never px). */
export function mm(value: number): string {
  return `${num(value)}mm`;
}

/** A CSS length in points (used for font sizes). */
export function pt(value: number): string {
  return `${num(value, 2)}pt`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
