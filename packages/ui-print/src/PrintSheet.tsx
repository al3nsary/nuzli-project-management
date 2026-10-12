import type { CardData } from '@nuzli/shared';
import type { CardTemplateLike } from './config';
import { CARD_BASE_CSS, printCss } from './print-css';
import { makeQrDataUrl, safeQrValue } from './qr';
import { resolveCardDimensions } from './sizes';
import { WorkCard } from './WorkCard';

export interface PrintCardItem {
  /** Stable React key (member/user id); falls back to the index. */
  key?: string;
  data: CardData;
  photoUrl?: string | null;
  qrDataUrl?: string | null;
}

export interface PrintSheetProps {
  template: CardTemplateLike;
  cards: PrintCardItem[];
  logoUrl?: string | null;
  /** Inject the page and base CSS (default). Turn off only if the host page already includes them. */
  includeStyles?: boolean;
}

/**
 * The print page: one card per physical page at exactly the template size, `@page` margin 0.
 * Render it on its own route/window and call `window.print()` once fonts and images have loaded
 * (`await document.fonts.ready; await waitForCardImages(sheetElement)`).
 */
export function PrintSheet({ template, cards, logoUrl, includeStyles = true }: PrintSheetProps) {
  const { widthMm, heightMm } = resolveCardDimensions(template.size, template.orientation);
  return (
    <div className="nz-sheet" dir="rtl" lang="ar">
      {includeStyles ? <style>{`${CARD_BASE_CSS}\n${printCss(widthMm, heightMm)}`}</style> : null}
      {cards.map((card, index) => (
        <WorkCard
          key={card.key ?? index}
          template={template}
          data={card.data}
          logoUrl={logoUrl}
          photoUrl={card.photoUrl}
          qrDataUrl={card.qrDataUrl}
        />
      ))}
    </div>
  );
}

/** Fills `qrDataUrl` (PNG) for every card with a safe `qrValue`; other cards are returned unchanged. */
export async function withQrDataUrls(cards: PrintCardItem[]): Promise<PrintCardItem[]> {
  return Promise.all(
    cards.map(async (card) => {
      if (card.qrDataUrl) return card;
      const value = safeQrValue(card.data.qrValue);
      return value ? { ...card, qrDataUrl: await makeQrDataUrl(value) } : card;
    }),
  );
}
