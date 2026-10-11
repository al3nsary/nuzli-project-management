import { num } from './units';

/** Base card styles — the same text as `src/print.css` (exported as `@nuzli/ui-print/print.css`). */
export const CARD_BASE_CSS: string = [
  ".nz-card { position: relative; box-sizing: border-box; overflow: hidden; direction: rtl; font-family: \"IBM Plex Sans Arabic\", \"Noto Sans Arabic\", Tahoma, sans-serif; line-height: 1.25; letter-spacing: 0; word-spacing: normal; font-kerning: normal; text-rendering: optimizeLegibility; -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
  ".nz-card *, .nz-card *::before, .nz-card *::after { box-sizing: border-box; margin: 0; padding: 0; letter-spacing: 0; }",
  ".nz-band { position: absolute; }",
  ".nz-content { position: absolute; display: flex; flex-direction: column; min-width: 0; min-height: 0; }",
  ".nz-hstack { display: flex; flex-direction: row; align-items: flex-start; min-width: 0; min-height: 0; }",
  ".nz-grow { flex: 1 1 auto; min-width: 0; min-height: 0; }",
  ".nz-text { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }",
  ".nz-rows { display: flex; flex-direction: column; min-width: 0; }",
  ".nz-name { font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; text-overflow: ellipsis; }",
  ".nz-ellipsis { display: block; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ".nz-row--team { display: flex; align-items: center; gap: 0.8mm; min-width: 0; white-space: nowrap; }",
  ".nz-swatch { display: inline-block; flex: none; }",
  ".nz-label { font-weight: 500; opacity: 0.72; }",
  ".nz-job { font-weight: 500; }",
  ".nz-mono { font-family: \"IBM Plex Mono\", \"IBM Plex Sans Arabic\", ui-monospace, monospace; font-variant-numeric: tabular-nums; unicode-bidi: isolate; }",
  ".nz-logo-row { display: flex; flex: none; align-items: center; min-width: 0; }",
  ".nz-logo { display: block; object-fit: contain; }",
  ".nz-photo { display: block; flex: none; object-fit: cover; }",
  ".nz-qr { display: block; flex: none; }",
  ".nz-qr-box { flex: none; }",
  ".nz-center { display: flex; justify-content: center; flex: none; }",
  ".nz-center-text { text-align: center; }",
  ".nz-push-end { margin-block-start: auto; }",
  ".nz-sheet { direction: rtl; }",
  "@media screen { .nz-sheet { display: flex; flex-direction: column; align-items: center; gap: 4mm; padding: 4mm; } .nz-sheet > .nz-card { outline: 0.2mm solid rgba(20, 35, 43, 0.25); } }",
].join('\n');

/**
 * Page CSS for one card per page at an exact size (brief §8.5, ADR-018).
 * The last card does not force a page break, so no blank trailing page is printed.
 */
export function printCss(widthMm: number, heightMm: number): string {
  if (!(widthMm > 0 && heightMm > 0)) throw new Error('printCss: width and height must be positive millimetres');
  const w = `${num(widthMm)}mm`;
  const h = `${num(heightMm)}mm`;
  return [
    `@page { size: ${w} ${h}; margin: 0; }`,
    `html, body { margin: 0; padding: 0; }`,
    `.nz-card { width: ${w}; height: ${h}; page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    `.nz-card:last-child { page-break-after: auto; break-after: auto; }`,
    `@media print { html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .nz-sheet { display: block; padding: 0; gap: 0; } .nz-sheet > .nz-card { outline: none; } }`,
  ].join('\n');
}
