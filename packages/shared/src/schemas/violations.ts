import { z } from 'zod';
import { isoDate, isoDateTime, optionalText, reason, uuid } from './common';
import type { Severity, ViolationFileKind, ViolationStatus } from '../enums';
import type { TeamSummaryDto } from './teams';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_UPLOAD_TYPES = [...ALLOWED_IMAGE_TYPES, 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
  memberId: uuid,
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
});
export type CreateViolationInput = z.input<typeof createViolationSchema>;

export const presignUploadSchema = z.object({
  entityType: z.enum(['violation', 'task', 'logo', 'member_photo']),
  entityId: uuid.optional(),
  kind: z.enum(['ID_CARD', 'EVIDENCE', 'ATTACHMENT', 'LOGO', 'PHOTO']).optional(),
  contentType: z.enum(ALLOWED_UPLOAD_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  /** Hex sha256 computed by the client (optional, verified on confirm when present). */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export interface PresignedUpload {
  fileId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
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
  member: { id: string; fullName: string; nationalIdMasked: string };
  team: TeamSummaryDto | null;
  supervisor: { id: string; fullName: string } | null;
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
  /** Photo counts announced by the client at create time (completeness check in the UI). */
  expectedPhotos?: { idCard: number; evidence: number };
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
}

export interface ViolationStats {
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
