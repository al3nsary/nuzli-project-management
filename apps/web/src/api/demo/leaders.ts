import type { TeamSupervisorDto } from '@nuzli/shared';
import type { DemoDb, DemoTeamSupervisor, DemoUser } from './db';
import { newId } from './util';

/**
 * Team leadership in the demo (owner request A9, ADR-100) — the same rules as
 * `apps/api/src/teams/team-dto.ts`: "leads the team" = an open row in `teamSupervisors` (primary
 * or not); a live team has exactly one open primary; `teams.supervisorId` mirrors the primary.
 */

/** Open rows of every team, primary first then by start. */
export function groupOpenLeaders(rows: readonly DemoTeamSupervisor[]): Map<string, DemoTeamSupervisor[]> {
  const out = new Map<string, DemoTeamSupervisor[]>();
  for (const r of rows) {
    if (r.validTo !== null) continue;
    const list = out.get(r.teamId) ?? [];
    list.push(r);
    out.set(r.teamId, list);
  }
  for (const list of out.values()) list.sort(byPrimaryThenStart);
  return out;
}

export const byPrimaryThenStart = (a: DemoTeamSupervisor, b: DemoTeamSupervisor) =>
  Number(b.isPrimary) - Number(a.isPrimary) || a.validFrom.localeCompare(b.validFrom);

export async function openLeaders(db: DemoDb, teamId: string): Promise<DemoTeamSupervisor[]> {
  const rows = await db.teamSupervisors.where('teamId').equals(teamId).filter((r) => r.validTo === null).toArray();
  return rows.sort(byPrimaryThenStart);
}

export async function openLeaderIds(db: DemoDb, teamId: string): Promise<string[]> {
  return (await openLeaders(db, teamId)).map((r) => r.userId);
}

/** Team ids the user leads now (any open row). */
export async function teamsLedBy(db: DemoDb, userId: string): Promise<Set<string>> {
  const rows = await db.teamSupervisors.where('userId').equals(userId).filter((r) => r.validTo === null).toArray();
  return new Set(rows.map((r) => r.teamId));
}

/**
 * The supervisors of a team at an instant (ADR-014 snapshot, ADR-100): the primary and every
 * supervisor whose row covers `at` — the same intervals as `resolveTeamAt` ([from, to)).
 */
export function leadersAt(
  rows: readonly DemoTeamSupervisor[],
  teamId: string,
  at: string | Date,
): { primaryId: string | null; ids: string[] } {
  const t = new Date(at).getTime();
  const hits = rows
    .filter((r) => r.teamId === teamId)
    .filter((r) => Date.parse(r.validFrom) <= t && (r.validTo === null || t < Date.parse(r.validTo)))
    .sort(byPrimaryThenStart);
  const ids = [...new Set(hits.map((r) => r.userId))];
  return { primaryId: hits.find((r) => r.isPrimary)?.userId ?? null, ids };
}

export function supervisorDtos(rows: readonly DemoTeamSupervisor[], users: Map<string, DemoUser>): TeamSupervisorDto[] {
  return [...rows].sort(byPrimaryThenStart).map((r) => {
    const u = users.get(r.userId);
    return {
      id: r.userId,
      fullName: u?.fullName ?? '—',
      isPrimary: r.isPrimary,
      hasPhoto: Boolean(u?.photoFileId),
      since: r.validFrom,
    };
  });
}

/** Closes a row at `at`; a row that started at that very instant is removed instead (zero length). */
async function closeRow(db: DemoDb, row: DemoTeamSupervisor, at: string) {
  if (row.validFrom === at) await db.teamSupervisors.delete(row.id);
  else await db.teamSupervisors.update(row.id, { validTo: at });
}

/**
 * Makes `toUserId` (already an open row) the primary at one instant: the old primary's row is
 * closed and — unless `removeOld` — reopened as a co-supervisor; the target's row is closed and
 * reopened as primary (or re-flagged in place when it started at that instant). Mirrors
 * `switchPrimary()` in the API. Must run inside a transaction over `teamSupervisors` + `teams`.
 */
export async function switchPrimary(
  db: DemoDb,
  teamId: string,
  toUserId: string,
  at: string,
  opts: { actorId: string; reason: string | null; removeOld?: boolean },
): Promise<{ fromUserId: string | null }> {
  const rows = await openLeaders(db, teamId);
  const old = rows.find((r) => r.isPrimary) ?? null;
  const target = rows.find((r) => r.userId === toUserId);
  if (!target) throw new Error('switchPrimary: target is not a current supervisor');
  if (old && old.userId === toUserId) return { fromUserId: null };
  if (old) {
    await closeRow(db, old, at);
    if (!opts.removeOld) {
      await db.teamSupervisors.add({
        id: newId(),
        teamId,
        userId: old.userId,
        isPrimary: false,
        validFrom: at,
        validTo: null,
        addedById: opts.actorId,
        reason: opts.reason,
      });
    }
  }
  if (target.validFrom === at) {
    await db.teamSupervisors.update(target.id, { isPrimary: true });
  } else {
    await db.teamSupervisors.update(target.id, { validTo: at });
    await db.teamSupervisors.add({
      id: newId(),
      teamId,
      userId: toUserId,
      isPrimary: true,
      validFrom: at,
      validTo: null,
      addedById: opts.actorId,
      reason: opts.reason,
    });
  }
  await db.teams.update(teamId, { supervisorId: toUserId });
  return { fromUserId: old?.userId ?? null };
}

/** Archive/reject: every open row of the team ends at `at`. */
export async function closeAllLeaders(db: DemoDb, teamId: string, at: string) {
  for (const r of await openLeaders(db, teamId)) await db.teamSupervisors.update(r.id, { validTo: at });
}
