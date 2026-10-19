/**
 * Small calculation rules shared by the API and the web demo (calculations audit 2026-10).
 * Scheduling rules (status ↔ progress, group status, weighted progress, HOUR edits, due day)
 * live in `@nuzli/scheduling`; these are the ones that do not belong to the engine.
 */

const ms = (v: Date | string | number): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

/**
 * L13: a violation's edit window is open strictly BEFORE `editableUntil`; at exactly
 * `editableUntil` it is closed (`now < until`). The API and the demo both use this.
 */
export function isEditWindowOpen(now: Date | string | number, editableUntil: Date | string | number): boolean {
  return ms(now) < ms(editableUntil);
}

/**
 * "This week vs previous week" change, in %, rounded to 1 decimal: this week so far compared
 * with the SAME elapsed span of the previous week (`previousWeekToDate`, from the previous
 * Sunday 00:00 Riyadh to now − 7 days). Null when the previous span had nothing (no base).
 */
export function weekChangePct(thisWeek: number, previousWeekToDate: number): number | null {
  if (!previousWeekToDate) return null;
  return Math.round(((thisWeek - previousWeekToDate) / previousWeekToDate) * 1000) / 10;
}

/** Violations per team member; null when the team had no members at the end of the period. */
export function perMemberRate(count: number, members: number): number | null {
  return members > 0 ? Math.round((count / members) * 100) / 100 : null;
}

/** Calendar days from the due day `due` (YYYY-MM-DD) to `today` — "days overdue" everywhere. */
export function calendarDaysOverdue(due: string, today: string): number {
  return Math.round((Date.parse(`${today.slice(0, 10)}T00:00:00Z`) - Date.parse(`${due.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}
