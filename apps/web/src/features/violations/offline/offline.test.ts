import { beforeEach, describe, expect, it } from 'vitest';
import { DemoApi } from '../../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../../api/demo/constants';
import { ApiError } from '../../../api/errors';
import type { ApiClient } from '../../../api/client';
import { hasExif, stripJpegMetadata } from '../../../lib/bytes';
import { BACKOFF_MAX_MS, backoffDelay } from './backoff';
import { OfflineDb, type OutboxPayload } from './db';
import { clearOfflineData, enqueueViolation, retryItem, unsyncedCount } from './outbox';
import { normalizeArabic, refreshRoster, searchRoster } from './roster';
import { SyncEngine } from './sync';
import { uuidv4 } from '../../../lib/uuid';

let n = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${n++}`;

const MONITOR = 'monitor1@demo.nuzli.example';
const MEMBER_1 = '00000000-0000-4000-8000-b00000000001';
const TYPE_1 = '00000000-0000-4000-8000-d10000000001';

/** A tiny "JPEG": the SOI + JFIF APP0 header the server's magic-byte check expects. */
function jpeg(size = 64): Blob {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return new Blob([b], { type: 'image/jpeg' });
}

function payload(over: Partial<OutboxPayload> = {}): OutboxPayload {
  return {
    clientUuid: uuidv4(),
    memberId: MEMBER_1,
    typeId: TYPE_1,
    description: 'وصف مخالفة للاختبار',
    latitude: 24.7136,
    longitude: 46.6753,
    accuracyM: 12,
    capturedAt: new Date().toISOString(),
    deviceInfo: { userAgent: 'vitest', platform: 'test', online: false, appVersion: 'test' },
    expectedIdPhotos: 1,
    expectedEvidencePhotos: 2,
    ...over,
  };
}

const display = {
  memberName: 'عضو',
  nationalIdMasked: '1•••••••04',
  teamName: null,
  teamColor: null,
  typeName: 'نوع',
};

async function setup() {
  const api = new DemoApi({ dbName: uniq('demo-off') });
  const s = await api.auth.login({ identifier: MONITOR, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  const db = new OfflineDb(uniq('offline'));
  let clock = Date.now();
  const engine = new SyncEngine({ api, db, getUserId: () => s.user.id, now: () => clock });
  return {
    api,
    db,
    engine,
    user: s.user,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

async function enqueue(db: OfflineDb, userId: string, p = payload(), evidence = 2) {
  return enqueueViolation(db, {
    userId,
    payload: { ...p, expectedEvidencePhotos: evidence },
    display,
    photos: [
      { kind: 'ID_CARD', blob: jpeg() },
      ...Array.from({ length: evidence }, () => ({ kind: 'EVIDENCE' as const, blob: jpeg(80) })),
    ],
  });
}

async function serverCount(api: DemoApi, clientUuid: string) {
  return api.db.violations.where('clientUuid').equals(clientUuid).count();
}

describe('outbox storage (brief §7.4)', () => {
  it('survives a reload: a new Dexie instance sees the item and its photo bytes', async () => {
    const name = uniq('reload');
    const db1 = new OfflineDb(name);
    const item = await enqueue(db1, 'user-1');
    db1.close();

    const db2 = new OfflineDb(name);
    const again = await db2.outbox.get(item.id);
    expect(again?.status).toBe('pending');
    expect(again?.photos).toHaveLength(3);
    expect(again?.photos[0]?.kind).toBe('ID_CARD');
    const files = await db2.outboxFiles.where('itemId').equals(item.id).toArray();
    expect(files).toHaveLength(3);
    const bytes = new Uint8Array(files.find((f) => f.kind === 'ID_CARD')!.data);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(await unsyncedCount(db2, 'user-1')).toBe(1);
  });

  it('logout clears the roster, meta, outbox and photos', async () => {
    const { api, db, user } = await setup();
    await refreshRoster(api, db, user.id);
    await enqueue(db, user.id);
    expect(await db.roster.count()).toBeGreaterThan(0);
    expect(await unsyncedCount(db)).toBe(1);
    await clearOfflineData(db);
    expect(await db.roster.count()).toBe(0);
    expect(await db.meta.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.outboxFiles.count()).toBe(0);
  });
});

describe('backoff (ADR-021)', () => {
  it('doubles from 2 s and caps at 5 minutes', () => {
    const s = (k: number) => backoffDelay(k) / 1000;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50].map(s)).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
    expect(backoffDelay(0)).toBe(0);
    expect(BACKOFF_MAX_MS).toBe(300_000);
  });
});

describe('roster on the device', () => {
  it('stores masked IDs and the last four digits only, and searches by name or tail', async () => {
    const { api, db, user } = await setup();
    const res = await refreshRoster(api, db, user.id);
    expect(res.count).toBeGreaterThan(20);
    const rows = await db.roster.toArray();
    const fullIds = new Map((await api.db.members.toArray()).map((m) => [m.id, m.nationalId]));
    for (const r of rows) {
      expect(r.nationalIdMasked).toMatch(/^[12]•{7}\d{2}$/);
      expect(r.nationalIdTail).toMatch(/^\d{4}$/);
      expect(r).not.toHaveProperty('nationalId');
      expect(JSON.stringify(r)).not.toContain(fullIds.get(r.memberId));
      expect(r.teamName).toBeTruthy();
    }
    const first = rows[0]!;
    expect(searchRoster(rows, first.nationalIdTail).map((r) => r.memberId)).toContain(first.memberId);
    expect(searchRoster(rows, first.nationalIdTail.slice(0, 2)).length).toBeGreaterThan(0);
    // Arabic normalisation: hamza forms, taa marbuta and Arabic-Indic digits.
    expect(normalizeArabic('أحمد المالكيّة ١٢')).toBe('احمد المالكيه 12');
    expect(searchRoster(rows, 'احمد').some((r) => r.fullName.includes('أحمد'))).toBe(true);
    // Types and form settings come along for offline use.
    expect(((await db.meta.get('types'))?.value as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('sync engine', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('runs create → presign → upload → confirm and frees the photo bytes', async () => {
    const { api, db, engine, user } = ctx;
    const item = await enqueue(db, user.id);
    const report = await engine.run();
    expect(report.synced).toBe(1);
    const done = await db.outbox.get(item.id);
    expect(done?.status).toBe('synced');
    expect(done?.photos.every((p) => p.confirmed)).toBe(true);
    expect(await db.outboxFiles.where('itemId').equals(item.id).count()).toBe(0);
    const v = await api.db.violations.where('clientUuid').equals(item.id).first();
    const files = await api.db.files.where('violationId').equals(v!.id).toArray();
    expect(files.filter((f) => f.kind === 'ID_CARD')).toHaveLength(1);
    expect(files.filter((f) => f.kind === 'EVIDENCE')).toHaveLength(2);
    expect(files.every((f) => f.status === 'READY')).toBe(true);
  });

  it('resumes after the create succeeded but before the photos — no duplicate', async () => {
    const { api, db, user, tick } = ctx;
    let failPresign = true;
    const flaky: ApiClient = Object.create(api);
    flaky.files = {
      ...api.files,
      presign: async (input) => {
        if (failPresign) throw new ApiError(0, 'NETWORK_ERROR', 'offline');
        return api.files.presign(input);
      },
    };
    let clock = Date.now();
    const engine = new SyncEngine({ api: flaky, db, getUserId: () => user.id, now: () => clock });
    const item = await enqueue(db, user.id);

    const first = await engine.run();
    expect(first.offline).toBe(true);
    const mid = await db.outbox.get(item.id);
    expect(mid?.violationId).toBeTruthy();
    expect(mid?.status).toBe('pending');
    expect(mid?.attempts).toBe(1);
    expect(mid?.nextAttemptAt).toBe(clock + 2000);
    expect(await serverCount(api, item.id)).toBe(1);

    // Still backing off: nothing happens.
    failPresign = false;
    expect((await engine.run()).synced).toBe(0);
    clock += 2_000;
    tick(0);
    const second = await engine.run();
    expect(second.synced).toBe(1);
    expect(await serverCount(api, item.id)).toBe(1);
    const v = await api.db.violations.where('clientUuid').equals(item.id).first();
    expect(v?.id).toBe(mid?.violationId);
    expect(await api.db.files.where('violationId').equals(v!.id).count()).toBe(3);
  });

  it('retries a create whose response was lost: the server answers 200 with the same violation', async () => {
    const { api, db, user } = ctx;
    let loseResponse = true;
    let created201 = 0;
    const flaky: ApiClient = Object.create(api);
    flaky.violations = {
      ...api.violations,
      create: async (input) => {
        const res = await api.violations.create(input);
        if (res.created) created201++;
        if (loseResponse) {
          loseResponse = false;
          throw new ApiError(0, 'NETWORK_ERROR', 'lost');
        }
        return res;
      },
    };
    const engine = new SyncEngine({ api: flaky, db, getUserId: () => user.id, now: () => Date.now() + 10 * 60_000 });
    const item = await enqueue(db, user.id);
    await engine.run();
    expect((await db.outbox.get(item.id))?.violationId).toBeNull();
    await engine.runNow();
    expect((await db.outbox.get(item.id))?.status).toBe('synced');
    expect(created201).toBe(1);
    expect(await serverCount(api, item.id)).toBe(1);
  });

  it('resumes a half-uploaded item without uploading the finished photos again', async () => {
    const { api, db, user } = ctx;
    const uploads: string[] = [];
    let failOnce = true;
    const flaky: ApiClient = Object.create(api);
    flaky.files = {
      ...api.files,
      upload: async (presigned, blob) => {
        if (uploads.length === 2 && failOnce) {
          failOnce = false;
          throw new ApiError(0, 'NETWORK_ERROR', 'dropped');
        }
        uploads.push(presigned.url);
        return api.files.upload(presigned, blob);
      },
    };
    const engine = new SyncEngine({ api: flaky, db, getUserId: () => user.id });
    const item = await enqueue(db, user.id, payload(), 3);
    await engine.run();
    const mid = await db.outbox.get(item.id);
    expect(mid?.photos.filter((p) => p.confirmed)).toHaveLength(2);
    await engine.runNow();
    expect((await db.outbox.get(item.id))?.status).toBe('synced');
    // 4 photos, 4 uploads in total: the two confirmed ones were not sent twice.
    expect(uploads).toHaveLength(4);
    expect(new Set(uploads).size).toBe(4);
    const v = await api.db.violations.where('clientUuid').equals(item.id).first();
    expect(await api.db.files.where('violationId').equals(v!.id).count()).toBe(4);
  });

  it('fails an item the server rejects, keeps the Arabic reason, and retries on demand', async () => {
    const { api, db, engine, user } = ctx;
    await api.db.violationTypes.update(TYPE_1, { isActive: false });
    const item = await enqueue(db, user.id);
    const report = await engine.run();
    expect(report.failed).toBe(1);
    const failed = await db.outbox.get(item.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('VALIDATION_FAILED');
    expect(failed?.error).toMatch(/[؀-ۿ]/);
    await api.db.violationTypes.update(TYPE_1, { isActive: true });
    await retryItem(db, item.id);
    expect((await engine.run()).synced).toBe(1);
  });

  it('keeps items pending without burning attempts when the session is gone', async () => {
    const { api, db, engine, user } = ctx;
    api.setAccessToken(null);
    const item = await enqueue(db, user.id);
    const report = await engine.run();
    expect(report.authRequired).toBe(true);
    const after = await db.outbox.get(item.id);
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(0);
  });

  it('only sends the signed-in user’s items, in the order they were recorded', async () => {
    const { api, db, user } = ctx;
    const order: string[] = [];
    const spy: ApiClient = Object.create(api);
    spy.violations = {
      ...api.violations,
      create: async (input) => {
        order.push(input.clientUuid);
        return api.violations.create(input);
      },
    };
    const engine = new SyncEngine({ api: spy, db, getUserId: () => user.id });
    const a = await enqueueViolation(db, { userId: user.id, payload: payload({ expectedEvidencePhotos: 1 }), display, photos: [{ kind: 'ID_CARD', blob: jpeg() }, { kind: 'EVIDENCE', blob: jpeg() }] }, new Date(Date.now() - 2000));
    const other = await enqueue(db, 'someone-else');
    const b = await enqueueViolation(db, { userId: user.id, payload: payload({ expectedEvidencePhotos: 1 }), display, photos: [{ kind: 'ID_CARD', blob: jpeg() }, { kind: 'EVIDENCE', blob: jpeg() }] }, new Date(Date.now() - 1000));
    await engine.run();
    expect(order).toEqual([a.id, b.id]);
    expect((await db.outbox.get(other.id))?.status).toBe('pending');
  });
});

describe('EXIF stripping (brief §7.2)', () => {
  it('removes APP1 (EXIF) and COM segments and keeps the image data', () => {
    const exif = [0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 1, 2, 3, 4];
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
    const com = [0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63];
    const sos = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
    const input = Uint8Array.from([0xff, 0xd8, ...app0, ...exif, ...com, ...sos]);
    expect(hasExif(input)).toBe(true);
    const out = stripJpegMetadata(input);
    expect(hasExif(out)).toBe(false);
    expect(Array.from(out)).toEqual([0xff, 0xd8, ...app0, ...sos]);
    // Non-JPEG input is untouched.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    expect(stripJpegMetadata(png)).toBe(png);
  });
});
