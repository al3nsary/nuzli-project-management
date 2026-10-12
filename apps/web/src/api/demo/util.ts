import { isFullNationalIdTerm, type ErrorCode, type Paginated } from '@nuzli/shared';
import { t } from '../../i18n';
import type { z } from 'zod';
import { ApiError } from '../errors';

/** HTTP status per error code, matching the real API (docs/API.md). */
const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  REJECTION_REASON_REQUIRED: 400,
  TOKEN_INVALID: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_PENDING: 403,
  ACCOUNT_REJECTED: 403,
  ACCOUNT_SUSPENDED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  MOBILE_TAKEN: 409,
  NATIONAL_ID_TAKEN: 409,
  LAST_ADMIN: 409,
  NOT_PENDING: 409,
  // Phase 2
  COLOR_TAKEN: 409,
  COLOR_INACTIVE: 409,
  COLOR_EXISTS: 409,
  NOT_A_SUPERVISOR: 400,
  MEMBER_ALREADY_IN_TEAM: 409,
  TEAM_NOT_ACTIVE: 409,
  MULTIPLE_TEAMS_DISABLED: 409,
  NOT_PENDING_TEAM: 409,
  TEAM_ARCHIVED: 409,
  NAME_TAKEN: 409,
  BUILTIN_LOCKED: 409,
  IN_USE: 409,
  LOGO_FILE_INVALID: 400,
  FILE_TYPE_NOT_ALLOWED: 400,
  FILE_TOO_LARGE: 413,
  PDF_NOT_CONFIGURED: 501,
  // Security changes (2026-10 review)
  RATE_LIMITED: 429,
  NATIONAL_ID_NOT_ACCEPTED: 400,
  // Phase 4
  CONFLICT_VERSION: 409,
  DEPENDENCY_CYCLE: 409,
  DEPENDENCY_SELF: 400,
  DEPENDENCY_EXISTS: 409,
  DEPENDENCY_TYPE_DISABLED: 400,
  TASK_PARENT_INVALID: 400,
  PROJECT_ARCHIVED: 409,
  CALENDAR_DATE_EXISTS: 409,
  ASSIGNEE_NOT_SUPERVISOR: 400,
};

export function fail(code: ErrorCode, details?: unknown): never {
  throw ApiError.of(code, STATUS[code] ?? 400, details);
}

export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    fail('VALIDATION_FAILED', { fieldErrors: r.error.flatten().fieldErrors });
  }
  return r.data;
}

export function newId() {
  return crypto.randomUUID();
}

export function paginate<T>(rows: T[], page = 1, pageSize = 25): Paginated<T> {
  const p = Math.max(1, Math.floor(page));
  const size = Math.min(200, Math.max(1, Math.floor(pageSize)));
  return {
    items: rows.slice((p - 1) * size, p * size),
    total: rows.length,
    page: p,
    pageSize: size,
  };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Demo-only hashing. The real API uses argon2id; this only avoids keeping plain text in IndexedDB. */
export function hashPassword(password: string) {
  return sha256(`nuzli-demo:${password}`);
}

/** Case- and space-insensitive comparison for names typed by people (reference lists, import). */
export function sameName(a: string, b: string) {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * ADR-067: `GET /members`, `/users` and `/users/supervisors` answer 400 when `q` holds a full
 * national ID — it must travel in a POST body (`…/search`), never in a URL.
 */
export function rejectFullIdInUrl(q: string | undefined, useInstead: string): void {
  if (isFullNationalIdTerm(q)) {
    fail('VALIDATION_FAILED', { fieldErrors: { q: [t('error.fullIdInUrl')] }, useInstead });
  }
}
