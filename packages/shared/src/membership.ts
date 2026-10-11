/**
 * Resolves which team a member belonged to at a given instant (brief §7.3).
 * Membership rows are half-open intervals [validFrom, validTo).
 */
export interface MembershipInterval {
  teamId: string;
  validFrom: string | Date;
  validTo: string | Date | null;
}

export function resolveTeamAt<T extends MembershipInterval>(
  memberships: readonly T[],
  at: string | Date,
): T | null {
  const t = new Date(at).getTime();
  let best: T | null = null;
  for (const m of memberships) {
    const from = new Date(m.validFrom).getTime();
    const to = m.validTo === null ? Number.POSITIVE_INFINITY : new Date(m.validTo).getTime();
    if (from <= t && t < to) {
      if (!best || new Date(best.validFrom).getTime() < from) best = m;
    }
  }
  return best;
}

/**
 * Clock-drift check (brief §7.3). A violation may legitimately wait offline for hours, so
 * `capturedAt` alone cannot reveal a wrong device clock. The client therefore sends
 * `clientSentAt` (its own clock at the moment of sync); the drift is that value minus the
 * server's `receivedAt`. Without it, only a capture time in the future is flagged.
 */
export function isClockDriftSuspect(input: {
  capturedAt: string | Date;
  receivedAt: string | Date;
  clientSentAt?: string | Date | null;
  thresholdMinutes: number;
}): boolean {
  const limit = input.thresholdMinutes * 60_000;
  const received = new Date(input.receivedAt).getTime();
  if (input.clientSentAt) {
    return Math.abs(new Date(input.clientSentAt).getTime() - received) > limit;
  }
  return new Date(input.capturedAt).getTime() - received > limit;
}
