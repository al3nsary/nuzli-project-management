/**
 * docs/API.md "Security changes (2026-10 review)" (ADR-062..067) in the demo adapter, which
 * mirrors the API so the UI is built against the same answers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ERRORS, nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { dropPrintRun, getPrintRun, putPrintRun } from '../../features/cards/printRun';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-sec-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const MEMBER = (k: number) => `00000000-0000-4000-8000-b${String(k).padStart(11, '0')}`;
const TEAM = (k: number) => `00000000-0000-4000-8000-a${String(k).padStart(11, '0')}`;
const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function codeOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('login throttling and the silent lock (ADR-062)', () => {
  it('answers 429 RATE_LIMITED with retryAfterSeconds after 5 failures, never 423', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await codeOf(api.auth.login({ identifier: SUP1, password: 'wrong-pass-1' }))).code).toBe(
        'INVALID_CREDENTIALS',
      );
    }
    // The 6th failure starts the cool-down; the next attempt is refused before the password check.
    await codeOf(api.auth.login({ identifier: SUP1, password: 'wrong-pass-1' }));
    const err = await codeOf(api.auth.login({ identifier: SUP1, password: DEMO_PASSWORD }));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(429);
    expect((err.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('a locked account answers INVALID_CREDENTIALS even with the right password, and is audited', async () => {
    const internals = api as unknown as { loginBuckets: Map<string, unknown> };
    for (let i = 0; i < 10; i++) {
      internals.loginBuckets.clear();
      await codeOf(api.auth.login({ identifier: SUP1, password: 'wrong-pass-1' }));
    }
    internals.loginBuckets.clear();
    const err = await codeOf(api.auth.login({ identifier: SUP1, password: DEMO_PASSWORD }));
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(err.status).toBe(401);
    // A12: the lock is account level (no workspace): kept outside every workspace's audit list.
    await loginAs(ADMIN);
    expect((await api.audit.list({ action: 'auth.account_locked' })).total).toBe(0);
    const accountLevel = await api.unscoped(() => api.db.audit.filter((a) => a.action === 'auth.account_locked').toArray(), 'r');
    expect(accountLevel).toHaveLength(1);
    expect((accountLevel[0] as { wid?: string | null }).wid).toBeNull();
  });
});

describe('full national IDs never in a URL (ADR-067)', () => {
  it('GET list refuses a full ID; POST search finds it', async () => {
    await loginAs(ADMIN);
    const member = await api.members.get(MEMBER(1));
    const full = member.nationalId!;
    const err = await codeOf(api.members.list({ q: full }));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect((err.details as { useInstead: string }).useInstead).toBe('POST /members/search');
    const found = await api.members.search({ q: full, page: 1, pageSize: 25 });
    expect(found.items.map((m) => m.id)).toEqual([MEMBER(1)]);
    // Last-4 still works on GET.
    expect((await api.members.list({ q: full.slice(-4) })).total).toBeGreaterThan(0);

    expect((await codeOf(api.users.list({ q: '1055123408' }))).code).toBe('VALIDATION_FAILED');
    const users = await api.users.search({ q: '1055123408', page: 1, pageSize: 25 });
    expect(users.items[0]?.email).toBe(ADMIN);
  });

  it('a supervisor gets the neutral NATIONAL_ID_NOT_ACCEPTED; admins keep NATIONAL_ID_TAKEN', async () => {
    await loginAs(ADMIN);
    const taken = (await api.members.get(MEMBER(1))).nationalId!;
    const admin = await codeOf(api.teams.addMember(TEAM(1), { fullName: 'عضو مكرر', nationalId: taken }));
    expect(admin.code).toBe('NATIONAL_ID_TAKEN');

    await loginAs(SUP1);
    const sup = await codeOf(api.teams.addMember(TEAM(1), { fullName: 'عضو مكرر', nationalId: taken }));
    expect(sup.code).toBe('NATIONAL_ID_NOT_ACCEPTED');
    expect(sup.message_ar).toBe(ERRORS.NATIONAL_ID_NOT_ACCEPTED);
    expect(sup.fieldErrors.nationalId).toBe(ERRORS.NATIONAL_ID_NOT_ACCEPTED);
    // A fresh ID still works for the supervisor — A12 round 2: as a request awaiting approval (202).
    await expect(
      api.teams.addMember(TEAM(1), { fullName: 'عضو جديد', nationalId: validId('188776655') }),
    ).resolves.toMatchObject({ status: 'PENDING_APPROVAL', request: { payload: { fullName: 'عضو جديد' } } });
    await loginAs(ADMIN);
    const audit = await api.audit.list({ action: 'member.duplicate_rejected' });
    expect(audit.total).toBe(1);
    expect(JSON.stringify(audit.items)).not.toContain(taken);
  });
});

describe('print batches: masked at rest, full IDs only in the POST answer (ADR-064)', () => {
  it('stores masked items with nationalIdPrinted, prints from `cards`, ignores client IDs', async () => {
    await loginAs(ADMIN);
    const base = (await api.cards.templates())[0]!;
    const tpl = await api.cards.updateTemplate(base.id, {
      config: { ...base.config, maskNationalId: false, fields: { ...base.config.fields, nationalId: true } },
    });
    const full = (await api.members.get(MEMBER(2))).nationalId!;
    const preview = await api.cards.preview({ templateId: tpl.id, memberIds: [MEMBER(2)] });
    expect((await api.audit.list({ action: 'cards.preview_full_ids' })).total).toBe(1);
    const key = crypto.randomUUID();
    const input = {
      idempotencyKey: key,
      templateId: tpl.id,
      items: [
        {
          memberId: MEMBER(2),
          // The client's ID and QR are ignored: the server derives them.
          data: { ...preview.subjects[0]!.data, nationalId: '1000000008', qrValue: 'forged' },
        },
      ],
    };
    const created = await api.cards.createBatch(input);
    expect(created.cards).toHaveLength(1);
    expect(created.cards[0]!.data.nationalId).toBe(full);
    expect(created.cards[0]!.data.qrValue).toBe(MEMBER(2));
    expect(created.cards[0]!.nationalIdPrinted).toBe('FULL');

    const detail = await api.cards.batch(created.id);
    expect(detail.items[0]!.nationalIdPrinted).toBe('FULL');
    expect(detail.items[0]!.data.nationalId).not.toBe(full);
    expect(detail.items[0]!.data.nationalId).toMatch(/•/);
    expect(JSON.stringify(await api.db.batches.toArray())).not.toContain(full);

    // An idempotent replay re-derives the IDs and is audited.
    const again = await api.cards.createBatch(input);
    expect(again.id).toBe(created.id);
    expect(again.cards[0]!.data.nationalId).toBe(full);
    expect((await api.audit.list({ action: 'cards.print_data_reissued' })).total).toBe(1);
  });

  it('the print run lives in memory only and is dropped', () => {
    putPrintRun('b1', [{ memberId: 'm', userId: null, data: { fullName: 'x' }, nationalIdPrinted: 'FULL' }]);
    expect(getPrintRun('b1')).toHaveLength(1);
    dropPrintRun();
    expect(getPrintRun('b1')).toBeNull();
  });
});

describe('uploads (ADR-066, superseded for photos by A8 / ADR-083)', () => {
  it('member_photo presign goes through the photo scope check (no entity → 400)', async () => {
    await loginAs(ADMIN);
    const err = await codeOf(
      api.files.presign({ entityType: 'member_photo', kind: 'PHOTO', contentType: 'image/jpeg', sizeBytes: 100 }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
  });
});

describe('logout clears device caches (security review checklist)', () => {
  it('wipes the roster, meta, outbox and the in-memory print run', async () => {
    const { offlineDb } = await import('../../features/violations/offline/db');
    const { wipeDevice } = await import('../../app/useSessionActions');
    const db = offlineDb();
    await db.meta.put({ key: 'lastRosterAt', value: new Date().toISOString() });
    await db.roster.put({ memberId: 'm1', searchName: 'x' } as never);
    putPrintRun('b2', [{ memberId: 'm', userId: null, data: { fullName: 'x' }, nationalIdPrinted: 'FULL' }]);
    await wipeDevice();
    expect(await db.meta.count()).toBe(0);
    expect(await db.roster.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(getPrintRun('b2')).toBeNull();
  });
});
