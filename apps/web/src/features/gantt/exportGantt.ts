/**
 * Gantt export (brief §6.1 "Export"): a standalone SVG built from the render model (not the
 * virtualised DOM), so it holds every row of the chosen range.
 * - PNG: the SVG with the self-hosted Arabic font embedded as a data URL, rasterised on a canvas.
 * - PDF: the same SVG in a print-only container, `@page { size: A4 landscape }`, `window.print()`.
 * Light colours are used for both (paper), whatever the screen theme.
 */
import { toDayNumber } from '@nuzli/scheduling';
import type { GanttDto } from '@nuzli/shared';
import plexArabic400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2?url';
import plexArabic600 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2?url';
import { formatNumber, t } from '../../i18n';
import type { Digits } from '../../i18n/format';
import { riyadhToday } from '../projects/engine';
import { calendarOf } from './batch';
import {
  BAR_HEIGHT,
  barFor,
  buildRows,
  dayEndX,
  dayStartX,
  dependencyPath,
  makeScale,
  type GanttRow,
  type Zoom,
} from './geometry';
import { dayLabel, gregorianRows, headerRowCount, hijriRows } from './timeHeader';

const C = {
  ink: '#1F2430',
  ground: '#F7F8FA',
  surface: '#FFFFFF',
  line: '#E6E8EC',
  field: '#303F9F',
  signal: '#A35C00',
  breach: '#C62828',
  ok: '#2E7D32',
  muted: '#5E6676',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ExportOptions {
  data: GanttDto;
  collapsed?: ReadonlySet<string>;
  fromDay: number;
  toDay: number;
  /** Pixels per day; for PDF it is chosen so the range fits the page. */
  dayWidth: number;
  zoom: Zoom;
  showHijri: boolean;
  digits: Digits;
  /** CSS `@font-face` rules to embed (PNG). */
  fontCss?: string;
  maxRows?: number;
}

const ROW = 26;
const HEAD = 22;
const GRID = 300;
const TITLE = 40;

/**
 * The whole chart as one SVG string, grid on the right, time flowing right → left.
 * Arabic labels carry direction="rtl", where text-anchor "start" is the RIGHT edge: every such label
 * is anchored at its right-hand x with "start" (A9 QA: "end" made names run off the image and bar
 * labels run over their bars).
 */
export function ganttSvg(o: ExportOptions): { svg: string; width: number; height: number } {
  const rows: GanttRow[] = buildRows(o.data.tasks, o.collapsed ?? new Set()).slice(0, o.maxRows ?? 600);
  const scale = makeScale(o.fromDay, o.toDay, o.dayWidth);
  const cal = calendarOf(o.data.calendar);
  const heads = headerRowCount(o.showHijri, o.zoom);
  const top = TITLE + HEAD * heads;
  const width = Math.ceil(scale.width) + GRID;
  const height = top + rows.length * ROW + 8;
  const today = toDayNumber(riyadhToday());
  const parts: string[] = [];
  const font = "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif";
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(font)}">`);
  if (o.fontCss) parts.push(`<style>${o.fontCss}</style>`);
  parts.push(`<rect width="${width}" height="${height}" fill="${C.surface}"/>`);
  const title = t('gantt.printTitle', { name: o.data.project.name, date: dayLabel(riyadhToday(), o.digits) });
  parts.push(`<text x="${width - 12}" y="26" text-anchor="start" font-size="16" font-weight="600" fill="${C.ink}" direction="rtl">${esc(title)}</text>`);

  // Timeline (left part, x in [0, scale.width]).
  const rowY = (i: number) => top + i * ROW;
  parts.push(`<g>`);
  for (let d = scale.startDay; d <= scale.endDay; d++) {
    if (!cal.isWorkingDayNum(d)) {
      parts.push(`<rect x="${dayEndX(scale, d)}" y="${top}" width="${scale.dayWidth}" height="${rows.length * ROW}" fill="${C.muted}" fill-opacity="0.1"/>`);
    }
  }
  const greg = gregorianRows(scale.startDay, scale.endDay, o.zoom, o.digits);
  const headRow = (segs: { fromDay: number; toDay: number; label: string }[], y: number, color: string) => {
    for (const s of segs) {
      const x1 = dayStartX(scale, s.fromDay);
      const x2 = dayEndX(scale, s.toDay);
      parts.push(`<line x1="${x1}" x2="${x1}" y1="${y}" y2="${y + HEAD}" stroke="${C.line}"/>`);
      if (x1 - x2 > 18) parts.push(`<text x="${(x1 + x2) / 2}" y="${y + 15}" text-anchor="middle" font-size="10" fill="${color}" direction="rtl">${esc(s.label)}</text>`);
    }
  };
  parts.push(`<rect x="0" y="${TITLE}" width="${scale.width}" height="${HEAD * heads}" fill="${C.ground}"/>`);
  headRow(greg.top, TITLE, C.ink);
  headRow(greg.bottom, TITLE + HEAD, C.muted);
  if (o.showHijri) hijriRows(scale.startDay, scale.endDay, o.zoom, o.digits).forEach((segs, i) => headRow(segs, TITLE + HEAD * (2 + i), C.field));
  if (today >= scale.startDay && today <= scale.endDay) {
    const x = dayStartX(scale, today) - scale.dayWidth / 2;
    parts.push(`<line x1="${x}" x2="${x}" y1="${top}" y2="${height}" stroke="${C.field}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  }
  const bars = rows.map((r) => {
    const b = barFor(r, r.task, scale, ROW);
    return { ...b, y: b.y + top, h: Math.min(b.h, 14), cy: rowY(r.index) + ROW / 2 };
  });
  const index = new Map(rows.map((r) => [r.id, r.index]));
  for (const d of o.data.dependencies) {
    const a = index.get(d.predecessorId);
    const b = index.get(d.successorId);
    if (a === undefined || b === undefined) continue;
    const pa = { ...bars[a]!, y: bars[a]!.cy - 7, h: 14 };
    const pb = { ...bars[b]!, y: bars[b]!.cy - 7, h: 14 };
    parts.push(`<path d="${dependencyPath(pa, pb, ROW)}" fill="none" stroke="${C.muted}" stroke-width="1"/>`);
  }
  rows.forEach((r, i) => {
    const b = bars[i]!;
    const y = b.cy - 7;
    parts.push(`<line x1="0" x2="${width}" y1="${rowY(i) + ROW}" y2="${rowY(i) + ROW}" stroke="${C.line}" stroke-opacity="0.5"/>`);
    if (b.kind === 'milestone') {
      const cx = (b.startX + b.endX) / 2;
      parts.push(`<path d="M${cx} ${b.cy - 7}L${cx + 7} ${b.cy}L${cx} ${b.cy + 7}L${cx - 7} ${b.cy}Z" fill="${r.task.status === 'DONE' ? C.ok : C.ink}"/>`);
      return;
    }
    if (b.kind === 'group') {
      parts.push(`<rect x="${b.x}" y="${b.cy - 4}" width="${b.w}" height="8" fill="${C.ink}" rx="2"/>`);
      return;
    }
    const late = r.task.status !== 'DONE' && toDayNumber(r.task.endDate) < today;
    const stroke = r.task.status === 'DONE' ? C.ok : late ? C.breach : C.field;
    parts.push(`<rect x="${b.x}" y="${y}" width="${b.w}" height="14" rx="3" fill="${stroke}" fill-opacity="0.25" stroke="${stroke}"/>`);
    parts.push(`<rect x="${b.startX - b.progressW}" y="${y}" width="${b.progressW}" height="14" rx="3" fill="${C.field}" fill-opacity="0.75"/>`);
    if (r.task.assignee?.teamColor) parts.push(`<rect x="${b.startX - 4}" y="${y}" width="4" height="14" fill="${r.task.assignee.teamColor}"/>`);
    if (r.task.assignee) {
      const label = `${r.task.assignee.fullName}${r.task.assignee.teamName ? ` (${r.task.assignee.teamName})` : ''}`;
      parts.push(`<text x="${b.x - 4}" y="${b.cy + 4}" text-anchor="start" font-size="9.5" fill="${C.muted}" direction="rtl">${esc(label)}</text>`);
    }
  });
  parts.push(`</g>`);

  // Grid (right part).
  const gx = scale.width;
  parts.push(`<rect x="${gx}" y="${TITLE}" width="${GRID}" height="${height - TITLE}" fill="${C.surface}"/>`);
  parts.push(`<line x1="${gx}" x2="${gx}" y1="${TITLE}" y2="${height}" stroke="${C.line}"/>`);
  parts.push(`<rect x="${gx}" y="${TITLE}" width="${GRID}" height="${HEAD * heads}" fill="${C.ground}"/>`);
  parts.push(`<text x="${width - 8}" y="${top - 8}" text-anchor="start" font-size="10" font-weight="600" fill="${C.muted}" direction="rtl">${esc(t('gantt.col.wbs'))}</text>`);
  parts.push(`<text x="${width - 56}" y="${top - 8}" text-anchor="start" font-size="10" font-weight="600" fill="${C.muted}" direction="rtl">${esc(t('gantt.col.name'))}</text>`);
  rows.forEach((r, i) => {
    const y = rowY(i) + 17;
    parts.push(`<text x="${width - 8}" y="${y}" text-anchor="end" font-size="10" fill="${C.muted}">${esc(r.task.wbs)}</text>`);
    const name = r.task.name.length > 34 ? `${r.task.name.slice(0, 33)}…` : r.task.name;
    parts.push(
      `<text x="${width - 56 - r.depth * 10}" y="${y}" text-anchor="start" font-size="11" ${r.hasChildren ? 'font-weight="600"' : ''} fill="${C.ink}" direction="rtl">${esc(name)}</text>`,
    );
    parts.push(`<text x="${gx + 6}" y="${y}" text-anchor="start" font-size="9.5" fill="${C.muted}">${esc(`${formatNumber(Math.round(r.task.progress))}٪`)}</text>`);
  });
  parts.push(`</svg>`);
  return { svg: parts.join(''), width, height };
}

async function fontFaceCss(): Promise<string> {
  const toDataUrl = async (url: string) => {
    const blob = await (await fetch(url)).blob();
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  };
  try {
    const [w4, w6] = await Promise.all([toDataUrl(plexArabic400), toDataUrl(plexArabic600)]);
    return `@font-face{font-family:'IBM Plex Sans Arabic';font-weight:400;src:url(${w4}) format('woff2')}@font-face{font-family:'IBM Plex Sans Arabic';font-weight:600;src:url(${w6}) format('woff2')}`;
  } catch {
    return ''; // fall back to the system Arabic font
  }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** PNG of the visible date range, every (expanded) row, fonts embedded. */
export async function exportGanttPng(o: Omit<ExportOptions, 'fontCss'>, filename: string): Promise<void> {
  const fontCss = await fontFaceCss();
  const { svg, width, height } = ganttSvg({ ...o, fontCss });
  const img = new Image();
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg'));
      img.src = svgUrl;
    });
    const scale = Math.min(2, 16_000 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
    download(blob, filename);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** PDF through the browser's print dialog: A4 landscape, the whole project scaled to the page width. */
export function printGantt(o: Omit<ExportOptions, 'dayWidth' | 'fontCss'>): void {
  const days = o.toDay - o.fromDay + 1;
  const pagePx = 1500; // ≈ A4 landscape at 96 dpi with a little margin, scaled by the SVG viewBox
  const { svg } = ganttSvg({ ...o, dayWidth: Math.max(0.6, (pagePx - GRID) / days) });
  const host = document.createElement('div');
  host.id = 'nz-gantt-print';
  host.setAttribute('dir', 'rtl');
  host.innerHTML = svg;
  const style = document.createElement('style');
  style.textContent = `@page { size: A4 landscape; margin: 8mm; }
@media print {
  body > *:not(#nz-gantt-print) { display: none !important; }
  #nz-gantt-print { display: block !important; }
  #nz-gantt-print svg { width: 100%; height: auto; direction: ltr; }
}
@media screen { #nz-gantt-print { display: none; } }`;
  document.head.appendChild(style);
  document.body.appendChild(host);
  const cleanup = () => {
    host.remove();
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // The container is display:none on screen, so it is harmless if a browser never fires afterprint.
  window.print();
}
