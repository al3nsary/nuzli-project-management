import { z } from 'zod';
import { email, fullName, hexColor, nationalId, optionalText, paginationQuery, reason, saudiMobile, uuid } from './common';
import type { MemberStatus, OrgUnitKind, TeamStatus } from '../enums';

export const memberInputSchema = z.object({
  fullName,
  nationalId,
  jobTitleId: uuid.optional(),
  jobTitleText: optionalText(80),
  departmentId: uuid.optional(),
  departmentText: optionalText(80),
});
export type MemberInput = z.input<typeof memberInputSchema>;

export const newSupervisorSchema = z.object({
  fullName,
  email,
  mobile: saudiMobile,
  nationalId,
});

export const createTeamSchema = z
  .object({
    name: z.string().trim().min(2, { message: 'اكتب اسم الفريق' }).max(80),
    colorId: uuid,
    /** Admin: existing supervisor, or `newSupervisor` inline. Supervisor: ignored (self). */
    supervisorId: uuid.optional(),
    newSupervisor: newSupervisorSchema.optional(),
    /**
     * A9 (ADR-100): several supervisors (admin only). The primary is `primarySupervisorId`;
     * by default the new supervisor, else `supervisorId`, else the first of `supervisorIds`.
     */
    supervisorIds: z.array(uuid).max(10).optional(),
    primarySupervisorId: uuid.optional(),
    /** A9: optional link to an organisational unit (admin only). */
    orgUnitId: uuid.optional(),
    members: z.array(memberInputSchema).max(500).default([]),
    /** Existing members to move into the new team. */
    existingMemberIds: z.array(uuid).max(500).default([]),
  })
  .refine((v) => !(v.supervisorId && v.newSupervisor), {
    message: 'اختر مشرفًا موجودًا أو أنشئ مشرفًا جديدًا، لا الاثنين',
    path: ['supervisorId'],
  })
  .refine(
    (v) =>
      !v.primarySupervisorId ||
      v.primarySupervisorId === v.supervisorId ||
      (v.supervisorIds ?? []).includes(v.primarySupervisorId),
    { message: 'المشرف الرئيسي يجب أن يكون من المشرفين المختارين', path: ['primarySupervisorId'] },
  );
export type CreateTeamInput = z.input<typeof createTeamSchema>;

export const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  colorId: uuid.optional(),
  /** A9: link to an organisational unit; null unlinks (admin only). */
  orgUnitId: uuid.nullable().optional(),
});

/** A9 `POST /teams/:id/supervisors`. */
export const addTeamSupervisorSchema = z.object({
  userId: uuid,
  isPrimary: z.boolean().default(false),
  reason: optionalText(300),
});

/** A9 `DELETE /teams/:id/supervisors/:userId` — removing the primary needs `newPrimaryUserId` (another current supervisor). */
export const removeTeamSupervisorSchema = z.object({
  reason,
  newPrimaryUserId: uuid.optional(),
});

/** A9 `POST /teams/:id/supervisors/:userId/primary`. */
export const setPrimarySupervisorSchema = z.object({ reason: optionalText(300) });

/** A9 `POST /teams/:id/foreman` — the worker foreman (مشرف عمّال), a current member of the team. */
export const setForemanSchema = z.object({ memberId: uuid });

export const changeSupervisorSchema = z.object({ supervisorId: uuid, reason: optionalText(300) });

export const moveMembersSchema = z.object({
  memberIds: z.array(uuid).min(1).max(500),
  toTeamId: uuid,
  reason: optionalText(300),
});
export type MoveMembersInput = z.input<typeof moveMembersSchema>;

export const updateMemberSchema = memberInputSchema.partial();

export const importMembersSchema = z.object({
  teamId: uuid,
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
  commit: z.boolean().default(false),
});

export const teamColorSchema = z.object({
  name: z.string().trim().min(2).max(40),
  hex: hexColor,
});

export const archiveTeamSchema = z.object({ reason });
export const rejectTeamSchema = z.object({ reason });

/** Admin palette edit: rename, retire (isActive=false) or restore. */
export const updateTeamColorSchema = z
  .object({ name: z.string().trim().min(2).max(40).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, { message: 'لا يوجد ما يُحدَّث' });

export const violationVisibilitySchema = z.object({ mode: z.enum(['INHERIT', 'SHOW', 'HIDE']) });

export interface TeamColorDto {
  id: string;
  name: string;
  hex: string;
  isActive: boolean;
}

/** Admin palette row: which ACTIVE/PENDING team holds the colour, if any. */
export interface TeamColorPaletteDto extends TeamColorDto {
  inUseBy: { teamId: string; teamName: string } | null;
}

/** 409 COLOR_TAKEN details: the client replaces its picker with `available`. */
export interface ColorTakenDetails {
  fieldErrors: { colorId: string[] };
  refresh: 'colors';
  available: TeamColorDto[];
}

export interface TeamSummaryDto {
  id: string;
  name: string;
  color: TeamColorDto;
}

/** A9: one current supervisor of a team (`id` is the user id). */
export interface TeamSupervisorDto {
  id: string;
  fullName: string;
  isPrimary: boolean;
  hasPhoto: boolean;
  /** Start of this person's current leadership row. */
  since?: string;
  /** A12 round 3: present (true) when the person holds more than one live role («صلاحية مزدوجة»). */
  dualRole?: boolean;
}

export interface TeamDto extends TeamSummaryDto {
  status: TeamStatus;
  /** The primary supervisor (kept for compatibility; every supervisor is in `supervisors`). */
  supervisor: { id: string; fullName: string; dualRole?: boolean } | null;
  /** A9 (ADR-100): every current supervisor, the primary first. Always sent by the API. */
  supervisors?: TeamSupervisorDto[];
  /** A9: the linked organisational unit. Always sent by the API (null when unlinked). */
  orgUnit?: { id: string; name: string; kind: OrgUnitKind } | null;
  memberCount: number;
  createdAt: string;
  violationVisibility?: 'INHERIT' | 'SHOW' | 'HIDE';
}

export interface TeamDetailDto extends TeamDto {
  members: MemberDto[];
  /** A9: the worker foreman (مشرف عمّال), also flagged by `members[].isForeman`. Always sent by the API. */
  foreman?: { id: string; fullName: string } | null;
}

/** A9 `GET /teams/:id/supervisors`. */
export interface TeamSupervisorsDto {
  current: TeamSupervisorDto[];
  history: SupervisorHistoryDto[];
}

export interface SupervisorHistoryDto {
  id: string;
  supervisor: { id: string; fullName: string; dualRole?: boolean };
  /** A9: the row was the primary supervisor (a primary change closes and reopens both rows). */
  isPrimary?: boolean;
  validFrom: string;
  validTo: string | null;
  changedBy: { id: string; fullName: string } | null;
  reason: string | null;
}

export interface MemberDto {
  id: string;
  fullName: string;
  nationalIdMasked: string;
  nationalId?: string;
  jobTitle: string | null;
  jobTitleId: string | null;
  department: string | null;
  departmentId: string | null;
  status: MemberStatus;
  team: TeamSummaryDto | null;
  photoFileId: string | null;
  /** Owner request A8: true when a photo is linked (`GET /members/:id/photo-url`). Always sent by the API. */
  hasPhoto?: boolean;
  /** A9: the worker foreman of their current team (record only, no account). Always sent by the API. */
  isForeman?: boolean;
}

export interface MembershipHistoryDto {
  id: string;
  team: TeamSummaryDto;
  validFrom: string;
  validTo: string | null;
  movedBy: { id: string; fullName: string } | null;
  reason: string | null;
}

export interface ImportRowResult {
  row: number;
  ok: boolean;
  errors: string[];
  value?: {
    fullName: string;
    nationalIdMasked: string;
    jobTitle?: string;
    department?: string;
    /** True when the text matched an admin-managed list entry (else kept as free text). */
    jobTitleMatched?: boolean;
    departmentMatched?: boolean;
  };
}

export interface ImportMembersResultDto {
  results: ImportRowResult[];
  /** Rows inserted (0 for a preview). */
  committed: number;
}

/**
 * `POST /members/search` — the same filters as `GET /members`, in the body, so a full national
 * ID never travels in a URL (security review L4).
 */
export const memberSearchSchema = paginationQuery.extend({
  teamId: uuid.optional(),
  unassigned: z.boolean().optional().default(false),
});
export type MemberSearchInput = z.input<typeof memberSearchSchema>;
