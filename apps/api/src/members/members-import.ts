import {
  ERRORS,
  fullName as fullNameSchema,
  maskNationalId,
  nationalId as nationalIdSchema,
  type ImportRowResult,
} from '@nuzli/shared';
import type { MemberInputData } from './member-writes';

/** Column aliases accepted in each pasted/Excel row (the client normally sends the English keys). */
const ALIASES: Record<keyof ImportColumns, string[]> = {
  fullName: ['fullname', 'name', 'الاسم', 'الاسم الكامل', 'الاسم الرباعي'],
  nationalId: ['nationalid', 'id', 'رقم الهوية', 'الهوية', 'رقم الإقامة', 'رقم الهوية/الإقامة'],
  jobTitle: ['jobtitle', 'title', 'المسمى الوظيفي', 'المسمّى الوظيفي', 'الوظيفة'],
  department: ['department', 'الإدارة', 'القسم'],
};

interface ImportColumns {
  fullName: string;
  nationalId: string;
  jobTitle: string;
  department: string;
}

const norm = (v: string) => v.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

function cell(raw: Record<string, unknown>, key: keyof ImportColumns): string {
  const wanted = ALIASES[key];
  for (const [k, v] of Object.entries(raw)) {
    if (k === key || wanted.includes(norm(k))) {
      if (v === null || v === undefined) return '';
      return String(v).trim();
    }
  }
  return '';
}

export interface ReferenceLists {
  jobTitles: ReadonlyArray<{ id: string; name: string }>;
  departments: ReadonlyArray<{ id: string; name: string }>;
}

export interface PreparedImportRow {
  row: number;
  input: MemberInputData;
}

/** National IDs that pass the shared schema, normalised (for the DB duplicate lookup). */
export function candidateNationalIds(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const raw of rows) {
    const parsed = nationalIdSchema.safeParse(cell(raw, 'nationalId'));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Validates every row with the shared `fullName` / `nationalId` schemas, flags duplicate IDs
 * inside the file and IDs already stored (`existingHashes`, blind index), and matches job title
 * and department by name to the admin lists — otherwise they are kept as free text.
 * Never returns a full national ID: results carry the masked form only (brief §13).
 */
export function validateImportRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  refs: ReferenceLists,
  opts: { hashOf: (nationalId: string) => string; existingHashes: ReadonlySet<string> },
): { results: ImportRowResult[]; valid: PreparedImportRow[] } {
  const jobs = new Map(refs.jobTitles.map((j) => [norm(j.name), j]));
  const deps = new Map(refs.departments.map((d) => [norm(d.name), d]));
  const firstRowOfHash = new Map<string, number>();
  const results: ImportRowResult[] = [];
  const valid: PreparedImportRow[] = [];

  rows.forEach((raw, index) => {
    const row = index + 1;
    const errors: string[] = [];
    const name = fullNameSchema.safeParse(cell(raw, 'fullName'));
    if (!name.success) errors.push(name.error.issues[0]?.message ?? ERRORS.VALIDATION_FAILED);
    const rawId = cell(raw, 'nationalId');
    const id = nationalIdSchema.safeParse(rawId);
    let masked = '';
    if (!rawId) {
      errors.push('رقم الهوية مطلوب');
    } else if (!id.success) {
      errors.push(id.error.issues[0]?.message ?? ERRORS.VALIDATION_FAILED);
    } else {
      masked = maskNationalId(id.data);
      const hash = opts.hashOf(id.data);
      const first = firstRowOfHash.get(hash);
      if (first !== undefined) errors.push(`رقم الهوية مكرّر في الملف (الصف ${first})`);
      else firstRowOfHash.set(hash, row);
      if (opts.existingHashes.has(hash)) errors.push(ERRORS.NATIONAL_ID_TAKEN);
    }

    const jobText = cell(raw, 'jobTitle').slice(0, 80);
    const depText = cell(raw, 'department').slice(0, 80);
    const job = jobText ? jobs.get(norm(jobText)) : undefined;
    const dep = depText ? deps.get(norm(depText)) : undefined;

    const value: NonNullable<ImportRowResult['value']> = {
      fullName: name.success ? name.data : cell(raw, 'fullName'),
      nationalIdMasked: masked,
      ...(jobText ? { jobTitle: job?.name ?? jobText, jobTitleMatched: !!job } : {}),
      ...(depText ? { department: dep?.name ?? depText, departmentMatched: !!dep } : {}),
    };
    const ok = errors.length === 0;
    results.push({ row, ok, errors, value });
    if (ok && name.success && id.success) {
      valid.push({
        row,
        input: {
          fullName: name.data,
          nationalId: id.data,
          ...(job ? { jobTitleId: job.id } : jobText ? { jobTitleText: jobText } : {}),
          ...(dep ? { departmentId: dep.id } : depText ? { departmentText: depText } : {}),
        },
      });
    }
  });
  return { results, valid };
}
