import { z } from 'zod';
import { fullName, isoDate, isoDateTime, nationalId, optionalText, reason, uuid } from './common';
import type { OcrStatus, Severity, ViolationFileKind, ViolationStatus } from '../enums';
import type { MemberDto, TeamSummaryDto } from './teams';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_UPLOAD_TYPES = [...ALLOWED_IMAGE_TYPES, 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Personal photos (owner request A8): images only, compressed client-side to about 600×600. */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** Upload entity types of personal photos (`entityId` = the user or the member). */
export const PHOTO_ENTITY_TYPES = ['user_photo', 'member_photo'] as const;
export type PhotoEntityType = (typeof PHOTO_ENTITY_TYPES)[number];

export const deviceInfoSchema = z
  .object({
    userAgent: z.string().max(400).optional(),
    platform: z.string().max(80).optional(),
    online: z.boolean().optional(),
    appVersion: z.string().max(40).optional(),
  })
  .passthrough();

export const createViolationSchema = z.object({
  /** Client-generated UUID — the idempotency key for offline sync (brief §7.4). */
  clientUuid: uuid,
  /**
   * A9 (ADR-103): optional — a monitor who does not know the person records the violation
   * without one and it is assigned later (`POST /violations/:id/assign` or `register-member`).
   */
  memberId: uuid.optional(),
  typeId: uuid,
  description: z.string().trim().min(3, { message: 'اكتب وصف المخالفة' }).max(2000),
  notes: optionalText(2000),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000),
  capturedAt: isoDateTime,
  /** Device clock at the moment of sending; used for the clock-drift check. */
  clientSentAt: isoDateTime.optional(),
  deviceInfo: deviceInfoSchema.default({}),
  /** Number of photos the client is going to upload, so the server can track completeness. */
  expectedIdPhotos: z.number().int().min(1).max(1).default(1),
  expectedEvidencePhotos: z.number().int().min(1).max(20),
  /** A9 (owner decision 4): one photo of the person is required on every violation. */
  expectedPersonPhotos: z.number().int().min(1).max(1).default(1),
});

/** A9 `POST /violations/:id/assign`. */
export const assignViolationSchema = z.object({ memberId: uuid });

/** A9 `POST /violations/:id/unassign` (admin). */
export const unassignViolationSchema = z.object({ reason: optionalText(500) });

/**
 * A9 `POST /violations/:id/register-member` — creates the member from the (OCR-confirmed) card
 * data, uses the violation's PERSON photo as the member photo, then assigns the violation.
 * Without `teamId` the member is created unassigned (admins only).
 */
export const registerViolationMemberSchema = z.object({
  fullName,
  nationalId,
  teamId: uuid.optional(),
  jobTitleId: uuid.optional(),
  jobTitleText: optionalText(80),
  departmentId: uuid.optional(),
  departmentText: optionalText(80),
  /** Copy the violation's PERSON photo to the new member (default true). */
  usePersonPhoto: z.boolean().default(true),
});
export type RegisterViolationMemberInput = z.input<typeof registerViolationMemberSchema>;

/**
 * A9 `POST /violations/:id/register-member` answer. `violation` is null when the caller may not
 * see it afterwards (a supervisor whose team hides violations).
 */
export interface RegisterViolationMemberResultDto {
  member: MemberDto;
  violation: ViolationDto | null;
}
export type CreateViolationInput = z.input<typeof createViolationSchema>;

/**
 * A9 project imports (`entityType: 'import'`, admin only): Excel, CSV, MS Project XML and .mpp.
 * Browsers report CSV/XML/MPP types inconsistently, so the client sends the canonical type for
 * the file extension: .xlsx → spreadsheetml, .csv → text/csv, .xml → application/xml, .mpp →
 * application/vnd.ms-project. The server checks the bytes (ZIP + xl/, text, XML root, OLE2).
 */
export const IMPORT_UPLOAD_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/xml',
  'text/xml',
  'application/vnd.ms-project',
] as const;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const presignUploadSchema = z
  .object({
    entityType: z.enum(['violation', 'task', 'logo', 'member_photo', 'user_photo', 'import']),
    entityId: uuid.optional(),
    kind: z.enum(['ID_CARD', 'EVIDENCE', 'PERSON', 'ATTACHMENT', 'LOGO', 'PHOTO']).optional(),
    contentType: z.enum([...ALLOWED_UPLOAD_TYPES, ...IMPORT_UPLOAD_TYPES]),
    sizeBytes: z.number().int().min(1).max(MAX_IMPORT_BYTES),
    /** Hex sha256 computed by the client (optional, verified on confirm when present). */
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .superRefine((v, ctx) => {
    const isImport = v.entityType === 'import';
    const types: readonly string[] = isImport ? IMPORT_UPLOAD_TYPES : ALLOWED_UPLOAD_TYPES;
    if (!types.includes(v.contentType)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: 'نوع الملف غير مسموح' });
    }
    if (!isImport && v.sizeBytes > MAX_UPLOAD_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sizeBytes'], message: 'حجم الملف أكبر من المسموح' });
    }
    if (isImport && (v.entityId || v.kind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entityId'], message: 'ملف الاستيراد لا يرتبط بعنصر' });
    }
  });
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export interface PresignedUpload {
  fileId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

/** `GET /me/photo-url`, `/users/:id/photo-url`, `/members/:id/photo-url` (owner request A8). */
export interface PhotoUrlDto {
  url: string;
  expiresAt: string;
}

export const updateViolationSchema = z.object({
  typeId: uuid.optional(),
  description: z.string().trim().min(3).max(2000).optional(),
  notes: optionalText(2000),
});

export const changeViolationStatusSchema = z
  .object({
    status: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'CONFIRMED', 'CANCELLED']),
    reason: optionalText(500),
  })
  .refine((v) => v.status !== 'CANCELLED' || (v.reason && v.reason.length >= 3), {
    message: 'اكتب سبب الإلغاء',
    path: ['reason'],
  });

export const violationResponseSchema = z.object({
  body: z.string().trim().min(3, { message: 'اكتب الرد أو الاعتراض' }).max(2000),
});

export const violationFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  teamId: uuid.optional(),
  memberId: uuid.optional(),
  recordedBy: uuid.optional(),
  typeId: uuid.optional(),
  status: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'CONFIRMED', 'CANCELLED']).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  /** Bounding box "south,west,north,east" for the map area filter. */
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional(),
  /** A9: `false` = violations recorded without a person and not assigned yet; `true` = assigned. */
  assigned: z.enum(['true', 'false']).optional(),
});
export type ViolationFilter = z.infer<typeof violationFilterSchema>;

export const violationTypeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().default(null),
  isActive: z.boolean().default(true),
});

/** `PATCH /violation-types/:id` — any subset; omitted fields keep their value. */
export const updateViolationTypeSchema = violationTypeSchema.partial();

export const cancelReason = reason;

export interface ViolationTypeDto {
  id: string;
  name: string;
  severity: Severity | null;
  isActive: boolean;
}

export interface ViolationFileDto {
  id: string;
  kind: ViolationFileKind;
  mimeType: string;
  ready: boolean;
}

export interface ViolationDto {
  id: string;
  clientUuid: string;
  /** A9 (ADR-103): null while the violation is not assigned to a person (`assigned = false`). */
  member: { id: string; fullName: string; nationalIdMasked: string } | null;
  team: TeamSummaryDto | null;
  /** The primary supervisor of the team at `capturedAt`. */
  supervisor: { id: string; fullName: string } | null;
  /** A9: false until a person is assigned. Always sent by the API. */
  assigned?: boolean;
  /** A9: every supervisor of the team at `capturedAt` (`supervisor_ids_snapshot`). Always sent by the API. */
  supervisors?: { id: string; fullName: string }[];
  /** A9: when and by whom the person was assigned (null for violations recorded with a person). */
  assignedAt?: string | null;
  assignedBy?: { id: string; fullName: string } | null;
  /** A9: state of the ID-card OCR job (null = no ID-card photo confirmed yet). Admins and the recorder. */
  ocrStatus?: OcrStatus | null;
  recordedBy: { id: string; fullName: string };
  type: ViolationTypeDto;
  description: string;
  notes: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
  receivedAt: string;
  clockDriftSuspect: boolean;
  status: ViolationStatus;
  cancelReason: string | null;
  files: ViolationFileDto[];
  responses: { id: string; supervisor: { id: string; fullName: string }; body: string; createdAt: string }[];
  editableUntil: string | null;
  /** Photo counts announced by the client at create time (completeness check in the UI). A9 adds `person`. */
  expectedPhotos?: { idCard: number; evidence: number; person?: number };
  /** Device clock at sync time, when the client sent it (ADR-014). */
  clientSentAt?: string | null;
  /** UA / platform / app version only; returned to admins. */
  deviceInfo?: Record<string, unknown>;
}

/** `GET /violations/roster`. */
export interface RosterResponse {
  items: RosterEntry[];
  /** Server time the roster was built; shown as "last updated" on the device. */
  generatedAt: string;
}

/** Minimal roster row cached on the monitor's device (brief §7.4). */
export interface RosterEntry {
  memberId: string;
  fullName: string;
  nationalIdMasked: string;
  /** Last four digits, used only for on-device search by ID. */
  nationalIdTail: string;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
  /** Owner request A8: the member photo (fetch it with `GET /members/:id/photo-url`). */
  photoFileId?: string | null;
  hasPhoto?: boolean;
}

/** One extracted ID-card field with the OCR confidence (0–100). */
export interface OcrFieldDto {
  value: string;
  confidence: number;
}

/** A9 `GET /violations/:id/ocr` (admin and the recorder). */
export interface ViolationOcrDto {
  status: OcrStatus | 'NONE';
  attempts: number;
  extractedAt: string | null;
  /** Short reason after FAILED (never OCR text). */
  error?: string | null;
  fields: {
    /** Masked (`1•••••••23`) unless the caller holds `nationalIds.readFull` (viewing it is audited). */
    nationalId: (OcrFieldDto & { masked: string; full: boolean; kind: 'CITIZEN' | 'RESIDENT' }) | null;
    name: OcrFieldDto | null;
    nameLatin: OcrFieldDto | null;
    birthDate: (OcrFieldDto & { calendar: 'HIJRI' | 'GREGORIAN' }) | null;
    expiryDate: (OcrFieldDto & { calendar: 'HIJRI' | 'GREGORIAN' }) | null;
    nationality: OcrFieldDto | null;
  };
  suggestedMembers: ViolationSuggestionDto[];
  /** Users whose national ID matches exactly (a supervisor or monitor on the card), for information. */
  suggestedUsers: { id: string; fullName: string; role: string }[];
}

export interface ViolationSuggestionDto {
  memberId: string;
  fullName: string;
  nationalIdMasked: string;
  team: TeamSummaryDto | null;
  hasPhoto: boolean;
  /** NATIONAL_ID = exact blind-index match; NAME = name similarity. */
  match: 'NATIONAL_ID' | 'NAME';
  /** 0–1 (1 for an exact ID match). */
  score: number;
}

export interface ViolationStats {
  /** A9: violations not assigned to a person yet (same filters; never in `byTeam`). */
  unassigned?: number;
  total: number;
  thisWeek: number;
  previousWeek: number;
  byTeam: { teamId: string; teamName: string; color: string; count: number; members: number; perMember: number }[];
  topMembers: { memberId: string; fullName: string; teamName: string | null; color: string | null; count: number }[];
  byMonitor: { userId: string; fullName: string; count: number }[];
  byType: { typeId: string; name: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
  trend: { date: string; count: number }[];
  heatmap: { weekday: number; hour: number; count: number }[];
  points: { id: string; lat: number; lng: number; color: string | null }[];
  /** True when more than the 5,000 newest points matched (the map shows only those). */
  pointsTruncated?: boolean;
  /** Server time the statistics were computed. */
  generatedAt?: string;
}
