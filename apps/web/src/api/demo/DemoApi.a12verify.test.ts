/**
 * Defects found by the A12 browser verification (docs/A12-verification.md) — demo parity with the
 * server.
 */
import { describe, expect, it } from 'vitest';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

describe('D3 — change password answers like the server', () => {
  it('a wrong current password says so (not «username or password»), and the new one must differ', async () => {
    const api = new DemoApi({ dbName: `nuzli-a12v-${Math.random()}` });
    const s = await api.auth.login({ identifier: 'admin1', password: DEMO_PASSWORD });
    api.setAccessToken(s.accessToken);

    const wrong = await errorOf(api.auth.changePassword({ currentPassword: 'Not-The-Pass-2026', newPassword: 'Brand-New-Pass-2026' }));
    expect(wrong.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(wrong.details)).toContain('كلمة المرور الحالية غير صحيحة');
    expect(JSON.stringify(wrong.details)).not.toContain('اسم المستخدم');

    const same = await errorOf(api.auth.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: DEMO_PASSWORD }));
    expect(same.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(same.details)).toContain('اختر كلمة مرور مختلفة عن الحالية');
  });
});
