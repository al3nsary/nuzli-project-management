// @nuzli/ui-print — work-card templates and print helpers (brief §8, ADR-018).
// Fonts are not bundled: the host app self-hosts IBM Plex Sans Arabic and IBM Plex Mono.
export { BUILTIN_CARD_SIZES, DEFAULT_CARD_SIZE, resolveCardDimensions } from './sizes';
export type { BuiltinCardSize, BuiltinCardSizeKey, CardDimensions } from './sizes';

export { buildCardModel, resolveConfig, formatValidity, DEFAULT_CARD_CONFIG, CARD_LABELS } from './config';
export type { CardTemplateLike, CardTemplateConfigInput, CardModel, CardAssets } from './config';

export { fitFontPt, estimateTextWidthMm } from './fit';
export { planText, computeFrame } from './plan';
export type { TextPlan, RowSpec, RowKind, Frame } from './plan';

export { makeQrDataUrl, assertSafeQrValue, isNationalIdLike, safeQrValue, qrMatrix } from './qr';

export { ClassicHorizontal } from './layouts/ClassicHorizontal';
export { VerticalBadge } from './layouts/VerticalBadge';
export { CompactLabel } from './layouts/CompactLabel';
export { WorkCard, LAYOUTS } from './WorkCard';
export type { WorkCardProps } from './WorkCard';
export { VestBand, vestBackground, FONT_STACK, MONO_STACK } from './parts';

export { PrintSheet, withQrDataUrls } from './PrintSheet';
export type { PrintSheetProps, PrintCardItem } from './PrintSheet';
export { printCss, CARD_BASE_CSS } from './print-css';
export { CalibrationCard } from './CalibrationCard';
export type { CalibrationCardProps } from './CalibrationCard';
export { mm, pt, MM_PER_PT } from './units';
