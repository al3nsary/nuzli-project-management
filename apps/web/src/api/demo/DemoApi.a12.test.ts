/**
 * A12 in the demo (ADR-153) — the same rules as the API (docs/API.md «A12 — workspaces & session»
 * and «A12 — round 2», docs/a12-roles.md): login by username, single-workspace mode, switching,
 * owners and workspaces, user management, the dual role, assistants (modules + scope), project
 * participants (levels bound per project), the supervisor's team tasks, worker requests, the money
 * rule and the project cover.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { can, nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { isMemberRequestAccepted } from '../client';
import { normalizeUser } from '../../stores/auth';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-a12-${Date.now()}-${n++}` });
});

const PASS = 'A12-Test-Pass-2026';
const PARK = '00000000-0000-4000-8000-f00000000001';
const CLEAN = '00000000-0000-4000-8000-f00000000002';
const TEAM1 = '00000000-0000-4000-8000-a00000000001';
const SUP1 = '00000000-0000-4000-8000-000000000003';
const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

async function login(identifier: string, password = DEMO_PASSWORD) {
  const s = await api.auth.login({ identifier, password });
  api.setAccessToken(s.accessToken);
  return s;
}

async function codeOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

/** The owner creates a second workspace with an admin; returns its id. */
async function secondWorkspace(): Promise<string> {
  await login('mmansary');
  const ws = await api.workspaces.create({ name: 'قسم الصيانة' });
  await api.users.create({
    username: 'ws2-admin',
    fullName: 'مدير قسم الصيانة',
    email: 'ws2-admin@a12.example',
    mobile: '0558220001',
    nationalId: validId('106622001'),
    password: PASS,
    mustChangePassword: false,
    memberships: [{ workspaceId: ws.id, role: 'ADMIN' }],
  });
  return ws.id;
}

describe('session: username login and single-workspace mode', () => {
  it('signs in by username, e-mail or mobile; one workspace → bound, no picker', async () => {
    for (const id of ['admin1', 'ADMIN1', 'admin1@demo.nuzli.example', '0550000101']) {
      const s = await login(id);
      expect(s.user.username).toBe('admin1');
      expect(s.singleWorkspace).toBe(true);
      expect(s.activeWorkspace?.name).toBe('إدارة المشاريع');
      expect(s.workspaces).toHaveLength(1);
    }
    expect((await codeOf(api.auth.login({ identifier: 'admin1', password: 'wrong-pass' }))).code).toBe('INVALID_CREDENTIALS');
    const info = await api.system.info();
    expect(info).toMatchObject({ workspaceCount: 1, singleWorkspace: true });
    expect(info.workspaces).toBeUndefined(); // owners only
    expect(await api.system.publicWorkspaces()).toEqual([{ id: expect.any(String), name: 'إدارة المشاريع' }]);
  });

  it('the owner mmansary: demo password, no forced change, admin of «إدارة المشاريع»', async () => {
    const s = await login('mmansary');
    expect(s.user.accountRole).toBe('OWNER');
    expect(s.user.mustChangePassword).toBe(false);
    expect(s.user.workspaceRoles).toEqual(['ADMIN']);
    expect((await api.system.info()).workspaces?.map((w) => w.name)).toEqual(['إدارة المشاريع']);
  });
});

describe('workspaces: picker, switch, archive', () => {
  it('several workspaces → no workspace bound until chosen; switch = new session, old one revoked, audited in the target', async () => {
    const ws2 = await secondWorkspace();
    const s = await login('mmansary');
    expect(s.singleWorkspace).toBe(false);
    expect(s.activeWorkspace).toBeNull();
    expect(s.workspaces?.map((w) => w.name)).toEqual(['إدارة المشاريع', 'قسم الصيانة']);
    expect((await codeOf(api.teams.list({}))).code).toBe('WORKSPACE_REQUIRED');
    const old = s.accessToken;
    const in2 = await api.auth.switchWorkspace(ws2);
    api.setAccessToken(in2.accessToken);
    expect(in2.accessToken).not.toBe(old);
    expect(in2.activeWorkspace?.id).toBe(ws2);
    // An empty workspace: defaults only.
    expect(await api.teams.list({})).toEqual([]);
    expect(await api.projects.list({})).toEqual([]);
    expect((await api.colors.list()).length).toBe(24);
    expect((await api.cards.templates()).length).toBe(3);
    expect((await api.audit.list({ action: 'auth.workspace_switched' })).total).toBe(1);
    // The previous session is gone.
    api.setAccessToken(old);
    expect((await codeOf(api.auth.me())).code).toBe('UNAUTHENTICATED');
  });

  it('a member of one workspace cannot enter another (403 WORKSPACE_FORBIDDEN); archiving refuses entry and ends its sessions', async () => {
    const ws2 = await secondWorkspace();
    await login('admin1');
    expect((await codeOf(api.auth.switchWorkspace(ws2))).code).toBe('WORKSPACE_FORBIDDEN');
    const admin2 = await login('ws2-admin', PASS);
    expect(admin2.activeWorkspace?.id).toBe(ws2);
    await login('mmansary');
    await api.workspaces.archive(ws2);
    expect((await codeOf(api.workspaces.archive((await api.workspaces.list())[0]!.id))).code).toBe('LAST_WORKSPACE');
    api.setAccessToken(admin2.accessToken);
    expect((await codeOf(api.teams.list({}))).code).toBe('UNAUTHENTICATED');
    await login('mmansary');
    expect((await codeOf(api.auth.switchWorkspace(ws2))).code).toBe('WORKSPACE_ARCHIVED');
    await api.workspaces.restore(ws2);
    expect((await api.auth.switchWorkspace(ws2)).activeWorkspace?.id).toBe(ws2);
  });

  it('owners: add an existing account, never remove the last one', async () => {
    await login('mmansary');
    const me = (await api.owners.list())[0]!;
    expect((await codeOf(api.owners.remove(me.id))).code).toBe('LAST_OWNER');
    const added = await api.owners.add({ identifier: 'admin2' });
    expect((await api.owners.list()).map((o) => o.id)).toContain(added.id);
    await api.owners.remove(added.id);
    await login('admin1');
    expect((await codeOf(api.owners.list())).code).toBe('FORBIDDEN');
    expect((await codeOf(api.workspaces.create({ name: 'قسم' }))).code).toBe('FORBIDDEN');
  });
});

describe('user management', () => {
  it('create with a username and a first password → the user must change it; set password ends sessions', async () => {
    await login('admin1');
    const u = await api.users.create({
      username: 'new.user',
      fullName: 'مستخدم جديد',
      email: 'new.user@a12.example',
      mobile: '0558330001',
      nationalId: validId('106633001'),
      role: 'MONITOR',
      password: PASS,
    });
    expect(u.username).toBe('new.user');
    expect(u.mustChangePassword).toBe(true);
    const s = await login('new.user', PASS);
    expect(s.user.mustChangePassword).toBe(true);
    expect((await codeOf(api.violations.mine({}))).code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await api.auth.changePassword({ currentPassword: PASS, newPassword: 'Changed-Pass-2026' });
    expect(changed.user.mustChangePassword).toBe(false);
    const theirs = changed.accessToken;
    await login('admin1');
    await api.users.setPassword(u.id, { password: 'Reset-Pass-2026' });
    api.setAccessToken(theirs);
    expect((await codeOf(api.auth.me())).code).toBe('UNAUTHENTICATED');
    expect((await login('new.user', 'Reset-Pass-2026')).user.mustChangePassword).toBe(true);
  });

  it('usernames are unique (Arabic USERNAME_TAKEN) and can change any time', async () => {
    await login('admin1');
    const sup = (await api.users.list({ q: 'supervisor2' })).items[0]!;
    const taken = await codeOf(api.users.setUsername(sup.id, { username: 'admin2' }));
    expect(taken.code).toBe('USERNAME_TAKEN');
    expect(taken.message_ar).toContain('اسم المستخدم');
    await api.users.setUsername(sup.id, { username: 'sara.alshehri' });
    expect((await login('sara.alshehri')).user.id).toBe(sup.id);
  });

  it('dual role: 409 DUAL_ROLE_CONFIRM_REQUIRED, then confirmed; the badge flag everywhere; other workspaces hidden from non-owners', async () => {
    const ws2 = await secondWorkspace();
    // The owner, inside the second workspace, gives supervisor1 a role there too.
    await api.auth.switchWorkspace(ws2).then((s) => api.setAccessToken(s.accessToken));
    const err = await codeOf(api.workspaces.addMember(ws2, { identifier: 'supervisor1', role: 'MONITOR' }));
    expect(err.code).toBe('DUAL_ROLE_CONFIRM_REQUIRED');
    expect((err.details as { roles: { role: string }[] }).roles.map((r) => r.role)).toEqual(['SUPERVISOR']);
    const m = await api.workspaces.addMember(ws2, { identifier: 'supervisor1', role: 'MONITOR', confirmDualRole: true });
    expect(m.dualRole).toBe(true);
    // The admin of «إدارة المشاريع» sees the badge but not where the other role is.
    await login('admin1');
    const seen = (await api.users.list({ q: 'supervisor1' })).items[0]!;
    expect(seen.dualRole).toBe(true);
    expect(seen.allRoles?.find((r) => r.role === 'MONITOR')).toMatchObject({ workspaceId: null, workspaceName: null });
    // Admins cannot edit an account that belongs to another workspace too.
    expect((await codeOf(api.users.update(seen.id, { fullName: 'تعديل' }))).code).toBe('USER_IN_OTHER_WORKSPACES');
    // The supervisor now picks a workspace after signing in.
    const s = await login('supervisor1');
    expect(s.activeWorkspace).toBeNull();
    expect(s.workspaces?.length).toBe(2);
  });
});

describe('assistants (modules + scope)', () => {
  it('the demo assistant: projects view, tasks edit — grants drive can() in the web like the API', async () => {
    const s = await login('assistant1');
    const user = normalizeUser(s.user);
    expect(user.grants).toEqual(expect.arrayContaining(['projects.readAll', 'tasks.manage', 'teams.readAll']));
    expect(can(user, 'projects.readAll')).toBe(true);
    expect(can(user, 'projects.manage')).toBe(false);
    expect(can(user, 'violations.create')).toBe(false); // never the MONITOR display fallback
    expect((await api.projects.list({})).length).toBeGreaterThan(0);
    expect((await codeOf(api.projects.create({ name: 'مشروع', startDate: '2026-11-01' }))).code).toBe('FORBIDDEN');
    const task = (await api.projects.gantt(PARK)).tasks.find((x) => x.type === 'TASK')!;
    await expect(api.tasks.update(task.id, { version: task.version, name: 'اسم جديد' })).resolves.toBeDefined();
    // No budget module → no money fields.
    const p = await api.projects.get(PARK);
    expect('budget' in p).toBe(false);
    expect((await codeOf(api.projects.budget(PARK))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.users.update(task.assignee?.id ?? SUP1, { fullName: 'x' }))).code).toBe('FORBIDDEN');
  });

  it('a project scope limits the projects the assistant sees', async () => {
    await login('admin1');
    const ws = (await api.auth.workspaces())[0]!.id;
    const assistant = (await api.workspaces.members(ws)).find((m) => m.user.username === 'assistant1')!;
    await api.workspaces.updateMember(ws, assistant.id, { scope: { projectIds: [CLEAN] } });
    await login('assistant1');
    expect((await api.projects.list({})).map((p) => p.id)).toEqual([CLEAN]);
    expect((await codeOf(api.projects.get(PARK))).code).toBe('NOT_FOUND');
  });
});

describe('project participants (levels bound per project)', () => {
  it('editor edits tasks of their project only; viewer reads and cannot comment; nobody sees money', async () => {
    await login('editor1');
    expect((await api.me.participations()).map((x) => x.level)).toEqual(['EDITOR']);
    expect((await api.projects.list({})).map((p) => p.id)).toEqual([PARK]);
    const g = await api.projects.gantt(PARK);
    expect('budget' in g.project).toBe(false);
    const task = g.tasks.find((x) => x.type === 'TASK')!;
    await expect(api.tasks.update(task.id, { version: task.version, name: 'من المحرّر' })).resolves.toBeDefined();
    expect((await codeOf(api.tasks.update(task.id, { version: task.version + 1, plannedCost: 10 } as never))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.projects.get(CLEAN))).code).toBe('NOT_FOUND');
    expect((await codeOf(api.participants.add(PARK, { userId: SUP1, title: 'x', level: 'VIEWER' }))).code).toBe('FORBIDDEN');

    await login('viewer1');
    const t = (await api.projects.gantt(PARK)).tasks.find((x) => x.type === 'TASK')!;
    expect((await api.tasks.comments(t.id)).length).toBeGreaterThanOrEqual(0);
    expect((await codeOf(api.tasks.addComment(t.id, { body: 'ملاحظة', mentions: [] }))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.tasks.update(t.id, { version: t.version, progress: 50 } as never))).code).toBe('FORBIDDEN');
  });

  it('admins add participants: members of the workspace only; contributor changes status but not names', async () => {
    await login('admin1');
    expect((await codeOf(api.participants.add(CLEAN, { userId: '00000000-0000-4000-8000-000000000010', title: 'متقدّم', level: 'VIEWER' }))).code).toBe('PARTICIPANT_NOT_MEMBER');
    await api.participants.add(CLEAN, { userId: '00000000-0000-4000-8000-000000000023', title: 'متابعة', level: 'CONTRIBUTOR' });
    expect((await codeOf(api.participants.add(CLEAN, { userId: '00000000-0000-4000-8000-000000000023', title: 'متابعة', level: 'VIEWER' }))).code).toBe('PARTICIPANT_EXISTS');
    await login('viewer1');
    const t = (await api.projects.gantt(CLEAN)).tasks.find((x) => x.type === 'TASK')!;
    await expect(api.tasks.update(t.id, { version: t.version, status: 'IN_PROGRESS' } as never)).resolves.toBeDefined();
    expect((await codeOf(api.tasks.update(t.id, { version: t.version + 1, name: 'اسم' } as never))).code).toBe('FORBIDDEN');
  });
});

describe("the supervisor's team tasks", () => {
  it('«مهامي» = own + the team’s (assignedToMe); team tasks: comment and status, never checklist, time log or attachments', async () => {
    await login('supervisor3');
    const mine = await api.tasks.mine();
    const own = mine.filter((x) => x.assignedToMe);
    const team = mine.filter((x) => !x.assignedToMe);
    expect(team.length).toBeGreaterThan(0);
    expect(team.every((x) => x.assignee?.id === SUP1)).toBe(true);
    expect(own.every((x) => x.assignee?.id !== SUP1)).toBe(true);
    const t = team.find((x) => x.type === 'TASK' && x.status !== 'DONE')!;
    await expect(api.tasks.addComment(t.id, { body: 'رد من مشرف الفريق', mentions: [] })).resolves.toBeDefined();
    await expect(api.tasks.update(t.id, { version: t.version, progress: 40 } as never)).resolves.toBeDefined();
    expect((await codeOf(api.tasks.update(t.id, { version: t.version + 1, name: 'x' } as never))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.tasks.addTimeEntry(t.id, { date: new Date().toISOString().slice(0, 10), minutes: 30 }))).code).toBe('TIME_ENTRY_NOT_ALLOWED');
    expect((await codeOf(api.files.presign({ entityType: 'task', entityId: t.id, kind: 'ATTACHMENT', contentType: 'image/png', sizeBytes: 10 }))).code).toBe('FORBIDDEN');
  });
});

describe('worker requests', () => {
  it('supervisor add → 202 request → approver approves → the worker exists; decided requests answer 409', async () => {
    await login('supervisor1');
    const out = await api.teams.addMember(TEAM1, { fullName: 'عامل بطلب', nationalId: validId('107711001') });
    expect(isMemberRequestAccepted(out)).toBe(true);
    const request = isMemberRequestAccepted(out) ? out.request : null;
    expect(request?.payload.nationalIdMasked).toMatch(/^1•+\d\d$/);
    expect((await api.members.search({ q: validId('107711001'), page: 1, pageSize: 5 })).total).toBe(0);
    expect((await api.memberRequests.list({ status: 'PENDING' })).items.map((r) => r.id)).toContain(request!.id);
    await login('admin1');
    expect((await api.notifications.list({})).items.some((x) => x.type === 'MEMBER_REQUEST_CREATED')).toBe(true);
    const approved = await api.memberRequests.approve(request!.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.member?.fullName).toBe('عامل بطلب');
    expect((await codeOf(api.memberRequests.reject(request!.id, { reason: 'متأخر' }))).code).toBe('MEMBER_REQUEST_NOT_PENDING');
    await login('supervisor1');
    expect((await api.notifications.list({})).items.some((x) => x.type === 'MEMBER_REQUEST_DECIDED')).toBe(true);
  });

  it('supervisor remove → REMOVE request (one per worker); rejection keeps the worker; admins archive directly', async () => {
    await login('supervisor1');
    const worker = (await api.members.list({ teamId: TEAM1 })).items[0]!;
    const first = await api.members.archive(worker.id, { reason: 'انتهى العقد' });
    const again = await api.members.archive(worker.id, { reason: 'انتهى العقد' });
    expect(isMemberRequestAccepted(first) && isMemberRequestAccepted(again) && first.request.id === again.request.id).toBe(true);
    await login('admin1');
    const id = isMemberRequestAccepted(first) ? first.request.id : '';
    await api.memberRequests.reject(id, { reason: 'ما زال مطلوبًا' });
    expect((await api.members.get(worker.id)).status).toBe('ACTIVE');
    expect(await api.members.archive(worker.id, { reason: 'إزالة مباشرة' })).toEqual({ status: 'ARCHIVED' });
    expect((await api.members.get(worker.id)).status).toBe('INACTIVE');
  });
});

describe('project cover', () => {
  it('upload (images only, 16:9 by the client), signed URL for readers, remove; generated colour always sent', async () => {
    await login('admin1');
    const p = await api.projects.get(PARK);
    expect(p.hasCover).toBe(false);
    expect(p.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect((await codeOf(api.projects.coverUrl(PARK))).code).toBe('NOT_FOUND');
    const pngBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' });
    await api.projects.uploadCover(PARK, pngBlob);
    expect((await api.projects.get(PARK)).hasCover).toBe(true);
    await login('viewer1');
    expect((await api.projects.coverUrl(PARK)).url).toBeTruthy();
    expect((await codeOf(api.projects.removeCover(PARK))).code).toBe('FORBIDDEN');
    await login('admin1');
    await api.projects.removeCover(PARK);
    expect((await api.projects.get(PARK)).hasCover).toBe(false);
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    expect((await codeOf(api.projects.uploadCover(PARK, svg))).code).toBe('VALIDATION_FAILED');
  });
});
