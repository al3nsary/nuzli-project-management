/** Retry schedule of the sync engine (ADR-021): 2 s, 4 s, 8 s … capped at 5 minutes. */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Delay before the next attempt after `attempts` failed attempts (1-based). */
export function backoffDelay(attempts: number): number {
  if (attempts <= 0) return 0;
  const exp = BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20);
  return Math.min(exp, BACKOFF_MAX_MS);
}
