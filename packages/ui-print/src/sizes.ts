import type { CardOrientation, CardSizeDto } from '@nuzli/shared';

export interface CardDimensions {
  widthMm: number;
  heightMm: number;
}

export type BuiltinCardSizeKey = 'CR80' | 'W90_H40' | 'IN4_IN2' | 'IN3_IN2' | 'IN4_IN3' | 'IN225_IN125';

export interface BuiltinCardSize extends CardDimensions {
  key: BuiltinCardSizeKey;
  /** Arabic display name (brief §8.3). */
  name: string;
  isDefault: boolean;
}

/** The six presets of brief §8.3, landscape (long side = width). CR80 is the default. */
export const BUILTIN_CARD_SIZES: readonly BuiltinCardSize[] = Object.freeze([
  { key: 'CR80', name: 'CR80 — بطاقة هوية قياسية (افتراضي)', widthMm: 85.6, heightMm: 54, isDefault: true },
  { key: 'W90_H40', name: '90 × 40 — المقاس المطلوب أصلًا', widthMm: 90, heightMm: 40, isDefault: false },
  { key: 'IN4_IN2', name: '4″ × 2″ — ملصق زيبرا شائع', widthMm: 101.6, heightMm: 50.8, isDefault: false },
  { key: 'IN3_IN2', name: '3″ × 2″ — ملصق زيبرا شائع', widthMm: 76.2, heightMm: 50.8, isDefault: false },
  { key: 'IN4_IN3', name: '4″ × 3″ — بطاقة كبيرة', widthMm: 101.6, heightMm: 76.2, isDefault: false },
  { key: 'IN225_IN125', name: '2.25″ × 1.25″ — ملصق صغير', widthMm: 57, heightMm: 32, isDefault: false },
] as BuiltinCardSize[]);

export const DEFAULT_CARD_SIZE: BuiltinCardSize = BUILTIN_CARD_SIZES.find((s) => s.isDefault)!;

/**
 * Page/card dimensions for a size and orientation.
 * Sizes are normalised first (long side = width), so LANDSCAPE is always wide and
 * PORTRAIT swaps to tall — a custom size entered as 54 × 85.6 behaves like CR80.
 */
export function resolveCardDimensions(
  size: Pick<CardSizeDto, 'widthMm' | 'heightMm'>,
  orientation: CardOrientation = 'LANDSCAPE',
): CardDimensions {
  const long = Math.max(size.widthMm, size.heightMm);
  const short = Math.min(size.widthMm, size.heightMm);
  return orientation === 'PORTRAIT' ? { widthMm: short, heightMm: long } : { widthMm: long, heightMm: short };
}
