import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CARD_BASE_CSS,
  resolveCardDimensions,
  type CardTemplateLike,
} from '@nuzli/ui-print';
import type {
  CardData,
  CardLayoutKey,
  CardOrientation,
  CardSizeDto,
  CardTemplateDto,
  LogoDto,
} from '@nuzli/shared';

/** Base card CSS once per screen page (the print view injects it through `<PrintSheet>`). */
export function CardStyles() {
  return <style>{CARD_BASE_CSS}</style>;
}

/** Sample card data for template previews — clearly a sample, never a real person. */
export const SAMPLE_CARD: CardData = {
  fullName: 'عبدالله بن محمد المثال',
  jobTitle: 'فني صيانة',
  nationalId: '1000000008',
  department: 'التشغيل الميداني',
  teamName: 'فريق الصيانة الميدانية',
  teamColor: '#1D4ED8',
  qrValue: '00000000-0000-4000-8000-000000000000',
  validUntil: '2027-03-31',
};

export function toTemplateLike(tpl: Pick<CardTemplateDto, 'size' | 'orientation' | 'layoutKey' | 'config'>): CardTemplateLike {
  return { size: tpl.size, orientation: tpl.orientation, layoutKey: tpl.layoutKey, config: tpl.config };
}

/** The logo a template prints: its own, else the default logo. */
export function logoFor(tpl: { logoId: string | null } | null | undefined, logos: LogoDto[] | undefined) {
  if (!logos?.length) return null;
  const own = tpl?.logoId ? logos.find((l) => l.id === tpl.logoId) : undefined;
  return (own ?? logos.find((l) => l.isDefault) ?? null)?.url ?? null;
}

/**
 * The template as printed (batch snapshot). The API's snapshot carries size, orientation,
 * layout and config; if a field is missing we fall back to the live template.
 */
export function templateFromSnapshot(
  snapshot: Record<string, unknown> | undefined,
  live: CardTemplateDto | undefined,
): (CardTemplateLike & { logoId: string | null }) | null {
  const s = (snapshot ?? {}) as {
    size?: Partial<CardSizeDto> | null;
    widthMm?: number;
    heightMm?: number;
    orientation?: CardOrientation;
    layoutKey?: CardLayoutKey;
    config?: CardTemplateLike['config'];
    logoId?: string | null;
  };
  const widthMm = s.size?.widthMm ?? s.widthMm ?? live?.size.widthMm;
  const heightMm = s.size?.heightMm ?? s.heightMm ?? live?.size.heightMm;
  const orientation = s.orientation ?? live?.orientation;
  const layoutKey = s.layoutKey ?? live?.layoutKey;
  if (!widthMm || !heightMm || !orientation || !layoutKey) return null;
  return {
    size: { widthMm, heightMm },
    orientation,
    layoutKey,
    config: s.config ?? live?.config,
    logoId: s.logoId ?? live?.logoId ?? null,
  };
}

const PX_PER_MM = 96 / 25.4;

/**
 * Fits a mm-sized card into the available width on screen (phones) with CSS `zoom`, so the
 * card itself keeps its exact millimetre layout. Printing never goes through this wrapper.
 */
export function FitCard({
  template,
  children,
  max = 1,
}: {
  template: CardTemplateLike;
  children: ReactNode;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(max);
  const { widthMm, heightMm } = resolveCardDimensions(template.size, template.orientation);
  const cardPx = widthMm * PX_PER_MM;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setZoom(Math.min(max, w / cardPx));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cardPx, max]);
  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0 }}>
      <div
        style={{
          zoom,
          width: `${widthMm}mm`,
          height: `${heightMm}mm`,
          marginInline: 'auto',
          boxShadow: '0 1px 2px rgb(20 35 43 / .12), 0 4px 12px rgb(20 35 43 / .08)',
          borderRadius: 4,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Waits until the self-hosted fonts and every image on the page are ready (docs/printing.md). */
export async function waitForPrintAssets(root: ParentNode = document) {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    const loads = [
      '400 10pt "IBM Plex Sans Arabic"',
      '500 10pt "IBM Plex Sans Arabic"',
      '700 10pt "IBM Plex Sans Arabic"',
      '400 10pt "IBM Plex Mono"',
      '500 10pt "IBM Plex Mono"',
    ].map((f) => document.fonts.load(f, 'نزلي 0123').catch(() => []));
    await Promise.all(loads);
    await document.fonts.ready;
  }
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map((img) =>
      img.complete
        ? img.decode?.().catch(() => undefined)
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
    ),
  );
}
