import {
  NOTHING,
  parseBbox,
  riyadhDate,
  riyadhDayEnd,
  riyadhDayStart,
  riyadhWeekBounds,
  scopeNeedsVisibilitySetting,
  violationFilterWhere,
  violationScopeWhere,
} from './violation-scope';

const ADMIN = { id: 'a1', role: 'ADMIN' as const, status: 'ACTIVE' };
const MONITOR = { id: 'm1', role: 'MONITOR' as const, status: 'ACTIVE' };
const SUP = { id: 's1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };

describe('violation data scope (brief §7.5–7.6, enforced in the query)', () => {
  it('ADMIN sees everything', () => {
    expect(violationScopeWhere(ADMIN, false)).toEqual({});
    expect(scopeNeedsVisibilitySetting(ADMIN)).toBe(false);
  });

  it('MONITOR sees only what they recorded', () => {
    expect(violationScopeWhere(MONITOR, true)).toEqual({ recordedById: 'm1' });
    expect(scopeNeedsVisibilitySetting(MONITOR)).toBe(false);
  });

  it('SUPERVISOR with the global setting ON: own non-archived teams, override HIDE excluded (INHERIT/none/SHOW pass)', () => {
    expect(scopeNeedsVisibilitySetting(SUP)).toBe(true);
    expect(violationScopeWhere(SUP, true)).toEqual({
      team: {
        is: {
          supervisors: { some: { userId: 's1', validTo: null } },
          status: { not: 'ARCHIVED' },
          OR: [{ visibility: { is: null } }, { visibility: { is: { mode: { in: ['INHERIT', 'SHOW'] } } } }],
        },
      },
    });
  });

  it('SUPERVISOR with the global setting OFF: only teams whose override is SHOW', () => {
    expect(violationScopeWhere(SUP, false)).toEqual({
      team: {
        is: {
          supervisors: { some: { userId: 's1', validTo: null } },
          status: { not: 'ARCHIVED' },
          visibility: { is: { mode: 'SHOW' } },
        },
      },
    });
  });

  it('no violation permission at all → matches nothing', () => {
    const odd = { id: 'x', role: 'SUPERVISOR' as const, status: 'SUSPENDED' };
    expect(violationScopeWhere(odd, true)).toBe(NOTHING);
  });
});

describe('Asia/Riyadh day and week boundaries', () => {
  it('a Riyadh day is [00:00+03, next 00:00+03)', () => {
    expect(riyadhDayStart('2026-10-12').toISOString()).toBe('2026-10-11T21:00:00.000Z');
    expect(riyadhDayEnd('2026-10-12').toISOString()).toBe('2026-10-12T21:00:00.000Z');
    expect(riyadhDate(new Date('2026-10-11T21:30:00Z'))).toBe('2026-10-12');
    expect(riyadhDate(new Date('2026-10-11T20:59:59Z'))).toBe('2026-10-11');
  });

  it('weeks start on Sunday in Riyadh', () => {
    // Monday 2026-10-12 10:00 Riyadh → week starts Sunday 2026-10-11 00:00 Riyadh.
    const b = riyadhWeekBounds(new Date('2026-10-12T07:00:00Z'));
    expect(b.thisStart.toISOString()).toBe('2026-10-10T21:00:00.000Z');
    expect(b.nextStart.toISOString()).toBe('2026-10-17T21:00:00.000Z');
    expect(b.prevStart.toISOString()).toBe('2026-10-03T21:00:00.000Z');
    // Saturday 23:30 Riyadh still belongs to the same week; Sunday 00:30 starts a new one.
    expect(riyadhWeekBounds(new Date('2026-10-17T20:30:00Z')).thisStart.toISOString()).toBe('2026-10-10T21:00:00.000Z');
    expect(riyadhWeekBounds(new Date('2026-10-17T21:30:00Z')).thisStart.toISOString()).toBe('2026-10-17T21:00:00.000Z');
  });
});

describe('violationFilterWhere', () => {
  it('maps every filter, with Riyadh day boundaries on captured_at', () => {
    const where = violationFilterWhere({
      from: '2026-10-01',
      to: '2026-10-31',
      teamId: 't',
      memberId: 'm',
      recordedBy: 'r',
      typeId: 'ty',
      status: 'CONFIRMED',
      severity: 'HIGH',
      bbox: '24.5,46.5,24.9,46.9',
      q: 'سالم',
    });
    expect(where.AND).toEqual([
      { capturedAt: { gte: new Date('2026-09-30T21:00:00Z'), lt: new Date('2026-10-31T21:00:00Z') } },
      { teamIdSnapshot: 't' },
      { memberId: 'm' },
      { recordedById: 'r' },
      { typeId: 'ty' },
      { status: 'CONFIRMED' },
      { type: { severity: 'HIGH' } },
      { latitude: { gte: 24.5, lte: 24.9 } },
      { longitude: { gte: 46.5, lte: 46.9 } },
      { member: { fullName: { contains: 'سالم', mode: 'insensitive' } } },
    ]);
    expect(violationFilterWhere({})).toEqual({});
  });

  it('bbox crossing the antimeridian wraps', () => {
    expect(parseBbox('10,170,20,-170')).toEqual({ south: 10, north: 20, west: 170, east: -170 });
    const where = violationFilterWhere({ bbox: '10,170,20,-170' });
    expect(where.AND).toContainEqual({ OR: [{ longitude: { gte: 170 } }, { longitude: { lte: -170 } }] });
  });
});
