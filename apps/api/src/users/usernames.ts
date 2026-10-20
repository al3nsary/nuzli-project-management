import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../common/app-error';
import { usernameBase } from './user-dto';

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'user'>;

/**
 * A12: the username of a new account — the requested one (USERNAME_TAKEN when it exists), or one
 * generated from the e-mail local part with a numeric suffix until it is free. The unique index
 * still guards the race (P2002 → USERNAME_TAKEN).
 */
export async function allocateUsername(db: Db, email: string, requested?: string | null): Promise<string> {
  if (requested) {
    const name = requested.trim().toLowerCase();
    if (await db.user.findUnique({ where: { username: name }, select: { id: true } })) throw new AppError('USERNAME_TAKEN');
    return name;
  }
  const base = usernameBase(email);
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (!(await db.user.findUnique({ where: { username: candidate }, select: { id: true } }))) return candidate;
  }
  throw new AppError('USERNAME_TAKEN');
}
