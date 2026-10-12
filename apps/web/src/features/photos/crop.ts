import { ALLOWED_IMAGE_TYPES, PHOTO_MAX_BYTES } from '@nuzli/shared';
import { blobToArrayBuffer, stripJpegMetadata } from '../../lib/bytes';
import type { MessageKey } from '../../i18n';

/**
 * Personal photos (owner request A8): the client crops a square and sends a 600×600 JPEG at
 * about 85 % quality. Re-encoding on a canvas drops every EXIF field (GPS included);
 * `stripJpegMetadata` is the second guarantee. The geometry below is pure so it is tested
 * without a canvas.
 */
export const PHOTO_OUTPUT_PX = 600;
export const PHOTO_JPEG_QUALITY = 0.85;
/** The shorter side of the source must have at least this many pixels. */
export const PHOTO_MIN_SOURCE_PX = 300;
/** Camera originals can be large; they are scaled down before cropping. */
export const PHOTO_SOURCE_MAX_BYTES = 15 * 1024 * 1024;
/** Sources above this are scaled to `PHOTO_PREPARE_MAX_SIDE` first (fast cropping on phones). */
export const PHOTO_PREPARE_ABOVE_BYTES = 3 * 1024 * 1024;
export const PHOTO_PREPARE_MAX_SIDE = 2048;
export const PHOTO_MAX_ZOOM = 4;

/** Zoom 1 = the largest square that fits; `cx`/`cy` = the crop centre in source pixels. */
export interface CropState {
  zoom: number;
  cx: number;
  cy: number;
}

export interface CropRect {
  x: number;
  y: number;
  side: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Zooming in never makes the crop smaller than `PHOTO_MIN_SOURCE_PX` source pixels. */
export function maxZoom(w: number, h: number): number {
  return Math.max(1, Math.min(PHOTO_MAX_ZOOM, Math.min(w, h) / PHOTO_MIN_SOURCE_PX));
}

export function initialCrop(w: number, h: number): CropState {
  return { zoom: 1, cx: w / 2, cy: h / 2 };
}

/** Keeps the zoom in range and the square inside the image. */
export function clampCrop(w: number, h: number, s: CropState): CropState {
  const zoom = clamp(s.zoom, 1, maxZoom(w, h));
  const half = Math.min(w, h) / zoom / 2;
  return { zoom, cx: clamp(s.cx, half, w - half), cy: clamp(s.cy, half, h - half) };
}

export function cropRect(w: number, h: number, s: CropState): CropRect {
  const c = clampCrop(w, h, s);
  const side = Math.min(w, h) / c.zoom;
  return { x: c.cx - side / 2, y: c.cy - side / 2, side };
}

/**
 * Drags the image by (dx, dy) **screen** pixels on a `viewPx` square view. Pointer deltas and
 * the canvas are both physical, so no direction sign applies: the picture follows the finger
 * in RTL and LTR alike.
 */
export function panBy(w: number, h: number, s: CropState, dx: number, dy: number, viewPx: number): CropState {
  const side = Math.min(w, h) / clamp(s.zoom, 1, maxZoom(w, h));
  const k = side / viewPx;
  return clampCrop(w, h, { ...s, cx: s.cx - dx * k, cy: s.cy - dy * k });
}

/** Zooms around the current centre. */
export function zoomTo(w: number, h: number, s: CropState, zoom: number): CropState {
  return clampCrop(w, h, { ...s, zoom });
}

export type PhotoErrorKey = Extract<
  MessageKey,
  'photo.err.type' | 'photo.err.size' | 'photo.err.small' | 'photo.err.read'
>;

/** Type and size of the chosen file (before decoding). */
export function validateSource(file: { type: string; size: number }): PhotoErrorKey | null {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) return 'photo.err.type';
  if (file.size > PHOTO_SOURCE_MAX_BYTES) return 'photo.err.size';
  return null;
}

export function validateDimensions(w: number, h: number): PhotoErrorKey | null {
  return Math.min(w, h) < PHOTO_MIN_SOURCE_PX ? 'photo.err.small' : null;
}

/** A decoded image ready for the cropper. */
export interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/**
 * Large camera originals are scaled down with browser-image-compression first (it also applies
 * the EXIF orientation to the pixels); smaller files are decoded as they are.
 */
export async function prepareSource(file: File | Blob): Promise<Blob> {
  if (file.size <= PHOTO_PREPARE_ABOVE_BYTES) return file;
  const { default: imageCompression } = await import('browser-image-compression');
  const input = file instanceof File ? file : new File([file], 'photo', { type: file.type });
  return imageCompression(input, {
    maxWidthOrHeight: PHOTO_PREPARE_MAX_SIDE,
    initialQuality: 0.92,
    fileType: 'image/jpeg',
    preserveExif: false,
    useWebWorker: false,
  });
}

/** Decodes a blob into an `<img>` (browsers apply the EXIF orientation when drawing it). */
export function loadImage(blob: Blob): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () =>
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The upload: the crop drawn on a `size`×`size` canvas (white under transparent PNGs) and
 * encoded as JPEG; quality steps down if it would exceed `PHOTO_MAX_BYTES` (never in practice).
 */
export async function renderCrop(
  image: Pick<LoadedImage, 'source' | 'width' | 'height'>,
  state: CropState,
  size = PHOTO_OUTPUT_PX,
  doc: Document = document,
): Promise<Blob> {
  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const r = cropRect(image.width, image.height, state);
  ctx.drawImage(image.source, r.x, r.y, r.side, r.side, 0, 0, size, size);
  for (const q of [PHOTO_JPEG_QUALITY, 0.75, 0.6]) {
    const blob = await canvasToBlob(canvas, q);
    if (!blob) throw new Error('encode');
    const clean = stripJpegMetadata(new Uint8Array(await blobToArrayBuffer(blob)));
    if (clean.byteLength <= PHOTO_MAX_BYTES) return new Blob([clean], { type: 'image/jpeg' });
  }
  throw new Error('too-large');
}
