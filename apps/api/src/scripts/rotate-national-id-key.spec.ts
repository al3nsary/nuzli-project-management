import { randomBytes } from 'node:crypto';
import { CryptoService } from '../crypto/crypto.service';
import { rotateRow, rotateTable } from './rotate-national-id-key';

const k = () => randomBytes(32).toString('base64');
const v1 = `v1:${k()}`;
const v2 = `v2:${k()}`;
const hmacOld = k();
const hmacNew = k();
const NID = '1000000023';

const before = new CryptoService({ encKey: v1, hmacKey: hmacOld });
const row = (id: string) => ({ id, nationalIdEnc: before.encrypt(NID), nationalIdHash: before.blindIndex(NID) });

describe('national-ID key rotation script (ADR-070)', () => {
  it('re-encrypts with the new key version and re-hashes with the new HMAC key', () => {
    const after = new CryptoService({ encKey: v2, oldEncKeys: [v1], hmacKey: hmacNew });
    const update = rotateRow(after, row('a'))!;
    expect(after.versionOf(update.nationalIdEnc!)).toBe('v2');
    expect(after.decrypt(update.nationalIdEnc!)).toBe(NID);
    expect(update.nationalIdHash).toBe(after.blindIndex(NID));
  });

  it('only re-encrypts when the HMAC key stays the same, and skips rows already current', () => {
    const after = new CryptoService({ encKey: v2, oldEncKeys: [v1], hmacKey: hmacOld });
    const update = rotateRow(after, row('a'))!;
    expect(update.nationalIdEnc).toBeDefined();
    expect(update.nationalIdHash).toBeUndefined();
    expect(rotateRow(after, { id: 'b', nationalIdEnc: update.nationalIdEnc!, nationalIdHash: after.blindIndex(NID) })).toBeNull();
  });

  it('walks the table in batches, writes each batch in a transaction, and a dry run writes nothing', async () => {
    const after = new CryptoService({ encKey: v2, oldEncKeys: [v1], hmacKey: hmacNew });
    const rows = ['a', 'b', 'c'].map(row);
    const findMany = jest.fn(({ cursor }: { cursor?: { id: string } }) => {
      const start = cursor ? rows.findIndex((r) => r.id === cursor.id) + 1 : 0;
      return Promise.resolve(rows.slice(start, start + 2));
    });
    const update = jest.fn((args: unknown) => args);
    const prisma = { user: { findMany, update }, $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)) };
    const logs: string[] = [];
    const stats = await rotateTable(prisma as never, after, 'user', { batchSize: 2, dryRun: false, log: (m) => logs.push(m) });
    expect(stats).toEqual({ scanned: 3, reencrypted: 3, rehashed: 3 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).not.toContain(NID);

    const dry = { user: { findMany, update: jest.fn() }, $transaction: jest.fn() };
    await rotateTable(dry as never, after, 'user', { batchSize: 2, dryRun: true, log: () => undefined });
    expect(dry.$transaction).not.toHaveBeenCalled();
  });
});
