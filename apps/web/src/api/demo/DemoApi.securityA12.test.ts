/**
 * Security review A12 (docs/security-review-2026-10-A12.md) — the demo backend behaves like the
 * API for every finding. Ported from the reviewer's reproductions (G1–G5 and the dual-member
 * test): each scenario now asserts the FIXED behaviour.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';

const PW = 'Scratch-Pass-2026';
const vid = (n9: string) => n9 + nationalIdCheckDigit(n9);
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 0, 0xff, 0xd9])], { type: 'image/jpeg' });
let api: DemoApi;
let A = '';
let B = '';
let ownerId = '';
let seq = 30;

async function login(id: string, pw = DEMO_PASSWORD) {
  const s = await api.auth.login({ identifier: id, password: pw });
  api.setAccessToken(s.accessToken);
  return s;
}
async function enter(wid: string) {
  api.setAccessToken((await api.auth.switchWorkspace(wid)).accessToken);
}
/** As the owner: an account with MONITOR roles in the given workspaces. */
async function mkUser(tag: string, wss: string[]) {
  const n = String(seq++);
  return api.users.create({
    username: 'sr-' + tag,
    fullName: 'حساب المراجعة ' + tag,
    email: 'sr-' + tag + '@x.example',
    mobile: '05581199' + n,
    nationalId: vid(('1077' + n + '00111').slice(0, 9)),
    password: PW,
    mustChangePassword: false,
    memberships: wss.map((w) => ({ workspaceId: w, role: 'MONITOR' as const })),
    confirmDualRole: true,
  } as never);
}

beforeAll(async () => {
  api = new DemoApi({ dbName: 'nz-security-a12-' + Date.now() });
  const s = await login('mmansary');
  ownerId = s.user.id;
  A = s.activeWorkspace!.id;
  B = (await api.workspaces.create({ name: 'قسم ب للمراجعة', code: 'sr-b' })).id;
});

describe('H2 — only an owner lifts an owner’s global suspension', () => {
  it('G1: admin of A cannot lift a GLOBAL suspension of a person who is also in B (SUSPENDED_BY_OWNER); the owner can', async () => {
    await login('mmansary');
    const x = await mkUser('g1', [A, B]);
    await api.users.suspend(x.id, { scope: 'global' } as never);
    expect(await api.rawUser(x.id)).toMatchObject({ status: 'SUSPENDED', suspendedGlobally: true });
    await login('admin1');
    await expect(api.users.reactivate(x.id)).rejects.toMatchObject({ code: 'SUSPENDED_BY_OWNER' });
    expect((await api.rawUser(x.id))!.status).toBe('SUSPENDED');
    await expect(api.auth.login({ identifier: 'sr-g1', password: PW })).rejects.toBeDefined();
    await login('mmansary');
    await api.users.reactivate(x.id, { scope: 'global' });
    expect(await api.rawUser(x.id)).toMatchObject({ status: 'ACTIVE', suspendedGlobally: false });
  });

  it('G2: admin of A cannot reactivate a globally suspended OWNER (FORBIDDEN, like suspend)', async () => {
    await login('mmansary');
    const o2 = await api.owners.add({ username: 'sr-owner2', fullName: 'مالك ثان للمراجعة', email: 'sr-owner2@x.example', mobile: '0558119990', nationalId: vid('107799901'), password: PW, mustChangePassword: false } as never);
    await api.workspaces.addAdmin(A, { userId: o2.id } as never);
    await api.users.suspend(o2.id, { scope: 'global' } as never);
    await login('admin1');
    await expect(api.users.suspend(o2.id, {} as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.users.reactivate(o2.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await api.rawUser(o2.id))!.status).toBe('SUSPENDED');
  });

  it('a suspension that only cascaded from A (the last membership) is still lifted by A’s admin', async () => {
    await login('mmansary');
    const y = await mkUser('casc', [A]);
    await login('admin1');
    await api.users.suspend(y.id, {} as never);
    expect(await api.rawUser(y.id)).toMatchObject({ status: 'SUSPENDED' });
    await api.users.reactivate(y.id);
    expect((await api.rawUser(y.id))!.status).toBe('ACTIVE');
  });
});

describe('M2 — the global profile photo follows the account rule', () => {
  it('G3: admin of A cannot replace or remove the photo of a person who is also in B (USER_IN_OTHER_WORKSPACES)', async () => {
    await login('mmansary');
    const y = await mkUser('g3', [A, B]);
    await login('admin1');
    await expect(api.users.update(y.id, { fullName: 'تغيير' } as never)).rejects.toMatchObject({ code: 'USER_IN_OTHER_WORKSPACES' });
    await expect(api.photos.upload({ kind: 'user', id: y.id }, jpeg())).rejects.toMatchObject({ code: 'USER_IN_OTHER_WORKSPACES' });
    await expect(api.photos.remove({ kind: 'user', id: y.id })).rejects.toMatchObject({ code: 'USER_IN_OTHER_WORKSPACES' });
    expect((await api.rawUser(y.id))!.photoFileId ?? null).toBeNull();
    // an A-only person: still the admin's to manage
    await login('mmansary');
    const solo = await mkUser('solo', [A]);
    await login('admin1');
    const { fileId } = await api.photos.upload({ kind: 'user', id: solo.id }, jpeg());
    expect((await api.rawUser(solo.id))!.photoFileId).toBe(fileId);
  });

  it('G4: admin of A cannot replace the OWNER’s photo', async () => {
    await login('admin1');
    await expect(api.photos.upload({ kind: 'user', id: ownerId }, jpeg())).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/) });
    expect((await api.rawUser(ownerId))!.photoFileId ?? null).toBeNull();
  });

  it('G5: admin of A cannot change the photo of a FORMER member who now belongs only to B (NOT_FOUND, like the API)', async () => {
    await login('mmansary');
    const z = await mkUser('g5', [A, B]);
    const m = (await api.workspaces.members(A)).find((r) => r.user.id === z.id)!;
    await api.workspaces.removeMember(A, m.id);
    await login('admin1');
    await expect(api.users.get(z.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.photos.upload({ kind: 'user', id: z.id }, jpeg())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.rawUser(z.id))!.photoFileId ?? null).toBeNull();
  });
});

describe('M1 — owner account changes are account-level audit entries', () => {
  it('an owner’s edit of a B-only person is not in A’s audit; owners read it with scope=account; admins may not', async () => {
    await login('mmansary');
    await enter(A);
    const y = await mkUser('m1', [B]);
    await api.users.update(y.id, { email: 'sr-m1-changed@x.example' } as never);
    await login('admin1');
    const inA = JSON.stringify(await api.audit.list({ pageSize: 200 }));
    expect(inA).not.toContain('sr-m1-changed@x.example');
    expect(inA).not.toContain('حساب المراجعة m1');
    await expect(api.audit.list({ scope: 'account' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await login('mmansary');
    await enter(A);
    const acct = JSON.stringify(await api.audit.list({ scope: 'account', pageSize: 200 }));
    expect(acct).toContain('sr-m1-changed@x.example');
  });
});

describe('M3 — notifications reach live members only', () => {
  it('a person removed from A gets no notification of A any more', async () => {
    await login('mmansary');
    await enter(A);
    const x = await mkUser('m3', [A, B]);
    const m = (await api.workspaces.members(A)).find((r) => r.user.id === x.id)!;
    await api.workspaces.removeMember(A, m.id);
    expect(await api.notify(x.id, 'TASK_OVERDUE', { taskName: 'مهمة' })).toBeUndefined();
    const stay = await mkUser('m3stay', [A]);
    expect(await api.notify(stay.id, 'TASK_OVERDUE', { taskName: 'مهمة' })).toBeTruthy();
  });
});

describe('L1 — the add-member lookup and the registration reveal nothing', () => {
  it('admin of A learns only THAT another role exists; a suspended account looks unknown', async () => {
    await login('mmansary');
    await mkUser('l1', [B]);
    await login('admin1');
    const err = await api.workspaces.addMember(A, { identifier: 'sr-l1', role: 'MEMBER' } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DUAL_ROLE_CONFIRM_REQUIRED', details: { roles: [], otherWorkspaces: true } });
    await login('mmansary');
    const sus = await mkUser('l1sus', [B]);
    await enter(B);
    await api.users.suspend(sus.id, {} as never);
    await login('admin1');
    await expect(api.workspaces.addMember(A, { identifier: 'sr-l1sus', role: 'MEMBER' } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a registration with a taken username gets the same answer, and a free variant of the name', async () => {
    api.setAccessToken(null);
    const r = await api.auth.register({
      workspaceId: A,
      accountType: 'MONITOR',
      fullName: 'متقدّم للمراجعة',
      email: 'sr-applicant@x.example',
      mobile: '0558119966',
      nationalId: vid('107799661'),
      password: PW,
      username: 'admin1',
    } as never);
    expect(r).toEqual({ status: 'PENDING' });
    const row = await api.rawUserBy('email', 'sr-applicant@x.example');
    expect(row?.username).toBe('admin12');
  });
});

describe('M5 — a person with roles in A and B, working in A, sees nothing of B', () => {
  it('notifications, participations and the session show A only (the reviewer’s dual-member test)', async () => {
    const MARK = 'سرّيبمزدوج';
    await login('mmansary');
    const d = await api.users.create({
      username: 'sr-dual', fullName: 'مزدوج المراجعة', email: 'sr-dual@x.example', mobile: '0558119977',
      nationalId: vid('107799770'), password: PW, mustChangePassword: false, confirmDualRole: true,
      memberships: [{ workspaceId: A, role: 'MONITOR' }, { workspaceId: B, role: 'MONITOR' }],
    } as never);
    await enter(B);
    const p = await api.projects.create({ name: 'مشروع ' + MARK, startDate: '2026-11-01' });
    await api.participants.add(p.id, { userId: d.id, title: 'منصب ' + MARK, level: 'EDITOR' } as never);
    await login('sr-dual', PW);
    await enter(A);
    const text = JSON.stringify([await api.notifications.list({}), await api.notifications.unreadCount(), await api.me.participations(), await api.auth.me()]);
    expect(text).not.toContain(MARK);
    expect(text).not.toContain(p.id);
    await enter(B);
    expect(JSON.stringify(await api.notifications.list({}))).toContain(MARK);
  });
});
