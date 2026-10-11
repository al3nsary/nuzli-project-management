import { resolveTeamAt } from '@nuzli/shared';
import { riyadhTimeDaysAgo } from '../../features/violations/time';
import type { DemoFile, DemoMembership, DemoSupervisorHistory, DemoViolation } from './db';
import type { ViolationSeedRow } from './seed';

/**
 * Turns the relative seed rows into violations "as if synced": capture time relative to the
 * seeding moment, team/supervisor snapshots resolved from membership history at that time
 * (ADR-014 — a member moved later keeps the old team on old violations), and placeholder
 * photo rows whose images are drawn on a canvas when first viewed.
 */
export function seedViolations(
  rows: ViolationSeedRow[],
  ctx: {
    memberships: DemoMembership[];
    supervisorHistory: DemoSupervisorHistory[];
    now: Date;
  },
): { violations: DemoViolation[]; files: DemoFile[] } {
  const violations: DemoViolation[] = [];
  const files: DemoFile[] = [];
  const latest = ctx.now.getTime() - 10 * 60_000;
  rows.forEach((r, index) => {
    let captured = riyadhTimeDaysAgo(ctx.now, r.daysAgo, r.riyadhTime).getTime();
    // "Today" rows whose wall-clock time has not come yet move to yesterday.
    if (captured > latest) captured -= 24 * 60 * 60 * 1000;
    const capturedAt = new Date(captured).toISOString();
    const receivedMs = Math.min(latest, captured + r.syncDelayMinutes * 60_000);
    const receivedAt = new Date(receivedMs).toISOString();
    const membership = resolveTeamAt(
      ctx.memberships.filter((m) => m.memberId === r.memberId),
      capturedAt,
    );
    const teamId = membership?.teamId ?? null;
    const sup = teamId
      ? resolveTeamAt(
          ctx.supervisorHistory.filter((h) => h.teamId === teamId),
          capturedAt,
        )
      : null;
    const clientSentAt = new Date(receivedMs + r.clockDriftMinutes * 60_000).toISOString();
    violations.push({
      id: r.id,
      clientUuid: r.clientUuid,
      memberId: r.memberId,
      typeId: r.typeId,
      teamIdSnapshot: teamId,
      supervisorIdSnapshot: sup?.supervisorId ?? null,
      recordedById: r.recordedById,
      description: r.description,
      notes: r.notes,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyM: r.accuracyM,
      capturedAt,
      receivedAt,
      clientSentAt,
      clockDriftSuspect: r.clockDriftMinutes > 10,
      deviceInfo: { platform: 'demo', appVersion: 'demo', online: r.syncDelayMinutes < 5 },
      expectedIdPhotos: 1,
      expectedEvidence: r.evidencePhotos,
      status: r.status,
      cancelReason: r.cancelReason,
      responses: [],
    });
    const hue = (index * 47) % 360;
    const photo = (k: number, kind: 'ID_CARD' | 'EVIDENCE'): DemoFile => ({
      id: `${r.id.slice(0, 24)}${kind === 'ID_CARD' ? 'e' : 'f'}${String(k).padStart(2, '0')}${r.id.slice(-9)}`,
      entityType: 'violation',
      entityId: r.id,
      kind,
      mimeType: 'image/jpeg',
      sizeBytes: 0,
      status: 'READY',
      createdById: r.recordedById,
      createdAt: new Date(receivedMs + k * 1000).toISOString(),
      expiresAt: receivedAt,
      violationId: r.id,
      placeholder: {
        label: kind === 'ID_CARD' ? 'نسخة العرض — ليست وثيقة حقيقية' : `مخالفة رقم ${index + 1} — صورة ${k}`,
        hue,
      },
    });
    files.push(photo(0, 'ID_CARD'));
    for (let k = 1; k <= r.evidencePhotos; k++) files.push(photo(k, 'EVIDENCE'));
  });
  return { violations, files };
}
