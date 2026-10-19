/**
 * Arabic messages of the import wizard (ADR-117). The API's own `message_ar` is used as is, except
 * where the wizard knows better what to say: a structure check failed on an import file (the
 * generic FILE_TYPE_NOT_ALLOWED text speaks of photos), the size limit (20 MB, not the photo
 * limit), and the two server-only paths (.mpp converter, Jira Cloud in the demo).
 */
import { ApiError, errorMessage } from '../../api/errors';
import { t, tKey, type MessageKey } from '../../i18n';

export function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'FILE_TYPE_NOT_ALLOWED') return t('import.err.structure');
    if (err.code === 'FILE_TOO_LARGE') return t('import.err.size');
    const reason = (err.details as { reason?: string } | undefined)?.reason;
    // Security review A9 (ADR-119/120): the API's limits and deadlines say what to do next.
    if (err.code === 'IMPORT_FILE_INVALID' && reason === 'xlsx-limits')
      return t('import.err.xlsxLimits');
    if (err.code === 'IMPORT_FILE_INVALID' && reason === 'xlsx-timeout')
      return t('import.err.xlsxTimeout');
    if (err.code === 'JIRA_REQUEST_FAILED' && reason === 'timeout')
      return t('import.err.jiraTimeout');
    if (
      err.code === 'JIRA_REQUEST_FAILED' &&
      (err.details as { reason?: string } | undefined)?.reason === 'demo'
    )
      return t('import.jira.demoBody');
  }
  return errorMessage(err);
}

/** A short Arabic title for the error block (what kind of problem), or null for the generic one. */
export function importErrorTitle(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  return tKey(`import.errTitle.${err.code}`, 'import.errTitle.other');
}

/** Arabic label of a warning code (the docs list them; `message_ar` carries the detail). */
export const warningLabel = (code: string): string =>
  tKey(`import.warn.${code}`, 'import.warn.other');

export const SOURCE_KEYS: Record<string, { title: MessageKey; hint: MessageKey }> = {
  ganttpro: { title: 'import.source.ganttpro', hint: 'import.source.ganttproHint' },
  xlsx: { title: 'import.source.xlsx', hint: 'import.source.xlsxHint' },
  csv: { title: 'import.source.csv', hint: 'import.source.csvHint' },
  xml: { title: 'import.source.xml', hint: 'import.source.xmlHint' },
  mpp: { title: 'import.source.mpp', hint: 'import.source.mppHint' },
  'jira-csv': { title: 'import.source.jira-csv', hint: 'import.source.jira-csvHint' },
  'jira-cloud': { title: 'import.source.jira-cloud', hint: 'import.source.jira-cloudHint' },
};
