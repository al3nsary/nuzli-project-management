import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { TaskDueService } from './task-due.service';

const P = '00000000-0000-4000-8000-0000000000a1';

function setup() {
  const fake = createFakeDb({
    users: [{ id: 'sup1', fullName: 'مشرف', role: 'SUPERVISOR', status: 'ACTIVE' }],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [{ id: 'h', date: d('2026-10-13'), isWorking: false, name: 'عطلة' }] }],
    projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'sup1' }],
    tasks: [
      task({ id: 'late', projectId: P, assigneeId: 'sup1', startDate: d('2026-10-05'), endDate: d('2026-10-08') }),
      task({ id: 'late-done', projectId: P, assigneeId: 'sup1', endDate: d('2026-10-08'), startDate: d('2026-10-08'), status: 'DONE' }),
      task({ id: 'late-unassigned', projectId: P, endDate: d('2026-10-08'), startDate: d('2026-10-08') }),
      // Today Mon 12; Tue 13 is a holiday → 2 working days ahead = Wed 14, Thu 15.
      task({ id: 'soon', projectId: P, assigneeId: 'sup1', endDate: d('2026-10-15'), startDate: d('2026-10-15') }),
      task({ id: 'later', projectId: P, assigneeId: 'sup1', endDate: d('2026-10-18'), startDate: d('2026-10-18') }),
    ],
  });
  const service = new TaskDueService(fake.db as never, fake.notifications as never);
  return { fake, service };
}

describe('TaskDueService — daily reminders', () => {
  // 07:00 Riyadh on Mon 2026-10-12.
  const NOW = new Date('2026-10-12T04:00:00Z');

  it('sends TASK_OVERDUE and TASK_DUE_SOON once per task (working days of the project calendar)', async () => {
    const { fake, service } = setup();
    expect(await service.run(NOW)).toEqual({ overdue: 1, dueSoon: 1 });
    expect(fake.data.notifications.map((n) => [n.type, (n.payload as { taskId: string }).taskId])).toEqual([
      ['TASK_OVERDUE', 'late'],
      ['TASK_DUE_SOON', 'soon'],
    ]);
    expect(fake.data.tasks.find((t) => t.id === 'late')?.overdueNotifiedAt).toEqual(NOW);

    // Idempotent: a second run (or the next day) sends nothing new.
    expect(await service.run(NOW)).toEqual({ overdue: 0, dueSoon: 0 });
    expect(await service.run(new Date('2026-10-13T04:00:00Z'))).toEqual({ overdue: 0, dueSoon: 0 });
    expect(fake.data.notifications).toHaveLength(2);
  });

  it('two runs racing for the same task notify once (the column is claimed first)', async () => {
    const { fake, service } = setup();
    await Promise.all([service.run(NOW), service.run(NOW)]);
    expect(fake.data.notifications.filter((n) => n.type === 'TASK_OVERDUE')).toHaveLength(1);
  });

  it('a date change resets the flag, so the task is reminded again', async () => {
    const { fake, service } = setup();
    await service.run(NOW);
    const soon = fake.data.tasks.find((t) => t.id === 'soon')!;
    // What ProjectStore.persist does when the end date moves.
    Object.assign(soon, { endDate: d('2026-10-14'), dueSoonNotifiedAt: null, overdueNotifiedAt: null });
    expect(await service.run(NOW)).toEqual({ overdue: 0, dueSoon: 1 });
  });
});
