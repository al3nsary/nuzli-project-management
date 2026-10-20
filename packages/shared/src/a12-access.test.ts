import { describe, expect, it } from 'vitest';
import {
  addWorkspaceMemberSchema,
  ASSISTANT_MODULE_GRANTS,
  ASSISTANT_MODULES,
  assistantGrants,
  assistantPermissionsSchema,
  assistantScopeOf,
  can,
  createAccountSchema,
  nationalIdCheckDigit,
  PARTICIPANT_GRANTS,
  PERMISSIONS,
  projectColor,
  ROLE_PERMISSIONS,
} from './index';

const assistant = (perms: Record<string, string>) => ({
  role: null,
  roles: ['ASSISTANT'],
  status: 'ACTIVE',
  grants: assistantGrants(perms),
});

describe('A12 round 2 — assistant modules', () => {
  it('every module maps to real permissions; edit includes view', () => {
    for (const m of ASSISTANT_MODULES) {
      const g = ASSISTANT_MODULE_GRANTS[m];
      for (const p of [...g.view, ...g.edit]) expect(PERMISSIONS).toContain(p);
      for (const p of g.view) expect(g.edit).toContain(p);
    }
  });

  it('admins hold every permission an assistant can be given', () => {
    for (const m of ASSISTANT_MODULES) for (const p of ASSISTANT_MODULE_GRANTS[m].edit) expect(ROLE_PERMISSIONS.ADMIN.has(p)).toBe(true);
  });

  it('per module and level: none / view / edit', () => {
    expect(can(assistant({}), 'projects.readAll')).toBe(false);
    expect(can(assistant({ projects: 'none' }), 'projects.readAll')).toBe(false);
    const view = assistant({ projects: 'view' });
    expect(can(view, 'projects.readAll')).toBe(true);
    expect(can(view, 'projects.manage')).toBe(false);
    const edit = assistant({ projects: 'edit' });
    expect(can(edit, 'projects.manage')).toBe(true);
    expect(can(edit, 'budget.read')).toBe(false);
    expect(can(assistant({ budget: 'view' }), 'budget.read')).toBe(true);
    expect(can(assistant({ budget: 'view' }), 'budget.manage')).toBe(false);
    expect(can(assistant({ cards: 'view' }), 'cards.print')).toBe(false);
    expect(can(assistant({ cards: 'edit' }), 'cards.print')).toBe(true);
    expect(can(assistant({ registrations: 'view' }), 'registrations.review')).toBe(false);
    expect(can(assistant({ registrations: 'edit' }), 'registrations.review')).toBe(true);
  });

  it('users / audit / settings are view-only (an "edit" is refused by the schema, read as view)', () => {
    expect(assistantPermissionsSchema.safeParse({ users: 'edit' }).success).toBe(false);
    expect(assistantPermissionsSchema.safeParse({ users: 'view', projects: 'edit' }).success).toBe(true);
    expect(assistantGrants({ users: 'edit' })).toEqual(['users.read']);
    expect(can(assistant({ users: 'view' }), 'users.edit')).toBe(false);
  });

  it('never grants full national IDs or the ID-card photo', () => {
    const all = assistantGrants(Object.fromEntries(ASSISTANT_MODULES.map((m) => [m, 'edit'])));
    expect(all).not.toContain('nationalIds.readFull');
    expect(all).not.toContain('violations.viewIdPhoto');
    expect(all).not.toContain('users.manageRoles');
  });

  it('unknown junk grants nothing; an unreadable scope fails closed', () => {
    expect(assistantGrants(null)).toEqual([]);
    expect(assistantGrants(['projects'])).toEqual([]);
    expect(assistantGrants({ projects: 'admin' })).toEqual([]);
    expect(assistantScopeOf({})).toEqual({ projectIds: null, teamIds: null });
    expect(assistantScopeOf({ projectIds: ['x'] })).toEqual({ projectIds: [], teamIds: [] });
  });

  it('permissions/scope are for assistants only', () => {
    const base = { userId: '0a120000-0000-4000-8000-000000000001' };
    expect(addWorkspaceMemberSchema.safeParse({ ...base, role: 'SUPERVISOR', permissions: { projects: 'view' } }).success).toBe(false);
    expect(addWorkspaceMemberSchema.safeParse({ ...base, role: 'ASSISTANT', permissions: { projects: 'view' } }).success).toBe(true);
    expect(addWorkspaceMemberSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
  });
});

describe('A12 round 2 — participants, accounts, covers', () => {
  it('participant levels: viewer reads, contributor works, editor edits tasks', () => {
    expect(PARTICIPANT_GRANTS.VIEWER).not.toContain('tasks.comment');
    expect(PARTICIPANT_GRANTS.CONTRIBUTOR).toContain('tasks.comment');
    expect(PARTICIPANT_GRANTS.CONTRIBUTOR).not.toContain('tasks.manage');
    expect(PARTICIPANT_GRANTS.EDITOR).toContain('tasks.manage');
    for (const l of Object.values(PARTICIPANT_GRANTS)) {
      expect(l).not.toContain('projects.manage');
      expect(l).not.toContain('budget.read');
    }
  });

  it('createAccountSchema: role or memberships; mustChangePassword needs a password', () => {
    const base = { fullName: 'محمد علي', email: 'a@b.sa', mobile: '0551234567', nationalId: '100000001' + nationalIdCheckDigit('100000001') };
    expect(createAccountSchema.safeParse(base).success).toBe(false);
    expect(createAccountSchema.safeParse({ ...base, role: 'MONITOR' }).success).toBe(true);
    expect(createAccountSchema.safeParse({ ...base, memberships: [{ role: 'ASSISTANT', permissions: { tasks: 'view' } }], password: 'Abcdefgh12', mustChangePassword: true }).success).toBe(true);
    expect(createAccountSchema.safeParse({ ...base, memberships: [{ role: 'ASSISTANT', permissions: { tasks: 'view' } }], mustChangePassword: true }).success).toBe(false);
  });

  it('a project keeps the same default cover colour', () => {
    const id = '0a120000-0000-4000-8000-000000000001';
    expect(projectColor(id)).toBe(projectColor(id));
    expect(projectColor(id)).toMatch(/^#[0-9A-F]{6}$/);
  });
});
