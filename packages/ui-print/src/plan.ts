import { CARD_LABELS, type CardModel } from './config';
import { estimateTextWidthMm, fitFontPt, lineBoxMm } from './fit';
import { clamp } from './units';

export const NAME_LINE_HEIGHT = 1.15;
export const BODY_LINE_HEIGHT = 1.3;

export type RowKind = 'jobTitle' | 'nationalId' | 'department' | 'team' | 'validUntil';

export interface RowSpec {
  kind: RowKind;
  label: string | null;
  value: string;
  /** Lower number = more important; the least important rows are dropped first when space runs out. */
  priority: number;
  /** Never dropped (the team row: a band must not appear without its team name). */
  keep?: boolean;
  /** Extra width (mm) taken by a swatch in front of the text. */
  extraMm?: number;
}

/** Card frame: paddings and the vest band, in mm. */
export interface Frame {
  pad: number;
  band: number;
  gap: number;
  /** Content-box paddings (logical). */
  blockStart: number;
  blockEnd: number;
  inlineStart: number;
  inlineEnd: number;
  innerW: number;
  innerH: number;
}

export function computeFrame(model: CardModel): Frame {
  const { widthMm: w, heightMm: h } = model.dims;
  const short = Math.min(w, h);
  const pad = clamp(short * 0.06, 1.5, 4);
  const band = model.team ? clamp(short * 0.06, 1.5, 4.5) : 0;
  const gap = clamp(short * 0.035, 0.8, 2.5);
  const strip = model.config.accentStrip;
  const inlineStart = pad + (strip === 'start' ? band : 0);
  const blockStart = pad + (strip === 'top' ? band : 0);
  const blockEnd = pad + (strip === 'bottom' ? band : 0);
  const inlineEnd = pad;
  return {
    pad,
    band,
    gap,
    blockStart,
    blockEnd,
    inlineStart,
    inlineEnd,
    innerW: Math.max(0, w - inlineStart - inlineEnd),
    innerH: Math.max(0, h - blockStart - blockEnd),
  };
}

/** Field rows in priority order: the team (identity) first, the validity date last. */
export function rowSpecs(model: CardModel, swatchMm: number, opts: { labels?: boolean } = {}): RowSpec[] {
  const labels = opts.labels ?? true;
  const rows: RowSpec[] = [];
  if (model.team) rows.push({ kind: 'team', label: null, value: model.team.name, priority: 1, keep: true, extraMm: swatchMm * 1.6 });
  if (model.jobTitle) rows.push({ kind: 'jobTitle', label: null, value: model.jobTitle, priority: 2 });
  if (model.nationalId)
    rows.push({ kind: 'nationalId', label: labels ? CARD_LABELS.nationalId : null, value: model.nationalId, priority: 3 });
  if (model.department)
    rows.push({ kind: 'department', label: labels ? CARD_LABELS.department : null, value: model.department, priority: 4 });
  if (model.validUntil) rows.push({ kind: 'validUntil', label: CARD_LABELS.validUntil, value: model.validUntil, priority: 5 });
  return rows;
}

export function rowText(row: RowSpec): string {
  return row.label ? `${row.label}: ${row.value}` : row.value;
}

export interface TextPlan {
  namePt: number;
  nameLines: number;
  bodyPt: number;
  rows: RowSpec[];
  /** Rows that did not fit and were left out (still visible in the editor preview count). */
  dropped: RowKind[];
  heightMm: number;
}

export interface PlanInput {
  name: string;
  rows: RowSpec[];
  widthMm: number;
  heightMm: number;
  namePt: number;
  bodyPt: number;
  maxNameLines: number;
  /** Fixed vertical space between blocks (mm). */
  gapMm?: number;
}

/**
 * Decides font sizes and which rows fit: shrink the name to fit its lines, shrink body rows
 * to one line each, then scale both down (to 70%) and finally drop the least important rows.
 * Whatever still overflows is ellipsised by CSS — text never spills off the card.
 */
export function planText(input: PlanInput): TextPlan {
  const { name, widthMm, heightMm, maxNameLines } = input;
  const gap = input.gapMm ?? 0;
  const nameFloor = Math.max(5, input.namePt * 0.6);
  const bodyFloor = Math.max(4, input.bodyPt * 0.75);

  let namePt = fitFontPt(name, { basePt: input.namePt, minPt: nameFloor, widthMm, lines: maxNameLines });
  let bodyPt = input.rows.reduce(
    (size, row) =>
      Math.min(size, fitFontPt(rowText(row), { basePt: input.bodyPt, minPt: bodyFloor, widthMm: widthMm - (row.extraMm ?? 0) })),
    input.bodyPt,
  );
  const linesFor = (pt: number) => (estimateTextWidthMm(name, pt) > widthMm ? Math.min(maxNameLines, 2) : 1);
  const measure = (np: number, bp: number, rows: RowSpec[]) =>
    lineBoxMm(np, NAME_LINE_HEIGHT, linesFor(np)) + rows.length * lineBoxMm(bp, BODY_LINE_HEIGHT) + (rows.length ? gap : 0);

  let rows = [...input.rows];
  let total = measure(namePt, bodyPt, rows);
  if (total > heightMm) {
    const s = Math.max(0.7, heightMm / total);
    namePt = Math.max(Math.min(nameFloor, namePt), Math.floor(namePt * s * 4) / 4);
    bodyPt = Math.max(Math.min(bodyFloor, bodyPt, 4), Math.floor(bodyPt * s * 4) / 4);
    total = measure(namePt, bodyPt, rows);
  }
  const dropped: RowKind[] = [];
  while (total > heightMm && rows.some((r) => !r.keep)) {
    const worst = rows.filter((r) => !r.keep).reduce((a, b) => (b.priority > a.priority ? b : a));
    rows = rows.filter((r) => r !== worst);
    dropped.push(worst.kind);
    total = measure(namePt, bodyPt, rows);
  }
  return { namePt, nameLines: linesFor(namePt), bodyPt, rows, dropped, heightMm: total };
}
