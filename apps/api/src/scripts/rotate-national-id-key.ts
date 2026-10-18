/**
 * National-ID key rotation (ADR-011, ADR-070; runbook: docs/backup-restore.md).
 *
 * Re-encrypts every `national_id_enc` with the CURRENT key (NATIONAL_ID_ENC_KEY, e.g. `v2:…`)
 * and recomputes every `national_id_hash` with the CURRENT HMAC key (NATIONAL_ID_HMAC_KEY), in
 * batches, for `users` and `team_members` (A9: and the encrypted OCR results in `violation_ocr`). Older encryption keys must be listed in
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

/**
 * A9 (ADR-104): the encrypted OCR results of violation ID cards (`violation_ocr.extracted_enc`,
 * JSON) and their blind index (`id_number_hash`) follow the same keys.
 */
export function rotateOcrRow(
  crypto: CryptoService,
  row: { violationId: string; extractedEnc: Uint8Array; idNumberHash: string | null },
): { violationId: string; extractedEnc?: Buffer; idNumberHash?: string | null } | null {
  const plain = crypto.decrypt(row.extractedEnc);
  const update: { violationId: string; extractedEnc?: Buffer; idNumberHash?: string | null } = { violationId: row.violationId };
  if (crypto.versionOf(row.extractedEnc) !== crypto.keyVersion) update.extractedEnc = crypto.encrypt(plain);
  const id = (JSON.parse(plain) as { fields?: { nationalId?: { value?: string } | null } }).fields?.nationalId?.value;
  const hash = id ? crypto.blindIndex(id) : null;
  if (hash !== row.idNumberHash) update.idNumberHash = hash;
  return update.extractedEnc || update.idNumberHash !== undefined ? update : null;
}

export async function rotateOcr(
  prisma: PrismaClient,
  crypto: CryptoService,
  opts: { batchSize: number; dryRun: boolean; log: (m: string) => void },
): Promise<RotationStats> {
  const stats: RotationStats = { scanned: 0, reencrypted: 0, rehashed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.violationOcr.findMany({
      where: { extractedEnc: { not: null } },
      select: { violationId: true, extractedEnc: true, idNumberHash: true },
      orderBy: { violationId: 'asc' },
      take: opts.batchSize,
      ...(cursor ? { cursor: { violationId: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.violationId;
    const updates = rows
      .map((r) => rotateOcrRow(crypto, { ...r, extractedEnc: r.extractedEnc! }))
      .filter((u): u is NonNullable<typeof u> => !!u);
    stats.scanned += rows.length;
    stats.reencrypted += updates.filter((u) => u.extractedEnc).length;
    stats.rehashed += updates.filter((u) => u.idNumberHash !== undefined).length;
    if (!opts.dryRun && updates.length) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.violationOcr.update({
            where: { violationId: u.violationId },
            data: {
              ...(u.extractedEnc ? { extractedEnc: u.extractedEnc } : {}),
              ...(u.idNumberHash !== undefined ? { idNumberHash: u.idNumberHash } : {}),
            },
          }),
        ),
      );
    }
    opts.log(`[rotate] violation_ocr: ${stats.scanned} scanned, ${stats.reencrypted} re-encrypted, ${stats.rehashed} re-hashed`);
    if (rows.length < opts.batchSize) break;
  }
  return stats;
}

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
    const o = await rotateOcr(prisma, crypto, { batchSize, dryRun, log });
    log(`[rotate] violation_ocr done — ${o.scanned} rows, ${o.reencrypted} re-encrypted, ${o.rehashed} re-hashed`);
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
