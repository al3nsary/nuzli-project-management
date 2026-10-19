/**
 * ZIP decompression-bomb guard for .xlsx imports (security review A9 M2, ADR-119).
 *
 * exceljs (through JSZip) inflates every entry fully into memory, so the archive is inspected
 * BEFORE it is handed to exceljs:
 *  1. The End-Of-Central-Directory record and the central directory headers are parsed to count
 *     the entries and sum their declared uncompressed sizes (limits below). ZIP64, encryption,
 *     multi-disk archives and compression methods other than stored/deflate are refused.
 *  2. Declared sizes can lie, so each entry is then actually inflated with `maxOutputLength` set
 *     to its declared size: an entry that inflates to more than it declares is refused, and the
 *     memory used is bounded by the (already checked) declared size of one entry.
 * Pure (Buffer in, verdict out); no dependency.
 */
import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = {
  /** Sum of the uncompressed sizes of every entry. */
  maxTotalUncompressed: 100 * 1024 * 1024,
  /** One entry, uncompressed. */
  maxEntryUncompressed: 50 * 1024 * 1024,
  maxEntries: 2_000,
  /** uncompressed / compressed, checked for entries above `ratioFloorBytes` only. */
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
} as const;

export type ZipLimits = { -readonly [K in keyof typeof ZIP_LIMITS]: number };

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export type ZipVerdict =
  | { ok: true; entries: number; totalUncompressed: number }
  | { ok: false; reason: 'NOT_ZIP' | 'UNSUPPORTED' | 'TOO_MANY_ENTRIES' | 'TOO_LARGE' | 'ENTRY_TOO_LARGE' | 'RATIO' | 'SIZE_MISMATCH' | 'CORRUPT' };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Offset of the End-Of-Central-Directory record, scanning back over a possible comment. */
function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_MIN) return -1;
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

/** Central-directory entries, or a verdict when the directory itself is unacceptable. */
export function readCentralDirectory(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntryInfo[] | Exclude<ZipVerdict, { ok: true }> {
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, reason: 'NOT_ZIP' };
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesHere = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers (0xFFFF / 0xFFFFFFFF) and multi-disk archives are never needed for an import.
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, reason: 'UNSUPPORTED' };
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) return { ok: false, reason: 'UNSUPPORTED' };
  if (entries > limits.maxEntries) return { ok: false, reason: 'TOO_MANY_ENTRIES' };
  if (cdOffset + cdSize > eocd) return { ok: false, reason: 'CORRUPT' };

  const out: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) return { ok: false, reason: 'CORRUPT' };
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (flags & 0x1) return { ok: false, reason: 'UNSUPPORTED' }; // encrypted
    if (method !== 0 && method !== 8) return { ok: false, reason: 'UNSUPPORTED' };
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      return { ok: false, reason: 'UNSUPPORTED' };
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Checks an archive against the limits from its central directory, then verifies that every
 * entry inflates to exactly what it declares (bounded by `maxOutputLength`).
 */
export function inspectZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS, opts: { verify?: boolean } = {}): ZipVerdict {
  const list = readCentralDirectory(buf, limits);
  if (!Array.isArray(list)) return list;
  let total = 0;
  for (const e of list) {
    if (e.uncompressedSize > limits.maxEntryUncompressed) return { ok: false, reason: 'ENTRY_TOO_LARGE' };
    total += e.uncompressedSize;
    if (total > limits.maxTotalUncompressed) return { ok: false, reason: 'TOO_LARGE' };
    if (e.uncompressedSize > limits.ratioFloorBytes && e.uncompressedSize > limits.maxRatio * Math.max(e.compressedSize, 1)) {
      return { ok: false, reason: 'RATIO' };
    }
    if (e.method === 0 && e.compressedSize !== e.uncompressedSize) return { ok: false, reason: 'SIZE_MISMATCH' };
  }
  if (opts.verify !== false) {
    for (const e of list) {
      const lo = e.localHeaderOffset;
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) return { ok: false, reason: 'CORRUPT' };
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const end = start + e.compressedSize;
      if (end > buf.length) return { ok: false, reason: 'CORRUPT' };
      if (e.method === 0) continue;
      if (e.uncompressedSize === 0) {
        // An empty entry must inflate to nothing; allow a tiny output buffer to detect more.
        try {
          if (inflateRawSync(buf.subarray(start, end), { maxOutputLength: 1 }).length !== 0) return { ok: false, reason: 'SIZE_MISMATCH' };
        } catch {
          return { ok: false, reason: 'SIZE_MISMATCH' };
        }
        continue;
      }
      let inflated: Buffer;
      try {
        inflated = inflateRawSync(buf.subarray(start, end), { maxOutputLength: e.uncompressedSize });
      } catch (err) {
        // RangeError (ERR_BUFFER_TOO_LARGE): the entry inflates to more than it declares.
        return { ok: false, reason: (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'SIZE_MISMATCH' : 'CORRUPT' };
      }
      if (inflated.length !== e.uncompressedSize) return { ok: false, reason: 'SIZE_MISMATCH' };
    }
  }
  return { ok: true, entries: list.length, totalUncompressed: total };
}
