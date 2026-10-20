import { describe, expect, it } from 'vitest';
import { can, effectiveRole, loginSchema, registerSchema, switchWorkspaceSchema, usernameSchema } from './index';

describe('A12 permissions per workspace', () => {
  it('OWNER holds every permission', () => {
    expect(can({ role: null, accountRole: 'OWNER', status: 'ACTIVE' }, 'cards.print')).toBe(true);
    expect(can({ role: null, accountRole: 'OWNER', status: 'SUSPENDED' }, 'cards.print')).toBe(false);
  });

  it('no role in the active workspace = nothing', () => {
    expect(can({ role: null, status: 'ACTIVE' }, 'notifications.read')).toBe(false);
  });

  it('a dual role grants the union of both roles', () => {
    const s = { role: 'SUPERVISOR' as const, roles: ['SUPERVISOR', 'MONITOR'], status: 'ACTIVE' };
    expect(can(s, 'violations.create')).toBe(true);
    expect(can(s, 'teams.manageOwn')).toBe(true);
    expect(can(s, 'users.read')).toBe(false);
  });

  it('ASSISTANT / MEMBER carry no permission in round 1', () => {
    expect(can({ role: null, roles: ['ASSISTANT', 'MEMBER'], status: 'ACTIVE' }, 'notifications.read')).toBe(false);
    expect(effectiveRole(['ASSISTANT'])).toBeNull();
    expect(effectiveRole(['MONITOR', 'ADMIN'])).toBe('ADMIN');
  });

  it('the pre-A12 subject shape still works (web compatibility)', () => {
    expect(can({ role: 'ADMIN', status: 'ACTIVE' }, 'users.read')).toBe(true);
    expect(can({ role: 'MONITOR' }, 'users.read')).toBe(false);
  });
});

describe('A12 schemas', () => {
  it('usernames: lower-cased, Latin, start with a letter, 3–32', () => {
    expect(usernameSchema.parse(' MMansary ')).toBe('mmansary');
    expect(usernameSchema.safeParse('1abc').success).toBe(false);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('محمد').success).toBe(false);
  });

  it('login accepts a username; registration and switch take a workspace id', () => {
    expect(loginSchema.safeParse({ identifier: 'mmansary', password: 'x' }).success).toBe(true);
    expect(switchWorkspaceSchema.safeParse({ workspaceId: 'not-a-uuid' }).success).toBe(false);
    const reg = registerSchema.safeParse({
      accountType: 'MONITOR',
      workspaceId: '0a120000-0000-4000-8000-000000000001',
      fullName: 'محمد علي',
      email: 'a@b.sa',
      mobile: '0551234567',
      nationalId: '1000000016',
      password: 'Abcdef12',
    });
    expect(reg.success || reg.error.issues.every((i) => i.path[0] !== 'workspaceId')).toBe(true);
  });
});
