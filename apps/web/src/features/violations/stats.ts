import type { Severity, ViolationFilter, ViolationStats, ViolationStatus } from '@nuzli/shared';
import {
  DAY_MS,
  riyadhDate,
  riyadhDayEnd,
  riyadhDayStart,
  riyadhWeekBounds,
  riyadhWeekdayHour,
} from './time';

/** What the statistics need from one violation (snapshot team, not the current one). */
export interface ViolationFact {
  id: string;
  capturedAt: string;
  teamId: string | null;
  memberId: string;
  recordedById: string;
  typeId: string;
  severity: Severity | null;
  status: ViolationStatus;
  latitude: number;
  longitude: number;
  /** Member name, for the `q` search of the list. */
  memberName?: string;
}

export interface StatsLookups {
  teams: Map<string, { name: string; color: string }>;
  members: Map<string, { fullName: string; currentTeamId: string | null }>;
  users: Map<string, { fullName: string }>;
  types: Map<string, { name: string }>;
  /** Members of a team whose membership was open at the instant (the API's `members`). */
  teamMembersAt(teamId: string, at: Date): number;
}

export const MAX_MAP_POINTS = 5000;
export const TOP_MEMBERS = 10;
export const MAX_TREND_FILL_DAYS = 1100;

export function parseBbox(bbox: string | undefined) {
  if (!bbox) return null;
  const [south, west, north, east] = bbox.split(',').map(Number);
  if ([south, west, north, east].some((n) => n === undefined || Number.isNaN(n))) return null;
  return { south: south!, west: west!, north: north!, east: east! };
}

/** The same WHERE as the API's `violationWhereSql()` (dates are Riyadh days). */
export function matchesFilter(
  v: ViolationFact,
  f: ViolationFilter,
  opts: { ignoreDates?: boolean } = {},
): boolean {
  const t = Date.parse(v.capturedAt);
  if (!opts.ignoreDates && f.from && t < riyadhDayStart(f.from).getTime()) return false;
  if (!opts.ignoreDates && f.to && t >= riyadhDayEnd(f.to).getTime()) return false;
  if (f.teamId && v.teamId !== f.teamId) return false;
  if (f.memberId && v.memberId !== f.memberId) return false;
  if (f.recordedBy && v.recordedById !== f.recordedBy) return false;
  if (f.typeId && v.typeId !== f.typeId) return false;
  if (f.status && v.status !== f.status) return false;
  if (f.severity && v.severity !== f.severity) return false;
  // A9 (ADR-103): `memberId` is '' while the violation has no person.
  if (f.assigned === 'true' && !v.memberId) return false;
  if (f.assigned === 'false' && v.memberId) return false;
  const box = parseBbox(f.bbox);
  if (box) {
    if (v.latitude < box.south || v.latitude > box.north) return false;
    const inLng =
      box.west <= box.east
        ? v.longitude >= box.west && v.longitude <= box.east
        : v.longitude >= box.west || v.longitude <= box.east;
    if (!inLng) return false;
  }
  return true;
}

/** "Members of the team at period end": the end of `to`, or now, whichever is earlier. */
export function periodEnd(f: ViolationFilter, now: Date): Date {
  if (!f.to) return now;
  const end = riyadhDayEnd(f.to);
  return end < now ? end : now;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function countBy<K>(rows: ViolationFact[], key: (v: ViolationFact) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

/**
 * Client-side copy of `GET /violations/stats` (apps/api violation-stats.ts, ADR-049) for the
 * demo adapter: every chart uses the same filtered rows; this/previous week ignore the date
 * range; `byTeam` leaves out violations without a team snapshot; `topMembers` = members with
 * more than one violation (top 10, current team shown); the trend is filled with zero days.
 */
export function computeViolationStats(
  all: ViolationFact[],
  f: ViolationFilter,
  now: Date,
  look: StatsLookups,
): ViolationStats {
  const rows = all.filter((v) => matchesFilter(v, f));
  const week = riyadhWeekBounds(now);
  let thisWeek = 0;
  let previousWeek = 0;
  for (const v of all) {
    if (!matchesFilter(v, f, { ignoreDates: true })) continue;
    const t = Date.parse(v.capturedAt);
    if (t >= week.thisStart.getTime() && t < week.nextStart.getTime()) thisWeek++;
    else if (t >= week.prevStart.getTime() && t < week.thisStart.getTime()) previousWeek++;
  }

  const end = periodEnd(f, now);
  const byTeam = [...countBy(rows.filter((r) => r.teamId), (r) => r.teamId as string)]
    .map(([teamId, count]) => {
      const team = look.teams.get(teamId) ?? { name: '—', color: '#5B6B72' };
      const members = look.teamMembersAt(teamId, end);
      return {
        teamId,
        teamName: team.name,
        color: team.color,
        count,
        members,
        perMember: members > 0 ? round2(count / members) : 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.teamName.localeCompare(b.teamName, 'ar'));

  const topMembers = [...countBy(rows.filter((r) => r.memberId), (r) => r.memberId)]
    .filter(([, n]) => n > 1)
    .map(([memberId, count]) => {
      const m = look.members.get(memberId);
      const team = m?.currentTeamId ? look.teams.get(m.currentTeamId) : undefined;
      return {
        memberId,
        fullName: m?.fullName ?? '—',
        teamName: team?.name ?? null,
        color: team?.color ?? null,
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.fullName.localeCompare(b.fullName, 'ar'))
    .slice(0, TOP_MEMBERS);

  const byMonitor = [...countBy(rows, (r) => r.recordedById)]
    .map(([userId, count]) => ({ userId, fullName: look.users.get(userId)?.fullName ?? '—', count }))
    .sort((a, b) => b.count - a.count || a.fullName.localeCompare(b.fullName, 'ar'));

  const byType = [...countBy(rows, (r) => r.typeId)]
    .map(([typeId, count]) => ({ typeId, name: look.types.get(typeId)?.name ?? '—', count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));

  const bySeverity = [...countBy(rows, (r) => r.severity ?? 'NONE')]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => b.count - a.count);

  const trendRows = [...countBy(rows, (r) => riyadhDate(r.capturedAt))]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const heat = new Map<string, { weekday: number; hour: number; count: number }>();
  for (const r of rows) {
    const { weekday, hour } = riyadhWeekdayHour(r.capturedAt);
    const k = `${weekday}:${hour}`;
    const cell = heat.get(k) ?? { weekday, hour, count: 0 };
    cell.count++;
    heat.set(k, cell);
  }

  const newest = [...rows].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return {
    unassigned: rows.filter((r) => !r.memberId).length,
    total: rows.length,
    thisWeek,
    previousWeek,
    byTeam,
    topMembers,
    byMonitor,
    byType,
    bySeverity,
    trend: fillTrend(trendRows, f, now),
    heatmap: [...heat.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    points: newest.slice(0, MAX_MAP_POINTS).map((r) => ({
      id: r.id,
      lat: r.latitude,
      lng: r.longitude,
      color: r.teamId ? look.teams.get(r.teamId)?.color ?? null : null,
    })),
    pointsTruncated: newest.length > MAX_MAP_POINTS,
    generatedAt: now.toISOString(),
  };
}

/** Fills missing days with zero so the x axis is continuous (same as the API). */
export function fillTrend(
  rows: { date: string; count: number }[],
  f: ViolationFilter,
  now: Date,
): { date: string; count: number }[] {
  if (!rows.length && !(f.from && f.to)) return [];
  const first = f.from ?? rows[0]?.date;
  const last = f.to ?? (rows.length ? rows[rows.length - 1]!.date : riyadhDate(now));
  if (!first || !last || first > last) return rows;
  const byDate = new Map(rows.map((r) => [r.date, r.count]));
  const out: { date: string; count: number }[] = [];
  let day = Date.parse(`${first}T00:00:00Z`);
  const stop = Date.parse(`${last}T00:00:00Z`);
  while (day <= stop) {
    if (out.length >= MAX_TREND_FILL_DAYS) return rows;
    const key = new Date(day).toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
    day += DAY_MS;
  }
  return out;
}
