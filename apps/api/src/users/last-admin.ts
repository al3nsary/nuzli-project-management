import type { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { activeWorkspaceId } from '../prisma/workspace-context';

/**
 * Locks every ACTIVE admin membership of the workspace for the rest of the transaction (ADR-009,
 * A12: per workspace) and returns the user ids. Two admins demoting each other at the same moment
 * serialise on these locks.
 */
export async function lockActiveAdmins(tx: Prisma.TransactionClient, workspaceId: string = activeWorkspaceId()): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT m.user_id AS id FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::uuid
      AND m.role = 'ADMIN'::"WorkspaceRole" AND m.status = 'ACTIVE'::"WorkspaceMembershipStatus"
      AND m.archived_at IS NULL AND u.status = 'ACTIVE'::"UserStatus"
    ORDER BY m.user_id
    FOR UPDATE OF m`;
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
  before: { role: string | null; status: string },
  after: { role: string | null; status: string },
): boolean {
  const wasActiveAdmin = before.role === 'ADMIN' && before.status === 'ACTIVE';
  const staysActiveAdmin = after.role === 'ADMIN' && after.status === 'ACTIVE';
  return wasActiveAdmin && !staysActiveAdmin;
}

/** Locks, counts, and blocks the change if it would remove the workspace's last active admin. */
export async function guardLastAdmin(
  tx: Prisma.TransactionClient,
  targetId: string,
  before: { role: string | null; status: string },
  after: { role: string | null; status: string },
  workspaceId?: string,
): Promise<void> {
  if (!removesActiveAdmin(before, after)) return;
  assertNotLastAdmin(await lockActiveAdmins(tx, workspaceId ?? activeWorkspaceId()), targetId);
}
