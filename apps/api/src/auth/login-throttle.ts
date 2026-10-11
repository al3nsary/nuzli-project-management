import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppError } from '../common/app-error';

/**
 * Progressive delay for password checks (security review M5, L8; ADR-062).
 *
 * Every failed password check counts against several buckets at once:
 *  - `ip`         the client address: up to 15 minutes between attempts after many failures,
 *                 so one source cannot spray guesses across accounts;
 *  - `ident`      the identifier typed (e-mail / mobile / user id), existing or not, so the
 *                 answer is the same for unknown accounts (no enumeration). Capped at 60 s, so
 *                 attackers spread over many IPs can slow an admin down but never lock them out;
 *  - `ident+ip`   the pair, which grows to 15 minutes for one source hammering one account.
 *
 * While a bucket is cooling down the request is refused with 429 RATE_LIMITED before the
 * password is even checked. Buckets forget their failures after `windowMs` without failures.
 * In-memory: the API runs as a single instance (ADR-062); a second replica would need Redis.
 */
export interface BucketPolicy {
  /** Failures allowed before any delay. */
  free: number;
  /** First delay; doubles with every further failure. */
  baseMs: number;
  maxMs: number;
}

export const THROTTLE_POLICIES = {
  ip: { free: 20, baseMs: 1_000, maxMs: 15 * 60_000 },
  ident: { free: 5, baseMs: 1_000, maxMs: 60_000 },
  pair: { free: 3, baseMs: 1_000, maxMs: 15 * 60_000 },
} as const satisfies Record<string, BucketPolicy>;

export type BucketKind = keyof typeof THROTTLE_POLICIES;

interface Bucket {
  kind: BucketKind;
  failures: number;
  lastFailureAt: number;
  nextAllowedAt: number;
}

const WINDOW_MS = 30 * 60_000;
const MAX_BUCKETS = 50_000;

/** Identifiers are hashed in memory too: no e-mail or mobile number sits in a heap dump. */
function hashed(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('base64url').slice(0, 22);
}

export function throttleKeys(identifier: string, ip: string | null): Array<{ kind: BucketKind; key: string }> {
  const id = hashed(identifier);
  const addr = ip ?? 'unknown';
  return [
    { kind: 'ip', key: `ip:${addr}` },
    { kind: 'ident', key: `id:${id}` },
    { kind: 'pair', key: `pair:${id}:${addr}` },
  ];
}

export function delayAfter(policy: BucketPolicy, failures: number): number {
  if (failures <= policy.free) return 0;
  const exp = Math.min(failures - policy.free - 1, 30);
  return Math.min(policy.baseMs * 2 ** exp, policy.maxMs);
}

@Injectable()
export class LoginThrottleService {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Throws 429 RATE_LIMITED (with `retryAfterSeconds`) while any bucket is cooling down. */
  assertAllowed(identifier: string, ip: string | null): void {
    const now = this.clock();
    let wait = 0;
    for (const { key } of throttleKeys(identifier, ip)) {
      const b = this.fresh(key, now);
      if (b && b.nextAllowedAt > now) wait = Math.max(wait, b.nextAllowedAt - now);
    }
    if (wait > 0) throw new AppError('RATE_LIMITED', { retryAfterSeconds: Math.ceil(wait / 1000) });
  }

  recordFailure(identifier: string, ip: string | null): void {
    const now = this.clock();
    if (this.buckets.size > MAX_BUCKETS) this.prune(now);
    for (const { kind, key } of throttleKeys(identifier, ip)) {
      const b = this.fresh(key, now) ?? { kind, failures: 0, lastFailureAt: now, nextAllowedAt: 0 };
      b.failures += 1;
      b.lastFailureAt = now;
      b.nextAllowedAt = now + delayAfter(THROTTLE_POLICIES[kind], b.failures);
      this.buckets.set(key, b);
    }
  }

  /**
   * A correct password clears the account's buckets. The IP bucket is left to expire on its
   * own, so logging into one's own account does not reset a password spray from that address.
   */
  recordSuccess(identifier: string, ip: string | null): void {
    for (const { kind, key } of throttleKeys(identifier, ip)) if (kind !== 'ip') this.buckets.delete(key);
  }

  /** After a successful password reset: forget the identifier's own and per-IP buckets. */
  clearIdentifier(identifier: string): void {
    const id = hashed(identifier);
    this.buckets.delete(`id:${id}`);
    for (const key of this.buckets.keys()) if (key.startsWith(`pair:${id}:`)) this.buckets.delete(key);
  }

  private fresh(key: string, now: number): Bucket | undefined {
    const b = this.buckets.get(key);
    if (b && now - b.lastFailureAt > WINDOW_MS && b.nextAllowedAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return b;
  }

  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (now - b.lastFailureAt > WINDOW_MS && b.nextAllowedAt <= now) this.buckets.delete(key);
    }
  }
}
