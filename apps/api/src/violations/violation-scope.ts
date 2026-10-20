import type { Prisma } from '@prisma/client';
import { can, type ViolationFilter } from '@nuzli/shared';
import type { Viewer } from '../teams/team-dto';
import { teamLimit } from '../access/access-context';

/**
 * Asia/Riyadh has been UTC+03:00 all year since 1947 (no daylight saving), so a calendar day
 * in Riyadh is the fixed instant range [D 00:00+03:00, D+1 00:00+03:00). SQL grouping still
 * uses `AT TIME ZONE 'Asia/Riyadh'`; these helpers only turn filter dates into instants.
 */
export const RIYADH_TZ = 'Asia/Riyadh';
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-10-12` → the instant the day starts in Riyadh (2026-10-11T21:00:00Z). */
export function riyadhDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+03:00`);
}

/** Exclusive end of a Riyadh calendar day (start of the next day). */
export function riyadhDayEnd(date: string): Date {
  return new Date(riyadhDayStart(date).getTime() + DAY_MS);
}

/** The Riyadh calendar date (`YYYY-MM-DD`) of an instant. */
export function riyadhDate(at: Date): string {
  return new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Week boundaries in Riyadh, weeks starting on **Sunday** (the Saudi working week).
 * Returns instants: previous week [prevStart, thisStart), this week [thisStart, nextStart).
 */
export function riyadhWeekBounds(now: Date): { prevStart: Date; thisStart: Date; nextStart: Date } {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS); // wall clock expressed in UTC fields
  const dow = local.getUTCDay(); // 0 = Sunday
  const today = riyadhDayStart(local.toISOString().slice(0, 10)).getTime();
  const thisStart = today - dow * DAY_MS;
  return {
    prevStart: new Date(thisStart - 7 * DAY_MS),
    thisStart: new Date(thisStart),
    nextStart: new Date(thisStart + 7 * DAY_MS),
  };
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** `"south,west,north,east"` → numbers (the schema already checked the shape). */
export function parseBbox(value: string | undefined): BBox | null {
  if (!value) return null;
  const [south, west, north, east] = value.split(',').map(Number);
  if ([south, west, north, east].some((n) => n === undefined || Number.isNaN(n))) return null;
  return {
    south: Math.min(south!, north!),
    north: Math.max(south!, north!),
    west: west!,
    east: east!,
  };
}

/** Prisma where for the shared filters (date range on captured_at in Riyadh days). */
export function violationFilterWhere(f: ViolationFilter & { q?: string }): Prisma.ViolationWhereInput {
  // Supervisors never see unassigned violations: their scope requires a team snapshot, which an
  // unassigned violation does not have (CHECK violations_unassigned_no_team_chk).
  const and: Prisma.ViolationWhereInput[] = [];
  if (f.from || f.to) {
    and.push({
      capturedAt: {
        ...(f.from ? { gte: riyadhDayStart(f.from) } : {}),
        ...(f.to ? { lt: riyadhDayEnd(f.to) } : {}),
      },
    });
  }
  if (f.teamId) and.push({ teamIdSnapshot: f.teamId });
  if (f.memberId) and.push({ memberId: f.memberId });
  // A9 (ADR-103): violations recorded without a person and not assigned yet, or the assigned ones.
  if (f.assigned === 'true') and.push({ memberId: { not: null } });
  if (f.assigned === 'false') and.push({ memberId: null });
  if (f.recordedBy) and.push({ recordedById: f.recordedBy });
  if (f.typeId) and.push({ typeId: f.typeId });
  if (f.status) and.push({ status: f.status });
  if (f.severity) and.push({ type: { severity: f.severity } });
  const box = parseBbox(f.bbox);
  if (box) {
    and.push({ latitude: { gte: box.south, lte: box.north } });
    // A box crossing the antimeridian (west > east) wraps around.
    and.push(
      box.west <= box.east
        ? { longitude: { gte: box.west, lte: box.east } }
        : { OR: [{ longitude: { gte: box.west } }, { longitude: { lte: box.east } }] },
    );
  }
  if (f.q) and.push({ member: { fullName: { contains: f.q, mode: 'insensitive' } } });
  return and.length ? { AND: and } : {};
}

/** Matches nothing — used when the viewer has no violation scope at all. */
export const NOTHING: Prisma.ViolationWhereInput = { id: { in: [] } };

/**
 * Data scope (brief §7.5–7.6, §17.3), applied **inside** the query:
 *  - `violations.readAll` (ADMIN): everything;
 *  - `violations.readRecorded` (MONITOR): rows they recorded;
 *  - `violations.readOwnTeams` (SUPERVISOR): rows whose team snapshot is a non-archived team they
 *    lead now, and only while visibility resolves to SHOW — the team override SHOW/HIDE wins,
 *    INHERIT (or no row) follows the global `SUPERVISORS_CAN_SEE_VIOLATIONS`.
 * Several grants are OR-ed; none → NOTHING (empty page / 404).
 */
export function violationScopeWhere(
  viewer: Viewer,
  supervisorsCanSee: boolean,
): Prisma.ViolationWhereInput {
  if (can(viewer, 'violations.readAll')) {
    // A12 round 2: an assistant limited to some teams sees those teams' violations.
    const limit = teamLimit(viewer);
    return limit ? { teamIdSnapshot: { in: limit } } : {};
  }
  const grants: Prisma.ViolationWhereInput[] = [];
  if (can(viewer, 'violations.readRecorded')) grants.push({ recordedById: viewer.id });
  if (can(viewer, 'violations.readOwnTeams')) {
    grants.push({
      team: {
        is: {
          // A9 (ADR-100): any team the viewer leads now (primary or not).
          supervisors: { some: { userId: viewer.id, validTo: null } },
          status: { not: 'ARCHIVED' },
          ...(supervisorsCanSee
            ? { OR: [{ visibility: { is: null } }, { visibility: { is: { mode: { in: ['INHERIT', 'SHOW'] } } } }] }
            : { visibility: { is: { mode: 'SHOW' } } }),
        },
      },
    });
  }
  if (!grants.length) return NOTHING;
  return grants.length === 1 ? grants[0]! : { OR: grants };
}

/** True when the scope needs the global visibility setting (saves a query for admins/monitors). */
export function scopeNeedsVisibilitySetting(viewer: Viewer): boolean {
  return !can(viewer, 'violations.readAll') && can(viewer, 'violations.readOwnTeams');
}
