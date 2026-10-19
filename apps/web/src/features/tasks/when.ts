import { formatDate, formatLocalTime, t } from '../../i18n';

/**
 * A task's dates as one line. DAY tasks: `YYYY-MM-DD` with an inclusive end. HOUR tasks: local
 * `YYYY-MM-DDTHH:MM` with an exclusive end, shown with their clock times.
 */
export function taskWhen(task: { startDate: string; endDate: string; type?: string }): string {
  const hours = task.startDate.length > 10 || task.endDate.length > 10;
  const sd = task.startDate.slice(0, 10);
  const ed = task.endDate.slice(0, 10);
  if (hours) {
    const from = formatLocalTime(task.startDate);
    const to = formatLocalTime(task.endDate);
    if (sd === ed) return t('a9s.when.sameDayHours', { date: formatDate(sd), from, to });
    return t('a9s.when.rangeHours', { start: formatDate(sd), from, end: formatDate(ed), to });
  }
  if (sd === ed || task.type === 'MILESTONE') return formatDate(sd);
  return t('a9s.when.range', { start: formatDate(sd), end: formatDate(ed) });
}
