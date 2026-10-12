/** Asia/Riyadh is UTC+03:00 all year (no DST). Kept engine-free so the main bundle stays small. */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Today's calendar date in Riyadh (`YYYY-MM-DD`). */
export function riyadhToday(now: Date = new Date()): string {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}
