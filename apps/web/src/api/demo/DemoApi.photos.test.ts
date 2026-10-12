/**
 * Owner request A8 (ADR-083/084) in the demo adapter: the same permission matrix as
 * apps/api/src/photos/photo-policy.ts, replace deletes the old object, remove, audit, and
 * card subjects carrying photo URLs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import type { PhotoTarget } from '../client';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-photos-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example'; // leads teams 1 and 2
const SUP2 = 'supervisor2@demo.nuzli.example'; // leads teams 3 and 4
const MON = 'monitor1@demo.nuzli.example';
const U = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const MEMBER = (k: number) => `00000000-0000-4000-8000-b${String(k).padStart(11, '0')}`;
const TEAM = (k: number) => `00000000-0000-4000-8000-a${String(k).padStart(11, '0')}`;

/** A few bytes that pass the JPEG magic-byte check. */
const jpeg = (tag = 1) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, tag, 0, 0xff, 0xd9])], { type: 'image/jpeg' });

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const member = (k: number): PhotoTarget => ({ kind: 'member', id: MEMBER(k) });

describe('user photos (A8)', () => {
  it('every user sets their own photo; the DTO and /me/photo-url follow', async () => {
    const me = await loginAs(MON);
    expect(me.hasPhoto).toBe(false);
    const { fileId } = await api.photos.upload({ kind: 'me', id: me.id }, jpeg());
    const after = await api.auth.me();
    expect(after.hasPhoto).toBe(true);
    expect(after.photoFileId).toBe(fileId);
    const url = await api.photos.url({ kind: 'me', id: me.id });
    expect(url.url).toBeTruthy();
    expect(Date.parse(url.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('an admin sets anyone’s photo; a supervisor cannot set another user’s (403)', async () => {
    await loginAs(ADMIN);
    await api.photos.upload({ kind: 'user', id: U(7) }, jpeg());
    expect((await api.users.get(U(7))).hasPhoto).toBe(true);
    await loginAs(SUP1);
    const err = await errorOf(api.photos.upload({ kind: 'user', id: U(7) }, jpeg()));
    expect(err.status).toBe(403);
    expect((await errorOf(api.photos.remove({ kind: 'user', id: U(7) }))).status).toBe(403);
  });

  it('active users see active users’ photos; a suspended account stays private', async () => {
    await loginAs(ADMIN);
    await api.photos.upload({ kind: 'user', id: U(6) }, jpeg()); // supervisor4 is SUSPENDED
    expect((await api.photos.url({ kind: 'user', id: U(6) })).url).toBeTruthy();
    await loginAs(MON);
    expect((await api.photos.url({ kind: 'user', id: U(3) })).url).toBeTruthy(); // seeded portrait
    expect((await errorOf(api.photos.url({ kind: 'user', id: U(6) }))).status).toBe(404);
  });
});

describe('member photos (A8) — permission matrix', () => {
  it('admin: allowed', async () => {
    await loginAs(ADMIN);
    await api.photos.upload(member(2), jpeg());
    expect((await api.members.get(MEMBER(2))).hasPhoto).toBe(true);
  });

  it('leading supervisor: allowed', async () => {
    await loginAs(SUP1);
    await api.photos.upload(member(2), jpeg());
    expect((await api.photos.url(member(2))).url).toBeTruthy();
  });

  it('another team’s supervisor: 404 (write and read)', async () => {
    await loginAs(SUP2);
    expect((await errorOf(api.photos.upload(member(2), jpeg()))).status).toBe(404);
    expect((await errorOf(api.photos.url(member(1)))).status).toBe(404);
    expect((await errorOf(api.photos.remove(member(1)))).status).toBe(404);
  });

  it('monitor: 403 to write, but sees roster members’ photos to confirm identity', async () => {
    await loginAs(MON);
    expect((await errorOf(api.photos.upload(member(2), jpeg()))).status).toBe(403);
    expect((await errorOf(api.photos.remove(member(1)))).status).toBe(403);
    expect((await api.photos.url(member(1))).url).toBeTruthy();
    const roster = await api.violations.roster();
    const withPhoto = roster.items.find((r) => r.memberId === MEMBER(1));
    expect(withPhoto?.hasPhoto).toBe(true);
    expect(roster.items.find((r) => r.memberId === MEMBER(2))?.hasPhoto).toBe(false);
  });

  it('unassigned member: 403 for a supervisor', async () => {
    await loginAs(SUP1);
    expect((await errorOf(api.photos.upload(member(36), jpeg()))).status).toBe(403);
  });

  it('refuses non-images and files over 2 MB at presign', async () => {
    await loginAs(ADMIN);
    const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
    expect((await errorOf(api.photos.upload(member(2), big))).code).toBe('FILE_TOO_LARGE');
    const pdf = await errorOf(
      api.files.presign({ entityType: 'member_photo', entityId: MEMBER(2), kind: 'PHOTO', contentType: 'application/pdf', sizeBytes: 10 }),
    );
    expect(pdf.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });
});

describe('replace and remove (A8)', () => {
  it('replacing deletes the old object and file; the audit holds file ids only', async () => {
    await loginAs(SUP1);
    const first = await api.photos.upload(member(2), jpeg(1));
    expect(await api.db.objects.get(first.fileId)).toBeTruthy();
    const second = await api.photos.upload(member(2), jpeg(2));
    expect(await api.db.objects.get(first.fileId)).toBeUndefined();
    expect((await api.db.files.get(first.fileId))?.deletedAt).toBeTruthy();
    expect((await api.db.members.get(MEMBER(2)))?.photoFileId).toBe(second.fileId);
    const audit = (await api.db.audit.toArray()).filter((a) => a.action === 'member.photo_updated');
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.after)).toContainEqual({ photoFileId: second.fileId });
    expect(audit.find((a) => (a.after as { photoFileId: string }).photoFileId === second.fileId)?.before).toEqual({
      photoFileId: first.fileId,
    });
  });

  it('remove unlinks, deletes the object, audits, and the URL answers 404', async () => {
    await loginAs(ADMIN);
    const seeded = (await api.db.members.get(MEMBER(1)))!.photoFileId!;
    await api.photos.url(member(1));
    await api.photos.remove(member(1));
    expect((await api.members.get(MEMBER(1))).hasPhoto).toBe(false);
    expect(await api.db.objects.get(seeded)).toBeUndefined();
    expect((await errorOf(api.photos.url(member(1)))).status).toBe(404);
    const audit = (await api.db.audit.toArray()).find((a) => a.action === 'member.photo_removed');
    expect(audit?.before).toEqual({ photoFileId: seeded });
    // Removing again is a no-op without a second entry.
    await api.photos.remove(member(1));
    expect((await api.db.audit.toArray()).filter((a) => a.action === 'member.photo_removed')).toHaveLength(1);
  });

  it('removes one’s own photo through /me', async () => {
    const me = await loginAs(SUP1); // seeded portrait
    expect(me.hasPhoto).toBe(true);
    await api.photos.remove({ kind: 'me', id: me.id });
    expect((await api.auth.me()).hasPhoto).toBe(false);
    expect((await api.db.audit.toArray()).some((a) => a.action === 'user.photo_removed')).toBe(true);
  });
});

describe('cards carry photos (A8, ADR-084)', () => {
  it('preview subjects get photoUrl for members and for the supervisor (the user photo)', async () => {
    await loginAs(ADMIN);
    const tpl = (await api.cards.templates()).find((x) => x.isDefault)!;
    expect(tpl.config.fields.photo).toBe(true);
    const res = await api.cards.preview({ templateId: tpl.id, teamIds: [TEAM(1)], includeSupervisors: true });
    const sup = res.subjects.find((s) => s.userId === U(3));
    expect(sup?.photoUrl).toBeTruthy();
    expect(sup?.data.photoFileId).toBeTruthy();
    expect(res.subjects.find((s) => s.memberId === MEMBER(1))?.photoUrl).toBeTruthy();
    expect(res.subjects.find((s) => s.memberId === MEMBER(2))?.photoUrl ?? null).toBeNull();

    const batch = await api.cards.createBatch({
      idempotencyKey: crypto.randomUUID(),
      templateId: tpl.id,
      items: res.subjects.slice(0, 3).map((s) => ({
        memberId: s.memberId ?? null,
        userId: s.userId ?? null,
        data: s.data,
      })),
    });
    expect(batch.cards.find((c) => c.userId === U(3))?.photoUrl).toBeTruthy();
    // The stored batch never keeps a URL.
    const stored = await api.db.batches.get(batch.id);
    expect(JSON.stringify(stored)).not.toMatch(/data:|blob:/);
  });

  it('the template switch turns the photo off for the run', async () => {
    await loginAs(ADMIN);
    const tpl = (await api.cards.templates()).find((x) => x.isDefault)!;
    await api.cards.updateTemplate(tpl.id, { config: { ...tpl.config, fields: { ...tpl.config.fields, photo: false } } });
    const res = await api.cards.preview({ templateId: tpl.id, teamIds: [TEAM(1)], includeSupervisors: true });
    expect(res.subjects.every((s) => !s.photoUrl)).toBe(true);
  });
});
