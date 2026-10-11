/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ar } from './ar';
import { en } from './en';
import {
  formatDate,
  formatNumber,
  interpolate,
  localizeDigits,
  setDisplayPrefs,
  t,
  tKey,
} from './index';

afterEach(() => setDisplayPrefs({ digits: 'latn', showHijri: false }));

describe('t()', () => {
  it('fills placeholders', () => {
    expect(t('dash.welcome', { name: 'نورة' })).toBe('أهلًا، نورة');
    expect(t('users.roleBody', { from: 'مشرف', to: 'مدير النظام' })).toContain(
      'من «مشرف» إلى «مدير النظام»',
    );
  });

  it('formats numeric placeholders with the user digit preference', () => {
    expect(t('common.total', { count: 12 })).toBe('الإجمالي: 12');
    setDisplayPrefs({ digits: 'arab' });
    expect(t('common.total', { count: 12 })).toBe('الإجمالي: ١٢');
  });

  it('leaves unknown placeholders visible', () => {
    expect(interpolate('مرحبًا {who}', {})).toBe('مرحبًا {who}');
  });

  it('falls back instead of showing a raw code', () => {
    expect(tKey('role.ADMIN', 'common.none')).toBe('مدير النظام');
    expect(tKey('audit.action.something.new', 'audit.action.other')).toBe('إجراء آخر');
  });

  it('ar and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
  });
});

describe('number and date formatting', () => {
  it('uses Western digits by default', () => {
    expect(formatNumber(1234567)).toMatch(/^1.?234.?567$/);
  });

  it('uses Arabic-Indic digits when chosen', () => {
    const s = formatNumber(1234567, { digits: 'arab' });
    expect(s).toMatch(/^[٠-٩٬]+$/);
    expect(s.replace(/٬/g, '')).toBe('١٢٣٤٥٦٧');
    expect(localizeDigits('1•••••••23', { digits: 'arab' })).toBe('١•••••••٢٣');
  });

  it('formats dates in Asia/Riyadh, Gregorian by default, with optional Hijri', () => {
    // 2026-10-11T22:30Z is already 12 October in Riyadh (UTC+3).
    const greg = formatDate('2026-10-11T22:30:00Z');
    expect(greg).toContain('12');
    expect(greg).toContain('2026');
    const both = formatDate('2026-10-11T22:30:00Z', { showHijri: true });
    expect(both).toMatch(/\(.*14\d\d.*\)/);
  });
});

describe('scripts/check-i18n.mjs', () => {
  it('passes on the current source', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-i18n.mjs')], {
      encoding: 'utf8',
    });
    expect(out).toContain('i18n check passed');
  });
});
