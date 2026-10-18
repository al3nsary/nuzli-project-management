import type { CSSProperties } from 'react';
import { t } from '../i18n';

/*
 * The real logos (owner requests A7 and A9, apps/web/public/brand/README.md). They are shown as
 * the original files — never recoloured, stretched or redrawn — so every <img> keeps its aspect
 * ratio. A9: Nozoly is the identity (white + indigo); the Muhsen mark is secondary («منظومة
 * مُحسن» in footers). Placement: design skill, "Logos".
 */

export type BrandFile =
  | 'muhsen-mark-white.png'
  | 'muhsen-mark.png'
  | 'muhsen-lockup-white.png'
  | 'muhsen-pattern.png'
  | 'nozoly-light.png'
  | 'nozoly-green.png';

/** Public URL of a brand file under the app base (`/` or the GitHub Pages path). */
export function brandUrl(file: BrandFile): string {
  const base = (import.meta.env.BASE_URL as string | undefined) || '/';
  return `${base.endsWith('/') ? base : base + '/'}brand/${file}`;
}

/*
 * nozoly-green.png and nozoly-light.png are 540×156 with transparent margins; the artwork
 * occupies x 14–415, y 44–141 (measured with pngjs), and the mark alone x 14–168. The logo box
 * shows exactly the artwork (the file is placed, not edited), so `width` is the visible width.
 */
const FILE = { w: 540, h: 156 };
const ART = { x: 14, y: 44, w: 402, h: 98 };
const MARK_W = 156;

/**
 * The Nozoly logo at a given visible width: green on light surfaces, the light file in dark mode.
 * `mark` shows the mark part only (the mini rail), from the same file.
 */
export function NozolyLogo({
  width = 120,
  mark = false,
  className,
  decorative = false,
}: {
  width?: number;
  mark?: boolean;
  className?: string;
  /** Next to the visible brand name: hidden from screen readers. */
  decorative?: boolean;
}) {
  const scale = width / (mark ? MARK_W : ART.w);
  const height = Math.round(ART.h * scale);
  const img: CSSProperties = {
    width: Math.round(FILE.w * scale),
    height: Math.round(FILE.h * scale),
    left: -Math.round(ART.x * scale),
    top: -Math.round(ART.y * scale),
  };
  return (
    <span
      className={['nz-logo', className].filter(Boolean).join(' ')}
      style={{ width, height }}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : t('brand.nozolyLogo')}
      aria-hidden={decorative || undefined}
    >
      <img className="nz-logo-day" src={brandUrl('nozoly-green.png')} alt="" style={img} draggable={false} />
      <img className="nz-logo-night" src={brandUrl('nozoly-light.png')} alt="" style={img} draggable={false} />
    </span>
  );
}

/** «منظومة مُحسن» with the small Muhsen mark — secondary since A9 (footers only). */
export function MuhsenSystemLine({ mini = false, className }: { mini?: boolean; className?: string }) {
  return (
    <div className={['nz-system', className].filter(Boolean).join(' ')}>
      <img className="nz-logo-day" src={brandUrl('muhsen-mark.png')} alt={t('brand.muhsenLogo')} width={20} height={16} draggable={false} />
      <img className="nz-logo-night" src={brandUrl('muhsen-mark-white.png')} alt={t('brand.muhsenLogo')} width={20} height={16} draggable={false} />
      {mini ? null : <span>{t('brand.system')}</span>}
    </div>
  );
}
