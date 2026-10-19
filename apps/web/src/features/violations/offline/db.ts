import Dexie, { type Table } from 'dexie';
import type {
  CreateViolationInput,
  PresignedUpload,
  RosterEntry,
  ViolationFileKind,
} from '@nuzli/shared';

/**
 * The device-side store of the violations module (brief §7.4, ADR-021): IndexedDB via Dexie.
 * Holds only what a monitor needs offline and is wiped on logout (docs/offline.md):
 *   roster       the minimal member list (masked national ID + last 4 digits, team name/colour)
 *   meta         last roster time, active violation types, the two settings the form needs,
 *                and the signed-in user's display profile for an offline reload
 *   outbox       violations waiting to sync, keyed by their client UUID, with step progress
 *   outboxFiles  the compressed photos (bytes), deleted as soon as the violation has synced
 */
export const OFFLINE_DB_NAME = 'nuzli-offline';

export interface RosterRow extends RosterEntry {
  /** Normalised Arabic name for on-device search (never sent anywhere). */
  searchName: string;
}

export interface MetaRow {
  key: MetaKey;
  value: unknown;
}

export type MetaKey =
  | 'lastRosterAt'
  | 'rosterUserId'
  | 'types'
  | 'formSettings'
  | 'offlineUser'
  | 'persisted';

export type OutboxStatus = 'pending' | 'uploading' | 'synced' | 'failed';

/** One photo of an outbox item and how far its upload got (resumable, ADR-021). */
export interface OutboxPhoto {
  /** Key of the bytes in `outboxFiles`. */
  key: string;
  kind: ViolationFileKind;
  order: number;
  type: string;
  size: number;
  fileId: string | null;
  /** Reused until it expires, so a retry never counts the same photo twice (ADR-048). */
  presigned: PresignedUpload | null;
  uploaded: boolean;
  confirmed: boolean;
}

/** What the lists show while the violation exists only on the device. */
export interface OutboxDisplay {
  memberName: string;
  nationalIdMasked: string;
  teamName: string | null;
  teamColor: string | null;
  typeName: string;
  /** A9: recorded without a person (assigned later). */
  unassigned?: boolean;
}

export type OutboxPayload = Omit<CreateViolationInput, 'clientSentAt'>;

export interface OutboxItem {
  /** = `payload.clientUuid`, the idempotency key. */
  id: string;
  /** Only the user who recorded it syncs it. */
  userId: string;
  createdAt: string;
  updatedAt: string;
  payload: OutboxPayload;
  display: OutboxDisplay;
  status: OutboxStatus;
  /** Arabic reason of the last failure (permanent or transient). */
  error: string | null;
  errorCode: string | null;
  attempts: number;
  /** Epoch ms before which the engine leaves the item alone (exponential backoff). */
  nextAttemptAt: number;
  /** Step 1 done: the server has the violation. */
  violationId: string | null;
  photos: OutboxPhoto[];
  syncedAt: string | null;
}

/**
 * The bytes of one photo. Stored as an ArrayBuffer, not a Blob: Safari has had long-standing
 * bugs with Blobs in IndexedDB, and ArrayBuffers clone everywhere (ADR-072).
 */
export interface OutboxFile {
  key: string;
  itemId: string;
  kind: ViolationFileKind;
  order: number;
  type: string;
  size: number;
  data: ArrayBuffer;
}

export class OfflineDb extends Dexie {
  roster!: Table<RosterRow, string>;
  meta!: Table<MetaRow, MetaKey>;
  outbox!: Table<OutboxItem, string>;
  outboxFiles!: Table<OutboxFile, string>;

  constructor(name: string = OFFLINE_DB_NAME) {
    super(name);
    this.version(1).stores({
      roster: 'memberId, searchName',
      meta: 'key',
      outbox: 'id, userId, status, createdAt',
      outboxFiles: 'key, itemId',
    });
  }
}

let shared: OfflineDb | null = null;

/** The app-wide instance (tests create their own with a unique name). */
export function offlineDb(): OfflineDb {
  if (!shared) shared = new OfflineDb();
  return shared;
}

export async function getMeta<T>(db: OfflineDb, key: MetaKey): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export function setMeta(db: OfflineDb, key: MetaKey, value: unknown) {
  return db.meta.put({ key, value });
}
