import { create } from 'zustand';
import type { ViolationFilter } from '@nuzli/shared';
import { DAY_MS, riyadhDate } from './time';

/** The last 30 Riyadh days. */
export function defaultViolationFilter(now = Date.now()): ViolationFilter {
  return { from: riyadhDate(now - 29 * DAY_MS), to: riyadhDate(now) };
}

/**
 * One filter for the list and the dashboard (brief §7.5: every chart responds to the same
 * filters). Kept in memory, not in the URL (no personal data in URLs, brief §13).
 */
interface FilterState {
  filter: ViolationFilter;
  set(patch: Partial<ViolationFilter>): void;
  reset(): void;
}

export const useViolationFilters = create<FilterState>((set) => ({
  filter: defaultViolationFilter(),
  set: (patch) =>
    set((s) => {
      const next = { ...s.filter, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '' || next[k] === null) delete next[k];
      return { filter: next as ViolationFilter };
    }),
  reset: () => set({ filter: defaultViolationFilter() }),
}));

/** How many filters differ from "everything in the last 30 days". */
export function activeFilterCount(f: ViolationFilter): number {
  const keys: (keyof ViolationFilter)[] = ['teamId', 'memberId', 'recordedBy', 'typeId', 'status', 'severity', 'bbox', 'assigned'];
  return keys.filter((k) => f[k]).length;
}
