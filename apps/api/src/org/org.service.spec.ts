import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { descendantsOf, nextSort, orderTree, wouldCreateCycle } from './org-tree';
import { OrgService } from './org.service';

const ctx: RequestContext = { actorId: 'admin-1', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
}

describe('org tree helpers (A9, ADR-102)', () => {
  // root ─ a ─ a1 ─ a1x
  //      └ b
  const parentOf = new Map<string, string | null>([
    ['root', null],
    ['a', 'root'],
    ['a1', 'a'],
    ['a1x', 'a1'],
    ['b', 'root'],
  ]);

  it('a node under itself or under a descendant is a cycle; anywhere else is fine', () => {
    expect(wouldCreateCycle(parentOf, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'a', 'a1x')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'root', 'b')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'a1', 'b')).toBe(false);
    expect(wouldCreateCycle(parentOf, 'a', null)).toBe(false);
    expect(descendantsOf(parentOf, 'a')).toEqual(new Set(['a1', 'a1x']));
  });

  it('a pre-existing loop elsewhere does not hang the check', () => {
    const broken = new Map<string, string | null>([
      ['x', 'y'],
      ['y', 'x'],
      ['n', null],
    ]);
    expect(wouldCreateCycle(broken, 'n', 'x')).toBe(false);
  });

  it('orderTree: parents first, siblings by sort then name; orphans become roots', () => {
    const rows = [
      { id: 'c', parentId: 'r', sort: 2, name: 'ج' },
      { id: 'r', parentId: null, sort: 1, name: 'ر' },
      { id: 'b', parentId: 'r', sort: 1, name: 'ب' },
      { id: 'o', parentId: 'missing', sort: 0, name: 'يتيم' },
      { id: 'bb', parentId: 'b', sort: 1, name: 'ب ب' },
    ];
    expect(orderTree(rows).map((r) => r.id)).toEqual(['o', 'r', 'b', 'bb', 'c']);
    expect(nextSort([])).toBe(1);
    expect(nextSort([1, 2.5, 2])).toBe(3);
  });
});

interface Unit {
  id: string;
  parentId: string | null;
  name: string;
  kind: string;
  code: string | null;
  sort: number;
  archivedAt: Date | null;
}
interface Position {
  id: string;
  unitId: string;
  title: string;
  holderUserId: string | null;
  holderMemberId: string | null;
  reportsToPositionId: string | null;
  sort: number;
}

/** A small in-memory org schema for the service. */
function setup() {
  const units = new Map<string, Unit>();
  const positions = new Map<string, Position>();
  let n = 0;
  const addUnit = (u: Partial<Unit> & { id: string }) =>
    units.set(u.id, { parentId: null, name: u.id, kind: 'UNIT', code: null, sort: 1, archivedAt: null, ...u });
  const addPos = (p: Partial<Position> & { id: string; unitId: string }) =>
    positions.set(p.id, { title: p.id, holderUserId: null, holderMemberId: null, reportsToPositionId: null, sort: 1, ...p });
  const eq = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    orgUnit: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const u = units.get(where.id);
        if (!u) return null;
        const children = [...units.values()].filter((c) => c.parentId === u.id).length;
        const pos = [...positions.values()].filter((p) => p.unitId === u.id).length;
        return { ...u, _count: { children, positions: pos, teams: u.id === 'with-team' ? 1 : 0 } };
      }),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        [...units.values()]
          .filter((u) => eq(u as never, where))
          .map((u) => ({ ...u, positions: [], teams: [] })),
      ),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => [...units.values()].filter((u) => eq(u as never, where)).length),
      create: jest.fn(async ({ data }: { data: Omit<Unit, 'id' | 'archivedAt'> }) => {
        const id = `u-${++n}`;
        addUnit({ id, ...data });
        return { id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Unit> }) => Object.assign(units.get(where.id)!, data)),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => units.delete(where.id)),
    },
    orgPosition: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = positions.get(where.id);
        return p ? { ...p, _count: { reports: [...positions.values()].filter((x) => x.reportsToPositionId === p.id).length }, holderUser: null, holderMember: null } : null;
      }),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => [...positions.values()].filter((p) => eq(p as never, where))),
      create: jest.fn(async ({ data }: { data: Omit<Position, 'id'> }) => {
        const id = `p-${++n}`;
        addPos({ id, ...data });
        return { id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Position> }) => Object.assign(positions.get(where.id)!, data)),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => positions.delete(where.id)),
    },
    team: { count: jest.fn(async ({ where }: { where: { orgUnitId: string } }) => (where.orgUnitId === 'with-team' ? 1 : 0)) },
    user: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === 'ghost' ? null : { archivedAt: null })) },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ archivedAt: null }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = new OrgService(prisma as never, new AuditService(prisma as never));
  const actions = () => tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
  // root ─ a ─ a1 ;  root ─ b ; archived z
  addUnit({ id: 'root' });
  addUnit({ id: 'a', parentId: 'root', sort: 1 });
  addUnit({ id: 'a1', parentId: 'a', sort: 1 });
  addUnit({ id: 'b', parentId: 'root', sort: 2 });
  addUnit({ id: 'z', archivedAt: new Date() });
  return { svc, tx, units, positions, addUnit, addPos, actions };
}

describe('OrgService — units (A9, ADR-102)', () => {
  it('create under a live parent goes after the last sibling; audited; under an archived parent → ORG_UNIT_ARCHIVED', async () => {
    const s = setup();
    const unit = await s.svc.createUnit({ parentId: 'root', name: 'إدارة التشغيل', kind: 'DEPARTMENT' }, ctx);
    expect(unit).toMatchObject({ parentId: 'root', name: 'إدارة التشغيل', kind: 'DEPARTMENT', sort: 3 });
    expect(s.actions()).toEqual(['org.unit_created']);
    expect(s.tx.$executeRaw).toHaveBeenCalled(); // advisory lock
    await expectCode(s.svc.createUnit({ parentId: 'z', name: 'قسم', kind: 'SECTION' }, ctx), 'ORG_UNIT_ARCHIVED');
  });

  it('move under itself or a descendant → ORG_CYCLE and nothing changes', async () => {
    const s = setup();
    await expectCode(s.svc.moveUnit('a', { parentId: 'a1' }, ctx), 'ORG_CYCLE');
    await expectCode(s.svc.moveUnit('root', { parentId: 'b' }, ctx), 'ORG_CYCLE');
    expect(s.units.get('a')!.parentId).toBe('root');
    expect(s.tx.orgUnit.update).not.toHaveBeenCalled();
  });

  it('move to another parent (end of its children) or to the root; reorder among siblings; audited', async () => {
    const s = setup();
    await s.svc.moveUnit('a1', { parentId: 'b' }, ctx);
    expect(s.units.get('a1')).toMatchObject({ parentId: 'b', sort: 1 });
    await s.svc.moveUnit('a1', { parentId: null, sort: 0.5 }, ctx);
    expect(s.units.get('a1')).toMatchObject({ parentId: null, sort: 0.5 });
    await s.svc.moveUnit('b', { parentId: 'root', sort: 0.5 }, ctx);
    expect(s.units.get('b')!.sort).toBe(0.5);
    expect(s.actions()).toEqual(['org.unit_moved', 'org.unit_moved', 'org.unit_moved']);
    await expectCode(s.svc.moveUnit('a', { parentId: 'z' }, ctx), 'ORG_UNIT_ARCHIVED');
  });

  it('archive needs no live child units and no linked live teams; delete needs a fully empty unit', async () => {
    const s = setup();
    await expectCode(s.svc.updateUnit('a', { archived: true }, ctx), 'ORG_UNIT_NOT_EMPTY');
    s.addUnit({ id: 'with-team', parentId: 'root' });
    await expectCode(s.svc.updateUnit('with-team', { archived: true }, ctx), 'ORG_UNIT_NOT_EMPTY');
    await s.svc.updateUnit('a1', { archived: true }, ctx);
    expect(s.units.get('a1')!.archivedAt).toBeInstanceOf(Date);
    await expectCode(s.svc.deleteUnit('a', ctx), 'ORG_UNIT_NOT_EMPTY'); // still has (archived) a1
    s.addPos({ id: 'p-b', unitId: 'b' });
    await expectCode(s.svc.deleteUnit('b', ctx), 'ORG_UNIT_NOT_EMPTY');
    s.positions.delete('p-b');
    await s.svc.deleteUnit('b', ctx);
    expect(s.units.has('b')).toBe(false);
    expect(s.actions()).toEqual(['org.unit_updated', 'org.unit_deleted']);
  });

  it('restoring a unit needs a live parent', async () => {
    const s = setup();
    s.addUnit({ id: 'kid', parentId: 'z', archivedAt: new Date() });
    await expectCode(s.svc.updateUnit('kid', { archived: false }, ctx), 'ORG_UNIT_ARCHIVED');
  });

  it('readers get the live tree; archived units only for org.manage with includeArchived', async () => {
    const s = setup();
    const live = await s.svc.tree(SUP, true);
    expect(live.units.map((u) => u.id)).not.toContain('z');
    expect(s.tx.orgUnit.findMany.mock.calls[0]![0]).toMatchObject({ where: { archivedAt: null } });
    await s.svc.tree(ADMIN, true);
    expect(s.tx.orgUnit.findMany.mock.calls[1]![0]).toMatchObject({ where: {} });
  });
});

describe('A9 error codes answer 409', () => {
  it('every new business conflict maps to HTTP 409', () => {
    for (const code of [
      'SUPERVISOR_ALREADY_IN_TEAM',
      'PRIMARY_SUPERVISOR_REQUIRED',
      'LAST_SUPERVISOR',
      'FOREMAN_NOT_MEMBER',
      'FOREMAN_HAS_ACCOUNT',
      'ORG_CYCLE',
      'ORG_REPORTS_CYCLE',
      'ORG_UNIT_NOT_EMPTY',
      'ORG_UNIT_ARCHIVED',
      'VIOLATION_ALREADY_ASSIGNED',
    ] as const) {
      expect(new AppError(code).status).toBe(409);
      expect(new AppError(code).messageAr.length).toBeGreaterThan(10);
    }
  });
});

describe('OrgService — positions (A9, ADR-102)', () => {
  it('a position is held by a user, a member or nobody — never both; naming one clears the other', async () => {
    const s = setup();
    s.tx.orgPosition.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) => {
      const p = s.positions.get(where.id);
      return p ? { ...p, _count: { reports: 0 }, holderUser: null, holderMember: null } : null;
    }) as never);
    const p = await s.svc.createPosition({ unitId: 'a', title: 'مدير الإدارة', holderUserId: 'u-1' }, ctx);
    expect(s.positions.get(p.id)).toMatchObject({ holderUserId: 'u-1', holderMemberId: null });
    await s.svc.updatePosition(p.id, { holderMemberId: 'm-1' }, ctx);
    expect(s.positions.get(p.id)).toMatchObject({ holderUserId: null, holderMemberId: 'm-1' });
    await s.svc.updatePosition(p.id, { holderUserId: null, holderMemberId: null }, ctx);
    expect(s.positions.get(p.id)).toMatchObject({ holderUserId: null, holderMemberId: null }); // vacant
    await expectCode(s.svc.createPosition({ unitId: 'a', title: 'نائب', holderUserId: 'u-1', holderMemberId: 'm-1' }, ctx), 'VALIDATION_FAILED');
    await expectCode(s.svc.createPosition({ unitId: 'a', title: 'نائب', holderUserId: 'ghost' }, ctx), 'VALIDATION_FAILED');
    await expectCode(s.svc.createPosition({ unitId: 'z', title: 'نائب' }, ctx), 'ORG_UNIT_ARCHIVED');
    expect(s.actions()).toEqual(['org.position_created', 'org.position_updated', 'org.position_updated']);
  });

  it('reporting lines may not loop (self or through a chain)', async () => {
    const s = setup();
    s.addPos({ id: 'ceo', unitId: 'root' });
    s.addPos({ id: 'vp', unitId: 'a', reportsToPositionId: 'ceo' });
    s.addPos({ id: 'mgr', unitId: 'a1', reportsToPositionId: 'vp' });
    await expectCode(s.svc.updatePosition('ceo', { reportsToPositionId: 'ceo' }, ctx), 'ORG_REPORTS_CYCLE');
    await expectCode(s.svc.updatePosition('ceo', { reportsToPositionId: 'mgr' }, ctx), 'ORG_REPORTS_CYCLE');
    await expectCode(s.svc.movePosition('vp', { reportsToPositionId: 'mgr' }, ctx), 'ORG_REPORTS_CYCLE');
    expect(s.positions.get('ceo')!.reportsToPositionId).toBeNull();
  });

  it('move to another unit (end of its positions) and another manager; delete detaches reports', async () => {
    const s = setup();
    s.addPos({ id: 'ceo', unitId: 'root' });
    s.addPos({ id: 'vp', unitId: 'a', reportsToPositionId: 'ceo' });
    s.addPos({ id: 'x', unitId: 'b', sort: 4 });
    await s.svc.movePosition('vp', { unitId: 'b', reportsToPositionId: null }, ctx);
    expect(s.positions.get('vp')).toMatchObject({ unitId: 'b', reportsToPositionId: null, sort: 5 });
    await s.svc.deletePosition('ceo', ctx);
    expect(s.positions.has('ceo')).toBe(false);
    expect(s.actions()).toEqual(['org.position_moved', 'org.position_deleted']);
  });
});
