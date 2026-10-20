import type { Prisma } from '@prisma/client';
import {
  can,
  COLOR_RESERVING_STATUSES,
  maskNationalIdParts,
  type MemberDto,
  type PermissionSubject,
  type TeamColorDto,
  type TeamDto,
  type TeamSummaryDto,
  type TeamSupervisorDto,
} from '@nuzli/shared';
import { AppError } from '../common/app-error';
import type { CryptoService } from '../crypto/crypto.service';
import { teamLimit } from '../access/access-context';

export type Viewer = PermissionSubject & { id: string };

export const RESERVING = COLOR_RESERVING_STATUSES as Array<'ACTIVE' | 'PENDING_APPROVAL'>;

export const COLOR_SELECT = { id: true, name: true, hex: true, isActive: true } satisfies Prisma.TeamColorSelect;

export function toColorDto(c: { id: string; name: string; hex: string; isActive: boolean }): TeamColorDto {
  return { id: c.id, name: c.name, hex: c.hex, isActive: c.isActive };
}

// ───────────────────────────────────────────── leaders (A9, ADR-100)

/** The open leadership rows of a team — "leads the team" = any open row in team_supervisors. */
export const OPEN_LEADERS = { where: { validTo: null }, select: { userId: true } } as const;

/** Every current supervisor with what a TeamSupervisorDto needs, the primary first. */
export const LEADERS_SELECT = {
  where: { validTo: null },
  orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
  select: {
    userId: true,
    isPrimary: true,
    validFrom: true,
    user: { select: { id: true, fullName: true, photoFileId: true } },
  },
} satisfies Prisma.Team$supervisorsArgs;

/**
 * A team as the scope checks need it: the user ids of its open leadership rows, and (A12 round 2)
 * its id — an assistant limited to some teams needs it; without it such an assistant is refused.
 */
export interface LedTeam {
  id?: string;
  supervisors: ReadonlyArray<{ userId: string }>;
}

export function leaderIds(team: LedTeam): string[] {
  return team.supervisors.map((s) => s.userId);
}

/** True when `userId` currently leads the team (any open row, primary or not). */
export function leads(userId: string, team: LedTeam): boolean {
  return team.supervisors.some((s) => s.userId === userId);
}

/** Prisma where: teams the user leads now. */
export function ledByWhere(userId: string): Prisma.TeamWhereInput {
  return { supervisors: { some: { userId, validTo: null } } };
}

export type LeaderRow = Prisma.TeamSupervisorGetPayload<{ select: typeof LEADERS_SELECT.select }>;

export function toSupervisorDtos(rows: readonly LeaderRow[]): TeamSupervisorDto[] {
  return [...rows]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.validFrom.getTime() - b.validFrom.getTime())
    .map((r) => ({
      id: r.user.id,
      fullName: r.user.fullName,
      isPrimary: r.isPrimary,
      hasPhoto: !!r.user.photoFileId,
      since: r.validFrom.toISOString(),
    }));
}

/** Everything a TeamDto needs, including the number of open memberships. */
export const TEAM_SELECT = {
  id: true,
  name: true,
  status: true,
  supervisorId: true,
  createdAt: true,
  color: { select: COLOR_SELECT },
  supervisor: { select: { id: true, fullName: true } },
  supervisors: LEADERS_SELECT,
  orgUnit: { select: { id: true, name: true, kind: true } },
  visibility: { select: { mode: true } },
  _count: { select: { memberships: { where: { validTo: null } } } },
} satisfies Prisma.TeamSelect;

export type TeamRow = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>;

export function toTeamDto(t: TeamRow): TeamDto {
  return {
    id: t.id,
    name: t.name,
    color: toColorDto(t.color),
    status: t.status,
    supervisor: t.supervisor ? { id: t.supervisor.id, fullName: t.supervisor.fullName } : null,
    supervisors: toSupervisorDtos(t.supervisors),
    orgUnit: t.orgUnit ? { id: t.orgUnit.id, name: t.orgUnit.name, kind: t.orgUnit.kind } : null,
    memberCount: t._count.memberships,
    createdAt: t.createdAt.toISOString(),
    violationVisibility: t.visibility?.mode ?? 'INHERIT',
  };
}

export const TEAM_SUMMARY_SELECT = {
  id: true,
  name: true,
  color: { select: COLOR_SELECT },
} satisfies Prisma.TeamSelect;

export function toTeamSummary(t: Prisma.TeamGetPayload<{ select: typeof TEAM_SUMMARY_SELECT }>): TeamSummaryDto {
  return { id: t.id, name: t.name, color: toColorDto(t.color) };
}

/** Columns for a MemberDto: the open membership (current team) and the reference names. */
export const MEMBER_SELECT = {
  id: true,
  fullName: true,
  nationalIdEnc: true,
  nationalIdHash: true,
  nationalIdFirst: true,
  nationalIdLast4: true,
  jobTitleId: true,
  jobTitleText: true,
  departmentId: true,
  departmentText: true,
  photoFileId: true,
  status: true,
  jobTitle: { select: { name: true } },
  department: { select: { name: true } },
  memberships: {
    where: { validTo: null },
    take: 1,
    select: { teamId: true, role: true, team: { select: { ...TEAM_SUMMARY_SELECT, status: true, supervisors: OPEN_LEADERS } } },
  },
} satisfies Prisma.TeamMemberSelect;

export type MemberRow = Prisma.TeamMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

/** Job title shown on screens and cards: the list entry when linked, else the free text. */
export function memberJobTitle(m: Pick<MemberRow, 'jobTitle' | 'jobTitleText'>): string | null {
  return m.jobTitle?.name ?? m.jobTitleText ?? null;
}

export function memberDepartment(m: Pick<MemberRow, 'department' | 'departmentText'>): string | null {
  return m.department?.name ?? m.departmentText ?? null;
}

/**
 * The national ID is masked from the stored first/last digits (no decryption) unless the
 * caller asks for the full value AND holds `nationalIds.readFull` (ADR-032).
 */
export function toMemberDto(
  m: MemberRow,
  opts: { viewer?: Viewer; full?: boolean; crypto?: CryptoService } = {},
): MemberDto {
  const open = m.memberships[0];
  const dto: MemberDto = {
    id: m.id,
    fullName: m.fullName,
    nationalIdMasked: maskNationalIdParts(m.nationalIdFirst, m.nationalIdLast4),
    jobTitle: memberJobTitle(m),
    jobTitleId: m.jobTitleId,
    department: memberDepartment(m),
    departmentId: m.departmentId,
    status: m.status,
    team: open ? toTeamSummary(open.team) : null,
    photoFileId: m.photoFileId,
    hasPhoto: !!m.photoFileId,
    isForeman: open?.role === 'FOREMAN',
  };
  if (opts.full && opts.crypto && opts.viewer && can(opts.viewer, 'nationalIds.readFull')) {
    dto.nationalId = opts.crypto.decrypt(m.nationalIdEnc);
  }
  return dto;
}

// ───────────────────────────────────────────── data scope (supervisors: own teams only)

export function canReadAllTeams(viewer: Viewer): boolean {
  return can(viewer, 'teams.readAll');
}

/** A12 round 2: true when an assistant's team scope lets them reach this team (no scope = all). */
export function withinTeamLimit(viewer: Viewer, team: { id?: string } | null | undefined): boolean {
  const limit = teamLimit(viewer);
  if (!limit) return true;
  return !!team?.id && limit.includes(team.id);
}

/** A12 round 2: where-clause of an assistant's team scope ({} when unlimited). */
export function teamLimitWhere(viewer: Viewer): Prisma.TeamWhereInput {
  const limit = teamLimit(viewer);
  return limit ? { id: { in: limit } } : {};
}

export function canManageAllTeams(viewer: Viewer): boolean {
  return can(viewer, 'teams.manageAll');
}

/**
 * Read scope: admins see every team; a supervisor sees only the teams they lead (any open
 * row in team_supervisors — primary or not, A9 ADR-100). A team the
 * viewer cannot see answers 404 (its existence is not revealed).
 */
export function canReadTeam(viewer: Viewer, team: LedTeam): boolean {
  return (canReadAllTeams(viewer) && withinTeamLimit(viewer, team)) || (can(viewer, 'teams.readOwn') && leads(viewer.id, team));
}

export function assertTeamReadable(viewer: Viewer, team: LedTeam): void {
  if (!canReadTeam(viewer, team)) throw new AppError('NOT_FOUND');
}

/** Manage scope: `teams.manageAll`, or `teams.manageOwn` on a team the viewer leads. */
export function assertTeamManageable(viewer: Viewer, team: LedTeam): void {
  assertTeamReadable(viewer, team);
  if (canManageAllTeams(viewer) && withinTeamLimit(viewer, team)) return;
  if (can(viewer, 'teams.manageOwn') && leads(viewer.id, team)) return;
  throw new AppError('FORBIDDEN');
}

/** Members: `members.manage`, or `members.manageOwn` when the member sits in a team the viewer leads. */
export function canManageMemberIn(viewer: Viewer, team: LedTeam | null): boolean {
  // A12 round 2: an assistant limited to some teams manages only their members (and unassigned ones).
  if (can(viewer, 'members.manage') && (!team || withinTeamLimit(viewer, team))) return true;
  return !!team && can(viewer, 'members.manageOwn') && leads(viewer.id, team);
}

/**
 * A12 round 2: the members a card printer may print — everyone for admins and printers without a
 * team scope; an assistant limited to some teams prints those teams' members (and unassigned ones).
 */
export function printMemberScopeWhere(viewer: Viewer): Prisma.TeamMemberWhereInput {
  if (!can(viewer, 'cards.print')) return memberScopeWhere(viewer);
  const limit = teamLimit(viewer);
  if (!limit) return {};
  return { OR: [{ memberships: { some: { validTo: null, teamId: { in: limit } } } }, { memberships: { none: { validTo: null } } }] };
}

/** Where-clause limiting members to what a supervisor may see: own teams' members, or unassigned. */
export function memberScopeWhere(viewer: Viewer): Prisma.TeamMemberWhereInput {
  if (canReadAllTeams(viewer) || can(viewer, 'members.manage')) {
    // A12 round 2: an assistant limited to some teams sees those teams' members (and unassigned ones).
    const limit = teamLimit(viewer);
    if (!limit) return {};
    return {
      OR: [
        { memberships: { some: { validTo: null, teamId: { in: limit } } } },
        { memberships: { none: { validTo: null } } },
      ],
    };
  }
  return {
    OR: [
      { memberships: { some: { validTo: null, team: ledByWhere(viewer.id) } } },
      { memberships: { none: { validTo: null } } },
    ],
  };
}
