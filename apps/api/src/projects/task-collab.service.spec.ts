import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectStore } from './project-store';
import { notificationPreview, TaskCollabService } from './task-collab.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const supCtx: RequestContext = { ...ctx, actorId: 'sup1' };
const ADMIN: AuthUser = { id: 'admin', role: 'ADMIN', status: 'ACTIVE', fullName: 'المدير', mustChangePassword: false, accountRole: 'USER', workspaceId: 'ws-test', roles: [] };
const SUP: AuthUser = { id: 'sup1', role: 'SUPERVISOR', status: 'ACTIVE', fullName: 'مشرف', mustChangePassword: false, accountRole: 'USER', workspaceId: 'ws-test', roles: [] };
const SUP2: AuthUser = { id: 'sup2', role: 'SUPERVISOR', status: 'ACTIVE', fullName: 'مشرف ٢', mustChangePassword: false, accountRole: 'USER', workspaceId: 'ws-test', roles: [] };
const P = '00000000-0000-4000-8000-0000000000a1';
const T = 'a0000000-0000-4000-8000-00000000000a';
const U = 'b0000000-0000-4000-8000-00000000000b';

async function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
}

function setup() {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'admin2', fullName: 'مدير ٢', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف', role: 'SUPERVISOR', status: 'ACTIVE' },
      { id: 'sup2', fullName: 'مشرف ٢', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [] }],
    projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' }],
    tasks: [task({ id: T, projectId: P, assigneeId: 'sup1' }), task({ id: U, projectId: P, startDate: d('2026-10-12'), endDate: d('2026-10-12') })],
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const files = { registerHook: jest.fn() };
  const service = new TaskCollabService(fake.db as never, store, audit, fake.notifications as never, files as never, {} as never, {} as never);
  return { fake, service };
}

describe('TaskCollabService', () => {
  it('a comment with mentions notifies TASK_MENTIONED (not the author) and is audited', async () => {
    const { fake, service } = setup();
    const c = await service.addComment(T, { body: 'راجع هذا يا @مشرف', mentions: ['sup1', 'admin', 'sup1'] }, ADMIN, ctx);
    expect(c.mentions).toEqual(['sup1', 'admin']);
    expect(fake.data.notifications).toEqual([expect.objectContaining({ userId: 'sup1', type: 'TASK_MENTIONED' })]);
    expect(fake.data.audit).toEqual([expect.objectContaining({ action: 'task.comment_added', entityId: T })]);
  });

  it('mentioning someone who cannot open the task is a validation error (A9: admins and the assignee only)', async () => {
    const { fake, service } = setup();
    expect(await code(service.addComment(T, { body: 'مرحبا', mentions: ['stranger'] }, ADMIN, ctx))).toBe('VALIDATION_FAILED');
    // sup2 is an active supervisor but not the assignee of T.
    expect(await code(service.addComment(T, { body: 'مرحبا', mentions: ['sup2'] }, ADMIN, ctx))).toBe('VALIDATION_FAILED');
    expect(fake.data.comments).toHaveLength(0);
  });

  it('uploads: admins and the assignee only; an entity id is required', async () => {
    const { service } = setup();
    const input = { entityType: 'task' as const, contentType: 'application/pdf' as const, sizeBytes: 10 };
    expect(await code(service.beforePresign({ ...input, entityId: T }, SUP))).toBeUndefined();
    // A9 (ADR-092): a task not assigned to the supervisor is invisible → 404.
    expect(await code(service.beforePresign({ ...input, entityId: U }, SUP))).toBe('NOT_FOUND');
    expect(await code(service.beforePresign({ ...input, entityId: U }, ADMIN))).toBeUndefined();
    expect(await code(service.beforePresign(input, ADMIN))).toBe('VALIDATION_FAILED');
  });
});

describe('TaskCollabService — A9 supervisor chat and TASK_COMMENTED', () => {
  it('the assigned supervisor reads and replies on their task; another supervisor gets 404', async () => {
    const { fake, service } = setup();
    const first = await service.addComment(T, { body: 'ابدأ اليوم من فضلك', mentions: [] }, ADMIN, ctx);
    const thread = await service.comments(T, SUP);
    expect(thread.map((c) => c.body)).toEqual(['ابدأ اليوم من فضلك']);
    const reply = await service.addComment(T, { body: 'تمام، بدأنا', mentions: [], replyToId: first.id }, SUP, supCtx);
    expect(reply.replyTo).toEqual({ id: first.id, authorName: 'المدير', bodyPreview: 'ابدأ اليوم من فضلك' });
    expect(await code(service.comments(T, SUP2))).toBe('NOT_FOUND');
    expect(await code(service.addComment(T, { body: 'x', mentions: [] }, SUP2, ctx))).toBe('NOT_FOUND');
    expect(await code(service.comments(U, SUP))).toBe('NOT_FOUND');
    expect(fake.data.comments).toHaveLength(2);
  });

  it('a quote must be a comment of the same task', async () => {
    const { fake, service } = setup();
    const other = await service.addComment(U, { body: 'على مهمة أخرى', mentions: [] }, ADMIN, ctx);
    expect(await code(service.addComment(T, { body: 'رد', mentions: [], replyToId: other.id }, ADMIN, ctx))).toBe('COMMENT_REPLY_INVALID');
    expect(fake.data.comments).toHaveLength(1);
  });

  it('TASK_COMMENTED goes to the assignee and earlier commenters, never the author; mentioned users get only TASK_MENTIONED', async () => {
    const { fake, service } = setup();
    await service.addComment(T, { body: 'أول تعليق', mentions: [] }, { ...ADMIN, id: 'admin2', fullName: 'مدير ٢' }, ctx);
    expect(fake.data.notifications).toEqual([expect.objectContaining({ userId: 'sup1', type: 'TASK_COMMENTED' })]);
    fake.data.notifications.length = 0;
    await service.addComment(T, { body: 'رد المشرف', mentions: ['admin'] }, SUP, supCtx);
    const byType = (t: string) => fake.data.notifications.filter((n) => n.type === t).map((n) => n.userId).sort();
    expect(byType('TASK_MENTIONED')).toEqual(['admin']);
    expect(byType('TASK_COMMENTED')).toEqual(['admin2']);
    expect(fake.data.notifications.some((n) => n.userId === 'sup1')).toBe(false);
  });

  it('posting marks the thread read for the author; markRead stores the time', async () => {
    const { fake, service } = setup();
    await service.addComment(T, { body: 'x', mentions: [] }, ADMIN, ctx);
    expect(fake.data.commentReads).toEqual([expect.objectContaining({ userId: 'admin', taskId: T })]);
    const at = new Date('2026-10-19T08:00:00Z');
    expect(await service.markRead(T, SUP, at)).toEqual({ taskId: T, lastReadAt: at.toISOString() });
    expect(fake.data.commentReads).toHaveLength(2);
    expect(await code(service.markRead(U, SUP))).toBe('NOT_FOUND');
  });
});

describe('notification previews never carry a national ID', () => {
  it('masks 10-digit IDs (Western and Arabic-Indic digits) but keeps other numbers', () => {
    expect(notificationPreview('هوية العامل 1012345678 والجوال 0551234567')).toBe('هوية العامل •••••••••• والجوال 0551234567');
    expect(notificationPreview('رقم ٢٠١٢٣٤٥٦٧٨ هنا')).toBe('رقم •••••••••• هنا');
    expect(notificationPreview('12 عاملًا')).toBe('12 عاملًا');
  });
});
