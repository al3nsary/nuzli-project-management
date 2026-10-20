/**
 * Owner recovery (security review A12 H1, ADR-163) — the ONLY way to make an account an owner
 * outside the app once the system has an owner. `BOOTSTRAP_OWNER_*` acts on first boot only, so a
 * lost owner (every owner removed or locked out, a forgotten password) is restored by an operator
 * WITH SERVER ACCESS, never by restarting the server:
 *
 *   docker compose exec api npm run owner:recover -- --username mmansary
 *   docker compose exec api npm run owner:recover -- --username mmansary --reset-password
 *   docker compose exec api npm run owner:recover -- --username mmansary --dry-run
 *
 * - The account must exist and have been approved (ACTIVE or SUSPENDED); it becomes OWNER. A
 *   suspended account is reactivated (the owner was locked out); a login lock is lifted.
 * - `--reset-password` sets a random temporary password, printed ONCE here (only its argon2id
 *   hash is stored), forces a change at the next sign-in and ends every session of the account.
 * - Audited as an account-level entry (`owner.recovered`, workspace NULL, no actor: the CLI).
 *
 * It connects with DATABASE_URL — inside the container that is the migrator role (the API itself
 * runs as nuzli_app). Logs carry the username only: never a password hash, an e-mail or an ID.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createScopedClient } from '../prisma/prisma.service';
import { runWithoutWorkspace } from '../prisma/workspace-context';
import { temporaryPassword } from '../seed/seed';

export const OWNER_RECOVERED = 'owner.recovered';

export interface RecoverOwnerOptions {
  username: string;
  resetPassword?: boolean;
  dryRun?: boolean;
}

export interface RecoverOwnerResult {
  userId: string;
  username: string;
  promoted: boolean;
  reactivated: boolean;
  /** Present only with `resetPassword` (and not a dry run): shown once by the CLI. */
  temporaryPassword?: string;
}

/** Restores `username` as an OWNER (see the header). Throws with an operator message when it cannot. */
export async function recoverOwner(raw: PrismaClient, opts: RecoverOwnerOptions, log: (m: string) => void = () => undefined): Promise<RecoverOwnerResult> {
  const username = opts.username.trim().toLowerCase();
  if (!username) throw new Error('[owner:recover] --username is required');
  const prisma = (raw as unknown as { $base?: unknown }).$base ? raw : createScopedClient(raw);
  return runWithoutWorkspace(async () => {
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true, status: true, accountRole: true } });
    if (!user) throw new Error(`[owner:recover] no account with the username "${username}"`);
    if (user.status !== 'ACTIVE' && user.status !== 'SUSPENDED') {
      throw new Error(`[owner:recover] "${username}" is ${user.status}: only an approved account (ACTIVE or SUSPENDED) can be made an owner`);
    }
    const promoted = user.accountRole !== 'OWNER';
    const reactivated = user.status === 'SUSPENDED';
    const generated = opts.resetPassword ? temporaryPassword() : undefined;
    if (opts.dryRun) {
      log(`[owner:recover] dry run: "${username}" would ${promoted ? 'become an OWNER' : 'stay an OWNER'}${reactivated ? ', be reactivated' : ''}${generated ? ', get a new temporary password' : ''}. Nothing was written.`);
      return { userId: user.id, username: user.username, promoted, reactivated };
    }
    const passwordHash = generated ? await argon2.hash(generated, { type: argon2.argon2id }) : undefined;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          accountRole: 'OWNER',
          status: 'ACTIVE',
          suspendedGlobally: false,
          failedLoginCount: 0,
          lockedUntil: null,
          ...(passwordHash ? { passwordHash, mustChangePassword: true } : {}),
        },
      });
      if (passwordHash) {
        await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.actionToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      }
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: OWNER_RECOVERED,
          entityType: 'user',
          entityId: user.id,
          before: { accountRole: user.accountRole, status: user.status },
          after: { accountRole: 'OWNER', status: 'ACTIVE', source: 'cli:owner:recover', passwordReset: !!passwordHash },
        },
      });
    });
    log(`[owner:recover] "${username}" is an OWNER${reactivated ? ' (reactivated)' : ''}${promoted ? '' : ' (already was)'}.`);
    return { userId: user.id, username: user.username, promoted, reactivated, ...(generated ? { temporaryPassword: generated } : {}) };
  }, 'maintenance:owner-recover');
}

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const username = argValue('username');
  if (!username) throw new Error('usage: npm run owner:recover -- --username <name> [--reset-password] [--dry-run]');
  const raw = new PrismaClient();
  try {
    const r = await recoverOwner(
      raw,
      { username, resetPassword: process.argv.includes('--reset-password'), dryRun: process.argv.includes('--dry-run') },
      (m) => console.log(m),
    );
    if (r.temporaryPassword) {
      // Shown ONCE. Never stored in clear, never written to a log file by this script.
      console.log(`[owner:recover] Temporary password (shown once — change it at the next sign-in): ${r.temporaryPassword}`);
    }
  } finally {
    await raw.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
