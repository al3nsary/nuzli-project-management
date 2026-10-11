import type { CardOrientation, CardSizeDto } from '@nuzli/shared';
import { FONT_STACK, MONO_STACK } from './parts';
import { CARD_BASE_CSS, printCss } from './print-css';
import { resolveCardDimensions } from './sizes';
import { mm, num, pt } from './units';

export interface CalibrationCardProps {
  size: Pick<CardSizeDto, 'widthMm' | 'heightMm'> & Partial<Pick<CardSizeDto, 'name'>>;
  orientation?: CardOrientation;
  /** Inject `@page` + base CSS so this renders as a standalone test page (default true). */
  includeStyles?: boolean;
}

const INK = '#14232B';
const STROKE = 0.2;

/**
 * Calibration / test print (brief §8.5): a border on the exact page edge, 5 mm / 10 mm rulers on
 * both axes, a centre crosshair, a 2 mm safe-area outline, the size in mm, and Arabic + Latin
 * sample text. Measure it with a ruler to check the driver's media size, margins and 100% scale.
 * The SVG uses a viewBox in millimetres (1 user unit = 1 mm).
 */
export function CalibrationCard({ size, orientation = 'LANDSCAPE', includeStyles = true }: CalibrationCardProps) {
  const { widthMm: w, heightMm: h } = resolveCardDimensions(size, orientation);
  const cx = w / 2;
  const cy = h / 2;
  const ticks: JSX.Element[] = [];
  // Physical coordinates on purpose: a ruler measures paper, it does not mirror in RTL.
  for (let x = 5; x < w; x += 5) {
    const long = x % 10 === 0;
    const len = long ? 3 : 1.6;
    ticks.push(<line key={`t${x}`} data-role="tick-x" x1={x} y1={0} x2={x} y2={len} />);
    ticks.push(<line key={`b${x}`} x1={x} y1={h} x2={x} y2={num(h - len)} />);
    if (long) {
      ticks.push(
        <text key={`tl${x}`} x={x} y={len + 1.8} fontSize={1.6} textAnchor="middle" stroke="none" fill={INK}>
          {x}
        </text>,
      );
    }
  }
  for (let y = 5; y < h; y += 5) {
    const long = y % 10 === 0;
    const len = long ? 3 : 1.6;
    ticks.push(<line key={`l${y}`} data-role="tick-y" x1={0} y1={y} x2={len} y2={y} />);
    ticks.push(<line key={`r${y}`} x1={w} y1={y} x2={num(w - len)} y2={y} />);
    if (long) {
      ticks.push(
        <text key={`ll${y}`} x={len + 0.6} y={y + 0.55} fontSize={1.6} stroke="none" fill={INK}>
          {y}
        </text>,
      );
    }
  }
  const textPt = Math.max(4.5, Math.min(9, Math.min(w, h) / 6));

  return (
    <div className="nz-sheet" dir="rtl" lang="ar">
      {includeStyles ? <style>{`${CARD_BASE_CSS}\n${printCss(w, h)}`}</style> : null}
      <div
        className="nz-card nz-calibration"
        dir="rtl"
        lang="ar"
        data-size={`${num(w)}x${num(h)}`}
        style={{ width: mm(w), height: mm(h), background: '#FFFFFF', color: INK, fontFamily: FONT_STACK }}
      >
        <svg
          className="nz-calibration__grid"
          width={mm(w)}
          height={mm(h)}
          viewBox={`0 0 ${num(w)} ${num(h)}`}
          style={{ position: 'absolute', top: '0mm', left: '0mm', width: mm(w), height: mm(h) }}
          aria-hidden="true"
        >
          <g stroke={INK} strokeWidth={STROKE} fill="none">
            {/* Border on the page edge (inset by half the stroke so all of it is on the page). */}
            <rect data-role="edge" x={STROKE / 2} y={STROKE / 2} width={num(w - STROKE)} height={num(h - STROKE)} />
            {/* 2 mm safe area. */}
            <rect
              data-role="safe-area"
              x={2}
              y={2}
              width={num(w - 4)}
              height={num(h - 4)}
              strokeDasharray="1 1"
              strokeWidth={0.12}
            />
            {/* Centre crosshair. */}
            <line data-role="crosshair" x1={num(cx - 4)} y1={num(cy)} x2={num(cx + 4)} y2={num(cy)} />
            <line x1={num(cx)} y1={num(cy - 4)} x2={num(cx)} y2={num(cy + 4)} />
            <circle cx={num(cx)} cy={num(cy)} r={1.5} />
            {ticks}
          </g>
        </svg>
        <div
          className="nz-calibration__text"
          style={{
            position: 'absolute',
            insetInline: mm(6),
            insetBlockStart: mm(Math.min(h - 6, cy + 2.5)),
            textAlign: 'center',
            fontSize: pt(textPt),
            lineHeight: 1.3,
          }}
        >
          <div className="nz-ellipsis" style={{ fontWeight: 700 }} data-role="size">
            <bdi dir="ltr" style={{ fontFamily: MONO_STACK }}>{`${num(w)} × ${num(h)}`}</bdi> مم
          </div>
          <div className="nz-ellipsis" data-role="arabic-sample">
            نزلي — اختبار المعايرة: محمد عبدالرحمن القحطاني
          </div>
          <div className="nz-ellipsis" dir="ltr" data-role="latin-sample" style={{ fontFamily: MONO_STACK }}>
            Nuzli calibration 0123456789
          </div>
        </div>
      </div>
    </div>
  );
}
