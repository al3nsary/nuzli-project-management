import { maskNationalId } from '@nuzli/shared';

/** Keys never written to the audit log, whatever their value. */
const DROP_KEYS = new Set([
  'passwordHash',
  'password',
  'newPassword',
  'currentPassword',
  'nationalIdEnc',
  'nationalIdHash',
  'tokenHash',
  'token',
  'refreshToken',
  'accessToken',
]);

const NATIONAL_ID_KEY = /national_?id$/i;

/**
 * Makes a before/after snapshot safe for the audit log: secrets are dropped, national IDs
 * are masked, Buffers removed, Dates turned into ISO strings (brief §13 — never raw IDs).
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 6) return '[depth]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(key)) continue;
      if (NATIONAL_ID_KEY.test(key) && typeof v === 'string') {
        out[key] = maskNationalId(v);
        continue;
      }
      const clean = sanitizeForAudit(v, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
