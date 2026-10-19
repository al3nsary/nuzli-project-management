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

// ───────────────────────────── A9 project imports (ADR-110)

export type ImportType =
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv'
  | 'application/xml'
  | 'text/xml'
  | 'application/vnd.ms-project';

/** Every content type the bucket may hold. */
export type StoredType = DetectedType | ImportType;

export const STORED_EXTENSIONS: Record<StoredType, string> = {
  ...EXTENSIONS,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/vnd.ms-project': 'mpp',
};

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

function contains(buf: Uint8Array, needle: string): boolean {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes(needle, 0, 'latin1');
}

/**
 * Structure check of an import upload (the whole file, ≤ 20 MB):
 * - xlsx: a ZIP whose entries include `[Content_Types].xml` and `xl/workbook.xml`;
 * - .mpp: an OLE2 compound file;
 * - XML: after an optional BOM and whitespace it starts with `<`, and it has no DOCTYPE (no
 *   entity declarations reach the parser: XXE / entity-expansion guard);
 * - CSV: text — no NUL byte in the first 64 KB unless it is UTF-16 with a BOM, and it is not a
 *   ZIP, OLE2, PDF or XML document in disguise.
 */
export function verifyImportBytes(bytes: Uint8Array, declared: ImportType): boolean {
  switch (declared) {
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return startsWith(bytes, ZIP) && contains(bytes, '[Content_Types].xml') && contains(bytes, 'xl/workbook.xml');
    case 'application/vnd.ms-project':
      return startsWith(bytes, OLE2);
    case 'application/xml':
    case 'text/xml': {
      const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8').replace(/^﻿/, '').trimStart();
      return head.startsWith('<') && !/<!DOCTYPE/i.test(Buffer.from(bytes).toString('latin1'));
    }
    case 'text/csv': {
      if (startsWith(bytes, ZIP) || startsWith(bytes, OLE2) || startsWith(bytes, ascii('%PDF-'))) return false;
      const utf16 = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
      if (utf16) return true;
      const probe = bytes.subarray(0, 65536);
      if (probe.includes(0)) return false;
      const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart();
      return !head.startsWith('<');
    }
    default:
      return false;
  }
}
