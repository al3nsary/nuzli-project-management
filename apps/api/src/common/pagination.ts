import type { Paginated } from '@nuzli/shared';

export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { items, total, page, pageSize };
}

export type SortOrder = 'asc' | 'desc';

/**
 * Calculations audit L5: offset pagination needs a total order, else rows with equal sort keys
 * can repeat or vanish between pages. Appends `{ id: 'asc' }` as the last key.
 */
export function withIdTiebreak<O extends object>(order: O | O[]): Array<O | { id: SortOrder }> {
  return [...(Array.isArray(order) ? order : [order]), { id: 'asc' as const }];
}

/** `field:asc` → `{ field: 'asc' }` when the field is in the allow-list, else the fallback. */
export function parseSort<F extends string>(
  sort: string | undefined,
  allowed: readonly F[],
  fallback: { [K in F]?: SortOrder },
): { [K in F]?: SortOrder } {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':');
  if (!field || (dir !== 'asc' && dir !== 'desc')) return fallback;
  if (!(allowed as readonly string[]).includes(field)) return fallback;
  return { [field]: dir } as { [K in F]?: SortOrder };
}
