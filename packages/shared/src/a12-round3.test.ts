import { describe, expect, it } from 'vitest';
import { applyDualRole, can, DISPLAY_ROLE_ORDER, displayRoleOf, participantCandidatesQuery, personRefIds } from './index';

describe('A12 round 3 — the display role (truthful, no MONITOR fallback)', () => {
  it('OWNER for owners, whatever their memberships', () => {
    expect(displayRoleOf({ accountRole: 'OWNER', roles: [] })).toBe('OWNER');
    expect(displayRoleOf({ accountRole: 'OWNER', roles: ['SUPERVISOR'] })).toBe('OWNER');
  });

  it('assistants and members show their own role; nothing = null', () => {
    expect(displayRoleOf({ roles: ['ASSISTANT'] })).toBe('ASSISTANT');
    expect(displayRoleOf({ roles: ['MEMBER'] })).toBe('MEMBER');
    expect(displayRoleOf({ accountRole: 'USER', roles: [] })).toBeNull();
  });

  it('a dual role shows the strongest — matrix roles first, then ASSISTANT, then MEMBER', () => {
    expect(DISPLAY_ROLE_ORDER).toEqual(['ADMIN', 'SUPERVISOR', 'MONITOR', 'ASSISTANT', 'MEMBER']);
    expect(displayRoleOf({ roles: ['ASSISTANT', 'SUPERVISOR'] })).toBe('SUPERVISOR');
    expect(displayRoleOf({ roles: ['MEMBER', 'ASSISTANT'] })).toBe('ASSISTANT');
    expect(displayRoleOf({ roles: ['MONITOR', 'ADMIN'] })).toBe('ADMIN');
  });

  it('a display role grants nothing by itself in can()', () => {
    expect(can({ role: 'ASSISTANT', status: 'ACTIVE' }, 'projects.readAll')).toBe(false);
    expect(can({ role: 'MEMBER', status: 'ACTIVE' }, 'violations.create')).toBe(false);
    expect(can({ role: 'OWNER', status: 'ACTIVE' }, 'users.read')).toBe(false);
    expect(can({ role: 'OWNER', accountRole: 'OWNER', status: 'ACTIVE' }, 'users.read')).toBe(true);
    expect(can({ role: 'ASSISTANT', status: 'ACTIVE', grants: ['projects.readAll'] }, 'projects.readAll')).toBe(true);
    // Older callers with a matrix role keep their column.
    expect(can({ role: 'MONITOR', status: 'ACTIVE' }, 'violations.create')).toBe(true);
  });
});

describe('A12 round 3 — participant candidates query', () => {
  it('q is optional, trimmed and bounded', () => {
    expect(participantCandidatesQuery.parse({})).toEqual({});
    expect(participantCandidatesQuery.parse({ q: '  سعد ' })).toEqual({ q: 'سعد' });
    expect(participantCandidatesQuery.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
  });
});

describe('A12 round 3 — dual-role flag on embedded person refs', () => {
  const page = () => ({
    items: [
      {
        task: { id: 't1', name: 'مهمة', assignee: { id: 'u1', fullName: 'أ' } },
        lastComment: { id: 'c1', author: { id: 'u2', fullName: 'ب' }, bodyPreview: '…' },
      },
    ],
    team: { supervisor: { id: 'u3', fullName: 'ج' }, supervisors: [{ id: 'u3', fullName: 'ج' }, { id: 'u4', fullName: 'د' }] },
    participant: { user: { id: 'u5', fullName: 'هـ', username: 'h' }, addedBy: { id: 'u1', fullName: 'أ' } },
    request: { requestedBy: { id: 'u6', fullName: 'و' }, decidedBy: null, member: { id: 'w1', fullName: 'عامل' } },
    foreman: { id: 'w2', fullName: 'مشرف عمّال' },
    file: new Uint8Array([1, 2, 3]),
  });

  it('collects the ids of person refs only (never workers)', () => {
    expect(personRefIds(page()).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });

  it('marks dual-role refs true and leaves the others without the field', () => {
    const p = applyDualRole(page(), new Set(['u1', 'u4', 'w1']));
    expect(p.items[0]!.task.assignee).toEqual({ id: 'u1', fullName: 'أ', dualRole: true });
    expect(p.participant.addedBy).toEqual({ id: 'u1', fullName: 'أ', dualRole: true });
    expect(p.team.supervisors[1]).toEqual({ id: 'u4', fullName: 'د', dualRole: true });
    expect('dualRole' in p.team.supervisors[0]!).toBe(false);
    expect('dualRole' in p.items[0]!.lastComment.author).toBe(false);
    expect('dualRole' in p.request.member).toBe(false);
  });

  it('never overrides a full user DTO that already says dualRole', () => {
    const session = { user: { id: 'u1', fullName: 'أ', dualRole: false } };
    expect(applyDualRole(session, new Set(['u1'])).user.dualRole).toBe(false);
  });
});
