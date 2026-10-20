/**
 * A12 round 3 in the demo — the same rules as the API (docs/API.md «A12 — round 3»):
 *  1. the display role is truthful (ASSISTANT / MEMBER / OWNER, no MONITOR stand-in);
 *  2. the participant picker (`participants.candidates`) for whoever manages participants;
 *  3. parity with the server: money in exports, and an assistant's scope on the violation
 *     statistics and export, project reports, dashboard, people, workload and card printing;
 *  4. «صلاحية مزدوجة» on the embedded person refs (assignees, authors, supervisors, participants, hub).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { nationalIdCheckDigit, type AssistantPermissions, type AssistantScope } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-a12r3-${Date.now()}-${n++}` });
});

const PARK = '00000000-0000-4000-8000-f00000000001';
const CLEAN = '00000000-0000-4000-8000-f00000000002';
const TEAM = (k: number) => `00000000-0000-4000-8000-a0000000000${k}`;
const ADMIN1 = '00000000-0000-4000-8000-000000000001';
const SUP1 = '00000000-0000-4000-8000-000000000003';
const EDITOR1 = '00000000-0000-4000-8000-000000000022';
const VIEWER1 = '00000000-0000-4000-8000-000000000023';
const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

async function login(identifier: string, password = DEMO_PASSWORD) {
  const s = await api.auth.login({ identifier, password });
  api.setAccessToken(s.accessToken);
  return s;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error('expected an ApiError');
}

async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/** Every cell of a workbook, or the text of a CSV / XML file. */
async function textOf(blob: Blob): Promise<string> {
  const buf = await bytesOf(blob);
  if (new Uint8Array(buf.slice(0, 2)).join(',') === '80,75') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const cells: string[] = [];
    wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => cells.push(String(c.text ?? '')))));
    return cells.join('\n');
  }
  return new TextDecoder().decode(buf);
}

async function rowCount(blob: Blob): Promise<number> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await bytesOf(blob));
  return wb.worksheets[0]!.actualRowCount;
}

/** The admin gives the demo assistant these modules and scope. */
async function setAssistant(permissions: AssistantPermissions, scope: AssistantScope = {}) {
  await login('admin1');
  const ws = (await api.auth.workspaces())[0]!.id;
  const m = (await api.workspaces.members(ws)).find((x) => x.user.username === 'assistant1')!;
  await api.workspaces.updateMember(ws, m.id, { permissions, scope });
  await login('assistant1');
}

// ───────────────────────────────────────────────────────────── 1. display role

describe('the display role is truthful', () => {
  it('assistant → ASSISTANT, participants → MEMBER, owner → OWNER; lists and demo buttons agree', async () => {
    expect((await login('assistant1')).user.role).toBe('ASSISTANT');
    expect((await api.auth.me()).role).toBe('ASSISTANT');
    expect((await login('editor1')).user.role).toBe('MEMBER');
    expect((await login('viewer1')).user.role).toBe('MEMBER');
    const owner = await login('mmansary');
    expect(owner.user.role).toBe('OWNER');
    expect(owner.user.workspaceRoles).toEqual(['ADMIN']);
    await login('admin1');
    const users = await api.users.list({ pageSize: 200 });
    const byName = new Map(users.items.map((u) => [u.username, u.role]));
    expect(byName.get('assistant1')).toBe('ASSISTANT');
    expect(byName.get('editor1')).toBe('MEMBER');
    expect(byName.get('mmansary')).toBe('OWNER');
    expect(byName.get('supervisor1')).toBe('SUPERVISOR');
    expect([...byName.values()]).not.toContain(null);
    const buttons = new Map(api.demo!.accounts.map((a) => [a.identifier, a.role]));
    expect(buttons.get('assistant1')).toBe('ASSISTANT');
    expect(buttons.get('editor1')).toBe('MEMBER');
    expect(buttons.get('mmansary')).toBe('OWNER');
  });
});

// ───────────────────────────────────────────────────────────── 2. participant picker

describe('participants.candidates — the picker', () => {
  it('admins: live members of the workspace, not yet participants, minimal fields only', async () => {
    await login('admin1');
    const list = await api.participants.candidates(PARK);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(SUP1);
    expect(ids).toContain(ADMIN1);
    expect(ids).not.toContain(EDITOR1); // already a participant of PARK
    expect(ids).not.toContain(VIEWER1);
    for (const c of list) expect(Object.keys(c).filter((k) => k !== 'dualRole').sort()).toEqual(['fullName', 'hasPhoto', 'id', 'role', 'username']);
    expect(JSON.stringify(list)).not.toMatch(/@demo\.nuzli|\+9665|nationalId|email|mobile/);
    expect(list.find((c) => c.id === SUP1)!.role).toBe('SUPERVISOR');
    expect(list.length).toBeLessThanOrEqual(20);
    const sup = list.find((c) => c.id === SUP1)!;
    expect((await api.participants.candidates(PARK, sup.fullName)).map((c) => c.id)).toEqual([SUP1]);
    expect((await api.participants.candidates(PARK, sup.username.toUpperCase())).map((c) => c.id)).toContain(SUP1);
    expect(await codeOf(api.participants.candidates(PARK, 'x'.repeat(81)))).toBe('VALIDATION_FAILED');
  });

  it('an assistant with projects:edit picks and adds WITHOUT the users module; view-only → 403; out of scope → 404', async () => {
    await setAssistant({ projects: 'view' });
    expect(await codeOf(api.participants.candidates(PARK))).toBe('FORBIDDEN');
    await setAssistant({ projects: 'edit' });
    const ws = (await api.auth.workspaces())[0]!.id;
    expect(await codeOf(api.workspaces.members(ws))).toBe('FORBIDDEN');
    expect((await api.participants.candidates(PARK)).map((c) => c.id)).toContain(SUP1);
    await api.participants.add(PARK, { userId: SUP1, title: 'منسّق', level: 'VIEWER' });
    expect((await api.participants.candidates(PARK)).map((c) => c.id)).not.toContain(SUP1);
    await setAssistant({ projects: 'edit' }, { projectIds: [CLEAN] });
    expect(await codeOf(api.participants.candidates(PARK))).toBe('NOT_FOUND');
    expect(Array.isArray(await api.participants.candidates(CLEAN))).toBe(true);
  });

  it('supervisors, monitors and participants (even editors) may not', async () => {
    for (const who of ['supervisor1', 'monitor1', 'editor1']) {
      await login(who);
      expect(await codeOf(api.participants.candidates(PARK))).toBe('FORBIDDEN');
    }
  });
});

// ───────────────────────────────────────────────────────────── 3. parity with the server

describe('exports: no money without budget.read (Excel, CSV, GanttPRO, MS Project)', () => {
  it('admins export the costs and the budget; the assistant without the budget module gets zeros and no budget', async () => {
    await login('admin1');
    const task = (await api.projects.gantt(PARK)).tasks.find((x) => x.type === 'TASK')!;
    await api.tasks.update(task.id, { version: task.version, plannedCost: 123457, actualCost: 98761 } as never);
    await api.projects.update(PARK, { budget: 7654321 } as never);
    const money = /123457|123,457|98761|98,761|7654321|7,654,321/;
    for (const format of ['xlsx', 'csv', 'ganttpro', 'xml'] as const) {
      expect(await textOf(await api.projects.export(PARK, format))).toMatch(money);
    }
    await setAssistant({ projects: 'view', tasks: 'view' });
    for (const format of ['xlsx', 'csv', 'ganttpro', 'xml'] as const) {
      expect(await textOf(await api.projects.export(PARK, format))).not.toMatch(money);
    }
    expect(await textOf(await api.projects.exportXlsx(PARK))).not.toMatch(money);
    await setAssistant({ projects: 'view', tasks: 'view', budget: 'view' });
    expect(await textOf(await api.projects.export(PARK, 'csv'))).toMatch(money);
  });

  it('a project participant (editor) exports without money too', async () => {
    await login('admin1');
    const task = (await api.projects.gantt(PARK)).tasks.find((x) => x.type === 'TASK')!;
    await api.tasks.update(task.id, { version: task.version, plannedCost: 123457 } as never);
    await login('editor1');
    expect(await textOf(await api.projects.export(PARK, 'csv'))).not.toMatch(/123457/);
  });

  it('A12 verification D6: without budget.read the cost COLUMNS are left out (not zeros); MS Project has no cost tags', async () => {
    await login('admin1');
    expect(await textOf(await api.projects.export(PARK, 'csv'))).toContain('التكلفة المخططة');
    expect(await textOf(await api.projects.export(PARK, 'xlsx'))).toContain('التكلفة الفعلية');
    expect(await textOf(await api.projects.export(PARK, 'xml'))).toContain('<Cost>');
    await login('editor1');
    const csv = await textOf(await api.projects.export(PARK, 'csv'));
    expect(csv).not.toMatch(/التكلفة المخططة|التكلفة الفعلية/);
    // the header and every row keep the same width
    const widths = new Set(csv.trim().split(/\r?\n/).slice(0, 5).map((l) => l.split(',').length));
    expect(widths.size).toBe(1);
    expect(await textOf(await api.projects.export(PARK, 'xlsx'))).not.toMatch(/التكلفة المخططة|التكلفة الفعلية/);
    const xml = await textOf(await api.projects.export(PARK, 'xml'));
    expect(xml).not.toMatch(/<Cost>|<ActualCost>/);
    expect(xml).toContain('<Task>');
  });
});

describe('an assistant limited to some teams: violation statistics and export', () => {
  it('count and export only those teams (an unassigned violation is outside the scope)', async () => {
    await setAssistant({ violations: 'view', violationStats: 'edit' });
    const all = await api.violations.stats({});
    const allXlsx = await api.violations.exportXlsx({});
    const rows = await api.db.violations.toArray();
    expect(all.total).toBe(rows.length);
    const inTeam1 = rows.filter((v) => v.teamIdSnapshot === TEAM(1)).length;
    expect(inTeam1).toBeGreaterThan(0);
    expect(inTeam1).toBeLessThan(rows.length);
    await setAssistant({ violations: 'view', violationStats: 'edit' }, { teamIds: [TEAM(1)] });
    const scoped = await api.violations.stats({});
    expect(scoped.total).toBe(inTeam1);
    const header = (await rowCount(allXlsx)) - rows.length;
    expect((await rowCount(await api.violations.exportXlsx({}))) - header).toBe(inTeam1);
    expect((await api.violations.list({ pageSize: 200 })).total).toBe(inTeam1);
    await setAssistant({ violations: 'view', violationStats: 'edit' }, { teamIds: [] });
    expect((await api.violations.stats({})).total).toBe(0);
  });
});

describe('an assistant limited to some projects: reports, dashboard, people, workload', () => {
  it('the projects report lists the scope only; participants their own projects', async () => {
    await setAssistant({ reports: 'view' });
    const all = (await api.projects.report({})).map((r) => r.project.id);
    expect(all).toEqual(expect.arrayContaining([PARK, CLEAN]));
    await setAssistant({ reports: 'view' }, { projectIds: [CLEAN] });
    expect((await api.projects.report({})).map((r) => r.project.id)).toEqual([CLEAN]);
    await login('editor1');
    expect((await api.projects.report({})).map((r) => r.project.id)).toEqual([PARK]);
    await login('supervisor1');
    expect(await codeOf(api.projects.report({}))).toBe('FORBIDDEN');
  });

  it('the dashboard and people of a project outside the scope answer 404; a participant reads their project', async () => {
    await setAssistant({ projects: 'view' }, { projectIds: [CLEAN] });
    expect((await api.projects.dashboard(CLEAN)).project.id).toBe(CLEAN);
    expect(await codeOf(api.projects.dashboard(PARK))).toBe('NOT_FOUND');
    expect(await codeOf(api.projects.people(PARK))).toBe('NOT_FOUND');
    await login('editor1');
    expect(Array.isArray(await api.projects.people(PARK))).toBe(true);
    expect((await api.projects.dashboard(PARK)).project.id).toBe(PARK);
    expect(await codeOf(api.projects.dashboard(CLEAN))).toBe('NOT_FOUND');
  });

  it('workload counts the scope only, for the workspace supervisors', async () => {
    const range = { from: '2026-01-01', to: '2026-03-31' };
    await login('admin1');
    const tasks = (await api.db.tasks.toArray()).filter((t) => t.type === 'TASK' && t.assigneeId && !t.archivedAt);
    const span = (p: string) => tasks.filter((t) => t.projectId === p);
    // a window that covers PARK's tasks
    const park = span(PARK);
    expect(park.length).toBeGreaterThan(0);
    range.from = park.map((t) => t.startDate.slice(0, 10)).sort()[0]!;
    const end = new Date(`${range.from}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 90);
    range.to = end.toISOString().slice(0, 10);
    await setAssistant({ reports: 'view' });
    const full = await api.workload(range);
    const total = (w: typeof full) => w.people.reduce((s, p) => s + p.totalAssignedMinutes, 0);
    expect(total(full)).toBeGreaterThan(0);
    for (const p of full.people) expect(p.user.id).not.toBe(ADMIN1);
    await setAssistant({ reports: 'view' }, { projectIds: [] });
    expect(total(await api.workload(range))).toBe(0);
    await setAssistant({ reports: 'view' }, { projectIds: [PARK] });
    const parkOnly = total(await api.workload(range));
    expect(parkOnly).toBeGreaterThan(0);
    expect(parkOnly).toBeLessThanOrEqual(total(full));
    await login('editor1');
    expect(await codeOf(api.workload(range))).toBe('FORBIDDEN');
  });
});

describe('an assistant limited to some teams: card printing and preview', () => {
  it('previews and prints those teams (and unassigned workers) only; supervisor cards for supervisors only', async () => {
    await setAssistant({ cards: 'edit' }, { teamIds: [TEAM(1)] });
    const template = (await api.cards.templates())[0]!;
    const preview = await api.cards.preview({ templateId: template.id, teamIds: [TEAM(1)], includeSupervisors: true });
    expect(preview.subjects.length).toBeGreaterThan(0);
    expect(await codeOf(api.cards.preview({ templateId: template.id, teamIds: [TEAM(2)] }))).toBe('NOT_FOUND');
    const team2Worker = (await api.db.memberships.toArray()).find((m) => m.teamId === TEAM(2) && m.validTo === null)!.memberId;
    const team1Worker = (await api.db.memberships.toArray()).find((m) => m.teamId === TEAM(1) && m.validTo === null)!.memberId;
    expect(await codeOf(api.cards.preview({ templateId: template.id, memberIds: [team2Worker] }))).toBe('NOT_FOUND');
    expect((await api.cards.preview({ templateId: template.id, memberIds: [team1Worker] })).subjects).toHaveLength(1);
    const batch = (items: Array<{ memberId?: string; userId?: string }>) =>
      api.cards.createBatch({ idempotencyKey: crypto.randomUUID(), templateId: template.id, items: items.map((i) => ({ ...i, data: { fullName: 'بطاقة' } })) });
    expect(await codeOf(batch([{ memberId: team2Worker }]))).toBe('NOT_FOUND');
    expect(await codeOf(batch([{ userId: ADMIN1 }]))).toBe('NOT_FOUND'); // not a supervisor
    await expect(batch([{ memberId: team1Worker }, { userId: SUP1 }])).resolves.toBeDefined();
  });

  it('without a team scope an assistant with cards:edit prints every team (no teams module needed)', async () => {
    await setAssistant({ cards: 'edit' });
    const template = (await api.cards.templates())[0]!;
    expect((await api.cards.preview({ templateId: template.id, teamIds: [TEAM(2)] })).subjects.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────── 4. dual role on embedded refs

describe('«صلاحية مزدوجة» on embedded person refs', () => {
  it('assignees, comment authors, team supervisors, participants and hub rows carry the flag; others do not', async () => {
    await login('admin1');
    const ws = (await api.auth.workspaces())[0]!.id;
    await api.workspaces.addMember(ws, { identifier: 'supervisor1', role: 'ASSISTANT', permissions: {}, confirmDualRole: true });
    const g = await api.projects.gantt(PARK);
    const assigned = g.tasks.filter((t) => t.assignee);
    expect(assigned.some((t) => t.assignee!.id === SUP1)).toBe(true);
    for (const t of assigned) expect(t.assignee!.dualRole).toBe(t.assignee!.id === SUP1 ? true : undefined);
    const task = assigned.find((t) => t.assignee!.id === SUP1)!;
    expect((await api.tasks.get(task.id)).assignee?.dualRole).toBe(true);
    await login('supervisor1');
    await api.tasks.addComment(task.id, { body: 'تعليق من صاحب صلاحية مزدوجة' });
    expect((await api.tasks.mine()).find((x) => x.id === task.id)?.assignee?.dualRole).toBe(true);
    await login('admin1');
    await api.participants.add(PARK, { userId: SUP1, title: 'منسّق', level: 'VIEWER' });
    const comments = await api.tasks.comments(task.id);
    expect(comments.find((c) => c.author.id === SUP1)!.author.dualRole).toBe(true);
    const team = await api.teams.get(TEAM(1));
    expect(team.supervisors?.find((s) => s.id === SUP1)?.dualRole).toBe(true);
    const parts = await api.participants.list(PARK);
    expect(parts.find((p) => p.user.id === SUP1)!.user.dualRole).toBe(true);
    expect('dualRole' in parts.find((p) => p.user.id === EDITOR1)!.user).toBe(false);
    const hub = await api.hub.list({ projectId: PARK, pageSize: 100 });
    const row = hub.items.find((i) => i.task.id === task.id)!;
    expect(row.task.assignee?.dualRole).toBe(true);
    expect(row.lastComment?.author).toMatchObject({ id: SUP1, dualRole: true });
  });

  it('approvals: the requester of a worker request is flagged', async () => {
    await login('admin1');
    const ws = (await api.auth.workspaces())[0]!.id;
    await api.workspaces.addMember(ws, { identifier: 'supervisor1', role: 'ASSISTANT', permissions: {}, confirmDualRole: true });
    await login('supervisor1');
    await api.teams.addMember(TEAM(1), { fullName: 'عامل بطلب', nationalId: validId('107733001') });
    await login('admin1');
    const reqs = await api.memberRequests.list({ status: 'ALL' });
    const mine = reqs.items.filter((r) => r.requestedBy?.id === SUP1);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.requestedBy?.dualRole).toBe(true);
  });
});
