import { Prisma } from '@prisma/client';
import { perMemberRate, type ViolationFilter, type ViolationStats } from '@nuzli/shared';
import { activeWorkspaceIdOrNull } from '../prisma/workspace-context';
import { parseBbox, riyadhDate, riyadhDayEnd, riyadhDayStart, riyadhWeekBounds } from './violation-scope';

/** The map shows at most this many points (newest first); `pointsTruncated` says when more matched. */
export const MAX_MAP_POINTS = 5000;
export const TOP_MEMBERS = 10;
/** The trend is filled with zero days only up to this length (longer ranges stay sparse). */
export const MAX_TREND_FILL_DAYS = 1100;

/**
 * SQL WHERE for the shared violation filters over `violations v JOIN violation_types t`.
 * Every value is a bound parameter (Prisma.sql); enum values are cast explicitly.
 * `ignoreDates` drops the captured_at range (used for the "this week / previous week" KPIs,
 * which are always relative to today).
 */
export function violationWhereSql(
  f: ViolationFilter,
  opts: { ignoreDates?: boolean; workspaceId?: string | null; teamIds?: string[] | null } = {},
): Prisma.Sql {
  // A12 (ADR-143): the statistics are raw SQL, so the workspace filter is part of it —
  // no workspace context, no rows.
  const workspaceId = opts.workspaceId !== undefined ? opts.workspaceId : activeWorkspaceIdOrNull();
  if (!workspaceId) return Prisma.sql`FALSE`;
  const parts: Prisma.Sql[] = [Prisma.sql`v.workspace_id = ${workspaceId}::uuid`];
  // A12 round 2: an assistant limited to some teams counts only their violations.
  if (opts.teamIds) {
    if (!opts.teamIds.length) return Prisma.sql`FALSE`;
    parts.push(Prisma.sql`v.team_id_snapshot IN (${Prisma.join(opts.teamIds.map((id) => Prisma.sql`${id}::uuid`))})`);
  }
  if (!opts.ignoreDates && f.from) parts.push(Prisma.sql`v.captured_at >= ${riyadhDayStart(f.from)}::timestamptz`);
  if (!opts.ignoreDates && f.to) parts.push(Prisma.sql`v.captured_at < ${riyadhDayEnd(f.to)}::timestamptz`);
  if (f.teamId) parts.push(Prisma.sql`v.team_id_snapshot = ${f.teamId}::uuid`);
  if (f.memberId) parts.push(Prisma.sql`v.member_id = ${f.memberId}::uuid`);
  // A9 (ADR-103): assigned = a person is linked; false = recorded without a person, not assigned yet.
  if (f.assigned === 'true') parts.push(Prisma.sql`v.member_id IS NOT NULL`);
  if (f.assigned === 'false') parts.push(Prisma.sql`v.member_id IS NULL`);
  if (f.recordedBy) parts.push(Prisma.sql`v.recorded_by = ${f.recordedBy}::uuid`);
  if (f.typeId) parts.push(Prisma.sql`v.type_id = ${f.typeId}::uuid`);
  if (f.status) parts.push(Prisma.sql`v.status = ${f.status}::"ViolationStatus"`);
  if (f.severity) parts.push(Prisma.sql`t.severity = ${f.severity}::"Severity"`);
  const box = parseBbox(f.bbox);
  if (box) {
    parts.push(Prisma.sql`v.latitude BETWEEN ${box.south} AND ${box.north}`);
    parts.push(
      box.west <= box.east
        ? Prisma.sql`v.longitude BETWEEN ${box.west} AND ${box.east}`
        : Prisma.sql`(v.longitude >= ${box.west} OR v.longitude <= ${box.east})`,
    );
  }
  return Prisma.join(parts, ' AND ');
}

const FROM = Prisma.sql`violations v JOIN violation_types t ON t.id = v.type_id AND t.workspace_id = v.workspace_id`;

/** "Members of the team at period end": the filter's last day, or now. */
export function periodEnd(f: ViolationFilter, now: Date): Date {
  if (!f.to) return now;
  const end = riyadhDayEnd(f.to);
  return end < now ? end : now;
}

/** The workspace the statistics run in (the joins repeat it; ADR-143). */
function workspaceIdOf(_f: ViolationFilter): string | null {
  return activeWorkspaceIdOrNull();
}

/** One SQL statement per chart; all share the same WHERE (brief §7.5: every chart, same filters). */
export function statsQueries(f: ViolationFilter, now: Date, teamIds: string[] | null = null) {
  const where = violationWhereSql(f, { teamIds });
  const whereNoDates = violationWhereSql(f, { ignoreDates: true, teamIds });
  const week = riyadhWeekBounds(now);
  // The same elapsed span of the previous week: previous Sunday 00:00 → now − 7 days.
  const prevToDateEnd = new Date(Math.min(now.getTime(), week.nextStart.getTime()) - 7 * 86_400_000);
  const end = periodEnd(f, now);
  return {
    totals: Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM ${FROM} WHERE ${where}) AS total,
        count(*) FILTER (WHERE v.captured_at >= ${week.thisStart}::timestamptz AND v.captured_at < ${week.nextStart}::timestamptz)::int AS this_week,
        count(*) FILTER (WHERE v.captured_at >= ${week.prevStart}::timestamptz AND v.captured_at < ${week.thisStart}::timestamptz)::int AS previous_week,
        count(*) FILTER (WHERE v.captured_at >= ${week.prevStart}::timestamptz AND v.captured_at < ${prevToDateEnd}::timestamptz)::int AS previous_week_to_date
      FROM ${FROM}
      WHERE ${whereNoDates} AND v.captured_at >= ${week.prevStart}::timestamptz AND v.captured_at < ${week.nextStart}::timestamptz`,
    byTeam: Prisma.sql`
      SELECT g.team_id, tm.name AS team_name, c.hex AS color, g.n AS count,
             (SELECT count(*)::int FROM team_memberships m
               WHERE m.team_id = g.team_id AND m.valid_from <= ${end}::timestamptz
                 AND (m.valid_to IS NULL OR m.valid_to > ${end}::timestamptz)) AS members
      FROM (SELECT v.team_id_snapshot AS team_id, count(*)::int AS n
              FROM ${FROM} WHERE ${where} AND v.team_id_snapshot IS NOT NULL
             GROUP BY v.team_id_snapshot) g
      JOIN teams tm ON tm.id = g.team_id AND tm.workspace_id = ${workspaceIdOf(f)}::uuid
      JOIN team_colors c ON c.id = tm.color_id AND c.workspace_id = tm.workspace_id
      ORDER BY g.n DESC, tm.name`,
    topMembers: Prisma.sql`
      SELECT g.member_id, mb.full_name, ct.name AS team_name, cc.hex AS color, g.n AS count
      FROM (SELECT v.member_id, count(*)::int AS n FROM ${FROM} WHERE ${where} AND v.member_id IS NOT NULL
             GROUP BY v.member_id HAVING count(*) > 1
             ORDER BY count(*) DESC, v.member_id LIMIT ${Prisma.raw(String(TOP_MEMBERS))}) g
      JOIN team_members mb ON mb.id = g.member_id AND mb.workspace_id = ${workspaceIdOf(f)}::uuid
      LEFT JOIN team_memberships om ON om.member_id = g.member_id AND om.valid_to IS NULL AND om.workspace_id = mb.workspace_id
      LEFT JOIN teams ct ON ct.id = om.team_id
      LEFT JOIN team_colors cc ON cc.id = ct.color_id
      ORDER BY g.n DESC, mb.full_name, g.member_id`,
    byMonitor: Prisma.sql`
      SELECT v.recorded_by AS user_id, u.full_name, count(*)::int AS count
      FROM ${FROM} JOIN users u ON u.id = v.recorded_by
      WHERE ${where}
      GROUP BY v.recorded_by, u.full_name
      ORDER BY 3 DESC, 2`,
    byType: Prisma.sql`
      SELECT t.id AS type_id, t.name, count(*)::int AS count
      FROM ${FROM} WHERE ${where}
      GROUP BY t.id, t.name
      ORDER BY 3 DESC, 2`,
    bySeverity: Prisma.sql`
      SELECT COALESCE(t.severity::text, 'NONE') AS severity, count(*)::int AS count
      FROM ${FROM} WHERE ${where}
      GROUP BY 1 ORDER BY 2 DESC`,
    trend: Prisma.sql`
      SELECT to_char((v.captured_at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS date, count(*)::int AS count
      FROM ${FROM} WHERE ${where}
      GROUP BY 1 ORDER BY 1`,
    heatmap: Prisma.sql`
      SELECT EXTRACT(DOW FROM v.captured_at AT TIME ZONE 'Asia/Riyadh')::int AS weekday,
             EXTRACT(HOUR FROM v.captured_at AT TIME ZONE 'Asia/Riyadh')::int AS hour,
             count(*)::int AS count
      FROM ${FROM} WHERE ${where}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    /** A9: the "unassigned" KPI — same filters, violations without a person (never in byTeam). */
    unassigned: Prisma.sql`
      SELECT count(*)::int AS count FROM ${FROM} WHERE ${where} AND v.member_id IS NULL`,
    points: Prisma.sql`
      SELECT v.id, v.latitude AS lat, v.longitude AS lng, c.hex AS color
      FROM ${FROM}
      LEFT JOIN teams tm ON tm.id = v.team_id_snapshot
      LEFT JOIN team_colors c ON c.id = tm.color_id
      WHERE ${where}
      ORDER BY v.captured_at DESC
      LIMIT ${Prisma.raw(String(MAX_MAP_POINTS + 1))}`,
  };
}

export type StatsQueries = ReturnType<typeof statsQueries>;

/** Raw rows as returned by `$queryRaw` for each query. */
export interface StatsRows {
  totals: Array<{ total: number; this_week: number; previous_week: number; previous_week_to_date?: number }>;
  byTeam: Array<{ team_id: string; team_name: string; color: string; count: number; members: number }>;
  topMembers: Array<{ member_id: string; full_name: string; team_name: string | null; color: string | null; count: number }>;
  byMonitor: Array<{ user_id: string; full_name: string; count: number }>;
  byType: Array<{ type_id: string; name: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  trend: Array<{ date: string; count: number }>;
  heatmap: Array<{ weekday: number; hour: number; count: number }>;
  points: Array<{ id: string; lat: number; lng: number; color: string | null }>;
  /** A9 — optional so older callers/tests that build rows by hand keep compiling. */
  unassigned?: Array<{ count: number }>;
}

/** Fills missing days with zero so the chart's x axis is continuous. */
export function fillTrend(rows: StatsRows['trend'], f: ViolationFilter, now: Date): ViolationStats['trend'] {
  if (!rows.length && !(f.from && f.to)) return [];
  const first = f.from ?? rows[0]?.date;
  const last = f.to ?? (rows.length ? rows[rows.length - 1]!.date : riyadhDate(now));
  if (!first || !last || first > last) return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  const byDate = new Map(rows.map((r) => [r.date, Number(r.count)]));
  const out: ViolationStats['trend'] = [];
  let day = new Date(`${first}T00:00:00Z`);
  const stop = new Date(`${last}T00:00:00Z`);
  while (day <= stop) {
    if (out.length >= MAX_TREND_FILL_DAYS) return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
    const key = day.toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
    day = new Date(day.getTime() + 86_400_000);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function assembleStats(rows: StatsRows, f: ViolationFilter, now: Date): ViolationStats {
  const totals = rows.totals[0] ?? { total: 0, this_week: 0, previous_week: 0 };
  const truncated = rows.points.length > MAX_MAP_POINTS;
  return {
    unassigned: Number(rows.unassigned?.[0]?.count ?? 0),
    total: Number(totals.total ?? 0),
    thisWeek: Number(totals.this_week ?? 0),
    previousWeek: Number(totals.previous_week ?? 0),
    previousWeekToDate: Number(totals.previous_week_to_date ?? 0),
    byTeam: rows.byTeam.map((r) => {
      const count = Number(r.count);
      const members = Number(r.members);
      return {
        teamId: r.team_id,
        teamName: r.team_name,
        color: r.color,
        count,
        members,
        perMember: members > 0 ? round2(count / members) : 0,
        perMemberRate: perMemberRate(count, members),
      };
    }),
    topMembers: rows.topMembers.map((r) => ({
      memberId: r.member_id,
      fullName: r.full_name,
      teamName: r.team_name,
      color: r.color,
      count: Number(r.count),
    })),
    byMonitor: rows.byMonitor.map((r) => ({ userId: r.user_id, fullName: r.full_name, count: Number(r.count) })),
    byType: rows.byType.map((r) => ({ typeId: r.type_id, name: r.name, count: Number(r.count) })),
    bySeverity: rows.bySeverity.map((r) => ({ severity: r.severity, count: Number(r.count) })),
    trend: fillTrend(rows.trend, f, now),
    heatmap: rows.heatmap.map((r) => ({ weekday: Number(r.weekday), hour: Number(r.hour), count: Number(r.count) })),
    points: rows.points.slice(0, MAX_MAP_POINTS).map((r) => ({
      id: r.id,
      lat: Number(r.lat),
      lng: Number(r.lng),
      color: r.color,
    })),
    pointsTruncated: truncated,
    generatedAt: now.toISOString(),
  };
}
