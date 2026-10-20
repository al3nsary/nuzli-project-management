import type { ApiClient } from '../../../api/client';
import { ApiError } from '../../../api/errors';
import { t } from '../../../i18n';
import { backoffDelay } from './backoff';
import type { OfflineDb, OutboxItem, OutboxPhoto } from './db';
import { inWorkspace, pruneSynced } from './outbox';

/** Re-presign when the stored URL has less than this left. */
const PRESIGN_MARGIN_MS = 30_000;
/** Foreground timer (ADR-021). */
export const SYNC_INTERVAL_MS = 60_000;
export const BACKGROUND_SYNC_TAG = 'nuzli-outbox';
export const SW_SYNC_MESSAGE = 'nuzli-sync';

export interface SyncReport {
  synced: number;
  failed: number;
  pending: number;
  /** The run stopped early: no network. */
  offline: boolean;
  /** The run stopped early: the session must be renewed by signing in. */
  authRequired: boolean;
}

export interface SyncEngineOptions {
  api: ApiClient;
  db: OfflineDb;
  /** The signed-in user; only their items are sent. */
  getUserId(): string | null;
  /**
   * A12 (H3): the session's workspace; only items recorded in it are sent (the others wait on the
   * device for a session of their workspace). `null` = no workspace chosen yet → nothing is sent;
   * `undefined` (or no getter) = a server without workspaces → every item of the user.
   */
  getWorkspaceId?(): string | null | undefined;
  now?: () => number;
  /** Called with every state change (for the UI store). */
  onState?: (state: SyncState) => void;
}

export interface SyncState {
  running: boolean;
  lastRunAt: number | null;
  authRequired: boolean;
  offline: boolean;
}

type Outcome = 'synced' | 'failed' | 'retry' | 'offline' | 'auth';

/** Why a step failed, and whether retrying can help. */
function classify(err: unknown): { kind: 'offline' | 'auth' | 'transient' | 'permanent'; code: string; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 0 || err.code === 'NETWORK_ERROR') {
      return { kind: 'offline', code: 'NETWORK_ERROR', message: t('sync.err.offline') };
    }
    if (err.status === 401 || err.code === 'UNAUTHENTICATED') {
      return { kind: 'auth', code: err.code, message: t('sync.err.auth') };
    }
    // A12 (H3): the session lost its workspace (switch, removal, archive) — the item waits, it is
    // never failed for that: it is sent again by a session of its own workspace.
    if (err.code === 'WORKSPACE_REQUIRED' || err.code === 'WORKSPACE_FORBIDDEN' || err.code === 'WORKSPACE_ARCHIVED') {
      return { kind: 'auth', code: err.code, message: t('sync.err.workspace') };
    }
    if (
      err.status >= 500 ||
      err.status === 408 ||
      err.status === 429 ||
      // A pending upload from an earlier attempt still counts until its URL expires (ADR-048).
      err.code === 'TOO_MANY_PHOTOS' ||
      err.code === 'FILE_NOT_UPLOADED' ||
      err.code === 'RATE_LIMITED'
    ) {
      return { kind: 'transient', code: err.code, message: err.message_ar };
    }
    return { kind: 'permanent', code: err.code, message: err.message_ar };
  }
  return { kind: 'transient', code: 'UNKNOWN', message: t('error.unknown') };
}

/**
 * The outbox sync engine (brief §7.4, ADR-021). One run at a time (and one tab at a time where
 * the Web Locks API exists). Items go in the order they were recorded; each item runs
 * create (idempotent by clientUuid) → presign → upload → confirm per photo, saving its progress
 * after every step so a reload, a crash or a dropped connection resumes exactly where it stopped.
 * Failures back off exponentially (2 s → 5 min); validation-type errors fail the item with the
 * server's Arabic reason and the user can retry or delete it.
 */
export class SyncEngine {
  private readonly api: ApiClient;
  private readonly db: OfflineDb;
  private readonly getUserId: () => string | null;
  private readonly getWorkspaceId: () => string | null | undefined;
  private readonly now: () => number;
  private readonly onState?: (state: SyncState) => void;
  private running: Promise<SyncReport> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopFns: (() => void)[] = [];
  state: SyncState = { running: false, lastRunAt: null, authRequired: false, offline: false };

  constructor(opts: SyncEngineOptions) {
    this.api = opts.api;
    this.db = opts.db;
    this.getUserId = opts.getUserId;
    this.getWorkspaceId = opts.getWorkspaceId ?? (() => undefined);
    this.now = opts.now ?? (() => Date.now());
    this.onState = opts.onState;
  }

  private setState(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  /** Runs now (single-flight). A call during a run schedules exactly one more run after it. */
  run(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.withLock(() => this.runOnce()).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    });
    return this.running;
  }

  /** «مزامنة الآن» and the `online` event: due now, whatever the backoff said. */
  async runNow(): Promise<SyncReport> {
    const userId = this.getUserId();
    const ws = this.getWorkspaceId();
    if (userId && ws !== null) {
      await this.db.outbox
        .filter((i) => i.userId === userId && i.status === 'pending' && inWorkspace(i, ws))
        .modify({ nextAttemptAt: 0 });
    }
    return this.run();
  }

  private async withLock(fn: () => Promise<SyncReport>): Promise<SyncReport> {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks?.request) return fn();
    let report: SyncReport | null = null;
    await locks.request('nuzli-outbox-sync', { ifAvailable: true }, async (lock) => {
      // Another tab is syncing: it will send everything; this tab just refreshes its view.
      if (!lock) return;
      report = await fn();
    });
    return report ?? { synced: 0, failed: 0, pending: 0, offline: false, authRequired: false };
  }

  private async runOnce(): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, failed: 0, pending: 0, offline: false, authRequired: false };
    const userId = this.getUserId();
    const ws = this.getWorkspaceId();
    // A12 (H3): no workspace chosen yet («اختر القسم»): nothing may be sent (and nothing is lost).
    if (!userId || ws === null) return report;
    this.setState({ running: true });
    try {
      // An item left "uploading" by a reload or a crash simply resumes. Only the items of the
      // session's workspace go; the others stay on the device for a session of theirs.
      const items = (await this.db.outbox.where('userId').equals(userId).toArray())
        .filter((i) => (i.status === 'pending' || i.status === 'uploading') && inWorkspace(i, ws))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const item of items) {
        if (item.nextAttemptAt > this.now()) {
          report.pending++;
          continue;
        }
        const outcome = await this.processItem(item);
        if (outcome === 'synced') report.synced++;
        else if (outcome === 'failed') report.failed++;
        else report.pending++;
        if (outcome === 'offline') {
          report.offline = true;
          break;
        }
        if (outcome === 'auth') {
          report.authRequired = true;
          break;
        }
      }
      await pruneSynced(this.db, this.now());
      this.setState({ authRequired: report.authRequired, offline: report.offline });
    } finally {
      this.setState({ running: false, lastRunAt: this.now() });
      void this.scheduleNext();
    }
    return report;
  }

  private async save(item: OutboxItem) {
    item.updatedAt = new Date(this.now()).toISOString();
    await this.db.outbox.put(item);
  }

  private async processItem(item: OutboxItem): Promise<Outcome> {
    // A pre-A12 item (no workspace) is adopted by the workspace that sends it.
    const ws = this.getWorkspaceId();
    if (item.workspaceId == null && ws) item.workspaceId = ws;
    item.status = 'uploading';
    await this.save(item);
    try {
      // 1. Create — idempotent: a retry after a lost response returns the same violation (200).
      if (!item.violationId) {
        const res = await this.api.violations.create({
          ...item.payload,
          clientSentAt: new Date(this.now()).toISOString(),
        });
        item.violationId = res.violation.id;
        await this.save(item);
      }
      // 2–4. Each photo: presign (reused while valid) → PUT → confirm.
      for (const photo of item.photos) {
        if (photo.confirmed) continue;
        await this.sendPhoto(item, photo);
      }
      item.status = 'synced';
      item.syncedAt = new Date(this.now()).toISOString();
      item.error = null;
      item.errorCode = null;
      await this.db.transaction('rw', this.db.outbox, this.db.outboxFiles, async () => {
        await this.save(item);
        // The photos are on the server now: free the device.
        await this.db.outboxFiles.where('itemId').equals(item.id).delete();
      });
      return 'synced';
    } catch (err) {
      const c = classify(err);
      item.error = c.message;
      item.errorCode = c.code;
      if (c.kind === 'permanent') {
        item.status = 'failed';
        await this.save(item);
        return 'failed';
      }
      item.status = 'pending';
      if (c.kind !== 'auth') {
        item.attempts += 1;
        item.nextAttemptAt = this.now() + backoffDelay(item.attempts);
      }
      await this.save(item);
      return c.kind === 'offline' ? 'offline' : c.kind === 'auth' ? 'auth' : 'retry';
    }
  }

  private async sendPhoto(item: OutboxItem, photo: OutboxPhoto) {
    if (!photo.uploaded) {
      const valid =
        photo.presigned && Date.parse(photo.presigned.expiresAt) - PRESIGN_MARGIN_MS > this.now();
      if (!valid) {
        const p = await this.api.files.presign({
          entityType: 'violation',
          entityId: item.violationId as string,
          kind: photo.kind,
          contentType: photo.type as 'image/jpeg',
          sizeBytes: photo.size,
        });
        photo.fileId = p.fileId;
        photo.presigned = p;
        await this.save(item);
      }
      const file = await this.db.outboxFiles.get(photo.key);
      if (!file) throw new ApiError(400, 'FILE_NOT_UPLOADED', t('sync.err.photoMissing'));
      try {
        await this.api.files.upload(
          photo.presigned!,
          new Blob([file.data], { type: file.type }),
        );
      } catch (err) {
        // An expired or rejected URL: presign again next time.
        if (err instanceof ApiError && err.code === 'FILE_NOT_UPLOADED') {
          photo.presigned = null;
          await this.save(item);
        }
        throw err;
      }
      photo.uploaded = true;
      await this.save(item);
    }
    try {
      await this.api.files.confirm(photo.fileId as string);
    } catch (err) {
      // The object never arrived: upload again with a fresh URL.
      if (err instanceof ApiError && err.code === 'FILE_NOT_UPLOADED') {
        photo.uploaded = false;
        photo.presigned = null;
        await this.save(item);
      }
      throw err;
    }
    photo.confirmed = true;
    await this.save(item);
  }

  /** Wakes up when the earliest backed-off item becomes due. */
  private async scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.stopFns.length) return; // not started (tests drive `run()` directly)
    const userId = this.getUserId();
    const ws = this.getWorkspaceId();
    if (!userId || ws === null) return;
    const pending = await this.db.outbox
      .filter((i) => i.userId === userId && i.status === 'pending' && inWorkspace(i, ws))
      .toArray();
    if (!pending.length) return;
    const next = Math.min(...pending.map((i) => i.nextAttemptAt));
    const delay = Math.max(1_000, next - this.now());
    if (delay > SYNC_INTERVAL_MS) return; // the interval covers it
    this.timer = setTimeout(() => void this.run(), delay);
  }

  /**
   * Attaches the triggers: `online`, focus and visibility, a 60 s timer, and messages from the
   * service worker's Background Sync (where supported; iOS has none, so the foreground triggers
   * are the guaranteed path). Returns the detach function.
   */
  start(): () => void {
    if (this.stopFns.length) return () => this.stop();
    const onOnline = () => void this.runNow();
    const onFocus = () => void this.run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.run();
    };
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === SW_SYNC_MESSAGE) void this.run();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const interval = setInterval(() => void this.run(), SYNC_INTERVAL_MS);
    this.stopFns.push(
      () => window.removeEventListener('online', onOnline),
      () => window.removeEventListener('focus', onFocus),
      () => document.removeEventListener('visibilitychange', onVisible),
      () => navigator.serviceWorker?.removeEventListener('message', onMessage),
      () => clearInterval(interval),
    );
    void this.run();
    return () => this.stop();
  }

  stop() {
    for (const fn of this.stopFns.splice(0)) fn();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Asks the service worker to wake us when connectivity returns (Chromium only). */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register(tag: string): Promise<void> };
    };
    if (!reg.sync) return false;
    await reg.sync.register(BACKGROUND_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

/** Asks the browser not to evict the outbox under storage pressure (brief §7.4). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
