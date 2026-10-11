import type { ViolationFilter } from '@nuzli/shared';
import { toQueryString, type ViolationListQuery } from './client';

/** The filter keys the API reads (violationFilterSchema + pagination); nothing else is sent. */
const KEYS = [
  'from',
  'to',
  'teamId',
  'memberId',
  'recordedBy',
  'typeId',
  'status',
  'severity',
  'bbox',
  'q',
  'sort',
  'page',
  'pageSize',
] as const;

/** `?from=…&teamId=…` from a filter object; empty values are dropped. */
export function toViolationQueryString(q: ViolationListQuery | ViolationFilter | undefined): string {
  if (!q) return '';
  const src = q as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of KEYS) if (src[k] !== undefined) picked[k] = src[k];
  return toQueryString(picked);
}
