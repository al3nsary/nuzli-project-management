import type { CardData } from '@nuzli/shared';
import { buildCardModel, type CardModel, type CardTemplateLike } from './config';
import { ClassicHorizontal } from './layouts/ClassicHorizontal';
import { CompactLabel } from './layouts/CompactLabel';
import { VerticalBadge } from './layouts/VerticalBadge';

export interface WorkCardProps {
  template: CardTemplateLike;
  data: CardData;
  logoUrl?: string | null;
  photoUrl?: string | null;
  /** Pre-rendered PNG from `makeQrDataUrl`; without it the QR is drawn as vector SVG from `data.qrValue`. */
  qrDataUrl?: string | null;
}

export const LAYOUTS = {
  CLASSIC_HORIZONTAL: ClassicHorizontal,
  VERTICAL_BADGE: VerticalBadge,
  COMPACT_LABEL: CompactLabel,
} as const satisfies Record<CardTemplateLike['layoutKey'], (p: { model: CardModel }) => JSX.Element>;

/** Renders one work card with the template's layout, size and orientation (brief §8). */
export function WorkCard({ template, data, logoUrl, photoUrl, qrDataUrl }: WorkCardProps) {
  const model = buildCardModel(template, data, { logoUrl, photoUrl, qrDataUrl });
  const Layout = LAYOUTS[template.layoutKey] ?? ClassicHorizontal;
  return <Layout model={model} />;
}
