import { describe, expect, it } from 'vitest';
import {
  can,
  isClockDriftSuspect,
  isValidNationalId,
  maskNationalId,
  nationalIdCheckDigit,
  normalizeSaudiMobile,
  PERMISSIONS,
  registerSchema,
  resolveTeamAt,
  ROLE_PERMISSIONS,
  toWesternDigits,
} from './index';

const withCheck = (first9: string) => first9 + nationalIdCheckDigit(first9);

describe('national ID', () => {
  it('accepts valid citizen and resident numbers', () => {
    expect(isValidNationalId(withCheck('100000000'))).toBe(true);
    expect(isValidNationalId(withCheck('123456789'))).toBe(true);
    expect(isValidNationalId(withCheck('298765432'))).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    const good = withCheck('123456789');
    const bad = good.slice(0, 9) + ((Number(good[9]) + 1) % 10);
    expect(isValidNationalId(bad)).toBe(false);
  });

  it('rejects wrong prefix and length', () => {
    expect(isValidNationalId('3' + withCheck('123456789').slice(1))).toBe(false);
    expect(isValidNationalId('12345')).toBe(false);
    expect(isValidNationalId('')).toBe(false);
  });

  it('accepts Arabic-Indic digits', () => {
    const id = withCheck('110000000');
    const arabic = id.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect(toWesternDigits(arabic)).toBe(id);
    expect(isValidNationalId(arabic)).toBe(true);
  });

  it('masks as 1•••••••23', () => {
    expect(maskNationalId('1234567823')).toBe('1•••••••23');
    expect(maskNationalId(null)).toBe('');
  });
});

describe('Saudi mobile', () => {
  it.each([
    ['0512345678', '+966512345678'],
    ['512345678', '+966512345678'],
    ['+966512345678', '+966512345678'],
    ['966512345678', '+966512345678'],
    ['00966512345678', '+966512345678'],
    ['05 1234 5678', '+966512345678'],
    ['٠٥١٢٣٤٥٦٧٨', '+966512345678'],
  ])('normalises %s', (input, out) => {
    expect(normalizeSaudiMobile(input)).toBe(out);
  });

  it.each(['0412345678', '+966412345678', '051234567', '+971512345678', 'abc'])('rejects %s', (v) => {
    expect(normalizeSaudiMobile(v)).toBeNull();
  });
});

describe('permission matrix', () => {
  it('gives admins every permission', () => {
    for (const p of PERMISSIONS) expect(can({ role: 'ADMIN', status: 'ACTIVE' }, p)).toBe(true);
  });

  it('denies everything to non-active users', () => {
    expect(can({ role: 'ADMIN', status: 'PENDING' }, 'users.read')).toBe(false);
    expect(can({ role: 'ADMIN', status: 'SUSPENDED' }, 'users.read')).toBe(false);
  });

  it('keeps monitors to violations they record', () => {
    const m = { role: 'MONITOR' as const, status: 'ACTIVE' };
    expect(can(m, 'violations.create')).toBe(true);
    expect(can(m, 'violations.readRecorded')).toBe(true);
    expect(can(m, 'violations.readAll')).toBe(false);
    expect(can(m, 'teams.readAll')).toBe(false);
    expect(can(m, 'tasks.readAssigned')).toBe(false);
  });

  it('lets supervisors create their own team but not approve teams', () => {
    const s = { role: 'SUPERVISOR' as const, status: 'ACTIVE' };
    expect(can(s, 'teams.createOwn')).toBe(true);
    expect(can(s, 'teams.approve')).toBe(false);
    expect(can(s, 'violations.create')).toBe(false);
    expect(can(s, 'users.manageRoles')).toBe(false);
  });

  it('only references known permissions', () => {
    const all = new Set<string>(PERMISSIONS);
    for (const set of Object.values(ROLE_PERMISSIONS)) for (const p of set) expect(all.has(p)).toBe(true);
  });
});

describe('membership snapshot', () => {
  const history = [
    { teamId: 'A', validFrom: '2026-01-01T00:00:00Z', validTo: '2026-03-01T08:00:00Z' },
    { teamId: 'B', validFrom: '2026-03-01T08:00:00Z', validTo: null },
  ];

  it('returns the team at the violation time, not the current one', () => {
    expect(resolveTeamAt(history, '2026-02-15T10:00:00Z')?.teamId).toBe('A');
    expect(resolveTeamAt(history, '2026-03-01T07:59:59Z')?.teamId).toBe('A');
    expect(resolveTeamAt(history, '2026-03-01T08:00:00Z')?.teamId).toBe('B');
    expect(resolveTeamAt(history, '2027-01-01T00:00:00Z')?.teamId).toBe('B');
  });

  it('returns null before the first membership', () => {
    expect(resolveTeamAt(history, '2025-12-31T23:59:59Z')).toBeNull();
  });
});

describe('clock drift', () => {
  const receivedAt = '2026-10-11T12:00:00Z';
  it('does not flag a violation that waited offline', () => {
    expect(
      isClockDriftSuspect({ capturedAt: '2026-10-11T06:00:00Z', receivedAt, clientSentAt: '2026-10-11T12:00:30Z', thresholdMinutes: 10 }),
    ).toBe(false);
  });
  it('flags a device clock that is off', () => {
    expect(
      isClockDriftSuspect({ capturedAt: '2026-10-11T06:00:00Z', receivedAt, clientSentAt: '2026-10-11T11:00:00Z', thresholdMinutes: 10 }),
    ).toBe(true);
    expect(isClockDriftSuspect({ capturedAt: '2026-10-11T13:00:00Z', receivedAt, thresholdMinutes: 10 })).toBe(true);
  });
});

describe('register schema', () => {
  it('normalises the mobile and validates the ID', () => {
    const r = registerSchema.safeParse({
      accountType: 'MONITOR',
      fullName: 'مستخدم تجريبي',
      email: 'Demo@Example.com',
      mobile: '0512345678',
      nationalId: withCheck('123456789'),
      password: 'Password123',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mobile).toBe('+966512345678');
      expect(r.data.email).toBe('demo@example.com');
    }
  });

  it('rejects ADMIN self-registration', () => {
    const r = registerSchema.safeParse({ accountType: 'ADMIN' });
    expect(r.success).toBe(false);
  });
});
