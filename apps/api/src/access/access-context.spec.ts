import { assistantGrants, can } from '@nuzli/shared';
import { projectScopeWhere, taskScopeWhere } from '../projects/project-dto';
import { memberScopeWhere, printMemberScopeWhere, withinTeamLimit } from '../teams/team-dto';
import { violationScopeWhere } from '../violations/violation-scope';
import { mayActOnTask, mayWorkOnTask, projectBoundGrants, taskRelation, unboundGrants, type ScopedViewer } from './access-context';
import { bodyChangesBudget, stripBudget } from './budget.interceptor';

const P1 = '0a120000-0000-4000-8000-000000000001';
const P2 = '0a120000-0000-4000-8000-000000000002';
const T1 = '0a120000-0000-4000-8000-000000000011';

const admin: ScopedViewer = { id: 'admin', role: 'ADMIN', roles: ['ADMIN'], status: 'ACTIVE' };
const supervisor = (peers: string[] = []): ScopedViewer => ({
  id: 'sup',
  role: 'SUPERVISOR',
  roles: ['SUPERVISOR'],
  status: 'ACTIVE',
  teamPeerIds: ['sup', ...peers],
});
const member = (participations: Record<string, 'VIEWER' | 'CONTRIBUTOR' | 'EDITOR'>): ScopedViewer => {
  const v: ScopedViewer = { id: 'mem', role: null, roles: ['MEMBER'], status: 'ACTIVE', participations, baseGrants: [] };
  v.grants = unboundGrants(v);
  return v;
};
const assistant = (perms: Record<string, string>, limits: ScopedViewer['limits'] = null): ScopedViewer => {
  const base = assistantGrants(perms);
  return { id: 'asst', role: null, roles: ['ASSISTANT'], status: 'ACTIVE', baseGrants: base, grants: base, limits };
};

describe('A12 round 2 — data scopes', () => {
  it('admins: everything; assistants: their project/team scope; nobody else sees a project', () => {
    expect(projectScopeWhere(admin)).toEqual({});
    expect(taskScopeWhere(admin)).toEqual({});
    const a = assistant({ projects: 'view' }, { projectIds: [P1], teamIds: null });
    expect(projectScopeWhere(a)).toEqual({ id: { in: [P1] } });
    expect(taskScopeWhere(a)).toEqual({ projectId: { in: [P1] } });
    expect(projectScopeWhere(supervisor())).toEqual({ id: { in: [] } });
    // reports.read opens projects for the reports routes only
    const r = assistant({ reports: 'view' });
    expect(projectScopeWhere(r)).toEqual({ id: { in: [] } });
    expect(projectScopeWhere(r, { reports: true })).toEqual({});
  });

  it('participants see their projects and every task of them', () => {
    const m = member({ [P1]: 'VIEWER' });
    expect(projectScopeWhere(m)).toEqual({ id: { in: [P1] }, archivedAt: null, isTemplate: false });
    expect(taskScopeWhere(m)).toEqual({ projectId: { in: [P1] }, project: { archivedAt: null, isTemplate: false } });
  });

  it('a supervisor sees own tasks and the tasks of the same team’s supervisors (owner rule)', () => {
    expect(taskScopeWhere(supervisor())).toEqual({ assigneeId: 'sup', project: { archivedAt: null, isTemplate: false } });
    expect(taskScopeWhere(supervisor(['co']))).toEqual({ assigneeId: { in: ['sup', 'co'] }, project: { archivedAt: null, isTemplate: false } });
    const both: ScopedViewer = { ...supervisor(), participations: { [P2]: 'VIEWER' } };
    expect(taskScopeWhere(both)).toEqual({ OR: [expect.objectContaining({ assigneeId: 'sup' }), expect.objectContaining({ projectId: { in: [P2] } })] });
  });

  it('team scope: members, violations, card printing', () => {
    const a = assistant({ members: 'edit', violations: 'view', cards: 'edit' }, { projectIds: null, teamIds: [T1] });
    expect(withinTeamLimit(a, { id: T1 })).toBe(true);
    expect(withinTeamLimit(a, { id: 'other' })).toBe(false);
    expect(withinTeamLimit(a, {})).toBe(false); // no id → refused (fail closed)
    expect(JSON.stringify(memberScopeWhere(a))).toContain(T1);
    expect(violationScopeWhere(a, true)).toEqual({ teamIdSnapshot: { in: [T1] } });
    expect(JSON.stringify(printMemberScopeWhere(a))).toContain(T1);
    expect(printMemberScopeWhere(assistant({ cards: 'edit' }))).toEqual({});
  });
});

describe('A12 round 2 — what a viewer may do on one task', () => {
  const task = { projectId: P1, assigneeId: 'sup' };

  it('assignee: work; team peer: status and comments only; stranger: read', () => {
    expect(taskRelation(supervisor(), task)).toBe('work');
    const co: ScopedViewer = { ...supervisor(['sup']), id: 'co', teamPeerIds: ['co', 'sup'] };
    expect(taskRelation(co, task)).toBe('team');
    expect(mayActOnTask(co, task)).toBe(true);
    expect(mayWorkOnTask(co, task)).toBe(false);
    const stranger: ScopedViewer = { ...supervisor(), id: 'x', teamPeerIds: ['x'] };
    expect(taskRelation(stranger, task)).toBe('read');
  });

  it('participants: viewer reads, contributor works, editor manages — on their project only', () => {
    expect(taskRelation(member({ [P1]: 'VIEWER' }), task)).toBe('read');
    expect(taskRelation(member({ [P1]: 'CONTRIBUTOR' }), task)).toBe('work');
    const editor = member({ [P1]: 'EDITOR' });
    expect(taskRelation(editor, task)).toBe('work');
    editor.grants = projectBoundGrants(editor, P1);
    expect(taskRelation(editor, task)).toBe('manage');
    editor.grants = projectBoundGrants(editor, P2);
    expect(can(editor, 'tasks.manage')).toBe(false);
    expect(can(editor, 'projects.readGranted')).toBe(true); // a 404 from the service, not a 403
  });

  it('unbound grants: read for any participant, comments only for contributors and editors', () => {
    expect(unboundGrants(member({ [P1]: 'VIEWER' }))).toEqual(['projects.readGranted']);
    expect(unboundGrants(member({ [P1]: 'CONTRIBUTOR' }))).toEqual(['projects.readGranted', 'tasks.comment']);
    expect(unboundGrants(member({}))).toEqual([]);
  });
});

describe('A12 round 2 — budget fields', () => {
  it('strips every money field, deep, without touching the rest', () => {
    const dto = { id: 'p', name: 'x', budget: 5, plannedCost: 1, tasks: [{ id: 't', actualCost: 2, overBudget: false, name: 'y' }], summary: { budgetBurn: {} } };
    expect(stripBudget(dto)).toEqual({ id: 'p', name: 'x', tasks: [{ id: 't', name: 'y' }], summary: {} });
  });

  it('detects a money change anywhere in a body', () => {
    expect(bodyChangesBudget({ version: 1, status: 'DONE' })).toBe(false);
    expect(bodyChangesBudget({ changes: [{ id: 't', plannedCost: 3 }] })).toBe(true);
    expect(bodyChangesBudget({ patch: { actualCost: 0 } })).toBe(true);
    expect(bodyChangesBudget({ budget: null })).toBe(true);
    expect(bodyChangesBudget({ budget: undefined })).toBe(false);
  });
});
