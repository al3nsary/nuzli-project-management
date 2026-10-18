import { Prisma } from '@prisma/client';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { AuthService } from './auth.service';
import { delayAfter, LoginThrottleService, THROTTLE_POLICIES } from './login-throttle';

const crypto = new CryptoService({ encKey: randomBytes(32).toString('base64'), hmacKey: randomBytes(32).toString('base64') });
const ctx = (ip = '203.0.113.7'): RequestContext => ({ actorId: null, ip, requestId: 'r1', userAgent: null });
const cfg = { LOGIN_MAX_FAILURES: 10, LOGIN_LOCK_MINUTES: 5, PUBLIC_WEB_URL: 'https://nuzli.example.sa' };
const flush = () => new Promise((r) => setImmediate(r));

const USER = {
  id: 'u1',
  fullName: 'خالد',
  email: 'khaled@example.sa',
  mobile: '+966551234567',
  nationalIdEnc: crypto.encrypt('1000000023'),
  nationalIdFirst: '1',
  nationalIdLast2: '23',
  role: 'ADMIN',
  requestedRole: null,
  requestedTeamName: null,
  status: 'ACTIVE',
  rejectionReason: null,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  preferences: {},
  passwordHash: 'hash:Correct-Pass-1',
  lockedUntil: null as Date | null,
  failedLoginCount: 0,
};

async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

function setup(opts: { user?: Partial<typeof USER> | null; existing?: Array<{ id: string; email: string; fullName: string }> } = {}) {
  let failed = opts.user === null ? 0 : (opts.user?.failedLoginCount ?? 0);
  const user = opts.user === null ? null : { ...USER, ...opts.user };
  const tx = {
    user: { create: jest.fn().mockResolvedValue({ ...USER, id: 'new', status: 'PENDING' }), update: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      findMany: jest.fn().mockResolvedValue(opts.existing ?? []),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (data.failedLoginCount && typeof data.failedLoginCount === 'object') failed += 1;
        else if (data.failedLoginCount === 0) failed = 0;
        return Promise.resolve({ ...user, failedLoginCount: failed });
      }),
    },
    auditLog: tx.auditLog,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const passwords = {
    hash: jest.fn((p: string) => Promise.resolve(`hash:${p}`)),
    verify: jest.fn((h: string | null, p: string) => Promise.resolve(h === `hash:${p}`)),
  };
  const access = { sign: jest.fn(() => 'jwt'), ttlSeconds: 900 };
  const refreshTokens = { issue: jest.fn().mockResolvedValue({ token: 'rt' }), revokeAllForUser: jest.fn() };
  const notifications = { notifyAdmins: jest.fn().mockResolvedValue(undefined) };
  const mail = { send: jest.fn().mockResolvedValue(undefined) };
  let now = Date.parse('2026-10-12T08:00:00Z');
  const throttle = new LoginThrottleService(() => now);
  const auth = new AuthService(
    prisma as never,
    cfg as never,
    crypto,
    passwords as never,
    access as never,
    refreshTokens as never,
    new AuditService(prisma as never),
    notifications as never,
    mail as never,
    throttle,
  );
  return { auth, prisma, tx, mail, notifications, advance: (ms: number) => (now += ms), throttle };
}

const registration = {
  accountType: 'MONITOR' as const,
  fullName: 'متقدم جديد',
  email: 'new@example.sa',
  mobile: '+966559876543',
  nationalId: '123456789' + nationalIdCheckDigit('123456789'),
  password: 'Monitor12345',
};

describe('registration does not reveal existing accounts (security review M4)', () => {
  it('a new applicant is created as PENDING and the admins are notified', async () => {
    const s = setup();
    await expect(s.auth.register(registration, ctx())).resolves.toEqual({ status: 'PENDING' });
    expect(s.tx.user.create).toHaveBeenCalled();
    expect(s.notifications.notifyAdmins).toHaveBeenCalledWith('REGISTRATION_REQUESTED', expect.anything());
  });

  it('a duplicate e-mail / mobile / national ID answers the same PENDING, creates nothing and e-mails the owner', async () => {
    const owner = { id: 'u1', email: 'khaled@example.sa', fullName: 'خالد' };
    const s = setup({ existing: [owner] });
    await expect(s.auth.register(registration, ctx())).resolves.toEqual({ status: 'PENDING' });
    await flush();
    expect(s.tx.user.create).not.toHaveBeenCalled();
    expect(s.notifications.notifyAdmins).not.toHaveBeenCalled();
    expect(s.mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: owner.email, subject: expect.stringContaining('محاولة تسجيل') }));
    const where = s.prisma.user.findMany.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { email: registration.email },
      { mobile: registration.mobile },
      { nationalIdHash: crypto.blindIndex(registration.nationalId) },
    ]);
    const audit = s.tx.auditLog.create.mock.calls.map((c) => c[0].data);
    expect(audit).toEqual([expect.objectContaining({ action: 'registration.duplicate_attempt', entityId: 'u1' })]);
    expect(JSON.stringify(audit)).not.toContain(registration.nationalId);
  });

  it('a unique-index race (P2002) is answered the same way', async () => {
    const s = setup();
    s.tx.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5', meta: { target: ['email'] } }),
    );
    s.prisma.user.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'u9', email: 'x@example.sa', fullName: 'x' }]);
    await expect(s.auth.register(registration, ctx())).resolves.toEqual({ status: 'PENDING' });
    await flush();
    expect(s.mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'x@example.sa' }));
  });
});

describe('login throttling and lockout (security review M5)', () => {
  it('unknown account, wrong password and locked account all answer INVALID_CREDENTIALS', async () => {
    expect(await code(setup({ user: null }).auth.login('ghost@example.sa', 'whatever-1', ctx()))).toBe('INVALID_CREDENTIALS');
    expect(await code(setup().auth.login(USER.email, 'wrong-pass-1', ctx()))).toBe('INVALID_CREDENTIALS');
    // Locked for another hour from now (a fixed date here expired on 2026-10-12).
    const locked = setup({ user: { lockedUntil: new Date(Date.now() + 3_600_000) } });
    // Even the right password: a locked account never says "locked".
    expect(await code(locked.auth.login(USER.email, 'Correct-Pass-1', ctx()))).toBe('INVALID_CREDENTIALS');
  });

  it('reaching LOGIN_MAX_FAILURES locks briefly, audits auth.account_locked and e-mails the owner', async () => {
    const s = setup({ user: { failedLoginCount: 9 } });
    expect(await code(s.auth.login(USER.email, 'wrong-pass-1', ctx()))).toBe('INVALID_CREDENTIALS');
    await flush();
    const lock = s.prisma.user.update.mock.calls.map((c) => c[0].data).find((d) => d.lockedUntil);
    expect((lock!.lockedUntil as Date).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
    expect(s.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'auth.account_locked', entityId: 'u1' }) });
    expect(s.mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: USER.email }));
  });

  it('per-identifier delay applies to unknown accounts too and is capped at 60 s (no permanent lockout)', async () => {
    const s = setup({ user: null });
    for (let i = 0; i < THROTTLE_POLICIES.ident.free; i++) {
      // A different IP each time: only the identifier bucket grows.
      expect(await code(s.auth.login('ghost@example.sa', 'x-wrong-1', ctx(`198.51.100.${i}`)))).toBe('INVALID_CREDENTIALS');
    }
    await code(s.auth.login('ghost@example.sa', 'x-wrong-1', ctx('198.51.100.50')));
    expect(await code(s.auth.login('ghost@example.sa', 'x-wrong-1', ctx('198.51.100.51')))).toBe('RATE_LIMITED');
    s.advance(THROTTLE_POLICIES.ident.maxMs + 1);
    expect(await code(s.auth.login('ghost@example.sa', 'x-wrong-1', ctx('198.51.100.52')))).toBe('INVALID_CREDENTIALS');
  });

  it('one IP spraying many accounts is slowed down by its IP bucket', async () => {
    const s = setup({ user: null });
    for (let i = 0; i <= THROTTLE_POLICIES.ip.free; i++) await code(s.auth.login(`user${i}@example.sa`, 'x-wrong-1', ctx()));
    expect(await code(s.auth.login('fresh@example.sa', 'x-wrong-1', ctx()))).toBe('RATE_LIMITED');
    // Another address is unaffected.
    expect(await code(s.auth.login('fresh@example.sa', 'x-wrong-1', ctx('192.0.2.1')))).toBe('INVALID_CREDENTIALS');
  });

  it('the delay grows exponentially and is capped per bucket', () => {
    expect(delayAfter(THROTTLE_POLICIES.pair, 3)).toBe(0);
    expect(delayAfter(THROTTLE_POLICIES.pair, 4)).toBe(1000);
    expect(delayAfter(THROTTLE_POLICIES.pair, 6)).toBe(4000);
    expect(delayAfter(THROTTLE_POLICIES.ident, 50)).toBe(60_000);
    expect(delayAfter(THROTTLE_POLICIES.ip, 200)).toBe(15 * 60_000);
  });

  it('a correct password clears the account buckets and the failure counter', async () => {
    const s = setup();
    await code(s.auth.login(USER.email, 'wrong-pass-1', ctx()));
    await expect(s.auth.login(USER.email, 'Correct-Pass-1', ctx())).resolves.toMatchObject({ refreshToken: 'rt' });
    expect(s.prisma.user.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }) }),
    );
  });
});

describe('a password reset lifts the lock and the delays (security review M5)', () => {
  it('delays follow the account whatever the spelling, and a reset clears them at once', async () => {
    const s = setup();
    for (let i = 0; i < 8; i++) await code(s.auth.login('0551234567', 'wrong-pass-1', ctx()));
    expect(await code(s.auth.login('+966551234567', 'Correct-Pass-1', ctx()))).toBe('RATE_LIMITED');
    const prisma = s.prisma as unknown as Record<string, unknown>;
    prisma.actionToken = {
      findUnique: jest.fn().mockResolvedValue({ id: 't1', userId: 'u1', purpose: 'RESET_PASSWORD', usedAt: null, expiresAt: new Date(Date.now() + 60_000) }),
    };
    (s.tx as unknown as Record<string, unknown>).actionToken = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    s.tx.user.update.mockResolvedValue({});
    await s.auth.resetPassword('token', 'Correct-Pass-1', ctx());
    expect(s.tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lockedUntil: null, failedLoginCount: 0 }) }));
    await expect(s.auth.login('+966551234567', 'Correct-Pass-1', ctx())).resolves.toMatchObject({ refreshToken: 'rt' });
  });
});

describe('change-password counts wrong current passwords (security review L8)', () => {
  it('a wrong current password increments the account counter and the throttle', async () => {
    const s = setup();
    const err = (await s.auth.changePassword('u1', 'wrong-pass-1', 'New-Pass-123', ctx()).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(s.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedLoginCount: { increment: 1 } } }));
  });

  it('repeated wrong guesses with a stolen token hit RATE_LIMITED, then lock the account', async () => {
    const s = setup({ user: { failedLoginCount: 0 } });
    let last = '';
    for (let i = 0; i < 12 && last !== 'RATE_LIMITED'; i++) {
      last = await code(s.auth.changePassword('u1', `wrong-pass-${i}`, 'New-Pass-123', ctx()));
    }
    expect(last).toBe('RATE_LIMITED');
  });
});
