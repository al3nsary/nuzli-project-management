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

/**
 * Security review A12 L1: a free username close to `requested` (`name`, `name2`, `name3`…, kept
 * within the 32-character rule). Self-registration uses it so an anonymous caller never learns
 * that a username is taken: the request is accepted either way and the approval e-mail tells the
 * applicant the username they sign in with.
 */
export async function freeUsernameLike(db: Db, requested: string): Promise<string> {
  const base = requested.trim().toLowerCase();
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? '' : String(n);
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!(await db.user.findUnique({ where: { username: candidate }, select: { id: true } }))) return candidate;
  }
  throw new AppError('USERNAME_TAKEN');
}
