import type { Prisma } from '@prisma/client';
import {
  cardDataSchema,
  cardTemplateConfigSchema,
  maskNationalId,
  maskNationalIdParts,
  type CardData,
  type CardSizeDto,
  type CardTemplateConfig,
  type CardTemplateDto,
  type NationalIdPrinted,
} from '@nuzli/shared';
import type { CryptoService } from '../crypto/crypto.service';
import { memberDepartment, memberJobTitle, type MemberRow } from '../teams/team-dto';

export const DEFAULT_TEAM_COLOR = '#1D5C63';
export const SUPERVISOR_ROLE_LABEL = 'مشرف الفريق';

/** Stored configs are re-validated on read; a broken row falls back to the defaults. */
export function parseConfig(value: Prisma.JsonValue | unknown): CardTemplateConfig {
  const parsed = cardTemplateConfigSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : cardTemplateConfigSchema.parse({});
}

type Dec = { toString(): string } | number;
const num = (v: Dec) => Number(typeof v === 'number' ? v : v.toString());

export function toSizeDto(s: { id: string; name: string; widthMm: Dec; heightMm: Dec; isBuiltin: boolean }): CardSizeDto {
  return { id: s.id, name: s.name, widthMm: num(s.widthMm), heightMm: num(s.heightMm), isBuiltin: s.isBuiltin };
}

export const TEMPLATE_SELECT = {
  id: true,
  name: true,
  orientation: true,
  layoutKey: true,
  config: true,
  isDefault: true,
  logoId: true,
  archivedAt: true,
  size: { select: { id: true, name: true, widthMm: true, heightMm: true, isBuiltin: true } },
} satisfies Prisma.CardTemplateSelect;

export type TemplateRow = Prisma.CardTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

export function toTemplateDto(t: TemplateRow): CardTemplateDto {
  return {
    id: t.id,
    name: t.name,
    size: toSizeDto(t.size),
    orientation: t.orientation,
    layoutKey: t.layoutKey,
    config: parseConfig(t.config),
    isDefault: t.isDefault,
    logoId: t.logoId,
  };
}

/** Template as printed (kept on the batch so later template edits never rewrite the log). */
export function templateSnapshot(t: TemplateRow): Record<string, unknown> {
  const dto = toTemplateDto(t);
  return { ...dto, capturedAt: new Date().toISOString() };
}

/**
 * Brief §8.2 / §13: the card shows the full national ID only when the template says so
 * (`maskNationalId = false`); otherwise the masked form. A hidden field carries nothing.
 */
export function cardNationalId(
  config: CardTemplateConfig,
  parts: { first: string; last: string },
  decrypt: () => string,
): string {
  if (!config.fields.nationalId) return '';
  if (config.maskNationalId) return maskNationalIdParts(parts.first, parts.last);
  return decrypt();
}

/** Whether this template prints the full national ID (brief §8.2). */
export function nationalIdPrintedFor(config: CardTemplateConfig): NationalIdPrinted {
  return config.fields.nationalId && !config.maskNationalId ? 'FULL' : 'MASKED';
}

/**
 * What is persisted in `card_print_items.rendered_data` (security review M2): the national ID
 * is ALWAYS masked; `national_id_printed` records whether the card carried it in full, and the
 * full value is decrypted from `team_members` / `users` only when a print run needs it.
 */
export function storedCardData(data: CardData): CardData {
  const parsed = cardDataSchema.parse(data);
  return { ...parsed, nationalId: parsed.nationalId ? maskNationalId(parsed.nationalId) : '' };
}

export interface CardTeam {
  name: string;
  hex: string;
}

export function memberCard(
  m: MemberRow,
  team: CardTeam | null,
  config: CardTemplateConfig,
  crypto: CryptoService,
): CardData {
  return {
    fullName: m.fullName,
    jobTitle: config.fields.jobTitle ? (memberJobTitle(m) ?? '') : '',
    nationalId: cardNationalId(config, { first: m.nationalIdFirst, last: m.nationalIdLast4 }, () =>
      crypto.decrypt(m.nationalIdEnc),
    ),
    department: config.fields.department ? (memberDepartment(m) ?? '') : '',
    teamName: config.fields.teamName ? (team?.name ?? '') : '',
    teamColor: team?.hex ?? DEFAULT_TEAM_COLOR,
    qrValue: m.id, // internal UUID — never the national ID (brief §8.2)
    photoFileId: config.fields.photo ? m.photoFileId : null,
    ...(config.fields.validUntil && config.validUntil ? { validUntil: config.validUntil } : {}),
  };
}

export interface SupervisorRow {
  id: string;
  fullName: string;
  nationalIdEnc: Uint8Array;
  nationalIdFirst: string;
  nationalIdLast2: string;
  /** The supervisor's own profile photo (owner request A8). */
  photoFileId?: string | null;
}

export function supervisorCard(
  u: SupervisorRow,
  team: CardTeam | null,
  config: CardTemplateConfig,
  crypto: CryptoService,
): CardData {
  return {
    fullName: u.fullName,
    jobTitle: config.fields.jobTitle ? SUPERVISOR_ROLE_LABEL : '',
    nationalId: cardNationalId(config, { first: u.nationalIdFirst, last: u.nationalIdLast2 }, () =>
      crypto.decrypt(u.nationalIdEnc),
    ),
    department: '',
    teamName: config.fields.teamName ? (team?.name ?? '') : '',
    teamColor: team?.hex ?? DEFAULT_TEAM_COLOR,
    qrValue: u.id,
    photoFileId: config.fields.photo ? (u.photoFileId ?? null) : null,
    roleLabel: SUPERVISOR_ROLE_LABEL,
    ...(config.fields.validUntil && config.validUntil ? { validUntil: config.validUntil } : {}),
  };
}
