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
} from '@nuzli/shared';
import { AppError } from '../common/app-error';
import type { CryptoService } from '../crypto/crypto.service';

export type Viewer = PermissionSubject & { id: string };

export const RESERVING = COLOR_RESERVING_STATUSES as Array<'ACTIVE' | 'PENDING_APPROVAL'>;

export const COLOR_SELECT = { id: true, name: true, hex: true, isActive: true } satisfies Prisma.TeamColorSelect;

export function toColorDto(c: { id: string; name: string; hex: string; isActive: boolean }): TeamColorDto {
  return { id: c.id, name: c.name, hex: c.hex, isActive: c.isActive };
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
    select: { teamId: true, team: { select: { ...TEAM_SUMMARY_SELECT, supervisorId: true } } },
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

export function canManageAllTeams(viewer: Viewer): boolean {
  return can(viewer, 'teams.manageAll');
}

/**
 * Read scope: admins see every team; a supervisor sees only the teams they lead. A team the
 * viewer cannot see answers 404 (its existence is not revealed).
 */
export function canReadTeam(viewer: Viewer, team: { supervisorId: string }): boolean {
  return canReadAllTeams(viewer) || (can(viewer, 'teams.readOwn') && team.supervisorId === viewer.id);
}

export function assertTeamReadable(viewer: Viewer, team: { supervisorId: string }): void {
  if (!canReadTeam(viewer, team)) throw new AppError('NOT_FOUND');
}

/** Manage scope: `teams.manageAll`, or `teams.manageOwn` on a team the viewer leads. */
export function assertTeamManageable(viewer: Viewer, team: { supervisorId: string }): void {
  assertTeamReadable(viewer, team);
  if (canManageAllTeams(viewer)) return;
  if (can(viewer, 'teams.manageOwn') && team.supervisorId === viewer.id) return;
  throw new AppError('FORBIDDEN');
}

/** Members: `members.manage`, or `members.manageOwn` when the member sits in a team the viewer leads. */
export function canManageMemberIn(viewer: Viewer, team: { supervisorId: string } | null): boolean {
  if (can(viewer, 'members.manage')) return true;
  return !!team && can(viewer, 'members.manageOwn') && team.supervisorId === viewer.id;
}

/** Where-clause limiting members to what a supervisor may see: own teams' members, or unassigned. */
export function memberScopeWhere(viewer: Viewer): Prisma.TeamMemberWhereInput {
  if (canReadAllTeams(viewer) || can(viewer, 'members.manage')) return {};
  return {
    OR: [
      { memberships: { some: { validTo: null, team: { supervisorId: viewer.id } } } },
      { memberships: { none: { validTo: null } } },
    ],
  };
}
