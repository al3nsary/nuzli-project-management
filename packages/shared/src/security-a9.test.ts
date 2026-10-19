import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, ERRORS, SETTINGS_SCHEMA, VIEW_PREF_MAX_COUNT } from './index';

describe('security review A9 additions (ADR-117..120)', () => {
  it('M1: the registration window from a violation is a setting, 30 days by default, 1–365', () => {
    expect(DEFAULT_SETTINGS.VIOLATION_REGISTER_MAX_AGE_DAYS).toBe(30);
    expect(SETTINGS_SCHEMA.shape.VIOLATION_REGISTER_MAX_AGE_DAYS.safeParse(0).success).toBe(false);
    expect(SETTINGS_SCHEMA.shape.VIOLATION_REGISTER_MAX_AGE_DAYS.safeParse(366).success).toBe(false);
    expect(ERRORS.VIOLATION_TOO_OLD_TO_REGISTER).toMatch(/[؀-ۿ]/);
  });

  it('L1: view preferences are capped per user, with an Arabic message', () => {
    expect(VIEW_PREF_MAX_COUNT).toBe(200);
    expect(ERRORS.VIEW_PREF_LIMIT).toContain('٢٠٠');
  });
});
