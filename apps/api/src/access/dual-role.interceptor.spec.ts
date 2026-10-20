import { DualRoleInterceptor, dualRoleUserIds } from './dual-role.interceptor';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function fakePrisma(dual: string[]) {
  const calls: unknown[] = [];
  return {
    calls,
    workspaceMembership: {
      groupBy: jest.fn(async (args: { where: { userId: { in: string[] } } }) => {
        calls.push(args);
        return args.where.userId.in.filter((id) => dual.includes(id)).map((userId) => ({ userId }));
      }),
    },
  };
}

describe('A12 round 3 — DualRoleInterceptor (one grouped query per answer)', () => {
  it('a gantt-like answer with many refs costs ONE grouped query on live memberships', async () => {
    const prisma = fakePrisma([U2]);
    const i = new DualRoleInterceptor(prisma as never);
    const gantt = {
      tasks: Array.from({ length: 50 }, (_, n) => ({ id: `t${n}`, assignee: { id: n % 2 ? U1 : U2, fullName: 'x' } })),
      comments: [{ author: { id: U3, fullName: 'y' } }],
    };
    const out = await i.decorate(gantt);
    expect(prisma.workspaceMembership.groupBy).toHaveBeenCalledTimes(1);
    const args = prisma.calls[0] as { where: { userId: { in: string[] }; archivedAt: null }; having: unknown };
    expect(args.where.userId.in.sort()).toEqual([U1, U2, U3].sort());
    expect(args.where.archivedAt).toBeNull();
    expect(args.having).toEqual({ userId: { _count: { gt: 1 } } });
    expect(out.tasks[1]!.assignee).toEqual({ id: U1, fullName: 'x' });
    expect(out.tasks[0]!.assignee).toEqual({ id: U2, fullName: 'x', dualRole: true });
  });

  it('no person ref, a Buffer, or no answer → no query', async () => {
    const prisma = fakePrisma([U1]);
    const i = new DualRoleInterceptor(prisma as never);
    await i.decorate({ items: [{ id: 'p', name: 'مشروع' }] });
    await i.decorate(Buffer.from('xlsx'));
    await i.decorate(undefined);
    expect(prisma.workspaceMembership.groupBy).not.toHaveBeenCalled();
  });

  it('ids that are not uuids never reach the database', async () => {
    const prisma = fakePrisma([]);
    expect(await dualRoleUserIds(prisma as never, ['not-a-uuid'])).toEqual(new Set());
    expect(prisma.workspaceMembership.groupBy).not.toHaveBeenCalled();
  });
});
