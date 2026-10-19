import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { verifyImportBytes } from './magic-bytes';
import { inspectZip, readCentralDirectory, ZIP_LIMITS } from './zip-guard';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const fixture = readFileSync(join(__dirname, '../../test/fixtures/imports/tasks.xlsx'));

interface Entry {
  name: string;
  data: Buffer;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
}

/** Minimal ZIP writer for the tests (local headers, central directory, EOCD). */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.stored ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? e.data.length;
    const crc = crc32(e.data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(e.stored ? 0 : 8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(size, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(e.stored ? 0 : 8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('ZIP bomb guard (security review A9 M2)', () => {
  it('a real .xlsx passes, with its entries counted from the central directory', () => {
    const v = inspectZip(fixture);
    expect(v.ok).toBe(true);
    const list = readCentralDirectory(fixture);
    expect(Array.isArray(list) && list.some((e) => e.name === 'xl/workbook.xml')).toBe(true);
    expect(verifyImportBytes(fixture, XLSX)).toBe(true);
  });

  it('a small, honest archive passes; something that is not a ZIP does not', () => {
    expect(inspectZip(makeZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.txt', data: Buffer.from('x'), stored: true }]))).toMatchObject({ ok: true, entries: 2, totalUncompressed: 6 });
    expect(inspectZip(Buffer.from('not a zip at all, just text'))).toEqual({ ok: false, reason: 'NOT_ZIP' });
  });

  it('a ratio above 100:1 (for entries above 1 MB) is refused — 8 MB of zeros deflate to a few KB', () => {
    const bomb = makeZip([{ name: 'xl/sharedStrings.xml', data: Buffer.alloc(8 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(20_000);
    expect(inspectZip(bomb)).toEqual({ ok: false, reason: 'RATIO' });
    // Small entries are not ratio-checked (tiny XML parts compress very well).
    expect(inspectZip(makeZip([{ name: 'z', data: Buffer.alloc(500_000) }])).ok).toBe(true);
  });

  it('total and per-entry uncompressed sizes and the entry count are bounded', () => {
    const lim = { ...ZIP_LIMITS, maxTotalUncompressed: 1000, maxEntryUncompressed: 600, maxEntries: 3 };
    const rnd = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251));
    expect(inspectZip(makeZip([{ name: 'a', data: rnd(500) }, { name: 'b', data: rnd(501) }]), lim)).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(inspectZip(makeZip([{ name: 'a', data: rnd(700) }]), lim)).toEqual({ ok: false, reason: 'ENTRY_TOO_LARGE' });
    expect(inspectZip(makeZip([1, 2, 3, 4].map((i) => ({ name: `f${i}`, data: rnd(10) }))), lim)).toEqual({ ok: false, reason: 'TOO_MANY_ENTRIES' });
    const many = makeZip(Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `e${i}`, data: Buffer.from('x'), stored: true })));
    expect(inspectZip(many)).toEqual({ ok: false, reason: 'TOO_MANY_ENTRIES' });
  });

  it('an entry that inflates to more than it declares is refused (sizes in the headers can lie)', () => {
    const liar = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(300_000, 0x41), declaredSize: 1000 }]);
    expect(inspectZip(liar)).toEqual({ ok: false, reason: 'SIZE_MISMATCH' });
    // The same lie, but declaring a larger size than the data, is refused as well.
    expect(inspectZip(makeZip([{ name: 'a', data: Buffer.from('abc'), declaredSize: 10 }]))).toEqual({ ok: false, reason: 'SIZE_MISMATCH' });
    // A bomb dressed as an .xlsx never passes the upload check.
    const dressed = makeZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.alloc(8 * 1024 * 1024) },
    ]);
    expect(verifyImportBytes(dressed, XLSX)).toBe(false);
  });

  it('ZIP64 markers and encrypted entries are refused', () => {
    const z = makeZip([{ name: 'a', data: Buffer.from('abc') }]);
    const zip64 = Buffer.from(z);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(inspectZip(zip64)).toEqual({ ok: false, reason: 'UNSUPPORTED' });
    const enc = Buffer.from(z);
    const cdOffset = enc.readUInt32LE(enc.length - 22 + 16);
    enc.writeUInt16LE(1, cdOffset + 8);
    expect(inspectZip(enc)).toEqual({ ok: false, reason: 'UNSUPPORTED' });
  });
});
