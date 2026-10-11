import { MM_PER_PT } from './units';

/**
 * Average advance of one character, as a fraction of the font size. IBM Plex Sans Arabic
 * averages ~0.5em for joined Arabic and ~0.55em for Latin/digits; 0.56 keeps us on the safe side.
 */
const AVG_ADVANCE_EM = 0.56;

/** Estimated rendered width (mm) of `text` at `sizePt`. Deterministic, so it works on the server too. */
export function estimateTextWidthMm(text: string, sizePt: number): number {
  return [...text].length * sizePt * MM_PER_PT * AVG_ADVANCE_EM;
}

export interface FitOptions {
  /** Preferred size (pt) from the template. */
  basePt: number;
  /** Never shrink below this (pt). */
  minPt: number;
  /** Width available for the text (mm). */
  widthMm: number;
  /** Lines the text may wrap to before it is ellipsised. */
  lines?: number;
}

/**
 * Picks a font size so the text fits in `lines` lines of `widthMm`, shrinking from `basePt`
 * down to `minPt`. What still doesn't fit is clipped by CSS with an ellipsis.
 */
export function fitFontPt(text: string, { basePt, minPt, widthMm, lines = 1 }: FitOptions): number {
  const floor = Math.min(minPt, basePt);
  if (!text || widthMm <= 0) return basePt;
  // Wrapping wastes some of every line except the last; budget 85% of the extra lines.
  const budget = widthMm * (lines === 1 ? 1 : 1 + (lines - 1) * 0.85);
  const needed = estimateTextWidthMm(text, basePt);
  if (needed <= budget) return basePt;
  const scaled = basePt * (budget / needed);
  return Math.max(floor, Math.floor(scaled * 4) / 4);
}

/** Height (mm) of `lines` lines at `sizePt` with the given line height. */
export function lineBoxMm(sizePt: number, lineHeight: number, lines = 1): number {
  return sizePt * MM_PER_PT * lineHeight * lines;
}
