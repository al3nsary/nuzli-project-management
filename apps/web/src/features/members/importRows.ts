import {
  ERRORS,
  maskNationalId,
  memberInputSchema,
  toWesternDigits,
  type ImportRowResult,
  type ReferenceItemDto,
} from '@nuzli/shared';
import { t } from '../../i18n';

/** Column keys of an import row (docs/API.md → POST /members/import). */
export const IMPORT_KEYS = ['fullName', 'nationalId', 'jobTitle', 'department'] as const;
export type ImportKey = (typeof IMPORT_KEYS)[number];
export type ImportRow = Partial<Record<ImportKey, string>>;

const HEADER_SYNONYMS: Record<ImportKey, string[]> = {
  fullName: ['الاسم', 'الاسم الكامل', 'اسم العضو', 'name', 'full name', 'fullname'],
  nationalId: [
    'رقم الهوية',
    'الهوية',
    'رقم الإقامة',
    'الإقامة',
    'الهوية/الإقامة',
    'رقم الهوية أو الإقامة',
    'national id',
    'nationalid',
    'id',
  ],
  jobTitle: ['المسمى', 'المسمى الوظيفي', 'الوظيفة', 'job title', 'jobtitle', 'title'],
  department: ['القسم', 'الإدارة', 'department', 'dept'],
};

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Maps a header row to column keys, or null when the row is data, not headers. */
export function headerMap(cells: string[]): (ImportKey | null)[] | null {
  const map = cells.map((c) => {
    const n = norm(c);
    return (IMPORT_KEYS.find((k) => HEADER_SYNONYMS[k].some((s) => norm(s) === n)) ??
      null) as ImportKey | null;
  });
  return map.some((k) => k === 'fullName' || k === 'nationalId') ? map : null;
}

function toRow(cells: string[], map: (ImportKey | null)[] | null): ImportRow {
  const row: ImportRow = {};
  const keys = map ?? IMPORT_KEYS;
  keys.forEach((key, i) => {
    if (!key) return;
    const v = (cells[i] ?? '').trim();
    if (v) row[key] = v;
  });
  return row;
}

const isEmptyRow = (r: ImportRow) => !Object.values(r).some((v) => v && v.trim());

/**
 * Rows pasted from a spreadsheet or typed: one per line, columns separated by tab, comma or
 * the Arabic comma, in the order name · national ID · job title · department. A header line
 * (e.g. «الاسم، رقم الهوية») is recognised and used for the column order.
 */
export function parsePastedRows(text: string): ImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const split = (line: string) => (line.includes('\t') ? line.split('\t') : line.split(/[,،]/));
  const first = split(lines[0]!);
  const map = headerMap(first);
  const body = map ? lines.slice(1) : lines;
  return body.map((l) => toRow(split(l), map)).filter((r) => !isEmptyRow(r));
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.text === 'string') return v.text;
  }
  return String(value);
}

/** Reads the first worksheet of an .xlsx file in the browser (exceljs, loaded on demand). */
export async function parseXlsx(file: Blob): Promise<ImportRow[]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    // exceljs rows are 1-based: index 0 is empty.
    grid.push(values.slice(1).map((v) => cellText(v).trim()));
  });
  if (!grid.length) return [];
  const map = headerMap(grid[0]!);
  const body = map ? grid.slice(1) : grid;
  return body.map((cells) => toRow(cells, map)).filter((r) => !isEmptyRow(r));
}

export interface ImportValidationContext {
  /** True when a national ID already belongs to a member in the system. */
  isTaken?: (nationalId: string) => boolean;
  jobTitles?: ReferenceItemDto[];
  departments?: ReferenceItemDto[];
}

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

/**
 * Per-row validation shared by the in-browser preview and the demo adapter: the shared
 * member schema, duplicates inside the file, IDs already registered, and matching the job
 * title / department text to the admin-managed lists (unmatched text is kept as free text).
 */
export function validateImportRows(
  rows: Record<string, unknown>[],
  ctx: ImportValidationContext = {},
): ImportRowResult[] {
  const seen = new Map<string, number>();
  const active = (items?: ReferenceItemDto[]) => (items ?? []).filter((i) => i.isActive !== false);
  return rows.map((raw, index) => {
    const row = index + 1;
    const fullName = text(raw.fullName);
    const nationalIdRaw = text(raw.nationalId);
    const jobTitle = text(raw.jobTitle);
    const department = text(raw.department);
    const errors: string[] = [];
    const parsed = memberInputSchema.safeParse({ fullName, nationalId: nationalIdRaw });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const msg =
          issue.path[0] === 'nationalId' && !nationalIdRaw
            ? t('import.error.nationalIdMissing')
            : issue.path[0] === 'fullName' && !fullName
              ? t('import.error.nameMissing')
              : issue.message;
        if (!errors.includes(msg)) errors.push(msg);
      }
    }
    const nationalId = toWesternDigits(nationalIdRaw).replace(/\s+/g, '');
    if (nationalId) {
      const firstRow = seen.get(nationalId);
      if (firstRow !== undefined) errors.push(t('import.error.duplicateInFile', { row: firstRow }));
      else seen.set(nationalId, row);
      if (parsed.success && ctx.isTaken?.(nationalId)) errors.push(ERRORS.NATIONAL_ID_TAKEN);
    }
    if (jobTitle.length > 80 || department.length > 80) errors.push(t('import.error.tooLong'));
    const jobMatch = jobTitle
      ? active(ctx.jobTitles).find((j) => norm(j.name) === norm(jobTitle))
      : undefined;
    const depMatch = department
      ? active(ctx.departments).find((d) => norm(d.name) === norm(department))
      : undefined;
    return {
      row,
      ok: errors.length === 0,
      errors,
      value: {
        fullName,
        nationalIdMasked: nationalId ? maskNationalId(nationalId) : '',
        ...(jobTitle ? { jobTitle: jobMatch?.name ?? jobTitle, jobTitleMatched: !!jobMatch } : {}),
        ...(department
          ? { department: depMatch?.name ?? department, departmentMatched: !!depMatch }
          : {}),
      },
    };
  });
}

/** The member input for a valid import row, linking list entries when the text matched. */
export function toMemberInput(
  raw: Record<string, unknown>,
  ctx: Pick<ImportValidationContext, 'jobTitles' | 'departments'>,
) {
  const jobTitle = text(raw.jobTitle);
  const department = text(raw.department);
  const job = jobTitle
    ? (ctx.jobTitles ?? []).find((j) => j.isActive !== false && norm(j.name) === norm(jobTitle))
    : undefined;
  const dep = department
    ? (ctx.departments ?? []).find((d) => d.isActive !== false && norm(d.name) === norm(department))
    : undefined;
  return {
    fullName: text(raw.fullName),
    nationalId: toWesternDigits(text(raw.nationalId)).replace(/\s+/g, ''),
    ...(job ? { jobTitleId: job.id } : jobTitle ? { jobTitleText: jobTitle } : {}),
    ...(dep ? { departmentId: dep.id } : department ? { departmentText: department } : {}),
  };
}
