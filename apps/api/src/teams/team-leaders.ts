import type { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';

type Tx = Prisma.TransactionClient;

/**
 * Several supervisors per team (owner request A9, ADR-100).
 *
 * `team_supervisors` holds one row per (team, user, interval); "leads the team" = an open row
 * (`valid_to IS NULL`). Exactly one open row per live team is the primary, and
 * `teams.supervisor_id` mirrors it for compatibility. A primary change closes the affected rows
 * and reopens them with the new flag at the same instant (history stays a contiguous timeline);
 * a row that started at that very instant is updated in place instead (the interval CHECK
 * forbids empty rows).
 */

export interface OpenLeaderRow {
  id: string;
  userId: string;
  isPrimary: boolean;
  validFrom: Date;
}

export const OPEN_LEADER_ROW = { id: true, userId: true, isPrimary: true, validFrom: true } as const;

export function openLeaders(tx: Tx, teamId: string): Promise<OpenLeaderRow[]> {
  return tx.teamSupervisor.findMany({
    where: { teamId, validTo: null },
    select: OPEN_LEADER_ROW,
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
  });
}

/** The leader set of a new team (pure, unit-tested). */
export interface CreateLeadersInput {
  isAdmin: boolean;
  viewerId: string;
  newSupervisorId?: string | null;
  supervisorId?: string;
  supervisorIds?: string[];
  primarySupervisorId?: string;
}

export function resolveCreateLeaders(input: CreateLeadersInput): { ids: string[]; primary: string } {
  if (!input.isAdmin) return { ids: [input.viewerId], primary: input.viewerId };
  const ids = [
    ...new Set(
      [input.newSupervisorId ?? undefined, input.supervisorId, ...(input.supervisorIds ?? [])].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  if (!ids.length) {
    throw new AppError('VALIDATION_FAILED', {
      fieldErrors: { supervisorId: ['اختر مشرفًا موجودًا أو أنشئ مشرفًا جديدًا'] },
    });
  }
  const primary = input.primarySupervisorId ?? input.newSupervisorId ?? input.supervisorId ?? ids[0]!;
  if (!ids.includes(primary)) {
    throw new AppError('VALIDATION_FAILED', {
      fieldErrors: { primarySupervisorId: ['المشرف الرئيسي يجب أن يكون من المشرفين المختارين'] },
    });
  }
  return { ids, primary };
}

/** Re-flags (or closes) an open row at `t`: in place when it started at `t`, else close + reopen. */
async function reflag(
  tx: Tx,
  teamId: string,
  row: OpenLeaderRow,
  isPrimary: boolean,
  t: Date,
  meta: { actorId: string | null; reason: string | null },
): Promise<void> {
  if (row.validFrom.getTime() >= t.getTime()) {
    await tx.teamSupervisor.update({ where: { id: row.id }, data: { isPrimary } });
    return;
  }
  const closed = await tx.teamSupervisor.updateMany({ where: { id: row.id, validTo: null }, data: { validTo: t } });
  if (closed.count !== 1) throw new AppError('CONFLICT_VERSION');
  await tx.teamSupervisor.create({
    data: { teamId, userId: row.userId, isPrimary, validFrom: t, addedById: meta.actorId, reason: meta.reason },
  });
}

/** Closes an open row at `t` (a row that started at `t` is deleted: it never really existed). */
export async function closeLeaderRow(tx: Tx, row: OpenLeaderRow, t: Date): Promise<void> {
  if (row.validFrom.getTime() >= t.getTime()) {
    await tx.teamSupervisor.delete({ where: { id: row.id } });
    return;
  }
  const closed = await tx.teamSupervisor.updateMany({ where: { id: row.id, validTo: null }, data: { validTo: t } });
  if (closed.count !== 1) throw new AppError('CONFLICT_VERSION');
}

/**
 * Makes `toUserId` (who must hold an open row) the primary at `t`. The old primary keeps leading
 * as a co-supervisor unless `removeOld` (then their row is closed). Keeps teams.supervisor_id in sync.
 * Order matters for the partial unique index: the old primary is un-flagged before the new one is flagged.
 */
export async function switchPrimary(
  tx: Tx,
  teamId: string,
  rows: OpenLeaderRow[],
  toUserId: string,
  t: Date,
  meta: { actorId: string | null; reason: string | null; removeOld?: boolean },
): Promise<{ fromUserId: string | null }> {
  const target = rows.find((r) => r.userId === toUserId);
  if (!target) throw new AppError('NOT_FOUND', { field: 'userId' });
  const old = rows.find((r) => r.isPrimary) ?? null;
  if (old && old.userId === toUserId && !meta.removeOld) return { fromUserId: old.userId };
  if (old && old.id !== target.id) {
    if (meta.removeOld) await closeLeaderRow(tx, old, t);
    else await reflag(tx, teamId, old, false, t, meta);
  }
  if (!target.isPrimary) await reflag(tx, teamId, target, true, t, meta);
  await tx.team.update({ where: { id: teamId }, data: { supervisorId: toUserId } });
  return { fromUserId: old?.userId ?? null };
}
