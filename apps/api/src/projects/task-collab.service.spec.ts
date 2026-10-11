import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthUser, RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectStore } from './project-store';
import { TaskCollabService } from './task-collab.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const ADMIN: AuthUser = { id: 'admin', role: 'ADMIN', status: 'ACTIVE', fullName: 'المدير', mustChangePassword: false };
const SUP: AuthUser = { id: 'sup1', role: 'SUPERVISOR', status: 'ACTIVE', fullName: 'مشرف', mustChangePassword: false };
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
      { id: 'sup1', fullName: 'مشرف', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [] }],
    projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' }],
    tasks: [task({ id: T, projectId: P, assigneeId: 'sup1' }), task({ id: U, projectId: P, startDate: d('2026-10-12'), endDate: d('2026-10-12') })],
  });
  const comments: Array<Record<string, unknown>> = [];
  Object.assign(fake.db, {
    taskComment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'c1', body: data.body, mentions: data.mentions, createdAt: new Date('2026-10-12T05:00:00Z'), author: { id: data.authorId, fullName: 'المدير' } };
        comments.push(row);
        return Promise.resolve(row);
      }),
    },
  });
  // Mentionable = active admins + supervisors with access or an assigned task in the project.
  fake.db.user.findMany = jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(where.id.in.filter((id) => id === 'admin' || id === 'sup1').map((id) => ({ id }))),
  );
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const files = { registerHook: jest.fn() };
  const service = new TaskCollabService(fake.db as never, store, audit, fake.notifications as never, files as never, {} as never, {} as never);
  return { fake, service, comments };
}

describe('TaskCollabService', () => {
  it('a comment with mentions notifies TASK_MENTIONED (not the author) and is audited', async () => {
    const { fake, service } = setup();
    const c = await service.addComment(T, { body: 'راجع هذا يا @مشرف', mentions: ['sup1', 'admin', 'sup1'] }, ADMIN, ctx);
    expect(c.mentions).toEqual(['sup1', 'admin']);
    expect(fake.data.notifications).toEqual([expect.objectContaining({ userId: 'sup1', type: 'TASK_MENTIONED' })]);
    expect(fake.data.audit).toEqual([expect.objectContaining({ action: 'task.comment_added', entityId: T })]);
  });

  it('mentioning someone without access to the project is a validation error', async () => {
    const { service, comments } = setup();
    expect(await code(service.addComment(T, { body: 'مرحبا', mentions: ['stranger'] }, ADMIN, ctx))).toBe('VALIDATION_FAILED');
    expect(comments).toHaveLength(0);
  });

  it('uploads: admins and the assignee only; an entity id is required', async () => {
    const { service } = setup();
    const input = { entityType: 'task' as const, contentType: 'application/pdf' as const, sizeBytes: 10 };
    expect(await code(service.beforePresign({ ...input, entityId: T }, SUP))).toBeUndefined();
    expect(await code(service.beforePresign({ ...input, entityId: U }, SUP))).toBe('FORBIDDEN');
    expect(await code(service.beforePresign({ ...input, entityId: U }, ADMIN))).toBeUndefined();
    expect(await code(service.beforePresign(input, ADMIN))).toBe('VALIDATION_FAILED');
  });
});
