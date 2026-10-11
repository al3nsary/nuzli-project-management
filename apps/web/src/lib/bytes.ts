/** Blob → ArrayBuffer that also works in jsdom (FileReader) and old Safari. */
export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof (blob as Blob & { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/**
 * Removes metadata segments from a JPEG: APP1…APP15 (EXIF, XMP, ICC, maker notes…) and COM.
 * APP0 (JFIF) and the image data are kept. Non-JPEG input is returned unchanged.
 * A second line of defence after the canvas re-encode in `compressImage` (brief §7.2).
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  const b = input;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return input;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return input; // not a marker where one is expected: leave the file alone
    const marker = b[i + 1]!;
    if (marker === 0xda) {
      // Start of scan: the rest is image data.
      for (let k = i; k < b.length; k++) out.push(b[k]!);
      return Uint8Array.from(out);
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const end = i + 2 + len;
    if (end > b.length) return input;
    const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMeta) for (let k = i; k < end; k++) out.push(b[k]!);
    i = end;
  }
  return input;
}

/** True when the JPEG still carries an EXIF APP1 segment. */
export function hasExif(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) return false;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (
      marker === 0xe1 &&
      b[i + 4] === 0x45 && // E
      b[i + 5] === 0x78 && // x
      b[i + 6] === 0x69 && // i
      b[i + 7] === 0x66 // f
    )
      return true;
    i += 2 + len;
  }
  return false;
}
