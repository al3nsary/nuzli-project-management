// @nuzli/ui-print — work-card templates and print helpers (brief §8, ADR-018).
// Fonts are not bundled: the host app self-hosts IBM Plex Sans Arabic and IBM Plex Mono.
export { BUILTIN_CARD_SIZES, DEFAULT_CARD_SIZE, resolveCardDimensions } from './sizes';
export type { BuiltinCardSize, BuiltinCardSizeKey, CardDimensions } from './sizes';

export { buildCardModel, resolveConfig, formatValidity, cardInitials, cardRole, DEFAULT_CARD_CONFIG, CARD_LABELS, FOREMAN_LABEL } from './config';
export type { CardTemplateLike, CardTemplateConfigInput, CardModel, CardAssets } from './config';

export { fitFontPt, estimateTextWidthMm } from './fit';
export { planText, computeFrame } from './plan';
export type { TextPlan, RowSpec, RowKind, Frame } from './plan';

export { makeQrDataUrl, assertSafeQrValue, isNationalIdLike, safeQrValue, qrMatrix } from './qr';

export { ClassicHorizontal, CLASSIC_PHOTO_W_MM, CLASSIC_PHOTO_MIN_W_MM } from './layouts/ClassicHorizontal';
export { VerticalBadge, BADGE_PHOTO_H_MM, BADGE_PHOTO_MIN_H_MM, BADGE_QR_MIN_MM } from './layouts/VerticalBadge';
export { CompactLabel, COMPACT_PHOTO_H_MM, COMPACT_PHOTO_MIN_H_MM } from './layouts/CompactLabel';
export { WorkCard, LAYOUTS } from './WorkCard';
export type { WorkCardProps } from './WorkCard';
export { VestBand, vestBackground, FONT_STACK, MONO_STACK, PhotoArea, PHOTO_ASPECT, PHOTO_BORDER, PHOTO_FILL, PHOTO_INK, ForemanRibbon, HelmetGlyph, FOREMAN_INK } from './parts';
export { waitForCardImages, CARD_IMAGES_TIMEOUT_MS } from './images';
export type { CardImagesResult } from './images';

export { PrintSheet, withQrDataUrls } from './PrintSheet';
export type { PrintSheetProps, PrintCardItem } from './PrintSheet';
export { printCss, CARD_BASE_CSS } from './print-css';
export { CalibrationCard } from './CalibrationCard';
export type { CalibrationCardProps } from './CalibrationCard';
export { mm, pt, MM_PER_PT } from './units';
