/**
 * File-type detection from the first bytes (brief §13: uploads validated by magic bytes).
 * Only JPEG, PNG, WebP and PDF are recognised; everything else — SVG, HTML, executables,
 * polyglots that do not start with a known signature — returns null and is rejected.
 */
export type DetectedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

export function detectFileType(head: Uint8Array): DetectedType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, PNG)) return 'image/png';
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf';
  return null;
}

export const EXTENSIONS: Record<DetectedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Bytes read with a ranged GET before confirming an upload (ADR-012). */
export const MAGIC_PROBE_BYTES = 4096;
