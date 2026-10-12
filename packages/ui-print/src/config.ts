import {
  cardTemplateConfigSchema,
  maskNationalId,
  toWesternDigits,
  type CardData,
  type CardLayoutKey,
  type CardOrientation,
  type CardSizeDto,
  type CardTemplateConfig,
} from '@nuzli/shared';
import { resolveCardDimensions, type CardDimensions } from './sizes';

/** Anything shaped like `CardTemplateDto`; `config` may be partial (defaults are filled in). */
export interface CardTemplateLike {
  size: Pick<CardSizeDto, 'widthMm' | 'heightMm'> & Partial<Pick<CardSizeDto, 'name'>>;
  orientation: CardOrientation;
  layoutKey: CardLayoutKey;
  config?: CardTemplateConfigInput;
}

export type CardTemplateConfigInput = Partial<Omit<CardTemplateConfig, 'fields' | 'fontSizes'>> & {
  fields?: Partial<CardTemplateConfig['fields']>;
  fontSizes?: Partial<CardTemplateConfig['fontSizes']>;
};

export const DEFAULT_CARD_CONFIG: CardTemplateConfig = cardTemplateConfigSchema.parse({});

const HEX = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_TEAM_COLOR = '#1D5C63';

/** Fills defaults; an invalid value falls back to its default instead of failing the whole card. */
export function resolveConfig(input?: CardTemplateConfigInput): CardTemplateConfig {
  const parsed = cardTemplateConfigSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const d = DEFAULT_CARD_CONFIG;
  const i = input ?? {};
  return {
    ...d,
    fields: { ...d.fields, ...pickBooleans(i.fields) },
    maskNationalId: typeof i.maskNationalId === 'boolean' ? i.maskNationalId : d.maskNationalId,
    logoPosition: i.logoPosition && ['start', 'end', 'center'].includes(i.logoPosition) ? i.logoPosition : d.logoPosition,
    fontSizes: {
      name: validNumber(i.fontSizes?.name, 5, 30) ?? d.fontSizes.name,
      body: validNumber(i.fontSizes?.body, 4, 20) ?? d.fontSizes.body,
    },
    accentStrip: i.accentStrip && ['start', 'top', 'bottom'].includes(i.accentStrip) ? i.accentStrip : d.accentStrip,
    background: i.background && HEX.test(i.background) ? i.background : d.background,
    textColor: i.textColor && HEX.test(i.textColor) ? i.textColor : d.textColor,
    validUntil: i.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(i.validUntil) ? i.validUntil : undefined,
  };
}

function pickBooleans<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'boolean') (out as Record<string, boolean>)[k] = v;
  return out;
}

function validNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** Everything a layout needs, already decided: which fields show, masked ID, formatted date. */
export interface CardModel {
  dims: CardDimensions;
  config: CardTemplateConfig;
  fullName: string;
  jobTitle: string | null;
  nationalId: string | null;
  department: string | null;
  /** Team name and colour travel together: never a colour without its name (design rule). */
  team: { name: string; color: string } | null;
  validUntil: string | null;
  qrValue: string | null;
  logoUrl: string | null;
  /** The photo to print; null with `showPhoto` → the initials placeholder. */
  photoUrl: string | null;
  /** `fields.photo`: the layout reserves a photo area (owner request A8), with or without a photo. */
  showPhoto: boolean;
  /** Placeholder text: first letters of the first and last name (`cardInitials`). */
  initials: string;
  qrDataUrl: string | null;
}

export interface CardAssets {
  logoUrl?: string | null;
  photoUrl?: string | null;
  qrDataUrl?: string | null;
}

export function buildCardModel(template: CardTemplateLike, data: CardData, assets: CardAssets = {}): CardModel {
  const config = resolveConfig(template.config);
  const f = config.fields;
  const text = (v: string | null | undefined) => (v ?? '').trim();

  const rawId = toWesternDigits(text(data.nationalId));
  const nationalId = f.nationalId && rawId ? (config.maskNationalId ? maskNationalId(rawId) : rawId) : null;

  const teamName = text(data.teamName);
  const teamColor = data.teamColor && HEX.test(data.teamColor) ? data.teamColor : DEFAULT_TEAM_COLOR;

  const validIso = text(data.validUntil) || config.validUntil || '';

  return {
    dims: resolveCardDimensions(template.size, template.orientation),
    config,
    fullName: text(data.fullName),
    jobTitle: f.jobTitle && text(data.jobTitle) ? text(data.jobTitle) : null,
    nationalId,
    department: f.department && text(data.department) ? text(data.department) : null,
    team: f.teamName && teamName ? { name: teamName, color: teamColor } : null,
    validUntil: f.validUntil && validIso ? formatValidity(validIso) : null,
    qrValue: f.qr ? text(data.qrValue) || null : null,
    logoUrl: f.logo && assets.logoUrl ? assets.logoUrl : null,
    photoUrl: f.photo && assets.photoUrl ? assets.photoUrl : null,
    showPhoto: f.photo,
    initials: cardInitials(text(data.fullName)),
    qrDataUrl: f.qr && assets.qrDataUrl ? assets.qrDataUrl : null,
  };
}

/** Arabic name particles that never give an initial. */
const PARTICLES = new Set(['بن', 'بنت', 'ابن', 'آل', 'ال', 'أبو', 'ابو', 'bin', 'bint', 'al']);
/** Zero-width non-joiner: keeps two Arabic initials from joining into a word. */
const ZWNJ = '\u200C';

function initialOf(word: string): string {
  // «القحطاني» → «ق», «الشمري» → «ش»: the article is not the name. «عبدالله» keeps «ع».
  const w = /^(ال|al-)/i.test(word) && [...word].length > 3 ? word.replace(/^(ال|al-)/i, '') : word;
  const ch = [...w].find((c) => /\p{L}/u.test(c)) ?? '';
  return ch.toLocaleUpperCase('ar');
}

/**
 * Initials for the photo placeholder: the first letters of the first and the last name,
 * e.g. «محمد بن عبدالرحمن القحطاني» → «م‌ق» (two letters kept apart by a ZWNJ).
 */
export function cardInitials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter((w) => w && !PARTICLES.has(w.toLowerCase()));
  if (!words.length) return '';
  const first = initialOf(words[0]!);
  const last = words.length > 1 ? initialOf(words[words.length - 1]!) : '';
  return last ? `${first}${ZWNJ}${last}` : first;
}

/** `2027-03-31` → `31 مارس 2027` (Gregorian, Western digits — brief / RTL skill defaults). */
export function formatValidity(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
}

/** Arabic labels printed on cards. */
export const CARD_LABELS = {
  nationalId: 'رقم الهوية',
  department: 'القسم',
  jobTitle: 'المسمى',
  team: 'الفريق',
  validUntil: 'صالحة حتى',
  logoAlt: 'الشعار',
  photoAlt: 'الصورة الشخصية',
  photoPlaceholder: 'لا توجد صورة',
  qrAlt: 'رمز التحقق',
} as const;
