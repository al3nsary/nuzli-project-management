import { z } from 'zod';
import { isoDate, uuid } from './common';
import type { CardLayoutKey, CardOrientation } from '../enums';

export const cardSizeSchema = z.object({
  name: z.string().trim().min(2).max(60),
  widthMm: z.number().min(20).max(300),
  heightMm: z.number().min(15).max(300),
});

export const cardTemplateConfigSchema = z.object({
  fields: z
    .object({
      logo: z.boolean().default(true),
      jobTitle: z.boolean().default(true),
      nationalId: z.boolean().default(true),
      department: z.boolean().default(true),
      teamName: z.boolean().default(true),
      photo: z.boolean().default(false),
      qr: z.boolean().default(true),
      validUntil: z.boolean().default(false),
    })
    .default({}),
  maskNationalId: z.boolean().default(true),
  logoPosition: z.enum(['start', 'end', 'center']).default('start'),
  /** Font sizes in points. */
  fontSizes: z
    .object({ name: z.number().min(5).max(30).default(11), body: z.number().min(4).max(20).default(7) })
    .default({}),
  accentStrip: z.enum(['start', 'top', 'bottom']).default('start'),
  background: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF'),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#14232B'),
  validUntil: isoDate.optional(),
});
export type CardTemplateConfig = z.infer<typeof cardTemplateConfigSchema>;

export const cardTemplateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  sizeId: uuid,
  orientation: z.enum(['LANDSCAPE', 'PORTRAIT']),
  layoutKey: z.enum(['CLASSIC_HORIZONTAL', 'VERTICAL_BADGE', 'COMPACT_LABEL']),
  config: cardTemplateConfigSchema,
  isDefault: z.boolean().default(false),
  logoId: uuid.nullable().optional(),
});

export const updateCardTemplateSchema = cardTemplateSchema.partial();

/** `POST /logos` — the file is uploaded first via `/files/presign` with entityType 'logo'. */
export const logoInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  fileId: uuid,
  isDefault: z.boolean().default(false),
});

/** `POST /cards/preview` — teams and/or individual members. */
export const cardPreviewSchema = z
  .object({
    templateId: uuid,
    teamIds: z.array(uuid).max(100).default([]),
    memberIds: z.array(uuid).max(1000).default([]),
    includeSupervisors: z.boolean().default(true),
  })
  .refine((v) => v.teamIds.length > 0 || v.memberIds.length > 0, {
    message: 'اختر فريقًا أو عضوًا واحدًا على الأقل',
    path: ['teamIds'],
  });
export type CardPreviewInput = z.input<typeof cardPreviewSchema>;

export const cardDataSchema = z.object({
  fullName: z.string().trim().max(120),
  jobTitle: z.string().trim().max(80).optional().default(''),
  nationalId: z.string().trim().max(20).optional().default(''),
  department: z.string().trim().max(80).optional().default(''),
  teamName: z.string().trim().max(80).optional().default(''),
  teamColor: z.string().optional().default('#1D5C63'),
  qrValue: z.string().max(80).optional(),
  photoFileId: uuid.nullable().optional(),
  validUntil: isoDate.optional(),
  roleLabel: z.string().max(40).optional(),
});
export type CardData = z.input<typeof cardDataSchema>;

export const printBatchSchema = z.object({
  /** Idempotency key (brief §12). */
  idempotencyKey: uuid,
  templateId: uuid,
  items: z
    .array(
      z.object({
        memberId: uuid.nullable().optional(),
        userId: uuid.nullable().optional(),
        data: cardDataSchema,
        saveBack: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(1000),
});
export type PrintBatchInput = z.input<typeof printBatchSchema>;

export interface CardSizeDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  isBuiltin: boolean;
}

export interface CardTemplateDto {
  id: string;
  name: string;
  size: CardSizeDto;
  orientation: CardOrientation;
  layoutKey: CardLayoutKey;
  config: CardTemplateConfig;
  isDefault: boolean;
  logoId: string | null;
}

export interface LogoDto {
  id: string;
  name: string;
  fileId: string;
  url?: string;
  isDefault: boolean;
}

export interface CardPreviewSubjectDto {
  memberId?: string;
  userId?: string;
  data: CardData;
}

export interface CardPreviewDto {
  template: CardTemplateDto;
  subjects: CardPreviewSubjectDto[];
}

export interface PrintBatchDto {
  id: string;
  idempotencyKey: string;
  template: { id: string; name: string };
  printedBy: { id: string; fullName: string };
  printedAt: string;
  cardCount: number;
}

export interface PrintBatchItemDto {
  id: string;
  memberId: string | null;
  userId: string | null;
  /** As printed; the national ID is masked unless the template printed it in full. */
  data: CardData;
  savedBack: boolean;
}

export interface PrintBatchDetailDto extends PrintBatchDto {
  /** Template (size, orientation, layout, config) as it was at print time. */
  templateSnapshot: Record<string, unknown>;
  items: PrintBatchItemDto[];
}

// ---------------------------------------------------------------- settings (brief §10)

export const SETTINGS_SCHEMA = z.object({
  REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: z.boolean().default(true),
  SUPERVISORS_CAN_SEE_VIOLATIONS: z.boolean().default(false),
  ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR: z.boolean().default(true),
  VIOLATION_EDIT_WINDOW_MINUTES: z.number().int().min(0).max(1440).default(15),
  VIOLATION_MAX_PHOTOS: z.number().int().min(1).max(20).default(5),
  CLOCK_DRIFT_THRESHOLD_MINUTES: z.number().int().min(1).max(1440).default(10),
  PRESIGNED_URL_TTL_SECONDS: z.number().int().min(60).max(3600).default(300),
  VIOLATION_PHOTO_RETENTION_DAYS: z.number().int().min(0).max(36500).default(0),
  GPS_ACCURACY_WARN_METERS: z.number().int().min(5).max(5000).default(50),
});
export type Settings = z.infer<typeof SETTINGS_SCHEMA>;
export type SettingKey = keyof Settings;
export const DEFAULT_SETTINGS: Settings = SETTINGS_SCHEMA.parse({});
export const updateSettingsSchema = SETTINGS_SCHEMA.partial();

export const referenceItemSchema = z.object({ name: z.string().trim().min(2).max(120) });
export const updateReferenceItemSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
});
export interface ReferenceItemDto {
  id: string;
  name: string;
  /** Inactive items are hidden from pickers but kept on existing members. */
  isActive?: boolean;
}

export interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface AuditEntryDto {
  id: string;
  actor: { id: string; fullName: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  at: string;
}
