/**
 * The project cover crop (A12 round 2): a fixed 16:9 frame over the picture, panned by drag or
 * the arrows and zoomed with a slider; the visible part is re-encoded on a canvas (EXIF dropped)
 * as a 1600×900 JPEG of at most `PROJECT_COVER_MAX_BYTES`. The geometry is pure (tested without
 * a canvas). Pointer deltas and canvas pixels are both physical, so no direction sign applies.
 */
import { PROJECT_COVER_MAX_BYTES } from '@nuzli/shared';

export const COVER_ASPECT = 16 / 9;
export const COVER_OUT_W = 1600;
export const COVER_OUT_H = 900;
export const COVER_MAX_ZOOM = 4;
export const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Zoom 1 = the largest 16:9 rectangle that fits the picture; `cx`/`cy` = its centre (source px). */
export interface CoverCrop {
  zoom: number;
  cx: number;
  cy: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The 16:9 rectangle at zoom 1. */
function baseSize(w: number, h: number): { w: number; h: number } {
  return w / h > COVER_ASPECT ? { w: h * COVER_ASPECT, h } : { w, h: w / COVER_ASPECT };
}

export function initialCover(w: number, h: number): CoverCrop {
  return { zoom: 1, cx: w / 2, cy: h / 2 };
}

export function clampCover(w: number, h: number, s: CoverCrop): CoverCrop {
  const zoom = clamp(Number.isFinite(s.zoom) ? s.zoom : 1, 1, COVER_MAX_ZOOM);
  const b = baseSize(w, h);
  const hw = b.w / zoom / 2;
  const hh = b.h / zoom / 2;
  return { zoom, cx: clamp(s.cx, hw, w - hw), cy: clamp(s.cy, hh, h - hh) };
}

/** The source rectangle that becomes the cover. */
export function coverRect(w: number, h: number, s: CoverCrop): Rect {
  const c = clampCover(w, h, s);
  const b = baseSize(w, h);
  const rw = b.w / c.zoom;
  const rh = b.h / c.zoom;
  return { x: c.cx - rw / 2, y: c.cy - rh / 2, w: rw, h: rh };
}

/** Drags the picture by (dx, dy) screen pixels on a frame `viewW` pixels wide: it follows the finger. */
export function panCover(w: number, h: number, s: CoverCrop, dx: number, dy: number, viewW: number): CoverCrop {
  const r = coverRect(w, h, s);
  const k = r.w / Math.max(1, viewW);
  return clampCover(w, h, { ...s, cx: s.cx - dx * k, cy: s.cy - dy * k });
}

export function zoomCover(w: number, h: number, s: CoverCrop, zoom: number): CoverCrop {
  return clampCover(w, h, { ...s, zoom });
}

/** Images only (JPEG/PNG/WebP). */
export function coverTypeOk(type: string): boolean {
  return (COVER_TYPES as readonly string[]).includes(type);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Draws the crop on a 1600×900 canvas and encodes it as JPEG, lowering the quality until it fits
 * 3 MB. Throws `Error('too-large')` when even the lowest quality is over the limit.
 */
export async function renderCover(source: CanvasImageSource, w: number, h: number, s: CoverCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = COVER_OUT_W;
  canvas.height = COVER_OUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  const r = coverRect(w, h, s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, COVER_OUT_W, COVER_OUT_H);
  for (const q of [0.86, 0.76, 0.64, 0.5]) {
    const blob = await toBlob(canvas, 'image/jpeg', q);
    if (!blob) throw new Error('encode');
    if (blob.size <= PROJECT_COVER_MAX_BYTES) return blob;
  }
  throw new Error('too-large');
}
