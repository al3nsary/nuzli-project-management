import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject, type WheelEvent } from 'react';
import { ActionIcon, Button, Group, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconFocusCentered, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import type { OrgUnitDto } from '@nuzli/shared';
import { buildForest, CHART, fitScale, layoutChart, type ChartBox } from '../../features/org/layout';
import { dirSign } from '../../lib/direction';
import { formatNumber, t } from '../../i18n';
import { kindLabel } from './dialogs';

const KIND_COLOR: Record<string, string> = {
  DEPARTMENT: '#303F9F',
  SECTION: '#3949AB',
  UNIT: '#5C6BC0',
  TEAM_GROUP: '#00838F',
};
const FONT = `'IBM Plex Sans Arabic', Tahoma, 'Segoe UI', Arial, sans-serif`;
const MIN = 0.2;
const MAX = 2;

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Fits `text` into `width` px with an ellipsis (canvas metrics; a character estimate without canvas). */
function fit(text: string, width: number, font: string): string {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent) ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  const measure = (s: string) => {
    if (!measureCtx) return s.length * 7.2;
    measureCtx.font = font;
    return measureCtx.measureText(s).width;
  };
  if (measure(text) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

function Box({ box, rtl }: { box: ChartBox; rtl: boolean }) {
  const u = box.unit;
  const pad = 14;
  const inner = box.width - pad * 2;
  const tx = rtl ? box.x + box.width - pad : box.x + pad;
  const anchor = 'start';
  const shown = u.positions.slice(0, CHART.maxLines);
  const more = u.positions.length - shown.length;
  const color = KIND_COLOR[u.kind] ?? '#303F9F';
  const title = `${kindLabel(u.kind)} — ${u.name}`;
  return (
    <g className="ogc-box" tabIndex={0} role="listitem" aria-label={title}>
      <title>{title}</title>
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={12} fill="var(--ogc-card, #fff)" stroke="var(--ogc-line, #E6E8EC)" />
      <rect x={box.x} y={box.y} width={box.width} height={5} rx={2} fill={color} />
      <text x={tx} y={box.y + 30} textAnchor={anchor} fontSize={15} fontWeight={700} fill="var(--ogc-ink, #1F2430)">
        {fit(u.name, inner, `700 15px ${FONT}`)}
      </text>
      <text x={tx} y={box.y + 50} textAnchor={anchor} fontSize={12} fill={color} fontWeight={600}>
        {kindLabel(u.kind)}
        {u.code ? ` · ${u.code}` : ''}
      </text>
      {shown.map((p, i) => {
        const y = box.y + CHART.headerHeight + i * CHART.lineHeight + 14;
        const holder = p.holder ? p.holder.fullName : t('org.pos.vacant');
        const line = fit(`${p.title}: ${holder}`, inner, `400 12.5px ${FONT}`);
        return (
          <text key={p.id} x={tx} y={y} textAnchor={anchor} fontSize={12.5} fill={p.holder ? 'var(--ogc-dim, #3D4452)' : '#A35C00'} fontWeight={p.holder ? 400 : 600}>
            {line}
          </text>
        );
      })}
      {more > 0 ? (
        <text x={tx} y={box.y + CHART.headerHeight + shown.length * CHART.lineHeight + 14} textAnchor={anchor} fontSize={12} fill="var(--ogc-faint, #6F7787)">
          {t('org.chart.more', { n: formatNumber(more) })}
        </text>
      ) : null}
      {u.teams.length ? (
        <g>
          {u.teams.slice(0, 6).map((tm, i) => (
            <circle
              key={tm.id}
              cx={rtl ? box.x + box.width - pad - 5 - i * 14 : box.x + pad + 5 + i * 14}
              cy={box.y + box.height - 18}
              r={5}
              fill={tm.color.hex}
            />
          ))}
          <text
            x={rtl ? box.x + box.width - pad - Math.min(6, u.teams.length) * 14 - 4 : box.x + pad + Math.min(6, u.teams.length) * 14 + 4}
            y={box.y + box.height - 14}
            textAnchor={anchor}
            fontSize={11.5}
            fill="var(--ogc-faint, #6F7787)"
          >
            {fit(t('org.chart.teams', { names: u.teams.map((tm) => tm.name).join('، ') }), inner - Math.min(6, u.teams.length) * 14 - 8, `400 11.5px ${FONT}`)}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * The structure as a top-down org chart (owner request A9): SVG laid out in logical x and drawn
 * mirrored for RTL; pan by dragging (pointer deltas and the translate are both physical, so no
 * sign flip), zoom with the buttons, Ctrl + wheel or the +/− keys, «ملاءمة» fits it, and
 * «تصدير PNG» rasterises the same SVG on a canvas.
 */
export function OrgChart({ units }: { units: OrgUnitDto[] }) {
  const rtl = dirSign() === -1;
  const layout = useMemo(() => layoutChart(buildForest(units), rtl ? -1 : 1), [units, rtl]);
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [fitted, setFitted] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const fitView = () => {
    if (!width || !height) return;
    const scale = fitScale(layout, { width, height });
    setView({ scale, tx: (width - layout.width * scale) / 2, ty: Math.max(8, (height - layout.height * scale) / 2) });
  };
  useEffect(() => {
    if (!fitted && width && height) {
      fitView();
      setFitted(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, fitted]);
  useEffect(() => setFitted(false), [layout.width, layout.height]);

  const zoomAt = (factor: number, cx = width / 2, cy = height / 2) =>
    setView((v) => {
      const scale = Math.min(MAX, Math.max(MIN, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Both clientX and translate are physical: the delta applies as is in RTL and LTR.
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = 48;
    if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.2);
    else if (e.key === '0') fitView();
    else if (e.key === 'ArrowLeft') setView((v) => ({ ...v, tx: v.tx + step }));
    else if (e.key === 'ArrowRight') setView((v) => ({ ...v, tx: v.tx - step }));
    else if (e.key === 'ArrowUp') setView((v) => ({ ...v, ty: v.ty + step }));
    else if (e.key === 'ArrowDown') setView((v) => ({ ...v, ty: v.ty - step }));
    else return;
    e.preventDefault();
  };

  const exportPng = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.querySelector('[data-pan]')?.removeAttribute('transform');
      clone.setAttribute('width', String(layout.width));
      clone.setAttribute('height', String(layout.height));
      clone.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
      const xml = new XMLSerializer().serializeToString(clone).replace(/var\(--ogc-[a-z]+, (#[0-9A-Fa-f]+)\)/g, '$1');
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('svg'));
        img.src = url;
      });
      const ratio = 2;
      const canvas = document.createElement('canvas');
      canvas.width = layout.width * ratio;
      canvas.height = layout.height * ratio;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(ratio, ratio);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('png');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${t('org.chart.fileName')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      notifications.show({ color: 'ok', message: t('org.chart.exported') });
    } catch {
      notifications.show({ color: 'breach', message: t('org.chart.exportFailed') });
    }
  };

  return (
    <div className="ogc">
      <Group className="ogc-tools" gap={6} justify="space-between" wrap="wrap">
        <Group gap={6}>
          <Tooltip label={t('org.chart.zoomIn')}>
            <ActionIcon variant="default" size={36} onClick={() => zoomAt(1.2)} aria-label={t('org.chart.zoomIn')}>
              <IconZoomIn size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('org.chart.zoomOut')}>
            <ActionIcon variant="default" size={36} onClick={() => zoomAt(1 / 1.2)} aria-label={t('org.chart.zoomOut')}>
              <IconZoomOut size={18} />
            </ActionIcon>
          </Tooltip>
          <Button variant="default" size="sm" leftSection={<IconFocusCentered size={16} />} onClick={fitView}>
            {t('org.chart.fit')}
          </Button>
          <span className="ogc-scale num" aria-live="polite">
            {formatNumber(Math.round(view.scale * 100))}٪
          </span>
        </Group>
        <Button variant="light" size="sm" leftSection={<IconDownload size={16} />} onClick={() => void exportPng()}>
          {t('org.chart.export')}
        </Button>
      </Group>
      <div
        ref={ref as RefObject<HTMLDivElement>}
        className="ogc-viewport"
        tabIndex={0}
        role="application"
        aria-label={t('org.chart.aria')}
        aria-roledescription={t('org.chart.role')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKey}
      >
        <svg ref={svgRef} width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" direction={rtl ? 'rtl' : 'ltr'} fontFamily={FONT}>
          <g data-pan transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <g fill="none" stroke="var(--ogc-edge, #C5CAE9)" strokeWidth={1.6}>
              {layout.edges.map((e) => (
                <path key={`${e.from}-${e.to}`} d={e.path} />
              ))}
            </g>
            <g role="list">
              {layout.boxes.map((b) => (
                <Box key={b.id} box={b} rtl={rtl} />
              ))}
            </g>
          </g>
        </svg>
      </div>
      <p className="ogc-hint">{t('org.chart.hint')}</p>
    </div>
  );
}
