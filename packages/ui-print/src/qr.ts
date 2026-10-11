import QRCode from 'qrcode';
import { toWesternDigits } from '@nuzli/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a value looks like a national ID / Iqama (or any 10+ digit personal number):
 * ten or more digits in a row once Arabic-Indic digits are converted and spaces, dashes,
 * dots and underscores are removed. Internal UUIDs are always accepted.
 */
export function isNationalIdLike(value: string): boolean {
  const trimmed = value.trim();
  if (UUID_RE.test(trimmed)) return false;
  const compact = toWesternDigits(trimmed).replace(/[\s\-_.‎‏]/g, '');
  return /\d{10,}/.test(compact);
}

/** Throws when a QR value could carry a national ID (brief §8.2: the QR holds the internal UUID only). */
export function assertSafeQrValue(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('QR value is empty; expected the internal member UUID');
  }
  if (isNationalIdLike(value)) {
    throw new Error('QR value looks like a national ID; only the internal member UUID may be encoded');
  }
  return value.trim();
}

/** The QR value to print, or `null` when it is missing or unsafe (the QR is then left out). */
export function safeQrValue(value: string | null | undefined): string | null {
  if (!value || !value.trim() || isNationalIdLike(value)) return null;
  return value.trim();
}

const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 0 } as const;

/**
 * PNG data URL for the internal UUID (error correction M, no quiet zone — the card's
 * padding provides it). Rejects anything that looks like a national ID.
 */
export async function makeQrDataUrl(value: string, resolution = 512): Promise<string> {
  const safe = assertSafeQrValue(value);
  return QRCode.toDataURL(safe, { ...QR_OPTIONS, type: 'image/png', width: resolution });
}

export interface QrMatrix {
  size: number;
  /** SVG path data, one unit per module. */
  path: string;
}

/** Synchronous QR module matrix as SVG path data (vector, crisp at any printer DPI). */
export function qrMatrix(value: string): QrMatrix {
  const safe = assertSafeQrValue(value);
  const qr = QRCode.create(safe, { errorCorrectionLevel: 'M' });
  const { size, data } = qr.modules;
  let path = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (data[row * size + col]) {
        const start = col;
        while (col < size && data[row * size + col]) col++;
        path += `M${start} ${row}h${col - start}v1h${start - col}z`;
      } else {
        col++;
      }
    }
  }
  return { size, path };
}
