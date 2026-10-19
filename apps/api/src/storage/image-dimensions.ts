/**
 * Width and height from an image header, without decoding (security review A9 "to verify":
 * decompression bombs before OCR). JPEG (SOFn markers), PNG (IHDR) and WebP (VP8, VP8L, VP8X).
 * Pure; returns null for anything it cannot read.
 */
export interface ImageSize {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}

/** Largest image handed to the OCR engine: 25 megapixels (the web sends at most 1600 px a side). */
export const MAX_OCR_PIXELS = 25_000_000;

function jpegSize(b: Buffer): ImageSize | null {
  let p = 2;
  // Walk the marker segments up to the first frame header (SOF0..SOF15 except DHT/JPG/DAC).
  for (let guard = 0; p + 9 < b.length && guard < 10_000; guard++) {
    if (b[p] !== 0xff) return null;
    let marker = b[p + 1]!;
    while (marker === 0xff && p + 2 < b.length) {
      p++;
      marker = b[p + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame
    const len = b.readUInt16BE(p + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (p + 9 > b.length) return null;
      return { type: 'image/jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    }
    p += 2 + len;
  }
  return null;
}

function pngSize(b: Buffer): ImageSize | null {
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const w = b.readUIntLE(24, 3) + 1;
    const h = b.readUIntLE(27, 3) + 1;
    return { type: 'image/webp', width: w, height: h };
  }
  return null;
}

export function imageSize(b: Buffer): ImageSize | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return pngSize(b);
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webpSize(b);
  return null;
}

/** Null when the image is acceptable for OCR, else the reason. */
export function ocrImageProblem(b: Buffer, maxPixels = MAX_OCR_PIXELS): 'NOT_AN_IMAGE' | 'IMAGE_TOO_LARGE' | null {
  const s = imageSize(b);
  if (!s || s.width < 1 || s.height < 1) return 'NOT_AN_IMAGE';
  return s.width * s.height > maxPixels ? 'IMAGE_TOO_LARGE' : null;
}
