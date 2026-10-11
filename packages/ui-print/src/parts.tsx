import type { CSSProperties, ReactNode } from 'react';
import { CARD_LABELS, type CardModel } from './config';
import { BODY_LINE_HEIGHT, NAME_LINE_HEIGHT, type Frame, type RowKind, type RowSpec } from './plan';
import { qrMatrix, safeQrValue } from './qr';
import { mm, num, pt } from './units';

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

export function Photo({ url, widthMm, heightMm }: { url: string; widthMm: number; heightMm: number }) {
  return (
    <img
      className="nz-photo"
      src={url}
      alt={CARD_LABELS.photoAlt}
      style={{ width: mm(widthMm), height: mm(heightMm), borderRadius: mm(Math.min(widthMm, heightMm) * 0.06) }}
    />
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

const DISPLAY_ORDER: RowKind[] = ['jobTitle', 'nationalId', 'department', 'team', 'validUntil'];

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
