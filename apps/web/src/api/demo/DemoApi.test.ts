import { beforeEach, describe, expect, it } from 'vitest';
import { ERRORS, nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';

let n = 0;
let api: DemoApi;

beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-test-${Date.now()}-${n++}` });
});

const ADMIN1 = 'admin1@demo.nuzli.example';
const ADMIN2 = 'admin2@demo.nuzli.example';
const PENDING = 'applicant1@demo.nuzli.example';

async function loginAs(identifier: string, password = DEMO_PASSWORD) {
  const s = await api.auth.login({ identifier, password });
  api.setAccessToken(s.accessToken);
  return s;
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

function validId(first9: string) {
  return first9 + nationalIdCheckDigit(first9);
}

describe('DemoApi — same rules as the real API', () => {
  it('rejects a PENDING account at login with the Arabic message', async () => {
    const err = await expectCode(
      api.auth.login({ identifier: PENDING, password: DEMO_PASSWORD }),
      'ACCOUNT_PENDING',
    );
    expect(err.message_ar).toBe(ERRORS.ACCOUNT_PENDING);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await expectCode(
      api.auth.login({ identifier: ADMIN1, password: 'wrong-password-1' }),
      'INVALID_CREDENTIALS',
    );
    await expectCode(
      api.auth.login({ identifier: 'nobody@demo.nuzli.example', password: 'x' }),
      'INVALID_CREDENTIALS',
    );
  });

  it('accepts login by Saudi mobile in local format', async () => {
    const s = await api.auth.login({ identifier: '0550000101', password: DEMO_PASSWORD });
    expect(s.user.email).toBe(ADMIN1);
  });

  it('register → cannot log in → admin approves (role changed) → logs in; admins notified; audit written', async () => {
    const reg = {
      accountType: 'SUPERVISOR' as const,
      fullName: 'مستخدم اختبار جديد',
      email: 'new.supervisor@demo.nuzli.example',
      mobile: '0559998877',
      nationalId: validId('112233445'),
      password: 'Password12345',
    };
    expect(await api.auth.register(reg)).toEqual({ status: 'PENDING' });
    await expectCode(
      api.auth.login({ identifier: reg.email, password: reg.password }),
      'ACCOUNT_PENDING',
    );

    await loginAs(ADMIN1);
    const notes = await api.notifications.list({ unread: true, pageSize: 50 });
    expect(
      notes.items.some(
        (x) => x.type === 'REGISTRATION_REQUESTED' && x.payload.fullName === reg.fullName,
      ),
    ).toBe(true);

    const pending = await api.registrations.list({ pageSize: 50 });
    const target = pending.items.find((u) => u.email === reg.email);
    expect(target).toBeDefined();
    expect(target!.nationalId).toBeUndefined();
    expect(target!.nationalIdMasked).toMatch(/^1•{7}\d{2}$/);

    const approved = await api.registrations.approve(target!.id, { role: 'MONITOR' });
    expect(approved.status).toBe('ACTIVE');
    expect(approved.role).toBe('MONITOR');

    const audit = await api.audit.list({ action: 'registration.approved' });
    expect(audit.items[0]?.entityId).toBe(target!.id);
    expect(audit.items[0]?.actor?.fullName).toBeTruthy();
    expect(audit.items[0]?.after).toMatchObject({ status: 'ACTIVE', role: 'MONITOR' });

    api.setAccessToken(null);
    const s = await api.auth.login({ identifier: reg.email, password: reg.password });
    expect(s.user.role).toBe('MONITOR');
  });

  it('rejecting requires a reason and writes the audit entry', async () => {
    await loginAs(ADMIN1);
    const [first] = (await api.registrations.list()).items;
    await expectCode(
      api.registrations.reject(first!.id, { reason: '' }),
      'REJECTION_REASON_REQUIRED',
    );
    const rejected = await api.registrations.reject(first!.id, { reason: 'البيانات ناقصة' });
    expect(rejected.status).toBe('REJECTED');
    const audit = await api.audit.list({ action: 'registration.rejected' });
    expect(audit.items.some((a) => a.entityId === first!.id)).toBe(true);
    await expectCode(api.registrations.approve(first!.id, {}), 'NOT_PENDING');
  });

  it('protects the last active admin from demotion and suspension', async () => {
    // A12: the owner (mmansary) is also an admin of «إدارة المشاريع»; an owner removes that role first.
    await loginAs('mmansary');
    const ws = (await api.workspaces.list())[0]!;
    const ownerId = (await api.owners.list())[0]!.id;
    await api.workspaces.removeAdmin(ws.id, ownerId);
    const me = await loginAs(ADMIN1);
    const admins = await api.users.list({ role: 'ADMIN', status: 'ACTIVE' });
    const other = admins.items.find((u) => u.email === ADMIN2)!;

    // Two admins: demoting the other one is allowed and audited.
    const demoted = await api.users.changeRole(other.id, { role: 'SUPERVISOR' });
    expect(demoted.role).toBe('SUPERVISOR');
    const roleAudit = await api.audit.list({ action: 'user.role_changed' });
    expect(roleAudit.items[0]?.before).toEqual({ role: 'ADMIN' });

    // Now ADMIN1 is the last active admin.
    const e1 = await expectCode(
      api.users.changeRole(me.user.id, { role: 'MONITOR' }),
      'LAST_ADMIN',
    );
    expect(e1.message_ar).toBe(ERRORS.LAST_ADMIN);
    await expectCode(api.users.suspend(me.user.id, {}), 'LAST_ADMIN');

    // Promoting someone again makes it possible.
    await api.users.changeRole(other.id, { role: 'ADMIN' });
    const suspended = await api.users.suspend(me.user.id, { reason: 'اختبار' });
    expect(suspended.status).toBe('SUSPENDED');
  });

  it('suspension revokes sessions and blocks login', async () => {
    await loginAs(ADMIN1);
    const sup = (await api.users.list({ q: 'supervisor1@' })).items[0]!;
    await api.users.suspend(sup.id, {});
    api.setAccessToken(null);
    await expectCode(
      api.auth.login({ identifier: sup.email, password: DEMO_PASSWORD }),
      'ACCOUNT_SUSPENDED',
    );
    const audit = await (async () => {
      await loginAs(ADMIN1);
      return api.audit.list({ action: 'user.suspended' });
    })();
    expect(audit.items.some((a) => a.entityId === sup.id)).toBe(true);
  });

  it('public registration never reveals duplicates (ADR-063); admins still get *_TAKEN', async () => {
    const base = {
      accountType: 'MONITOR' as const,
      fullName: 'مكرر البيانات',
      email: ADMIN1,
      mobile: '0551112233',
      nationalId: validId('199887766'),
      password: 'Password12345',
    };
    await expect(api.auth.register(base)).resolves.toEqual({ status: 'PENDING' });
    const before = (await api.db.users.toArray()).length;
    await expect(
      api.auth.register({ ...base, email: 'x1@demo.nuzli.example', mobile: '0550000101' }),
    ).resolves.toEqual({ status: 'PENDING' });
    await expect(
      api.auth.register({ ...base, email: 'x2@demo.nuzli.example', nationalId: '1055123408' }),
    ).resolves.toEqual({ status: 'PENDING' });
    expect((await api.db.users.toArray()).length).toBe(before);

    await loginAs(ADMIN1);
    const err = await expectCode(
      api.users.create({
        fullName: 'مدير جديد',
        email: ADMIN2.toUpperCase(),
        mobile: '0551112299',
        nationalId: validId('177665544'),
        role: 'ADMIN',
      }),
      'EMAIL_TAKEN',
    );
    expect(err.fieldErrors.email).toBe(ERRORS.EMAIL_TAKEN);
    const dup = await api.audit.list({ action: 'registration.duplicate_attempt' });
    expect(dup.total).toBe(3);
    expect(JSON.stringify(dup.items)).not.toContain('1055123408');
  });

  it('admin creates another admin; the new account must change its password; creation is audited', async () => {
    await loginAs(ADMIN1);
    const created = await api.users.create({
      fullName: 'مدير ثالث تجريبي',
      email: 'admin3@demo.nuzli.example',
      mobile: '0551234000',
      nationalId: validId('123123123'),
      role: 'ADMIN',
    });
    expect(created.status).toBe('ACTIVE');
    expect(created.mustChangePassword).toBe(true);
    const audit = await api.audit.list({ action: 'user.created' });
    expect(audit.items[0]?.entityId).toBe(created.id);

    api.setAccessToken(null);
    await loginAs('admin3@demo.nuzli.example');
    await expectCode(api.users.list(), 'PASSWORD_CHANGE_REQUIRED');
    await api.auth.changePassword({
      currentPassword: DEMO_PASSWORD,
      newPassword: 'MyNewPassword9',
    });
    expect((await api.users.list()).total).toBeGreaterThan(0);
  });

  it('validates input with the shared zod schemas (Arabic field errors)', async () => {
    const err = await expectCode(
      api.auth.register({
        accountType: 'MONITOR',
        fullName: 'اسم',
        email: 'not-an-email',
        mobile: '123',
        nationalId: '1234567890',
        password: 'short',
      }),
      'VALIDATION_FAILED',
    );
    expect(err.fieldErrors.email).toBe('بريد إلكتروني غير صالح');
    expect(Object.keys(err.fieldErrors)).toEqual(
      expect.arrayContaining(['email', 'mobile', 'nationalId', 'password']),
    );
  });

  it('enforces permissions with can(): a supervisor cannot read users or the audit log', async () => {
    await loginAs('supervisor1@demo.nuzli.example');
    await expectCode(api.users.list(), 'FORBIDDEN');
    await expectCode(api.audit.list(), 'FORBIDDEN');
    await expectCode(api.settings.update({ VIOLATION_MAX_PHOTOS: 3 }), 'FORBIDDEN');
    expect((await api.settings.get()).VIOLATION_MAX_PHOTOS).toBe(5);
  });

  it('restores the session after a reload (refresh) and forgets it after logout', async () => {
    await loginAs(ADMIN1);
    const again = new DemoApi({ dbName: api.db.name });
    const restored = await again.auth.refresh();
    expect(restored?.user.email).toBe(ADMIN1);
    await again.auth.logout();
    expect(await new DemoApi({ dbName: api.db.name }).auth.refresh()).toBeNull();
  });

  it('settings changes are validated and audited', async () => {
    await loginAs(ADMIN1);
    await expectCode(api.settings.update({ VIOLATION_MAX_PHOTOS: 99 }), 'VALIDATION_FAILED');
    const next = await api.settings.update({ VIOLATION_MAX_PHOTOS: 7 });
    expect(next.VIOLATION_MAX_PHOTOS).toBe(7);
    const audit = await api.audit.list({ action: 'settings.updated' });
    expect(audit.items[0]?.after).toEqual({ VIOLATION_MAX_PHOTOS: 7 });
  });

  it('reset restores the seed', async () => {
    await loginAs(ADMIN1);
    const first = (await api.registrations.list()).items[0]!;
    await api.registrations.approve(first.id, {});
    await api.demo.reset();
    await loginAs(ADMIN1);
    expect((await api.registrations.list()).total).toBe(3);
  });
});
