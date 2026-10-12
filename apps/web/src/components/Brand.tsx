import type { CSSProperties } from 'react';
import { t } from '../i18n';

/*
 * The two real logos (owner request A7, apps/web/public/brand/README.md). They are shown as
 * files — never recoloured, stretched, cropped or redrawn — so every <img> keeps its aspect
 * ratio (`height: auto` or `object-fit: contain`). Placement: design skill, "Logos".
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

/** The Muhsen "M" in its gold tile (sidebar head, 42×42, radius 13). */
export function MuhsenMarkTile({ size = 42 }: { size?: number }) {
  const inner = Math.round(size * (23 / 42));
  return (
    <span className="nz-mark" style={{ width: size, height: size }}>
      <img
        src={brandUrl('muhsen-mark-white.png')}
        alt={t('brand.muhsenLogo')}
        width={inner}
        height={inner}
        style={{ width: inner, height: inner, objectFit: 'contain' }}
        draggable={false}
      />
    </span>
  );
}

/** «تطوير نُزلي» with the Nozoly logo: light variant on green, green variant on light surfaces. */
export function NozolyCredit({
  variant,
  width = 96,
  className,
  style,
}: {
  variant: 'light' | 'green';
  width?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={['nz-credit', className].filter(Boolean).join(' ')} style={style}>
      <img
        src={brandUrl(variant === 'light' ? 'nozoly-light.png' : 'nozoly-green.png')}
        alt={t('brand.nozolyLogo')}
        width={width}
        style={{ width, height: 'auto' }}
        draggable={false}
      />
      <span>{t('brand.developedBy')}</span>
    </div>
  );
}
