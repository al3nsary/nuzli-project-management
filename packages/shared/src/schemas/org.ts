import { z } from 'zod';
import { optionalText, uuid } from './common';
import type { OrgUnitKind, Role, TeamStatus } from '../enums';
import type { TeamColorDto } from './teams';

// A9 — organisational structure (ADR-102): a tree of units and positions held by a user, a
// team member, or nobody (vacant). Admins manage it (`org.manage`); supervisors read it (`org.read`).

const unitKind = z.enum(['DEPARTMENT', 'SECTION', 'UNIT', 'TEAM_GROUP']);
const unitName = z.string().trim().min(2, { message: 'اكتب اسم الوحدة' }).max(120);
const positionTitle = z.string().trim().min(2, { message: 'اكتب مسمّى المنصب' }).max(120);
const code = z.string().trim().max(30).regex(/^[\p{L}\p{N}._-]*$/u, { message: 'الرمز: حروف وأرقام و . _ - فقط' });
const sort = z.number().finite().min(-1e9).max(1e9);

export const createOrgUnitSchema = z.object({
  parentId: uuid.nullable().default(null),
  name: unitName,
  kind: unitKind,
  code: code.optional(),
  /** Position among siblings (fractional). Default: after the last sibling. */
  sort: sort.optional(),
});
export type CreateOrgUnitInput = z.input<typeof createOrgUnitSchema>;

export const updateOrgUnitSchema = z
  .object({
    name: unitName.optional(),
    kind: unitKind.optional(),
    code: code.nullable().optional(),
    /** true archives the unit (it must be empty of live children, positions and teams); false restores it. */
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'لا يوجد ما يُحدَّث' });

/** `POST /org/units/:id/move` — a new parent (null = root) and/or position among siblings. */
export const moveOrgUnitSchema = z.object({
  parentId: uuid.nullable(),
  sort: sort.optional(),
});

const holderRefine = <T extends { holderUserId?: string | null; holderMemberId?: string | null }>(v: T) =>
  !(v.holderUserId && v.holderMemberId);
const holderMessage = { message: 'المنصب يشغله مستخدم أو عضو فريق أو يبقى شاغرًا، لا الاثنان', path: ['holderUserId'] };

export const createOrgPositionSchema = z
  .object({
    unitId: uuid,
    title: positionTitle,
    holderUserId: uuid.nullable().optional(),
    holderMemberId: uuid.nullable().optional(),
    reportsToPositionId: uuid.nullable().optional(),
    sort: sort.optional(),
  })
  .refine(holderRefine, holderMessage);
export type CreateOrgPositionInput = z.input<typeof createOrgPositionSchema>;

export const updateOrgPositionSchema = z
  .object({
    title: positionTitle.optional(),
    /** Setting one holder clears the other; both null = vacant. */
    holderUserId: uuid.nullable().optional(),
    holderMemberId: uuid.nullable().optional(),
    reportsToPositionId: uuid.nullable().optional(),
  })
  .refine(holderRefine, holderMessage);

/** `POST /org/positions/:id/move` — another unit, another manager and/or another place among siblings. */
export const moveOrgPositionSchema = z
  .object({
    unitId: uuid.optional(),
    reportsToPositionId: uuid.nullable().optional(),
    sort: sort.optional(),
  })
  .refine((v) => v.unitId !== undefined || v.reportsToPositionId !== undefined || v.sort !== undefined, {
    message: 'لا يوجد ما يُحدَّث',
  });

export const orgTreeQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export const orgDeleteSchema = z.object({ reason: optionalText(300) });

export interface OrgHolderDto {
  type: 'USER' | 'MEMBER';
  id: string;
  fullName: string;
  hasPhoto: boolean;
  /** USER holders: their role. */
  role?: Role;
  /** MEMBER holders: their current team, if any. */
  team?: { id: string; name: string; color: TeamColorDto } | null;
}

export interface OrgPositionDto {
  id: string;
  unitId: string;
  title: string;
  holder: OrgHolderDto | null;
  reportsToPositionId: string | null;
  sort: number;
}

export interface OrgTeamLinkDto {
  id: string;
  name: string;
  status: TeamStatus;
  color: TeamColorDto;
  memberCount: number;
  supervisors: { id: string; fullName: string; isPrimary: boolean; hasPhoto: boolean }[];
}

export interface OrgUnitDto {
  id: string;
  parentId: string | null;
  name: string;
  kind: OrgUnitKind;
  code: string | null;
  sort: number;
  archivedAt: string | null;
  positions: OrgPositionDto[];
  teams: OrgTeamLinkDto[];
}

/** `GET /org` — every unit as a flat list (parents before children, siblings by `sort`). */
export interface OrgTreeDto {
  units: OrgUnitDto[];
  generatedAt: string;
}
