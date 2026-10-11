/**
 * National-ID key rotation (ADR-011, ADR-070; runbook: docs/backup-restore.md).
 *
 * Re-encrypts every `national_id_enc` with the CURRENT key (NATIONAL_ID_ENC_KEY, e.g. `v2:…`)
 * and recomputes every `national_id_hash` with the CURRENT HMAC key (NATIONAL_ID_HMAC_KEY), in
 * batches, for `users` and `team_members`. Older encryption keys must be listed in
 * NATIONAL_ID_ENC_KEYS_OLD so existing ciphertexts can be read. Idempotent: rows already on
 * the current key version with a current hash are skipped, so an interrupted run can simply be
 * started again.
 *
 *   node dist/scripts/rotate-national-id-key.js --dry-run
 *   node dist/scripts/rotate-national-id-key.js [--batch-size=500]
 *
 * Stop the API first when the HMAC key changes (lookups and uniqueness use the hash). Logs
 * carry counts only — never an ID, a hash or a row id.
 */
import { PrismaClient } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';

export interface RotationRow {
  id: string;
  nationalIdEnc: Uint8Array;
  nationalIdHash: string;
}

export interface RotationUpdate {
  id: string;
  nationalIdEnc?: Buffer;
  nationalIdHash?: string;
}

/** What has to change for one row, or null when it is already current. */
export function rotateRow(crypto: CryptoService, row: RotationRow): RotationUpdate | null {
  const plain = crypto.decrypt(row.nationalIdEnc);
  const update: RotationUpdate = { id: row.id };
  if (crypto.versionOf(row.nationalIdEnc) !== crypto.keyVersion) update.nationalIdEnc = crypto.encrypt(plain);
  const hash = crypto.blindIndex(plain);
  if (hash !== row.nationalIdHash) update.nationalIdHash = hash;
  return update.nationalIdEnc || update.nationalIdHash ? update : null;
}

export interface RotationStats {
  scanned: number;
  reencrypted: number;
  rehashed: number;
}

type Table = 'user' | 'teamMember';

/** Walks one table by id in batches; each batch is written in one transaction. */
export async function rotateTable(
  prisma: PrismaClient,
  crypto: CryptoService,
  table: Table,
  opts: { batchSize: number; dryRun: boolean; log: (m: string) => void },
): Promise<RotationStats> {
  const stats: RotationStats = { scanned: 0, reencrypted: 0, rehashed: 0 };
  const delegate = prisma[table] as unknown as {
    findMany(args: unknown): Promise<RotationRow[]>;
  };
  let cursor: string | undefined;
  for (;;) {
    const rows = await delegate.findMany({
      select: { id: true, nationalIdEnc: true, nationalIdHash: true },
      orderBy: { id: 'asc' },
      take: opts.batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    const updates = rows.map((r) => rotateRow(crypto, r)).filter((u): u is RotationUpdate => !!u);
    stats.scanned += rows.length;
    stats.reencrypted += updates.filter((u) => u.nationalIdEnc).length;
    stats.rehashed += updates.filter((u) => u.nationalIdHash).length;
    if (!opts.dryRun && updates.length) {
      await prisma.$transaction(
        updates.map((u) =>
          (prisma[table] as unknown as { update(args: unknown): Prisma$Promise }).update({
            where: { id: u.id },
            data: {
              ...(u.nationalIdEnc ? { nationalIdEnc: u.nationalIdEnc } : {}),
              ...(u.nationalIdHash ? { nationalIdHash: u.nationalIdHash } : {}),
            },
          }),
        ),
      );
    }
    opts.log(`[rotate] ${table}: ${stats.scanned} scanned, ${stats.reencrypted} re-encrypted, ${stats.rehashed} re-hashed`);
    if (rows.length < opts.batchSize) break;
  }
  return stats;
}

type Prisma$Promise = ReturnType<PrismaClient['user']['update']>;

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const env = process.env;
  if (!env.NATIONAL_ID_ENC_KEY || !env.NATIONAL_ID_HMAC_KEY) {
    throw new Error('[rotate] NATIONAL_ID_ENC_KEY and NATIONAL_ID_HMAC_KEY are required (the NEW keys).');
  }
  const crypto = new CryptoService({
    encKey: env.NATIONAL_ID_ENC_KEY,
    oldEncKeys: (env.NATIONAL_ID_ENC_KEYS_OLD ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    hmacKey: env.NATIONAL_ID_HMAC_KEY,
  });
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Math.min(Math.max(Number(argValue('batch-size') ?? 500) || 500, 1), 5000);
  const log = (m: string) => console.log(m);
  log(`[rotate] target key version ${crypto.keyVersion}${dryRun ? ' (dry run: nothing is written)' : ''}`);
  const prisma = new PrismaClient();
  try {
    for (const table of ['user', 'teamMember'] as const) {
      const s = await rotateTable(prisma, crypto, table, { batchSize, dryRun, log });
      log(`[rotate] ${table} done — ${s.scanned} rows, ${s.reencrypted} re-encrypted, ${s.rehashed} re-hashed`);
    }
  } finally {
    await prisma.$disconnect();
  }
  log('[rotate] finished. Remove retired keys from NATIONAL_ID_ENC_KEYS_OLD only after a fresh backup.');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Never print row data: only the message.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
