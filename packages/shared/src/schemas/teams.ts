import { z } from 'zod';
import { email, fullName, hexColor, nationalId, optionalText, reason, saudiMobile, uuid } from './common';
import type { MemberStatus, TeamStatus } from '../enums';

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
    members: z.array(memberInputSchema).max(500).default([]),
    /** Existing members to move into the new team. */
    existingMemberIds: z.array(uuid).max(500).default([]),
  })
  .refine((v) => !(v.supervisorId && v.newSupervisor), {
    message: 'اختر مشرفًا موجودًا أو أنشئ مشرفًا جديدًا، لا الاثنين',
    path: ['supervisorId'],
  });
export type CreateTeamInput = z.input<typeof createTeamSchema>;

export const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  colorId: uuid.optional(),
});

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

export interface TeamColorDto {
  id: string;
  name: string;
  hex: string;
  isActive: boolean;
}

export interface TeamSummaryDto {
  id: string;
  name: string;
  color: TeamColorDto;
}

export interface TeamDto extends TeamSummaryDto {
  status: TeamStatus;
  supervisor: { id: string; fullName: string } | null;
  memberCount: number;
  createdAt: string;
  violationVisibility?: 'INHERIT' | 'SHOW' | 'HIDE';
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
  value?: { fullName: string; nationalIdMasked: string; jobTitle?: string; department?: string };
}
