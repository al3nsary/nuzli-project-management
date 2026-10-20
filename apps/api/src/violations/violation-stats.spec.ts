import type { Prisma } from '@prisma/client';
import {
  assembleStats,
  fillTrend,
  MAX_MAP_POINTS,
  periodEnd,
  statsQueries,
  violationWhereSql,
  type StatsRows,
} from './violation-stats';
import { newStore, workspaceStorage } from '../prisma/workspace-context';
import { UNIT_TEST_WORKSPACE_ID } from '../../test/unit/workspace-setup';

const text = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ');

describe('violationWhereSql — the WHERE shared by every chart', () => {
  it('no filters → the workspace filter only (A12); no workspace → FALSE', () => {
    const w = violationWhereSql({});
    expect(w.text).toBe('v.workspace_id = $1::uuid');
    expect(w.values).toEqual([UNIT_TEST_WORKSPACE_ID]);
    expect(workspaceStorage.run(newStore(), () => violationWhereSql({})).text).toBe('FALSE');
  });

  it('binds every filter as a parameter, casting uuids and enums', () => {
    const w = violationWhereSql({
      from: '2026-10-01',
      to: '2026-10-07',
      teamId: '11111111-1111-4111-8111-111111111111',
      memberId: '22222222-2222-4222-8222-222222222222',
      recordedBy: '33333333-3333-4333-8333-333333333333',
      typeId: '44444444-4444-4444-8444-444444444444',
      status: 'CANCELLED',
      severity: 'CRITICAL',
      bbox: '24.1,46.2,24.9,46.8',
    });
    expect(text(w)).toBe(
      'v.workspace_id = $1::uuid AND v.captured_at >= $2::timestamptz AND v.captured_at < $3::timestamptz AND v.team_id_snapshot = $4::uuid' +
        ' AND v.member_id = $5::uuid AND v.recorded_by = $6::uuid AND v.type_id = $7::uuid' +
        ' AND v.status = $8::"ViolationStatus" AND t.severity = $9::"Severity"' +
        ' AND v.latitude BETWEEN $10 AND $11 AND v.longitude BETWEEN $12 AND $13',
    );
    expect(w.values).toEqual([
      UNIT_TEST_WORKSPACE_ID,
      new Date('2026-09-30T21:00:00Z'),
      new Date('2026-10-07T21:00:00Z'),
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      'CANCELLED',
      'CRITICAL',
      24.1,
      24.9,
      46.2,
      46.8,
    ]);
    // Values never end up in the SQL text (no injection surface).
    expect(w.text).not.toContain('CANCELLED');
  });

  it('ignoreDates drops only the captured_at range (week KPIs are relative to today)', () => {
    const w = violationWhereSql({ from: '2026-01-01', to: '2026-01-31', status: 'SUBMITTED' }, { ignoreDates: true });
    expect(text(w)).toBe('v.workspace_id = $1::uuid AND v.status = $2::"ViolationStatus"');
  });
});

describe('statsQueries', () => {
  const now = new Date('2026-10-12T07:00:00Z');

  it('every query carries the same filter values; grouping uses Asia/Riyadh', () => {
    const q = statsQueries({ teamId: '11111111-1111-4111-8111-111111111111' }, now);
    for (const key of ['byTeam', 'topMembers', 'byMonitor', 'byType', 'bySeverity', 'trend', 'heatmap', 'points'] as const) {
      expect(q[key].values).toContain('11111111-1111-4111-8111-111111111111');
    }
    expect(text(q.trend)).toContain("AT TIME ZONE 'Asia/Riyadh'");
    expect(text(q.heatmap)).toContain("EXTRACT(DOW FROM v.captured_at AT TIME ZONE 'Asia/Riyadh')");
    expect(text(q.heatmap)).toContain("EXTRACT(HOUR FROM v.captured_at AT TIME ZONE 'Asia/Riyadh')");
    expect(text(q.points)).toContain(`LIMIT ${MAX_MAP_POINTS + 1}`);
    expect(text(q.topMembers)).toContain('HAVING count(*) > 1');
  });

  it('team member counts use the half-open membership interval at period end', () => {
    const q = statsQueries({ to: '2026-09-30' }, now);
    expect(text(q.byTeam)).toContain('m.valid_from <= $');
    expect(text(q.byTeam)).toContain('(m.valid_to IS NULL OR m.valid_to > $');
    expect(q.byTeam.values).toContainEqual(new Date('2026-09-30T21:00:00Z'));
    expect(periodEnd({}, now)).toBe(now);
    expect(periodEnd({ to: '2027-01-01' }, now)).toBe(now); // a future end is capped at now
  });

  it('week KPIs use Sunday-start Riyadh weeks and ignore the date filter', () => {
    const q = statsQueries({ from: '2025-01-01', to: '2025-01-31' }, now);
    expect(q.totals.values).toContainEqual(new Date('2026-10-10T21:00:00Z')); // this Sunday
    expect(q.totals.values).toContainEqual(new Date('2026-10-03T21:00:00Z')); // previous Sunday
    expect(q.totals.values).toContainEqual(new Date('2024-12-31T21:00:00Z')); // `from` used for the total only
  });
});

describe('assembleStats', () => {
  const empty: StatsRows = {
    totals: [{ total: 7, this_week: 3, previous_week: 2 }],
    byTeam: [{ team_id: 't1', team_name: 'أ', color: '#123456', count: 6, members: 4 }],
    topMembers: [],
    byMonitor: [],
    byType: [],
    bySeverity: [{ severity: 'NONE', count: 1 }],
    trend: [
      { date: '2026-10-01', count: 2 },
      { date: '2026-10-03', count: 1 },
    ],
    heatmap: [{ weekday: 0, hour: 9, count: 5 }],
    points: [],
  };

  it('maps rows, computes perMember and fills the trend', () => {
    const s = assembleStats(empty, { from: '2026-10-01', to: '2026-10-04' }, new Date('2026-10-12T00:00:00Z'));
    expect(s).toMatchObject({ total: 7, thisWeek: 3, previousWeek: 2, pointsTruncated: false });
    expect(s.byTeam[0]).toEqual({ teamId: 't1', teamName: 'أ', color: '#123456', count: 6, members: 4, perMember: 1.5, perMemberRate: 1.5 });
    expect(s.trend).toEqual([
      { date: '2026-10-01', count: 2 },
      { date: '2026-10-02', count: 0 },
      { date: '2026-10-03', count: 1 },
      { date: '2026-10-04', count: 0 },
    ]);
    expect(s.heatmap).toEqual([{ weekday: 0, hour: 9, count: 5 }]);
  });

  it('caps the map at 5,000 points and flags the truncation', () => {
    const points = Array.from({ length: MAX_MAP_POINTS + 1 }, (_, i) => ({ id: `p${i}`, lat: 24, lng: 46, color: null }));
    const s = assembleStats({ ...empty, points }, {}, new Date());
    expect(s.points).toHaveLength(MAX_MAP_POINTS);
    expect(s.pointsTruncated).toBe(true);
  });

  it('a team without members reports perMember 0; no data and no range → empty trend', () => {
    const s = assembleStats({ ...empty, byTeam: [{ ...empty.byTeam[0]!, members: 0 }], trend: [] }, {}, new Date());
    expect(s.byTeam[0]!.perMember).toBe(0);
    expect(fillTrend([], {}, new Date())).toEqual([]);
  });
});

describe('A9: unassigned violations in the statistics (ADR-103)', () => {
  it('assigned=false / true filter on member_id', () => {
    expect(violationWhereSql({ assigned: 'false' }).text).toBe('v.workspace_id = $1::uuid AND v.member_id IS NULL');
    expect(violationWhereSql({ assigned: 'true' }).text).toBe('v.workspace_id = $1::uuid AND v.member_id IS NOT NULL');
  });

  it('a separate "unassigned" KPI with the same filters; byTeam and topMembers leave them out', () => {
    const q = statsQueries({ typeId: '44444444-4444-4444-8444-444444444444' }, new Date('2026-10-12T00:00:00Z'));
    expect(text(q.unassigned)).toContain('AND v.member_id IS NULL');
    expect(q.unassigned.values).toContain('44444444-4444-4444-8444-444444444444');
    expect(text(q.byTeam)).toContain('v.team_id_snapshot IS NOT NULL');
    expect(text(q.topMembers)).toContain('v.member_id IS NOT NULL');
  });

  it('assembleStats reports the count (0 when the row is missing)', () => {
    const base: StatsRows = { totals: [], byTeam: [], topMembers: [], byMonitor: [], byType: [], bySeverity: [], trend: [], heatmap: [], points: [] };
    expect(assembleStats({ ...base, unassigned: [{ count: 7 }] }, {}, new Date()).unassigned).toBe(7);
    expect(assembleStats(base, {}, new Date()).unassigned).toBe(0);
  });
});

describe('calculations audit 2026-10 — week KPI, per-member rate, top-member ties', () => {
  // Monday 2026-10-12 10:00 Riyadh (week from Sunday 11th).
  const now = new Date('2026-10-12T07:00:00Z');

  it('previousWeekToDate counts the previous week up to now − 7 days (same elapsed span)', () => {
    const q = statsQueries({}, now);
    expect(text(q.totals)).toContain('AS previous_week_to_date');
    expect(q.totals.values).toContainEqual(new Date('2026-10-05T07:00:00Z'));
    const s = assembleStats(
      { totals: [{ total: 9, this_week: 3, previous_week: 10, previous_week_to_date: 3 }], byTeam: [], topMembers: [], byMonitor: [], byType: [], bySeverity: [], trend: [], heatmap: [], points: [] },
      {},
      now,
    );
    expect(s).toMatchObject({ thisWeek: 3, previousWeek: 10, previousWeekToDate: 3 });
  });

  it('perMemberRate is null for a team with no members at the end of the period (perMember stays 0)', () => {
    const s = assembleStats(
      { totals: [], byTeam: [{ team_id: 't', team_name: 'ب', color: '#000000', count: 4, members: 0 }], topMembers: [], byMonitor: [], byType: [], bySeverity: [], trend: [], heatmap: [], points: [] },
      {},
      now,
    );
    expect(s.byTeam[0]).toMatchObject({ perMember: 0, perMemberRate: null });
  });

  it('top members are ordered deterministically on ties (count, then member id)', () => {
    const t = text(statsQueries({}, now).topMembers);
    expect(t).toContain('ORDER BY count(*) DESC, v.member_id LIMIT');
    expect(t).toContain('ORDER BY g.n DESC, mb.full_name, g.member_id');
  });
});
