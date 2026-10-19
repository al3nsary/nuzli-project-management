import type { DurationUnit, TaskType } from './types';

/** What {@link weightedProgress} reads from a task. */
export interface ProgressItem {
  readonly type: TaskType;
  readonly durationDays: number;
  /** HOUR projects: working hours (the weight there, read to the minute). */
  readonly durationHours?: number | undefined;
  readonly progress: number;
  /** True for a GROUP with no live child (calculations audit H2): it weighs 0. */
  readonly isEmptyGroup?: boolean | undefined;
}

/**
 * The weight of a task in a duration-weighted progress average (the engine's `rollUp` rule):
 * milestones and empty groups weigh 0; HOUR projects weigh by working minutes
 * (`durationHours × 60`), DAY projects by working days (`durationDays`).
 */
export function progressWeight(t: ProgressItem, unit: DurationUnit = 'DAY'): number {
  if (t.type === 'MILESTONE' || t.isEmptyGroup) return 0;
  if (unit === 'HOUR') {
    const h = t.durationHours;
    return h != null && Number.isFinite(h) ? Math.max(0, Math.round(h * 60)) : 0;
  }
  return Math.max(0, Math.trunc(t.durationDays) || 0);
}

/**
 * Duration-weighted average progress, rounded to 2 decimals (like `rollUp`): the plain average
 * when every weight is 0, and 0 for an empty list. Used for project progress (its root tasks),
 * a person's progress (their leaves) and anywhere else a set of tasks is summarised.
 */
export function weightedProgress(items: ReadonlyArray<ProgressItem>, unit: DurationUnit = 'DAY'): number {
  if (!items.length) return 0;
  let weighted = 0;
  let weights = 0;
  let plain = 0;
  for (const t of items) {
    const w = progressWeight(t, unit);
    weighted += w * t.progress;
    weights += w;
    plain += t.progress;
  }
  const value = weights > 0 ? weighted / weights : plain / items.length;
  return Math.round(value * 100) / 100;
}

/**
 * Rounds half away from zero (symmetric): 0.5 → 1 and −0.5 → −1, so a lag of +4 h and one of
 * −4 h on an 8-hour day become +1 d and −1 d (`Math.round(-0.5)` is −0). Never returns −0.
 */
export function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r;
}
