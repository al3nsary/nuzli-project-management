import { describe, expect, it } from 'vitest';
import {
  can,
  isClockDriftSuspect,
  isFullNationalIdTerm,
  memberSearchSchema,
  userSearchSchema,
  isValidNationalId,
  maskNationalId,
  maskNationalIdParts,
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

  it('masks from stored parts without decrypting', () => {
    expect(maskNationalIdParts('1', '23')).toBe('1•••••••23');
    expect(maskNationalIdParts('2', '4523')).toBe('2•••••••23');
    expect(maskNationalIdParts('', '23')).toBe('');
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

describe('national-ID search terms stay out of URLs (security review L4)', () => {
  it('flags a full 10-digit ID (Western or Arabic-Indic digits, with spaces) but not last-4 or names', () => {
    expect(isFullNationalIdTerm('1234567890')).toBe(true);
    expect(isFullNationalIdTerm('١٢٣٤٥٦٧٨٩٠')).toBe(true);
    expect(isFullNationalIdTerm('12345 67890')).toBe(true);
    expect(isFullNationalIdTerm('7890')).toBe(false);
    expect(isFullNationalIdTerm('0551234567')).toBe(false);
    expect(isFullNationalIdTerm('+966512345678')).toBe(false);
    expect(isFullNationalIdTerm('محمد')).toBe(false);
    expect(isFullNationalIdTerm(undefined)).toBe(false);
  });

  it('POST search bodies accept the list filters', () => {
    expect(memberSearchSchema.parse({ q: '1234567890' })).toMatchObject({ page: 1, pageSize: 25, unassigned: false });
    expect(userSearchSchema.parse({ q: 'x', role: 'ADMIN' }).role).toBe('ADMIN');
    expect(userSearchSchema.safeParse({ role: 'ROOT' }).success).toBe(false);
  });
});

describe('personal photos (owner request A8)', () => {
  it('cards reserve a photo area by default', async () => {
    const { cardTemplateConfigSchema } = await import('./index');
    expect(cardTemplateConfigSchema.parse({}).fields.photo).toBe(true);
    expect(cardTemplateConfigSchema.parse({ fields: { photo: false } }).fields.photo).toBe(false);
  });

  it('presign accepts user and member photos, images only, and the photo cap is 2 MB', async () => {
    const { presignUploadSchema, PHOTO_MAX_BYTES } = await import('./index');
    const base = { entityId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', kind: 'PHOTO', sizeBytes: 1000 };
    expect(presignUploadSchema.safeParse({ ...base, entityType: 'user_photo', contentType: 'image/webp' }).success).toBe(true);
    expect(presignUploadSchema.safeParse({ ...base, entityType: 'member_photo', contentType: 'image/jpeg' }).success).toBe(true);
    expect(presignUploadSchema.safeParse({ ...base, entityType: 'user_photo', contentType: 'image/svg+xml' }).success).toBe(false);
    expect(PHOTO_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
