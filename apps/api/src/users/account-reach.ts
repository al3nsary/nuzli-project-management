import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../common/app-error';

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'workspaceMembership'>;

/**
 * A12 (ADR-149) + security review M2: an account is GLOBAL — one identity, one profile photo, for
 * every workspace. Who may change it: an owner always; a workspace admin only when every live
 * membership of the person is in a workspace that admin administers (USER_IN_OTHER_WORKSPACES
 * otherwise); nobody but owners touches an owner (FORBIDDEN). Used by account edits
 * (AccountsService.assertMayEdit) and by the profile photo (PhotosService) alike.
 */
export async function assertAccountWithinReach(
  db: Db,
  target: { accountRole: string; memberships: ReadonlyArray<{ workspaceId: string }> },
  viewer: { id: string; accountRole?: string | null },
): Promise<void> {
  if (viewer.accountRole === 'OWNER') return;
  if (target.accountRole === 'OWNER') throw new AppError('FORBIDDEN');
  const adminOf = await db.workspaceMembership.findMany({
    where: { userId: viewer.id, role: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    select: { workspaceId: true },
  });
  const mine = new Set(adminOf.map((m) => m.workspaceId));
  if (target.memberships.some((m) => !mine.has(m.workspaceId))) throw new AppError('USER_IN_OTHER_WORKSPACES');
}
