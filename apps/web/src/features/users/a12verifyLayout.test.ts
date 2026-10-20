/**
 * A12 verification D4 / D1 (visual, re-verified in Chrome): the username field carries a long hint,
 * so the first row of «إنشاء مستخدم» and «حساب جديد» (owners) aligns both inputs on their baseline;
 * the «كل الحسابات» name column keeps a minimum width so Arabic names do not wrap onto three lines.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('account forms layout', () => {
  it('the username row aligns its inputs at the end (create user, new owner)', () => {
    for (const file of ['features/users/dialogs.tsx', 'pages/system/OwnersPage.tsx']) {
      const s = src(file);
      const hint = s.indexOf("description={t('a12admin.usernameHint')}");
      const grid = s.lastIndexOf('<SimpleGrid', hint);
      expect(s.slice(grid, hint)).toContain("style={{ alignItems: 'end' }}");
    }
  });

  it('«كل الحسابات» gives the name column a minimum width', () => {
    expect(src('pages/system/AccountsPage.tsx')).toContain("<Table.Th miw={230}>{t('users.col.name')}</Table.Th>");
  });
});
