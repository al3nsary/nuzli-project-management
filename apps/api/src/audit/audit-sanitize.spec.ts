import { sanitizeForAudit } from './audit-sanitize';
import { AuditAction, endOf } from './audit.service';

describe('sanitizeForAudit', () => {
  it('masks national IDs, drops secrets and buffers, keeps the rest', () => {
    const out = sanitizeForAudit({
      id: 'u1',
      nationalId: '1234567823',
      passwordHash: '$argon2id$...',
      nationalIdEnc: Buffer.from('x'),
      nested: { national_id: '2234567890', token: 'abc', role: 'ADMIN' },
      at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(out).toEqual({
      id: 'u1',
      nationalId: '1•••••••23',
      nested: { national_id: '2•••••••90', role: 'ADMIN' },
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toContain('1234567823');
  });
});


describe('audit query and vocabulary', () => {
  it('a bare date as `to` covers the whole day (UTC)', () => {
    expect(endOf('2026-10-12').toISOString()).toBe('2026-10-12T23:59:59.999Z');
    expect(endOf('2026-10-12T05:00:00Z').toISOString()).toBe('2026-10-12T05:00:00.000Z');
  });

  it('uses the Phase 1 action names agreed with the web app (ADR-028)', () => {
    expect(Object.values(AuditAction)).toEqual(
      expect.arrayContaining([
        'registration.requested', 'registration.approved', 'registration.rejected',
        'user.created', 'user.role_changed', 'user.suspended', 'user.reactivated',
        'settings.updated', 'auth.password_changed',
      ]),
    );
  });
});
