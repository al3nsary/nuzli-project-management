import type { CSSProperties, ReactNode } from 'react';
import { CARD_LABELS, type CardModel } from './config';
import { BODY_LINE_HEIGHT, NAME_LINE_HEIGHT, type Frame, type RowKind, type RowSpec } from './plan';
import { qrMatrix, safeQrValue } from './qr';
import { MM_PER_PT, mm, num, pt } from './units';

export const FONT_STACK = '"IBM Plex Sans Arabic", "Noto Sans Arabic", Tahoma, sans-serif';
export const MONO_STACK = '"IBM Plex Mono", "IBM Plex Sans Arabic", ui-monospace, monospace';

const REFLECTIVE = 'rgba(255, 255, 255, 0.3)';

/**
 * The vest band (شريط السترة): the team colour crossed by two reflective lines at 30% white
 * (design system signature). `direction` is the axis the band runs along.
 */
export function vestBackground(color: string, along: 'block' | 'inline'): string {
  const to = along === 'block' ? 'to bottom' : 'to left';
  return (
    `linear-gradient(${to}, transparent 30%, ${REFLECTIVE} 30% 34%, transparent 34% 62%, ` +
    `${REFLECTIVE} 62% 66%, transparent 66%), ${color}`
  );
}

export function VestBand({ model, frame }: { model: CardModel; frame: Frame }) {
  if (!model.team || frame.band <= 0) return null;
  const strip = model.config.accentStrip;
  const style: CSSProperties =
    strip === 'start'
      ? { insetBlock: '0mm', insetInlineStart: '0mm', inlineSize: mm(frame.band), background: vestBackground(model.team.color, 'block') }
      : {
          insetInline: '0mm',
          ...(strip === 'top' ? { insetBlockStart: '0mm' } : { insetBlockEnd: '0mm' }),
          blockSize: mm(frame.band),
          background: vestBackground(model.team.color, 'inline'),
        };
  return <div className={`nz-band nz-band--${strip}`} data-team-color={model.team.color} aria-hidden="true" style={style} />;
}

/** The outer card: exact mm box, background/text colours, band, and the padded content box. */
export function CardShell({
  model,
  frame,
  layout,
  children,
}: {
  model: CardModel;
  frame: Frame;
  layout: string;
  children: ReactNode;
}) {
  const { widthMm, heightMm } = model.dims;
  return (
    <div
      className={`nz-card nz-card--${layout}`}
      dir="rtl"
      lang="ar"
      data-layout={layout}
      data-size={`${num(widthMm)}x${num(heightMm)}`}
      style={{
        width: mm(widthMm),
        height: mm(heightMm),
        background: model.config.background,
        color: model.config.textColor,
        fontFamily: FONT_STACK,
      }}
    >
      <VestBand model={model} frame={frame} />
      <div
        className="nz-content"
        style={{
          insetBlockStart: mm(frame.blockStart),
          insetBlockEnd: mm(frame.blockEnd),
          insetInlineStart: mm(frame.inlineStart),
          insetInlineEnd: mm(frame.inlineEnd),
          gap: mm(frame.gap),
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Logo({ url, heightMm, maxWidthMm }: { url: string; heightMm: number; maxWidthMm: number }) {
  return (
    <img
      className="nz-logo"
      src={url}
      alt={CARD_LABELS.logoAlt}
      style={{ height: mm(heightMm), maxWidth: mm(maxWidthMm), maxHeight: mm(heightMm) }}
    />
  );
}

export function LogoRow({
  model,
  heightMm,
  widthMm,
}: {
  model: CardModel;
  heightMm: number;
  widthMm: number;
}) {
  if (!model.logoUrl) return null;
  const justify = { start: 'flex-start', center: 'center', end: 'flex-end' }[model.config.logoPosition];
  return (
    <div className="nz-logo-row" data-logo-position={model.config.logoPosition} style={{ justifyContent: justify, height: mm(heightMm) }}>
      <Logo url={model.logoUrl} heightMm={heightMm} maxWidthMm={widthMm * 0.6} />
    </div>
  );
}

// ───────────────────────────────────────────── photo area (owner request A8)

/** Photo frame: 3:4 portrait (height = width × 4/3). */
export const PHOTO_ASPECT = 4 / 3;
// A9 identity (QA): the placeholder takes the Nozoly indigo tints instead of the old Muhsen green.
export const PHOTO_BORDER = '#C5CAE9';
export const PHOTO_FILL = '#E8EAF6';
export const PHOTO_INK = '#303F9F';
export const PHOTO_RADIUS_MM = 1;
export const PHOTO_BORDER_MM = 0.25;

/**
 * The photo area: the photo (`object-fit: cover`) in a thin framed box, or — without a photo —
 * the initials on a pale indigo field over a faint silhouette, never an empty hole.
 * `data-photo-mm` carries the box size for tests and print checks.
 */
export function PhotoArea({ model, widthMm, heightMm }: { model: CardModel; widthMm: number; heightMm: number }) {
  if (!model.showPhoto || widthMm <= 0 || heightMm <= 0) return null;
  // A10: a foreman's photo gets an indigo frame (the ribbon under the name carries the words).
  const foreman = Boolean(model.role?.foreman);
  const frame: CSSProperties = {
    width: mm(widthMm),
    height: mm(heightMm),
    border: foreman ? `${mm(PHOTO_BORDER_MM * 2)} solid ${FOREMAN_INK}` : `${mm(PHOTO_BORDER_MM)} solid ${PHOTO_BORDER}`,
    borderRadius: mm(PHOTO_RADIUS_MM),
    background: PHOTO_FILL,
  };
  const size = `${num(widthMm)}x${num(heightMm)}`;
  if (model.photoUrl) {
    return (
      <div className="nz-photo-frame" data-photo="image" data-photo-mm={size} style={frame}>
        <img
          className="nz-photo"
          src={model.photoUrl}
          alt={CARD_LABELS.photoAlt}
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }
  const initialsPt = Math.max(5, Math.min(widthMm * 0.36, heightMm * 0.3) / MM_PER_PT);
  return (
    <div
      className="nz-photo-frame nz-photo-placeholder"
      data-photo="placeholder"
      data-photo-mm={size}
      role="img"
      aria-label={CARD_LABELS.photoPlaceholder}
      style={{ ...frame, color: PHOTO_INK }}
    >
      <svg className="nz-photo-silhouette" viewBox="0 0 30 40" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
        <circle cx="15" cy="15" r="7" fill={PHOTO_INK} />
        <path d="M2 40c0-8.5 5.8-14 13-14s13 5.5 13 14z" fill={PHOTO_INK} />
      </svg>
      <span className="nz-initials" style={{ fontSize: pt(initialsPt) }}>
        {model.initials}
      </span>
    </div>
  );
}

/** Foreman indigo (Nozoly indigo 700) and its print-safe white text: contrast 8.6:1. */
export const FOREMAN_INK = '#303F9F';

/** A hard hat (helmet) glyph as inline SVG — no icon font, prints as vector. */
export function HelmetGlyph({ sizeMm, color = '#FFFFFF' }: { sizeMm: number; color?: string }) {
  return (
    <svg className="nz-helmet" viewBox="0 0 24 24" width={mm(sizeMm)} height={mm(sizeMm)} aria-hidden="true" style={{ width: mm(sizeMm), height: mm(sizeMm) }}>
      <path d="M3 17.2h18a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.8a1 1 0 0 1 1-1z" fill={color} />
      <path d="M4 16.2a8 8 0 0 1 5.6-7.63V12h1.6V6.3a.8.8 0 0 1 .8-.8h0a.8.8 0 0 1 .8.8V12h1.6V8.57A8 8 0 0 1 20 16.2z" fill={color} />
    </svg>
  );
}

/**
 * Owner request A10: the worker foreman ribbon — «مشرف عمّال» in white on indigo with a helmet,
 * one body line high, sized in mm/pt. The text label is always printed, so the marker never
 * depends on colour alone (monochrome Zebra ribbons still read it).
 */
export function ForemanRibbon({ label, sizePt, align = 'start' }: { label: string; sizePt: number; align?: 'start' | 'center' }) {
  const lineMm = sizePt * MM_PER_PT * BODY_LINE_HEIGHT;
  const glyph = sizePt * MM_PER_PT * 1.05;
  return (
    <div className="nz-row nz-row--role" data-field="role" data-foreman="true" style={{ justifyContent: align === 'center' ? 'center' : 'flex-start', blockSize: mm(lineMm) }}>
      <span
        className="nz-role"
        style={{
          fontSize: pt(sizePt * 0.92),
          background: FOREMAN_INK,
          color: '#FFFFFF',
          border: `${mm(0.2)} solid ${FOREMAN_INK}`,
          borderRadius: mm(lineMm * 0.22),
          paddingInline: mm(lineMm * 0.28),
          gap: mm(lineMm * 0.18),
          blockSize: mm(lineMm * 0.92),
        }}
      >
        <HelmetGlyph sizeMm={glyph} />
        <span className="nz-role-text">{label}</span>
      </span>
    </div>
  );
}

/** The QR code: a pre-rendered PNG when given, otherwise a vector SVG built synchronously. */
export function QrCode({ model, sizeMm }: { model: CardModel; sizeMm: number }) {
  if (sizeMm <= 0) return null;
  const box = { width: mm(sizeMm), height: mm(sizeMm) };
  if (model.qrDataUrl) {
    return <img className="nz-qr" src={model.qrDataUrl} alt={CARD_LABELS.qrAlt} style={box} />;
  }
  const value = safeQrValue(model.qrValue);
  if (!value) return null;
  const { size, path } = qrMatrix(value);
  return (
    <svg
      className="nz-qr"
      role="img"
      aria-label={CARD_LABELS.qrAlt}
      viewBox={`0 0 ${size} ${size}`}
      width={mm(sizeMm)}
      height={mm(sizeMm)}
      shapeRendering="crispEdges"
      style={box}
    >
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** Whether the card will actually show a QR (so layouts don't reserve space for nothing). */
export function hasQr(model: CardModel): boolean {
  return Boolean(model.qrDataUrl || safeQrValue(model.qrValue));
}

export function NameBlock({
  name,
  sizePt,
  lines,
  align = 'start',
}: {
  name: string;
  sizePt: number;
  lines: number;
  align?: 'start' | 'center';
}) {
  return (
    <div
      className="nz-name"
      style={{ fontSize: pt(sizePt), lineHeight: NAME_LINE_HEIGHT, WebkitLineClamp: lines, textAlign: align }}
    >
      {name}
    </div>
  );
}

const DISPLAY_ORDER: RowKind[] = ['role', 'jobTitle', 'nationalId', 'department', 'team', 'validUntil'];

export function sortForDisplay(rows: RowSpec[], order: RowKind[] = DISPLAY_ORDER): RowSpec[] {
  return [...rows].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function FieldRow({
  row,
  sizePt,
  model,
  align = 'start',
}: {
  row: RowSpec;
  sizePt: number;
  model: CardModel;
  align?: 'start' | 'center';
}) {
  const style: CSSProperties = { fontSize: pt(sizePt), lineHeight: BODY_LINE_HEIGHT, textAlign: align };
  if (row.kind === 'role' && model.role) return <ForemanRibbon label={row.value} sizePt={sizePt} align={align} />;
  if (row.kind === 'team' && model.team) {
    const swatchH = sizePt * 0.3528 * 1.05;
    return (
      <div className={`nz-row nz-row--team`} data-field="team" style={{ ...style, justifyContent: align === 'center' ? 'center' : 'flex-start' }}>
        <span
          className="nz-swatch"
          aria-hidden="true"
          style={{
            width: mm(swatchH * 0.75),
            height: mm(swatchH),
            background: vestBackground(model.team.color, 'block'),
            borderRadius: mm(swatchH * 0.12),
          }}
        />
        <span className="nz-ellipsis nz-team-name">{row.value}</span>
      </div>
    );
  }
  const isId = row.kind === 'nationalId';
  return (
    <div className={`nz-row nz-row--${row.kind} nz-ellipsis`} data-field={row.kind} style={style}>
      {row.label ? <span className="nz-label">{row.label}: </span> : null}
      {isId ? (
        <bdi className="nz-mono" dir="ltr">
          {row.value}
        </bdi>
      ) : (
        <span className={row.kind === 'jobTitle' ? 'nz-job' : undefined}>{row.value}</span>
      )}
    </div>
  );
}
