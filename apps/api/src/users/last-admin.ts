import type { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';

/**
 * Locks every ACTIVE admin row for the rest of the transaction (ADR-009) and returns their ids.
 * Two admins demoting each other at the same moment serialise on these locks.
 */
export async function lockActiveAdmins(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE role = 'ADMIN'::"Role" AND status = 'ACTIVE'::"UserStatus"
    ORDER BY id
    FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** Throws LAST_ADMIN when removing `targetId` would leave no active admin. */
export function assertNotLastAdmin(activeAdminIds: readonly string[], targetId: string): void {
  if (activeAdminIds.includes(targetId) && activeAdminIds.length <= 1) {
    throw new AppError('LAST_ADMIN');
  }
}

/** Would this change take the user out of the "active admin" set? */
export function removesActiveAdmin(
  before: { role: string; status: string },
  after: { role: string; status: string },
): boolean {
  const wasActiveAdmin = before.role === 'ADMIN' && before.status === 'ACTIVE';
  const staysActiveAdmin = after.role === 'ADMIN' && after.status === 'ACTIVE';
  return wasActiveAdmin && !staysActiveAdmin;
}

/** Locks, counts, and blocks the change if it would remove the last active admin. */
export async function guardLastAdmin(
  tx: Prisma.TransactionClient,
  targetId: string,
  before: { role: string; status: string },
  after: { role: string; status: string },
): Promise<void> {
  if (!removesActiveAdmin(before, after)) return;
  assertNotLastAdmin(await lockActiveAdmins(tx), targetId);
}
