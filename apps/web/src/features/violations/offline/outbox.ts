import type { ViolationFileKind } from '@nuzli/shared';
import { blobToArrayBuffer } from '../../../lib/bytes';
import type {
  OfflineDb,
  OutboxDisplay,
  OutboxFile,
  OutboxItem,
  OutboxPayload,
  OutboxPhoto,
} from './db';

export interface NewPhoto {
  kind: ViolationFileKind;
  blob: Blob;
}

/** Synced rows stay visible as «أُرسلت» for a day, then only the server list has them. */
export const SYNCED_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Saves a violation and its compressed photos to the outbox in one transaction. This is the
 * only way a violation is recorded — online or not — so a crash or a lost connection between
 * "save" and "sent" never loses it (brief §7.4).
 */
export async function enqueueViolation(
  db: OfflineDb,
  input: { userId: string; payload: OutboxPayload; display: OutboxDisplay; photos: NewPhoto[] },
  now: Date = new Date(),
): Promise<OutboxItem> {
  const id = input.payload.clientUuid;
  const order = { ID_CARD: 0, EVIDENCE: 0 } as Record<ViolationFileKind, number>;
  const files: OutboxFile[] = [];
  const photos: OutboxPhoto[] = [];
  for (const p of input.photos) {
    const n = order[p.kind]++;
    const key = `${id}:${p.kind}:${n}`;
    const data = await blobToArrayBuffer(p.blob);
    files.push({
      key,
      itemId: id,
      kind: p.kind,
      order: n,
      type: p.blob.type || 'image/jpeg',
      size: data.byteLength,
      data,
    });
    photos.push({
      key,
      kind: p.kind,
      order: n,
      type: p.blob.type || 'image/jpeg',
      size: data.byteLength,
      fileId: null,
      presigned: null,
      uploaded: false,
      confirmed: false,
    });
  }
  // The ID card goes first, then the evidence photos in the order they were taken.
  photos.sort((a, b) => (a.kind === b.kind ? a.order - b.order : a.kind === 'ID_CARD' ? -1 : 1));
  const at = now.toISOString();
  const item: OutboxItem = {
    id,
    userId: input.userId,
    createdAt: at,
    updatedAt: at,
    payload: input.payload,
    display: input.display,
    status: 'pending',
    error: null,
    errorCode: null,
    attempts: 0,
    nextAttemptAt: 0,
    violationId: null,
    photos,
    syncedAt: null,
  };
  await db.transaction('rw', db.outbox, db.outboxFiles, async () => {
    await db.outbox.put(item);
    await db.outboxFiles.bulkPut(files);
  });
  return item;
}

/** Items not yet on the server (pending, uploading or failed). */
export async function unsyncedCount(db: OfflineDb, userId?: string | null): Promise<number> {
  return db.outbox
    .filter((i) => i.status !== 'synced' && (!userId || i.userId === userId))
    .count();
}

/** «إعادة المحاولة»: back to pending, now, with a fresh backoff. */
export async function retryItem(db: OfflineDb, id: string) {
  await db.outbox.update(id, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    errorCode: null,
    updatedAt: new Date().toISOString(),
  });
}

/** Deletes a failed item and its photos from the device (after the user confirms). */
export async function deleteItem(db: OfflineDb, id: string) {
  await db.transaction('rw', db.outbox, db.outboxFiles, async () => {
    await db.outboxFiles.where('itemId').equals(id).delete();
    await db.outbox.delete(id);
  });
}

/** Drops synced rows older than `SYNCED_KEEP_MS` (their photos are already gone). */
export async function pruneSynced(db: OfflineDb, now = Date.now()) {
  const old = await db.outbox
    .filter((i) => i.status === 'synced' && !!i.syncedAt && now - Date.parse(i.syncedAt) > SYNCED_KEEP_MS)
    .primaryKeys();
  if (old.length) await db.outbox.bulkDelete(old);
}

/**
 * Logout (brief §7.4): every cached personal datum and the outbox leave the device.
 * The caller warns first when `unsyncedCount` > 0.
 */
export async function clearOfflineData(db: OfflineDb) {
  await db.transaction('rw', [db.roster, db.meta, db.outbox, db.outboxFiles], async () => {
    await Promise.all([db.roster.clear(), db.meta.clear(), db.outbox.clear(), db.outboxFiles.clear()]);
  });
}
