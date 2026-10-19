/**
 * A9 imports — the file side shared by the wizard and the DemoApi: the sources the wizard offers,
 * the canonical content type per extension (the API accepts only those, ADR-110), the client-side
 * checks (type and the 20 MB limit) and the structure checks the API runs at `confirm`
 * (apps/api/src/storage/magic-bytes.ts `verifyImportBytes`), and `draftOf`, which routes a file to
 * its parser exactly like `ImportsService.draftOf`.
 */
import { MAX_IMPORT_BYTES, type ImportFormat } from '@nuzli/shared';
import { importError, type ImportDraft } from './model';
import { parseJiraCsv } from './jira';
import { parseMspdi } from './mspdi';
import { decodeText, readCsv, readXlsx, tableToDraft } from './tabular';

export { MAX_IMPORT_BYTES };

/** What the wizard's first step offers (Jira Cloud is not a file). */
export type ImportSource = ImportFormat | 'jira-cloud';
export const IMPORT_SOURCES: readonly ImportSource[] = [
  'xlsx',
  'csv',
  'xml',
  'mpp',
  'jira-csv',
  'jira-cloud',
];

export type ImportContentType =
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv'
  | 'application/xml'
  | 'text/xml'
  | 'application/vnd.ms-project';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

/** The extension a format accepts, and the content type sent to `presign` (never the browser's guess). */
export const FORMAT_FILE: Record<ImportFormat, { ext: string; contentType: ImportContentType }> = {
  xlsx: { ext: '.xlsx', contentType: XLSX },
  csv: { ext: '.csv', contentType: 'text/csv' },
  'jira-csv': { ext: '.csv', contentType: 'text/csv' },
  xml: { ext: '.xml', contentType: 'application/xml' },
  mpp: { ext: '.mpp', contentType: 'application/vnd.ms-project' },
};

export type FileProblem = 'type' | 'size' | 'empty';

/** Client-side checks before any upload: the extension of the chosen format and 1 B … 20 MB. */
export function checkImportFile(
  file: { name: string; size: number },
  format: ImportFormat,
): FileProblem | null {
  if (!file.name.toLowerCase().endsWith(FORMAT_FILE[format].ext)) return 'type';
  if (file.size <= 0) return 'empty';
  if (file.size > MAX_IMPORT_BYTES) return 'size';
  return null;
}

/** The format a dropped file most likely is (the wizard pre-selects it). */
export function formatOfName(name: string): ImportFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith('.xlsx')) return 'xlsx';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.xml')) return 'xml';
  if (n.endsWith('.mpp')) return 'mpp';
  return null;
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, sig: readonly number[]) => sig.every((x, i) => b[i] === x);
const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);

/** The API's structure check at confirm (ZIP with a workbook, OLE2, XML without DOCTYPE, NUL-free text). */
export function verifyImportBytes(bytes: Uint8Array, declared: string): boolean {
  switch (declared) {
    case XLSX: {
      const text = latin1(bytes);
      return (
        startsWith(bytes, ZIP) &&
        text.includes('[Content_Types].xml') &&
        text.includes('xl/workbook.xml')
      );
    }
    case 'application/vnd.ms-project':
      return startsWith(bytes, OLE2);
    case 'application/xml':
    case 'text/xml': {
      const head = utf8(bytes.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
      return head.startsWith('<') && !/<!DOCTYPE/i.test(latin1(bytes));
    }
    case 'text/csv': {
      if (
        startsWith(bytes, ZIP) ||
        startsWith(bytes, OLE2) ||
        startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
      )
        return false;
      const utf16 = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
      if (utf16) return true;
      if (bytes.subarray(0, 65536).includes(0)) return false;
      const head = utf8(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
      return !head.startsWith('<');
    }
    default:
      return false;
  }
}

/** Parses one file into a draft (`ImportsService.draftOf`). `.mpp` needs the server's converter. */
export async function draftOf(
  format: ImportFormat,
  bytes: Uint8Array,
  dateOrder: 'DMY' | 'MDY' = 'DMY',
  sheetName?: string,
): Promise<ImportDraft> {
  switch (format) {
    case 'xlsx': {
      const { rows } = await readXlsx(bytes, sheetName);
      return tableToDraft(rows, { dateOrder });
    }
    case 'csv':
      return tableToDraft(readCsv(bytes), { dateOrder });
    case 'jira-csv':
      return parseJiraCsv(bytes, dateOrder);
    case 'xml':
      return parseMspdi(decodeText(bytes));
    case 'mpp':
      // The converter (MPXJ, ADR-111) runs only next to the API.
      throw importError('MPP_CONVERTER_NOT_CONFIGURED');
  }
}
