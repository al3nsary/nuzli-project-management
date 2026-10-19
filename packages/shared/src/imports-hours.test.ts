import { describe, expect, it } from 'vitest';
import {
  calendarExceptionSchema,
  calendarSchema,
  convertProjectSchema,
  createDependencySchema,
  createProjectSchema,
  createTaskSchema,
  importCommitSchema,
  importJiraSchema,
  importProjectSchema,
  IMPORT_FILE_FORMATS,
  IMPORT_FORMATS,
  cardDataSchema,
  MAX_IMPORT_BYTES,
  presignUploadSchema,
  projectExportQuerySchema,
  taskBatchSchema,
  updateProjectSchema,
  workingHoursSchema,
} from './index';

const U = '00000000-0000-4000-8000-000000000001';

describe('A9 hours — schemas (ADR-109)', () => {
  it('projects take durationUnit, working days and working hours', () => {
    const p = createProjectSchema.parse({
      name: 'مشروع',
      startDate: '2026-11-01',
      durationUnit: 'HOUR',
      workingDays: [0, 1, 2, 3, 4],
      workingHours: [
        { start: '09:00', end: '13:00' },
        { start: '14:00', end: '18:00' },
      ],
    });
    expect(p).toMatchObject({ durationUnit: 'HOUR', workingDays: [0, 1, 2, 3, 4] });
    expect(createProjectSchema.safeParse({ name: 'مشروع', startDate: '2026-11-01', workingDays: [] }).success).toBe(false);
    expect(updateProjectSchema.parse({ durationUnit: 'DAY' })).toMatchObject({ durationUnit: 'DAY' });
    expect(convertProjectSchema.safeParse({ durationUnit: 'WEEK' }).success).toBe(false);
  });

  it('working hours: HH:MM, end after start, no overlap, 24:00 allowed', () => {
    expect(workingHoursSchema.safeParse([{ start: '22:00', end: '24:00' }]).success).toBe(true);
    expect(workingHoursSchema.safeParse([{ start: '13:00', end: '09:00' }]).success).toBe(false);
    expect(workingHoursSchema.safeParse([{ start: '09:00', end: '13:00' }, { start: '12:00', end: '15:00' }]).success).toBe(false);
    expect(workingHoursSchema.safeParse([{ start: '9:00', end: '13:00' }]).success).toBe(false);
    expect(calendarSchema.parse({ name: 'تقويم', workingHours: [{ start: '08:00', end: '16:00' }] }).workingHours).toHaveLength(1);
    expect(calendarExceptionSchema.parse({ date: '2027-03-01', isWorking: true, name: 'رمضان', workingHours: [{ start: '10:00', end: '15:00' }] }).workingHours).toHaveLength(1);
  });

  it('tasks and batches accept local date-times and durationHours; dependencies lagHours', () => {
    expect(createTaskSchema.parse({ name: 'x', startDate: '2026-10-11T09:30', durationHours: 2.5 })).toMatchObject({ startDate: '2026-10-11T09:30', durationHours: 2.5 });
    expect(createTaskSchema.safeParse({ name: 'x', startDate: '2026-10-11T09:30Z' }).success).toBe(false);
    expect(taskBatchSchema.parse({ changes: [{ id: U, version: 0, startDate: '2026-10-11T14:00:00+03:00', durationHours: 1 }] }).changes[0]).toMatchObject({ durationHours: 1 });
    expect(createDependencySchema.parse({ predecessorId: U, successorId: U, lagHours: -1.5 })).toMatchObject({ lagHours: -1.5, lagDays: 0 });
  });
});

describe('A9 imports — schemas (ADR-110..112)', () => {
  it('presign: imports are xlsx/csv/xml/mpp up to 20 MB, never linked to an entity; other uploads keep 10 MB and images/PDF', () => {
    const base = { entityType: 'import' as const, sizeBytes: 1000 };
    for (const t of ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/xml', 'text/xml', 'application/vnd.ms-project']) {
      expect(presignUploadSchema.safeParse({ ...base, contentType: t }).success).toBe(true);
    }
    expect(presignUploadSchema.safeParse({ ...base, contentType: 'image/png' }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...base, contentType: 'text/csv', sizeBytes: MAX_IMPORT_BYTES }).success).toBe(true);
    expect(presignUploadSchema.safeParse({ ...base, contentType: 'text/csv', sizeBytes: MAX_IMPORT_BYTES + 1 }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...base, contentType: 'text/csv', entityId: U }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ entityType: 'task', contentType: 'text/csv', sizeBytes: 10 }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ entityType: 'task', contentType: 'image/png', sizeBytes: 11 * 1024 * 1024 }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ entityType: 'task', contentType: 'image/png', sizeBytes: 10 }).success).toBe(true);
  });

  it('import, Jira, commit and export bodies', () => {
    expect(importProjectSchema.parse({ fileId: U, format: 'xml' }).options).toEqual({ dateOrder: 'DMY' });
    expect(importProjectSchema.safeParse({ fileId: U, format: 'pdf' }).success).toBe(false);
    expect(importJiraSchema.safeParse({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'x'.repeat(24) }).success).toBe(false);
    expect(importJiraSchema.safeParse({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'x'.repeat(24), projectKey: 'OPS' }).success).toBe(true);
    expect(importJiraSchema.safeParse({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.sa', apiToken: 'x'.repeat(24), projectKey: 'ops' }).success).toBe(false);
    expect(importCommitSchema.parse({ previewId: U, assigneeMap: { أحمد: U, سعد: null } }).assigneeMap).toEqual({ أحمد: U, سعد: null });
    expect(projectExportQuerySchema.parse({}).format).toBe('xlsx');
    expect(projectExportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false);
  });
});

describe('A10 — GanttPRO import/export, foreman on cards', () => {
  it('imports accept «ganttpro» (IMPORT_FILE_FORMATS) while IMPORT_FORMATS keeps its members; exports accept «ganttpro»', () => {
    expect(IMPORT_FILE_FORMATS).toEqual([...IMPORT_FORMATS, 'ganttpro']);
    expect(importProjectSchema.parse({ fileId: U, format: 'ganttpro' }).format).toBe('ganttpro');
    expect(importProjectSchema.safeParse({ fileId: U, format: 'gantt' }).success).toBe(false);
    expect(projectExportQuerySchema.parse({ format: 'ganttpro' }).format).toBe('ganttpro');
  });

  it('card data carries the optional foreman mark', () => {
    expect(cardDataSchema.parse({ fullName: 'س', isForeman: true, roleLabel: 'مشرف عمّال' })).toMatchObject({ isForeman: true, roleLabel: 'مشرف عمّال' });
    expect(cardDataSchema.parse({ fullName: 'س' }).isForeman).toBeUndefined();
  });
});
