/**
 * A12 — the demo's workspace isolation suite (owner: «العزل أولًا», ADR-153). It mirrors the
 * server suite (apps/api/test/isolation): a second workspace B is built with its own data
 * (accounts, a team, a worker, a project with tasks, labels, a custom field, comments, a checklist,
 * time entries, a dependency, a participant, a worker request, a violation type and a violation, a
 * calendar, a portfolio, org units, reference data, card sizes and templates, a print batch, a
 * cover image, files, notifications, settings, a pending registration). Then EVERY method of the
 * `ApiClient` interface is called by five identities of workspace A — admin, assistant (every
 * module), supervisor, monitor and project participant — aimed at B: B ids in paths and bodies, B
 * filters. A call must either fail with an ApiError or answer without any B id or B text
 * (JSON, text and Excel parsed cell by cell). At the end B's rows are byte-for-byte unchanged.
 *
 * Coverage gate: the method list is read from `client.ts` with the TypeScript parser — a method
 * without a case here fails the suite.
 *
 * Security review A12 M5 (ADR-166): a sixth identity — a person with roles in BOTH workspaces, with
 * B notifications, a B participation and a B view preference, working in A — probes every method;
 * and every scoped Dexie table is read directly in A's context (model by model). Removing the
 * workspace filter of ANY scoped table makes this suite fail (`npm run test:isolation:mutation`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import ExcelJS from 'exceljs';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { SCOPED_TABLES } from './scoping';
import type { PresignedUpload } from '@nuzli/shared';

const MARK = 'سرّيب٧';
const PASSWORD = 'Isolation-Pass-2026';
const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);
const uuid = () => crypto.randomUUID();
const png = () =>
  new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(1)])], { type: 'image/png' });

interface BIds {
  ws: string;
  adminId: string;
  supId: string;
  monId: string;
  memberUserId: string;
  teamId: string;
  workerId: string;
  colorId: string;
  projectId: string;
  taskId: string;
  task2Id: string;
  labelId: string;
  fieldId: string;
  commentId: string;
  checklistId: string;
  timeEntryId: string;
  dependencyId: string;
  typeId: string;
  violationId: string;
  calendarId: string;
  exceptionId: string;
  portfolioId: string;
  unitId: string;
  positionId: string;
  referenceId: string;
  sizeId: string;
  templateId: string;
  batchId: string;
  requestId: string;
  registrationId: string;
  attachmentFileId: string;
  coverFileId: string;
  logoId: string;
  notificationId: string;
}

interface AIds {
  ws: string;
  projectId: string;
  taskId: string;
  teamId: string;
}

let api: DemoApi;
let B: BIds;
let A: AIds;
let before = '';
const allBIds = new Set<string>();

async function login(identifier: string, password = DEMO_PASSWORD) {
  const s = await api.auth.login({ identifier, password });
  api.setAccessToken(s.accessToken);
  // M5: a person with several workspaces works in A (once A is known).
  if (!s.activeWorkspace && A?.ws && (s.workspaces ?? []).some((w) => w.id === A.ws) && identifier === DUAL) {
    const sw = await api.auth.switchWorkspace(A.ws);
    api.setAccessToken(sw.accessToken);
    return sw;
  }
  return s;
}

/** M5: the person with roles in A (monitor) and B (supervisor). Not a B fingerprint: they are in A too. */
const DUAL = 'iso-dual';

/** B's business rows and identity rows (memberships, its accounts, the workspace), sorted, as JSON. */
async function snapshotB(wid: string): Promise<string> {
  return api.unscoped(async () => {
    const out: Record<string, unknown[]> = {};
    for (const name of SCOPED_TABLES) {
      const rows = (await api.db.table(name).toArray()) as Record<string, unknown>[];
      out[name] = rows.filter((r) => r.wid === wid).sort((a, b) => String(a.id ?? a.violationId).localeCompare(String(b.id ?? b.violationId)));
    }
    const memberships = (await api.db.wsMemberships.toArray()).filter((m) => m.workspaceId === wid);
    out.wsMemberships = memberships.sort((a, b) => a.id.localeCompare(b.id));
    const accountIds = new Set(memberships.map((m) => m.userId));
    out.users = (await api.db.users.toArray())
      .filter((u) => accountIds.has(u.id) || u.requestedWorkspaceId === wid)
      .map((u) => ({ ...u, lastLoginAt: null, failedLogins: 0, lockedUntil: null }))
      .sort((a, b) => a.id.localeCompare(b.id));
    out.workspace = [await api.db.workspaces.get(wid)];
    out.settings = [(await api.db.kv.get(`settings:${wid}`)) ?? null];
    return JSON.stringify(out);
  }, 'r');
}

/** Workspace B, built by the owner inside B (as a real owner would), with a MARK in every name. */
async function buildB(): Promise<BIds> {
  await login('mmansary');
  const ws = await api.workspaces.create({ name: 'قسم الاختبار ب', code: 'iso-b' });
  const mk = async (username: string, role: 'ADMIN' | 'SUPERVISOR' | 'MONITOR' | 'MEMBER', n: string) =>
    api.users.create({
      username,
      fullName: `حساب ${MARK} ${n}`,
      email: `${username}@iso-b.example`,
      mobile: `05581100${n}`,
      nationalId: validId(`1066${n}0011`.slice(0, 9)),
      password: PASSWORD,
      mustChangePassword: false,
      memberships: [{ workspaceId: ws.id, role }],
    });
  // M5: the dual member — MONITOR in A, SUPERVISOR in B (created by the owner, confirmed).
  const aWs = (await api.auth.workspaces()).find((w) => w.id !== ws.id)!;
  const dual = await api.users.create({
    username: DUAL,
    fullName: 'شخص في القسمين للاختبار',
    email: 'iso-dual@iso-b.example',
    mobile: '0558110031',
    nationalId: validId('106600310'),
    password: PASSWORD,
    mustChangePassword: false,
    confirmDualRole: true,
    memberships: [{ workspaceId: aWs.id, role: 'MONITOR' }, { workspaceId: ws.id, role: 'SUPERVISOR' }],
  } as never);
  const admin = await mk('isob-admin', 'ADMIN', '11');
  const sup = await mk('isob-sup', 'SUPERVISOR', '12');
  const mon = await mk('isob-mon', 'MONITOR', '13');
  const member = await mk('isob-member', 'MEMBER', '14');
  const s = await api.auth.switchWorkspace(ws.id);
  api.setAccessToken(s.accessToken);

  const color = (await api.colors.available())[0]!;
  const team = await api.teams.create({ name: `فريق ${MARK}`, colorId: color.id, supervisorId: sup.id, members: [], existingMemberIds: [] });
  const worker = await api.teams.addMember(team.id, { fullName: `عامل ${MARK}`, nationalId: validId('199112233') });
  const workerId = (worker as { id: string }).id;
  const project = await api.projects.create({ name: `مشروع ${MARK}`, startDate: '2026-11-01' });
  const task = await api.tasks.create(project.id, { name: `مهمة ${MARK}`, startDate: '2026-11-01', durationDays: 3, assigneeId: sup.id });
  const task2 = await api.tasks.create(project.id, { name: `مهمة ثانية ${MARK}`, startDate: '2026-11-05', durationDays: 2 });
  const label = await api.labels.create(project.id, { name: `وسم ${MARK}`, color: '#123456' });
  await api.tasks.addLabel(task.id, label.id);
  const field = await api.customFields.create(project.id, { name: `حقل ${MARK}`, type: 'TEXT' });
  const comment = await api.tasks.addComment(task.id, { body: `تعليق ${MARK}`, mentions: [] });
  const item = await api.tasks.addChecklistItem(task.id, { text: `بند ${MARK}` });
  const entry = await api.tasks.addTimeEntry(task.id, { date: new Date().toISOString().slice(0, 10), minutes: 60, note: `وقت ${MARK}` });
  const dep = await api.dependencies.create(project.id, { predecessorId: task.id, successorId: task2.id });
  await api.participants.add(project.id, { userId: member.id, title: `منصب ${MARK}`, level: 'EDITOR' });
  // M5: B rows keyed by the dual member (a participation + its notification, an assigned task).
  await api.participants.add(project.id, { userId: dual.id, title: `منصب المزدوج ${MARK}`, level: 'VIEWER' });
  await api.tasks.update(task2.id, { assigneeId: dual.id } as never).catch(() => undefined);
  const type = await api.violationTypes.create({ name: `نوع ${MARK}`, severity: 'LOW' });
  const calendar = await api.calendars.create({ name: `تقويم ${MARK}`, weekendDays: [5, 6] });
  const withEx = await api.calendars.addException(calendar.id, { date: '2026-12-01', isWorking: false, name: `عطلة ${MARK}` });
  const portfolio = await api.portfolios.create({ name: `محفظة ${MARK}`, projectIds: [project.id] });
  const unit = await api.org.createUnit({ name: `وحدة ${MARK}`, kind: 'UNIT' });
  const position = await api.org.createPosition({ unitId: unit.id, title: `منصب ${MARK}`, holderUserId: sup.id });
  const reference = await api.reference.create('departments', { name: `إدارة ${MARK}` });
  const size = await api.cards.createSize({ name: `مقاس ${MARK}`, widthMm: 86, heightMm: 54 });
  const base = (await api.cards.templates())[0]!;
  const template = await api.cards.createTemplate({ name: `قالب ${MARK}`, sizeId: size.id, orientation: base.orientation, layoutKey: base.layoutKey, config: base.config });
  const batch = await api.cards.createBatch({
    idempotencyKey: uuid(),
    templateId: template.id,
    items: [{ memberId: workerId, data: { fullName: `عامل ${MARK}` } }],
  });
  const logo = await api.logos.upload({ name: `شعار ${MARK}`, file: png() as Blob & { type: string } });
  await api.settings.update({ VIOLATION_EDIT_WINDOW_MINUTES: 77 } as never);
  await api.viewPrefs.put({ projectId: project.id, key: 'gantt.columns', value: [{ id: MARK }] });
  // A task attachment and a cover image (files of B).
  const presigned = await api.files.presign({ entityType: 'task', entityId: task.id, kind: 'ATTACHMENT', contentType: 'image/png', sizeBytes: png().size });
  await api.files.upload(presigned, png());
  await api.files.confirm(presigned.fileId);
  await api.tasks.attach(task.id, presigned.fileId);
  const cover = await api.projects.uploadCover(project.id, png());

  // The monitor of B records a violation (no person).
  await login('isob-mon', PASSWORD);
  const { violation } = await api.violations.create({
    clientUuid: uuid(),
    typeId: type.id,
    description: `مخالفة ${MARK}`,
    latitude: 24.7,
    longitude: 46.7,
    accuracyM: 5,
    capturedAt: new Date().toISOString(),
    deviceInfo: { userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test' },
    expectedIdPhotos: 1,
    expectedEvidencePhotos: 1,
  });
  // M5: rows of the three scoped tables the API flows above do not fill in B (a closed supervision,
  // project access, an OCR job) — written as B's rows, so a missing filter on them has B to leak.
  const at = new Date().toISOString();
  await api.inWorkspace(ws.id, async () => {
    await api.db.table('supervisorHistory').add({ id: uuid(), teamId: team.id, supervisorId: sup.id, validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z', changedById: admin.id, reason: `سبب ${MARK}` });
    await api.db.table('projectAccess').add({ id: uuid(), projectId: project.id, userId: sup.id, level: 'VIEW', createdAt: at });
    await api.db.table('violationOcr').add({ violationId: violation.id, fileId: presigned.fileId, status: 'PENDING', attempts: 0, error: `خطأ ${MARK}`, extracted: null, extractedAt: null, updatedAt: at });
  });
  // M5: the dual member's own B rows (a view preference), written as them inside B.
  await login(DUAL, PASSWORD);
  api.setAccessToken((await api.auth.switchWorkspace(ws.id)).accessToken);
  await api.viewPrefs.put({ projectId: project.id, key: 'gantt.columns', value: [{ id: `المزدوج ${MARK}` }] });
  // The supervisor of B asks to add a worker (a request waiting in B).
  await login('isob-sup', PASSWORD);
  const accepted = await api.teams.addMember(team.id, { fullName: `مرشّح ${MARK}`, nationalId: validId('199445566') });
  const requestId = (accepted as { request: { id: string } }).request.id;
  // A public registration addressed to B (notifies B's admins).
  api.setAccessToken(null);
  await api.auth.register({
    workspaceId: ws.id,
    accountType: 'MONITOR',
    fullName: `متقدّم ${MARK}`,
    email: 'isob-applicant@iso-b.example',
    mobile: '0558110015',
    nationalId: validId('106600150'),
    password: PASSWORD,
  });
  const registrationId = (await api.unscoped(() => api.db.users.where('email').equals('isob-applicant@iso-b.example').first(), 'r'))!.id;
  await login('isob-admin', PASSWORD);
  const notificationId = (await api.notifications.list({})).items[0]?.id ?? uuid();

  return {
    ws: ws.id,
    adminId: admin.id,
    supId: sup.id,
    monId: mon.id,
    memberUserId: member.id,
    teamId: team.id,
    workerId,
    colorId: color.id,
    projectId: project.id,
    taskId: task.id,
    task2Id: task2.id,
    labelId: label.id,
    fieldId: field.id,
    commentId: comment.id,
    checklistId: item.id,
    timeEntryId: entry.id,
    dependencyId: dep.id,
    typeId: type.id,
    violationId: violation.id,
    calendarId: calendar.id,
    exceptionId: withEx.exceptions[0]!.id,
    portfolioId: portfolio.id,
    unitId: unit.id,
    positionId: position.id,
    referenceId: reference.id,
    sizeId: size.id,
    templateId: template.id,
    batchId: batch.id,
    requestId,
    registrationId,
    attachmentFileId: presigned.fileId,
    coverFileId: cover.fileId,
    logoId: logo.id,
    notificationId,
  };
}

// ---------------------------------------------------------------------------- the cases

type Probe = (b: BIds, a: AIds) => Promise<unknown>;
type Case = { probes: Probe[] } | { exempt: string };
const p = (...probes: Probe[]): Case => ({ probes });
const fakePresigned = (fileId: string): PresignedUpload => ({
  fileId,
  url: `demo-storage://${fileId}`,
  method: 'PUT',
  headers: { 'Content-Type': 'image/png' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const CASES: Record<string, Case> = {
  // plumbing (no data)
  mode: { exempt: 'a constant' },
  demo: { exempt: 'demo controls (reset is global demo data by design)' },
  setAccessToken: { exempt: 'client plumbing' },
  onSessionChange: { exempt: 'client plumbing' },
  // auth — identity is global; nothing of B is reachable through the session calls
  'auth.register': p(() => api.auth.register({ accountType: 'MONITOR', fullName: 'تسجيل اختبار', email: `r${Date.now()}@iso-a.example`, mobile: '0559990001', nationalId: validId('107700001'), password: PASSWORD })),
  'auth.login': { exempt: 'used to sign each identity in (global identity by design)' },
  'auth.refresh': p(() => api.auth.refresh()),
  'auth.logout': { exempt: 'ends the probing session (run last by the harness)' },
  'auth.forgotPassword': p(() => api.auth.forgotPassword({ email: 'isob-admin@iso-b.example' })),
  'auth.resetPassword': p(() => api.auth.resetPassword({ token: 'x'.repeat(40), password: PASSWORD })),
  'auth.changePassword': p(() => api.auth.changePassword({ currentPassword: 'wrong-password', newPassword: PASSWORD })),
  'auth.me': p(() => api.auth.me()),
  'auth.switchWorkspace': p((b) => api.auth.switchWorkspace(b.ws)),
  'auth.workspaces': p(() => api.auth.workspaces()),
  'system.info': p(() => api.system.info()),
  'system.publicWorkspaces': { exempt: 'public by design: active workspace names for the registration step (no business data)' },
  'me.update': p(() => api.me.update({ preferences: { digits: 'latn' } })),
  'me.participations': p(() => api.me.participations()),
  // owners and workspaces — owner-only (FORBIDDEN for every identity here)
  'owners.list': p(() => api.owners.list()),
  'owners.add': p((b) => api.owners.add({ userId: b.adminId })),
  'owners.remove': p((b) => api.owners.remove(b.adminId)),
  'workspaces.list': p(() => api.workspaces.list()),
  'workspaces.create': p(() => api.workspaces.create({ name: 'قسم ثالث' })),
  'workspaces.rename': p((b) => api.workspaces.rename(b.ws, { name: 'اسم جديد' })),
  'workspaces.archive': p((b) => api.workspaces.archive(b.ws)),
  'workspaces.restore': p((b) => api.workspaces.restore(b.ws)),
  'workspaces.summary': p((b) => api.workspaces.summary(b.ws)),
  'workspaces.admins': p((b) => api.workspaces.admins(b.ws)),
  'workspaces.addAdmin': p((b) => api.workspaces.addAdmin(b.ws, { userId: b.supId, confirmDualRole: true })),
  'workspaces.removeAdmin': p((b) => api.workspaces.removeAdmin(b.ws, b.adminId)),
  'workspaces.members': p((b) => api.workspaces.members(b.ws), (_b, a) => api.workspaces.members(a.ws)),
  'workspaces.addMember': p(
    (b) => api.workspaces.addMember(b.ws, { userId: b.adminId, role: 'MONITOR', confirmDualRole: true }),
    (_b, a) => api.workspaces.addMember(a.ws, { identifier: 'isob-admin', role: 'MONITOR' }),
  ),
  'workspaces.updateMember': p((b) => api.workspaces.updateMember(b.ws, uuid(), { title: 'x' })),
  'workspaces.removeMember': p((b) => api.workspaces.removeMember(b.ws, uuid())),
  // users
  'users.list': p(() => api.users.list({ q: 'isob' }), () => api.users.list({})),
  'users.get': p((b) => api.users.get(b.adminId), (b) => api.users.get(b.registrationId)),
  'users.create': p((b) => api.users.create({ fullName: 'حساب جديد', email: `n${Date.now()}@iso-a.example`, mobile: '0559990002', nationalId: validId('107700002'), memberships: [{ workspaceId: b.ws, role: 'ADMIN' }], password: PASSWORD })),
  'users.all': p(() => api.users.all({})),
  'users.update': p((b) => api.users.update(b.adminId, { fullName: 'مخترق' })),
  'users.setUsername': p((b) => api.users.setUsername(b.adminId, { username: 'stolen-name' })),
  'users.setPassword': p((b) => api.users.setPassword(b.adminId, { password: 'Stolen-Pass-2026', mustChangePassword: false })),
  'users.changeRole': p((b) => api.users.changeRole(b.supId, { role: 'ADMIN' })),
  'users.suspend': p((b) => api.users.suspend(b.adminId, {}), (b) => api.users.suspend(b.adminId, { scope: 'global' })),
  'users.reactivate': p((b) => api.users.reactivate(b.adminId), (b) => api.users.reactivate(b.adminId, { scope: 'global' })),
  'users.supervisors': p(() => api.users.supervisors()),
  'users.search': p(() => api.users.search({ q: '1066', page: 1, pageSize: 50 })),
  'registrations.list': p(() => api.registrations.list({})),
  'registrations.approve': p((b) => api.registrations.approve(b.registrationId, {})),
  'registrations.reject': p((b) => api.registrations.reject(b.registrationId, { reason: 'اختبار العزل' })),
  'audit.list': p(() => api.audit.list({ pageSize: 200 }), (b) => api.audit.list({ entityId: b.teamId })),
  'notifications.list': p(() => api.notifications.list({})),
  'notifications.unreadCount': p(() => api.notifications.unreadCount()),
  'notifications.markRead': p((b) => api.notifications.markRead(b.notificationId)),
  'notifications.markAllRead': p(() => api.notifications.markAllRead()),
  'settings.get': p(() => api.settings.get()),
  'settings.update': p(() => api.settings.update({ VIOLATION_EDIT_WINDOW_MINUTES: 60 } as never)),
  // colours and teams
  'colors.available': p((b) => api.colors.available(b.teamId), () => api.colors.available()),
  'colors.list': p(() => api.colors.list()),
  'colors.create': p(() => api.colors.create({ name: 'لون اختبار', hex: '#0A0B0C' })),
  'colors.update': p((b) => api.colors.update(b.colorId, { name: 'مسروق' })),
  'teams.list': p(() => api.teams.list({ status: 'ALL' }), () => api.teams.list({ q: MARK })),
  'teams.get': p((b) => api.teams.get(b.teamId)),
  'teams.create': p((b) => api.teams.create({ name: 'فريق مختلط', colorId: b.colorId, supervisorId: b.supId, members: [], existingMemberIds: [b.workerId] })),
  'teams.update': p((b) => api.teams.update(b.teamId, { name: 'مسروق' })),
  'teams.approve': p((b) => api.teams.approve(b.teamId)),
  'teams.reject': p((b) => api.teams.reject(b.teamId, { reason: 'اختبار العزل' })),
  'teams.archive': p((b) => api.teams.archive(b.teamId, { reason: 'اختبار العزل' })),
  'teams.changeSupervisor': p((b) => api.teams.changeSupervisor(b.teamId, { supervisorId: b.supId }), (b, a) => api.teams.changeSupervisor(a.teamId, { supervisorId: b.supId })),
  'teams.supervisorHistory': p((b) => api.teams.supervisorHistory(b.teamId)),
  'teams.setViolationVisibility': p((b) => api.teams.setViolationVisibility(b.teamId, 'SHOW')),
  'teams.addMember': p((b) => api.teams.addMember(b.teamId, { fullName: 'عامل مخترق', nationalId: validId('107700003') })),
  'teams.importMembers': p((b) => api.teams.importMembers({ teamId: b.teamId, rows: [{ fullName: 'عامل مستورد', nationalId: validId('107700004') }], commit: true })),
  'teams.supervisorsOf': p((b) => api.teams.supervisorsOf(b.teamId)),
  'teams.addSupervisor': p((b) => api.teams.addSupervisor(b.teamId, { userId: b.supId }), (b, a) => api.teams.addSupervisor(a.teamId, { userId: b.supId })),
  'teams.removeSupervisor': p((b) => api.teams.removeSupervisor(b.teamId, b.supId, { reason: 'اختبار العزل' })),
  'teams.setPrimarySupervisor': p((b) => api.teams.setPrimarySupervisor(b.teamId, b.supId, {})),
  'teams.setForeman': p((b) => api.teams.setForeman(b.teamId, b.workerId), (b, a) => api.teams.setForeman(a.teamId, b.workerId)),
  'teams.clearForeman': p((b) => api.teams.clearForeman(b.teamId)),
  // org
  'org.tree': p(() => api.org.tree({ includeArchived: true })),
  'org.createUnit': p((b) => api.org.createUnit({ parentId: b.unitId, name: 'تحت وحدة ب', kind: 'UNIT' })),
  'org.updateUnit': p((b) => api.org.updateUnit(b.unitId, { name: 'مسروقة' })),
  'org.moveUnit': p((b) => api.org.moveUnit(b.unitId, { parentId: null })),
  'org.deleteUnit': p((b) => api.org.deleteUnit(b.unitId)),
  'org.createPosition': p((b) => api.org.createPosition({ unitId: b.unitId, title: 'منصب مخترق' })),
  'org.updatePosition': p((b) => api.org.updatePosition(b.positionId, { title: 'مسروق' })),
  'org.movePosition': p((b) => api.org.movePosition(b.positionId, { unitId: b.unitId })),
  'org.deletePosition': p((b) => api.org.deletePosition(b.positionId)),
  // members and worker requests
  'members.list': p(() => api.members.list({ pageSize: 200 }), (b) => api.members.list({ teamId: b.teamId })),
  'members.get': p((b) => api.members.get(b.workerId)),
  'members.update': p((b) => api.members.update(b.workerId, { fullName: 'مسروق' })),
  'members.history': p((b) => api.members.history(b.workerId)),
  'members.move': p((b, a) => api.members.move({ memberIds: [b.workerId], toTeamId: a.teamId }), (b) => api.members.move({ memberIds: [b.workerId], toTeamId: b.teamId })),
  'members.search': p(() => api.members.search({ q: '1991', page: 1, pageSize: 50 })),
  'members.archive': p((b) => api.members.archive(b.workerId, { reason: 'اختبار العزل' })),
  'memberRequests.list': p(() => api.memberRequests.list({ status: 'ALL' }), (b) => api.memberRequests.list({ teamId: b.teamId, status: 'ALL' })),
  'memberRequests.get': p((b) => api.memberRequests.get(b.requestId)),
  'memberRequests.approve': p((b) => api.memberRequests.approve(b.requestId)),
  'memberRequests.reject': p((b) => api.memberRequests.reject(b.requestId, { reason: 'اختبار العزل' })),
  'participants.list': p((b) => api.participants.list(b.projectId)),
  // A12 round 3 — the picker: B's project refused; on A's project, B's names find nobody.
  'participants.candidates': p((b) => api.participants.candidates(b.projectId), (_b, a) => api.participants.candidates(a.projectId, MARK)),
  'participants.add': p((b) => api.participants.add(b.projectId, { userId: b.memberUserId, title: 'x', level: 'VIEWER' }), (b, a) => api.participants.add(a.projectId, { userId: b.memberUserId, title: 'x', level: 'VIEWER' })),
  'participants.update': p((b) => api.participants.update(b.projectId, b.memberUserId, { level: 'VIEWER' })),
  'participants.remove': p((b) => api.participants.remove(b.projectId, b.memberUserId)),
  // reference and cards
  'reference.list': p(() => api.reference.list('departments'), () => api.reference.list('job-titles')),
  'reference.create': p(() => api.reference.create('departments', { name: `إدارة اختبار ${Date.now()}` })),
  'reference.update': p((b) => api.reference.update('departments', b.referenceId, { name: 'مسروقة' })),
  'reference.remove': p((b) => api.reference.remove('departments', b.referenceId)),
  'cards.sizes': p(() => api.cards.sizes()),
  'cards.createSize': p(() => api.cards.createSize({ name: 'مقاس اختبار', widthMm: 90, heightMm: 55 })),
  'cards.deleteSize': p((b) => api.cards.deleteSize(b.sizeId)),
  'cards.templates': p(() => api.cards.templates()),
  'cards.createTemplate': p(async (b) => {
    const base = (await api.cards.templates())[0];
    return api.cards.createTemplate({ name: 'قالب مختلط', sizeId: b.sizeId, orientation: 'LANDSCAPE', layoutKey: 'CLASSIC_HORIZONTAL', config: base!.config, logoId: b.logoId });
  }),
  'cards.updateTemplate': p((b) => api.cards.updateTemplate(b.templateId, { name: 'مسروق' })),
  'cards.archiveTemplate': p((b) => api.cards.archiveTemplate(b.templateId)),
  'cards.preview': p((b) => api.cards.preview({ templateId: b.templateId, teamIds: [b.teamId] }), async (b) => {
    const tpl = (await api.cards.templates())[0]!;
    return api.cards.preview({ templateId: tpl.id, teamIds: [b.teamId], memberIds: [b.workerId] });
  }),
  'cards.createBatch': p(async (b) => {
    const tpl = (await api.cards.templates())[0]!;
    return api.cards.createBatch({ idempotencyKey: uuid(), templateId: tpl.id, items: [{ memberId: b.workerId, data: { fullName: 'x' } }] });
  }, (b) => api.cards.createBatch({ idempotencyKey: uuid(), templateId: b.templateId, items: [{ data: { fullName: 'x' } }] })),
  'cards.batches': p(() => api.cards.batches({})),
  'cards.batch': p((b) => api.cards.batch(b.batchId)),
  'cards.pdf': p((b) => api.cards.pdf(b.batchId)),
  // files and photos
  'files.presign': p(
    (b) => api.files.presign({ entityType: 'task', entityId: b.taskId, kind: 'ATTACHMENT', contentType: 'image/png', sizeBytes: 100 }),
    (b) => api.files.presign({ entityType: 'violation', entityId: b.violationId, kind: 'EVIDENCE', contentType: 'image/png', sizeBytes: 100 }),
    (b) => api.files.presign({ entityType: 'member_photo', entityId: b.workerId, kind: 'PHOTO', contentType: 'image/png', sizeBytes: 100 }),
    (b) => api.files.presign({ entityType: 'project_cover', entityId: b.projectId, contentType: 'image/png', sizeBytes: 100 }),
  ),
  'files.upload': p((b) => api.files.upload(fakePresigned(b.attachmentFileId), png())),
  'files.confirm': p((b) => api.files.confirm(b.attachmentFileId)),
  'photos.url': p((b) => api.photos.url({ kind: 'member', id: b.workerId }), (b) => api.photos.url({ kind: 'user', id: b.adminId })),
  'photos.upload': p((b) => api.photos.upload({ kind: 'member', id: b.workerId }, png())),
  'photos.remove': p((b) => api.photos.remove({ kind: 'member', id: b.workerId })),
  // violations
  'violationTypes.list': p(() => api.violationTypes.list({})),
  'violationTypes.create': p(() => api.violationTypes.create({ name: `نوع اختبار ${Date.now()}`, severity: 'LOW' })),
  'violationTypes.update': p((b) => api.violationTypes.update(b.typeId, { name: 'مسروق' })),
  'violations.roster': p(() => api.violations.roster()),
  'violations.create': p((b) =>
    api.violations.create({
      clientUuid: uuid(),
      memberId: b.workerId,
      typeId: b.typeId,
      description: 'مخالفة مختلطة',
      latitude: 24.7,
      longitude: 46.7,
      accuracyM: 5,
      capturedAt: new Date().toISOString(),
      deviceInfo: { userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test' },
      expectedIdPhotos: 1,
      expectedEvidencePhotos: 1,
    }),
  ),
  'violations.list': p(() => api.violations.list({ pageSize: 200 }), (b) => api.violations.list({ teamId: b.teamId } as never)),
  'violations.mine': p(() => api.violations.mine({})),
  'violations.get': p((b) => api.violations.get(b.violationId)),
  'violations.fileUrl': p((b) => api.violations.fileUrl(b.violationId, b.attachmentFileId)),
  'violations.update': p((b) => api.violations.update(b.violationId, { description: 'مسروق' })),
  'violations.setStatus': p((b) => api.violations.setStatus(b.violationId, { status: 'CONFIRMED' })),
  'violations.respond': p((b) => api.violations.respond(b.violationId, { body: 'رد مخترق' } as never)),
  'violations.stats': p(() => api.violations.stats({}), (b) => api.violations.stats({ teamId: b.teamId } as never)),
  'violations.exportXlsx': p(() => api.violations.exportXlsx({})),
  'violations.dashboardPdf': p(() => api.violations.dashboardPdf({})),
  'violations.ocr': p((b) => api.violations.ocr(b.violationId)),
  'violations.retryOcr': p((b) => api.violations.retryOcr(b.violationId)),
  'violations.assign': p((b) => api.violations.assign(b.violationId, { memberId: b.workerId })),
  'violations.unassign': p((b) => api.violations.unassign(b.violationId, {})),
  'violations.registerMember': p((b) => api.violations.registerMember(b.violationId, { fullName: 'مسجّل', nationalId: validId('107700005'), teamId: b.teamId })),
  'logos.list': p(() => api.logos.list()),
  'logos.upload': p(() => api.logos.upload({ name: `شعار اختبار ${Date.now()}`, file: png() as Blob & { type: string } })),
  'logos.setDefault': p((b) => api.logos.setDefault(b.logoId)),
  'logos.remove': p((b) => api.logos.remove(b.logoId)),
  // projects and tasks
  'projects.list': p(() => api.projects.list({ status: 'ALL' }), () => api.projects.list({ q: MARK })),
  'projects.get': p((b) => api.projects.get(b.projectId)),
  'projects.create': p((b) => api.projects.create({ name: 'مشروع مختلط', startDate: '2026-11-01', calendarId: b.calendarId })),
  'projects.update': p((b) => api.projects.update(b.projectId, { name: 'مسروق' })),
  'projects.archive': p((b) => api.projects.archive(b.projectId)),
  'projects.access': p((b) => api.projects.access(b.projectId)),
  'projects.grantAccess': p((b) => api.projects.grantAccess(b.projectId, { userId: b.supId }), (b, a) => api.projects.grantAccess(a.projectId, { userId: b.supId })),
  'projects.revokeAccess': p((b) => api.projects.revokeAccess(b.projectId, b.supId)),
  'projects.gantt': p((b) => api.projects.gantt(b.projectId)),
  'projects.exportXlsx': p((b) => api.projects.exportXlsx(b.projectId)),
  'projects.export': p((b) => api.projects.export(b.projectId, 'csv'), (b) => api.projects.export(b.projectId, 'xml')),
  'projects.convert': p((b) => api.projects.convert(b.projectId, 'HOUR')),
  'projects.budget': p((b) => api.projects.budget(b.projectId)),
  'projects.people': p((b) => api.projects.people(b.projectId)),
  'projects.dashboard': p((b) => api.projects.dashboard(b.projectId)),
  'projects.calendar': p((b) => api.projects.calendar(b.projectId, { from: '2026-11-01', to: '2026-12-31' })),
  'projects.saveAsTemplate': p((b) => api.projects.saveAsTemplate(b.projectId, { name: 'قالب مختلط' })),
  'projects.templates': p(() => api.projects.templates()),
  'projects.report': p(() => api.projects.report({ status: 'ALL' })),
  'projects.coverUrl': p((b) => api.projects.coverUrl(b.projectId)),
  'projects.uploadCover': p((b) => api.projects.uploadCover(b.projectId, png())),
  'projects.removeCover': p((b) => api.projects.removeCover(b.projectId)),
  'tasks.create': p((b) => api.tasks.create(b.projectId, { name: 'مهمة مختلطة', startDate: '2026-11-01' }), (b, a) => api.tasks.create(a.projectId, { name: 'مهمة مختلطة', startDate: '2026-11-01', assigneeId: b.supId, parentId: b.taskId })),
  'tasks.get': p((b) => api.tasks.get(b.taskId)),
  'tasks.update': p((b) => api.tasks.update(b.taskId, { version: 1, name: 'مسروقة' } as never), (b) => api.tasks.update(b.taskId, { version: 1, progress: 50 } as never)),
  'tasks.batch': p((b) => api.tasks.batch(b.projectId, { changes: [{ id: b.taskId, version: 1, durationDays: 9 }] } as never), (b, a) => api.tasks.batch(a.projectId, { changes: [{ id: b.taskId, version: 1, durationDays: 9 }] } as never)),
  'tasks.archive': p((b) => api.tasks.archive(b.taskId)),
  'tasks.mine': p(() => api.tasks.mine()),
  'tasks.comments': p((b) => api.tasks.comments(b.taskId)),
  'tasks.addComment': p((b) => api.tasks.addComment(b.taskId, { body: 'تعليق مخترق', mentions: [] }), (b, a) => api.tasks.addComment(a.taskId, { body: 'إشارة', mentions: [b.adminId] })),
  'tasks.markRead': p((b) => api.tasks.markRead(b.taskId)),
  'tasks.activity': p((b) => api.tasks.activity(b.taskId)),
  'tasks.attachments': p((b) => api.tasks.attachments(b.taskId)),
  'tasks.attach': p((b) => api.tasks.attach(b.taskId, b.attachmentFileId), (b, a) => api.tasks.attach(a.taskId, b.attachmentFileId)),
  'tasks.attachmentUrl': p((b) => api.tasks.attachmentUrl(b.taskId, b.attachmentFileId), (b, a) => api.tasks.attachmentUrl(a.taskId, b.attachmentFileId)),
  'tasks.removeAttachment': p((b) => api.tasks.removeAttachment(b.taskId, b.attachmentFileId)),
  'tasks.duplicate': p((b) => api.tasks.duplicate(b.taskId, {})),
  'tasks.bulk': p((b) => api.tasks.bulk(b.projectId, { ids: [b.taskId], versions: { [b.taskId]: 1 }, patch: { priority: 'HIGH' } }), (b, a) => api.tasks.bulk(a.projectId, { ids: [b.taskId], versions: { [b.taskId]: 1 }, patch: { priority: 'HIGH' } })),
  'tasks.bulkArchive': p((b) => api.tasks.bulkArchive(b.projectId, { ids: [b.taskId] } as never)),
  'tasks.restore': p((b) => api.tasks.restore(b.projectId, [b.taskId]), (b, a) => api.tasks.restore(a.projectId, [b.taskId])),
  'tasks.labels': p((b) => api.tasks.labels(b.taskId)),
  'tasks.addLabel': p((b) => api.tasks.addLabel(b.taskId, b.labelId), (b, a) => api.tasks.addLabel(a.taskId, b.labelId)),
  'tasks.removeLabel': p((b) => api.tasks.removeLabel(b.taskId, b.labelId)),
  'tasks.customFields': p((b) => api.tasks.customFields(b.taskId)),
  'tasks.setCustomValue': p((b) => api.tasks.setCustomValue(b.taskId, b.fieldId, 'x'), (b, a) => api.tasks.setCustomValue(a.taskId, b.fieldId, 'x')),
  'tasks.checklist': p((b) => api.tasks.checklist(b.taskId)),
  'tasks.addChecklistItem': p((b) => api.tasks.addChecklistItem(b.taskId, { text: 'بند مخترق' })),
  'tasks.updateChecklistItem': p((b) => api.tasks.updateChecklistItem(b.taskId, b.checklistId, { done: true }), (b, a) => api.tasks.updateChecklistItem(a.taskId, b.checklistId, { done: true })),
  'tasks.removeChecklistItem': p((b) => api.tasks.removeChecklistItem(b.taskId, b.checklistId)),
  'tasks.reorderChecklist': p((b) => api.tasks.reorderChecklist(b.taskId, { ids: [b.checklistId] } as never)),
  'tasks.timeEntries': p((b) => api.tasks.timeEntries(b.taskId)),
  'tasks.addTimeEntry': p((b) => api.tasks.addTimeEntry(b.taskId, { date: new Date().toISOString().slice(0, 10), minutes: 30 })),
  'dependencies.create': p((b) => api.dependencies.create(b.projectId, { predecessorId: b.task2Id, successorId: b.taskId }), (b, a) => api.dependencies.create(a.projectId, { predecessorId: a.taskId, successorId: b.taskId })),
  'dependencies.remove': p((b) => api.dependencies.remove(b.dependencyId)),
  'calendars.list': p(() => api.calendars.list()),
  'calendars.get': p((b) => api.calendars.get(b.calendarId)),
  'calendars.create': p(() => api.calendars.create({ name: `تقويم اختبار ${Date.now()}`, weekendDays: [5, 6] })),
  'calendars.update': p((b) => api.calendars.update(b.calendarId, { name: 'مسروق' })),
  'calendars.addException': p((b) => api.calendars.addException(b.calendarId, { date: '2026-12-02', isWorking: false, name: 'عطلة مخترقة' })),
  'calendars.removeException': p((b) => api.calendars.removeException(b.calendarId, b.exceptionId)),
  'labels.list': p((b) => api.labels.list(b.projectId)),
  'labels.create': p((b) => api.labels.create(b.projectId, { name: 'وسم مخترق', color: '#654321' })),
  'labels.update': p((b) => api.labels.update(b.labelId, { name: 'مسروق' })),
  'labels.remove': p((b) => api.labels.remove(b.labelId)),
  'customFields.list': p((b) => api.customFields.list(b.projectId)),
  'customFields.create': p((b) => api.customFields.create(b.projectId, { name: 'حقل مخترق', type: 'TEXT' })),
  'customFields.update': p((b) => api.customFields.update(b.fieldId, { name: 'مسروق' })),
  'customFields.remove': p((b) => api.customFields.remove(b.fieldId)),
  'timeEntries.mine': p(() => api.timeEntries.mine({ from: '2026-01-01', to: '2027-12-31' })),
  'timeEntries.update': p((b) => api.timeEntries.update(b.timeEntryId, { minutes: 5 })),
  'timeEntries.remove': p((b) => api.timeEntries.remove(b.timeEntryId)),
  'viewPrefs.list': p((b) => api.viewPrefs.list({ projectId: b.projectId }), () => api.viewPrefs.list({})),
  'viewPrefs.put': p((b) => api.viewPrefs.put({ projectId: b.projectId, key: 'gantt.columns', value: [] })),
  'viewPrefs.remove': p((b) => api.viewPrefs.remove({ projectId: b.projectId, key: 'gantt.columns' })),
  'portfolios.list': p(() => api.portfolios.list()),
  'portfolios.get': p((b) => api.portfolios.get(b.portfolioId)),
  'portfolios.create': p((b) => api.portfolios.create({ name: 'محفظة مختلطة', projectIds: [b.projectId] })),
  'portfolios.update': p((b) => api.portfolios.update(b.portfolioId, { name: 'مسروقة' })),
  'portfolios.remove': p((b) => api.portfolios.remove(b.portfolioId)),
  'portfolios.addProject': p((b) => api.portfolios.addProject(b.portfolioId, b.projectId)),
  'portfolios.removeProject': p((b) => api.portfolios.removeProject(b.portfolioId, b.projectId)),
  workload: p((b) => api.workload({ from: '2026-11-01', to: '2026-12-31', userIds: [b.supId] }), () => api.workload({ from: '2026-11-01', to: '2026-12-31' })),
  'imports.upload': p(() => api.imports.upload(new Blob(['name\nx'], { type: 'text/csv' }), 'text/csv')),
  'imports.preview': p((b) => api.imports.preview({ fileId: b.attachmentFileId, format: 'csv', options: {} } as never)),
  'imports.jira': p(() => api.imports.jira({ siteUrl: 'https://iso.atlassian.net', email: 'a@iso.example', apiToken: 'x'.repeat(12), projectKey: 'ISO', options: {} } as never)),
  'imports.commit': p(() => api.imports.commit({ previewId: uuid() } as never)),
  'hub.list': p(() => api.hub.list({ filter: 'all', pageSize: 100 }), (b) => api.hub.list({ projectId: b.projectId, filter: 'all' })),
  'hub.attachments': p(() => api.hub.attachments({ pageSize: 100 }), (b) => api.hub.attachments({ projectId: b.projectId } as never)),
};

// ---------------------------------------------------------------------------- checks

/** Every member of `interface ApiClient` (namespace.method), read from client.ts. */
function apiClientMethods(): string[] {
  const file = join(__dirname, '..', 'client.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  ts.forEachChild(sf, (n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== 'ApiClient') return;
    for (const m of n.members) {
      const name = m.name?.getText(sf) ?? '';
      if (ts.isPropertySignature(m) && m.type && ts.isTypeLiteralNode(m.type)) {
        for (const mm of m.type.members) out.push(`${name}.${mm.name?.getText(sf) ?? ''}`);
      } else out.push(name);
    }
  });
  return out;
}

async function textOf(value: unknown): Promise<string> {
  if (value instanceof Blob) {
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(value);
    });
    if (value.type.includes('spreadsheet') || new Uint8Array(buf.slice(0, 2)).join(',') === '80,75') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const cells: string[] = [];
      wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => cells.push(String(c.text ?? '')))));
      return cells.join('\n');
    }
    return new TextDecoder().decode(buf);
  }
  return JSON.stringify(value ?? null);
}

class Leak extends Error {}

async function probe(name: string, run: () => Promise<unknown>, stats: { refused: number; clean: number }, allowed: ReadonlySet<string> = new Set()) {
  let out: unknown;
  try {
    out = await run();
  } catch (err) {
    if (err instanceof ApiError) {
      stats.refused += 1;
      return;
    }
    throw new Error(`${name}: not an API answer — ${(err as Error)?.stack ?? String(err)}`);
  }
  const text = await textOf(out);
  const leaked = [...allBIds].filter((id) => !allowed.has(id) && text.includes(id));
  if (text.includes(MARK) || leaked.length) {
    throw new Leak(`${name}: workspace B leaked (${leaked.join(', ') || MARK}) → ${text.slice(0, 300)}`);
  }
  stats.clean += 1;
}

// ---------------------------------------------------------------------------- the suite

beforeAll(async () => {
  api = new DemoApi({ dbName: `nuzli-isolation-${Date.now()}` });
  // The demo's OCR engine is not needed here (no ID-card photo is uploaded).
  try {
    B = await buildB();
  } catch (err) {
    throw new Error(`building workspace B failed: ${(err as Error).message} ${JSON.stringify((err as ApiError).details ?? null)} ${(err as Error).stack}`);
  }
  for (const v of Object.values(B)) allBIds.add(v);
  // Workspace A («إدارة المشاريع»): an assistant with every module, and A's own ids.
  await login('mmansary');
  const a = (await api.auth.workspaces()).find((w) => w.id !== B.ws)!;
  const s = await api.auth.switchWorkspace(a.id);
  api.setAccessToken(s.accessToken);
  const everything = Object.fromEntries(
    ['projects', 'tasks', 'budget', 'teams', 'members', 'formation', 'cards', 'cardTemplates', 'violations', 'violationStats', 'reference', 'calendars', 'org', 'registrations', 'reports'].map((m) => [m, 'edit']),
  );
  await api.users.create({
    username: 'isoa-assistant',
    fullName: 'مساعد القسم أ للاختبار',
    email: 'isoa-assistant@iso-a.example',
    mobile: '0558110021',
    nationalId: validId('106600210'),
    password: PASSWORD,
    mustChangePassword: false,
    memberships: [{ workspaceId: a.id, role: 'ASSISTANT', permissions: { ...everything, users: 'view', audit: 'view', settings: 'view' } }],
  });
  const project = (await api.projects.list({}))[0]!;
  const task = (await api.projects.gantt(project.id)).tasks.find((t) => t.type === 'TASK')!;
  const team = (await api.teams.list({}))[0]!;
  A = { ws: a.id, projectId: project.id, taskId: task.id, teamId: team.id };
  api.setAccessToken(null);
  before = await snapshotB(B.ws);
}, 120_000);

describe('A12 demo isolation — coverage gate', () => {
  it('every ApiClient method has an isolation case (and no case is stale)', () => {
    const methods = apiClientMethods();
    expect(methods.length).toBeGreaterThan(200);
    expect(methods.filter((m) => !(m in CASES))).toEqual([]);
    expect(Object.keys(CASES).filter((k) => !methods.includes(k))).toEqual([]);
  });
});

const IDENTITIES: { name: string; login: [string, string?] }[] = [
  { name: 'admin of A', login: ['admin1'] },
  { name: 'assistant of A (every module)', login: ['isoa-assistant', PASSWORD] },
  { name: 'supervisor of A', login: ['supervisor1'] },
  { name: 'monitor of A', login: ['monitor1'] },
  { name: 'project participant of A (editor)', login: ['editor1'] },
  // Security review A12 M5: roles in A and B, working in A.
  { name: 'person with roles in A and B (working in A)', login: [DUAL, PASSWORD] },
];

describe('A12 demo isolation — six identities of workspace A aimed at workspace B', () => {
  for (const who of IDENTITIES) {
    it(`${who.name}: every method refuses B or answers without B`, async () => {
      const stats = { refused: 0, clean: 0 };
      for (const [name, c] of Object.entries(CASES)) {
        if ('exempt' in c) continue;
        // The dual member may enter B — that is their own right (and is audited in B), not a leak.
        if (who.login[0] === DUAL && name === 'auth.switchWorkspace') continue;
        for (const run of c.probes) {
          await login(...(who.login as [string, string?]));
          // The dual member's OWN session lists the workspaces they belong to — B's id among them.
          const allowed = who.login[0] === DUAL && name.startsWith('auth.') ? new Set([B.ws]) : undefined;
          await probe(name, () => run(B, A), stats, allowed);
        }
      }
      expect(stats.refused + stats.clean).toBeGreaterThan(250);
      expect(stats.refused).toBeGreaterThan(100);
    }, 180_000);
  }

  it('positive controls: A works for its own users (the probes are not failing for another reason)', async () => {
    await login('admin1');
    expect((await api.teams.list({})).length).toBeGreaterThan(0);
    expect((await api.projects.list({})).length).toBeGreaterThan(0);
    expect((await api.users.list({})).total).toBeGreaterThan(5);
    expect((await api.members.list({})).total).toBeGreaterThan(10);
    expect((await api.violations.list({})).total).toBeGreaterThan(10);
    await login('isoa-assistant', PASSWORD);
    expect((await api.projects.list({})).length).toBeGreaterThan(0);
    expect((await api.teams.list({})).length).toBeGreaterThan(0);
    await login('editor1');
    // editor1 is a participant of «تأهيل حديقة الحي الشمالي» only.
    expect((await api.projects.list({})).map((x) => x.id)).toEqual(['00000000-0000-4000-8000-f00000000001']);
  }, 60_000);

  it('M5: the fixture puts B rows in EVERY scoped table (so a missing filter has something to leak)', async () => {
    const empty: string[] = [];
    for (const name of SCOPED_TABLES) {
      const n = await api.unscoped(async () => (await api.db.table(name).toArray()).filter((r: Record<string, unknown>) => r.wid === B.ws).length, 'r');
      if (!n) empty.push(name);
    }
    expect(empty).toEqual([]);
  });

  it('M5: APP LAYER, table by table — every scoped Dexie table read in A’s context returns no row of B', async () => {
    await login('admin1');
    const leaks: string[] = [];
    for (const name of SCOPED_TABLES) {
      const rows = (await api.inWorkspace(A.ws, () => api.db.table(name).toArray(), 'r')) as Array<Record<string, unknown>>;
      const foreign = rows.filter((r) => r.wid !== A.ws && !(name === 'files' && r.wid == null && r.entityType === 'user_photo'));
      if (foreign.length) leaks.push(`${name}: ${foreign.length} row(s) of another workspace`);
      const inB = await api.inWorkspace(A.ws, () => api.db.table(name).filter((r: Record<string, unknown>) => r.wid === B.ws).count(), 'r');
      if (inB) leaks.push(`${name}.filter(wid = B).count → ${inB}`);
    }
    expect(leaks).toEqual([]);
  });

  it('M5: the dual member, in A, sees nothing of B in their own notifications, participations and session', async () => {
    await login(DUAL, PASSWORD);
    const text = JSON.stringify([await api.notifications.list({}), await api.notifications.unreadCount(), await api.me.participations(), await api.auth.me(), await api.viewPrefs.list({ projectId: B.projectId })]);
    expect(text).not.toContain(MARK);
    expect(text).not.toContain(B.projectId);
  });

  it('B itself still sees its data (the probes did not delete anything)', async () => {
    await login('isob-admin', PASSWORD);
    expect((await api.projects.get(B.projectId)).name).toContain(MARK);
    expect((await api.teams.get(B.teamId)).name).toContain(MARK);
    expect((await api.memberRequests.get(B.requestId)).status).toBe('PENDING');
  });
});

afterAll(async () => {
  // Byte-for-byte: B's rows, memberships, accounts, workspace and settings are unchanged.
  const after = await snapshotB(B.ws);
  expect(after).toBe(before);
});
