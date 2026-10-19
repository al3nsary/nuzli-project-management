import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useComputedColorScheme } from '@mantine/core';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { formatNumber, getDisplayPrefs } from '../../i18n';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, MarkLineComponent, TitleComponent, SVGRenderer]);

/**
 * Charts of the A9 reports (dashboard, budget, reports, portfolios). Colours come from the live
 * tokens (indigo for the plan, green for done/actual within plan, amber/red for state), so light
 * and dark schemes both read well. RTL: category names sit on the right, bars grow to the left,
 * time runs right-to-left like the Gantt. Legends are HTML (`ChartLegend`) so they follow the
 * page direction.
 */
export interface ChartPalette {
  ink: string;
  dim: string;
  dim2: string;
  line: string;
  panel: string;
  panel2: string;
  primary: string;
  tint: string;
  amber: string;
  red: string;
  live: string;
  blue: string;
}

function readPalette(): ChartPalette {
  const cs = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--ink', '#1F2430'),
    dim: v('--dim', '#5E6676'),
    dim2: v('--dim2', '#6F7787'),
    line: v('--line', '#E6E8EC'),
    panel: v('--panel', '#FFFFFF'),
    panel2: v('--panel2', '#F5F6F9'),
    primary: v('--primary', '#303F9F'),
    tint: v('--tint', '#E8EAF6'),
    amber: v('--amber', '#A35C00'),
    red: v('--red', '#C62828'),
    live: v('--live', '#2E7D32'),
    blue: v('--blue', '#1565C0'),
  };
}

export function useChartPalette(): ChartPalette {
  const scheme = useComputedColorScheme('light');
  const [p, setP] = useState(readPalette);
  useEffect(() => {
    const id = requestAnimationFrame(() => setP(readPalette()));
    return () => cancelAnimationFrame(id);
  }, [scheme]);
  return p;
}

const FONT = "'IBM Plex Sans Arabic', system-ui, sans-serif";
type Fmt = (n: number) => string;
const plain: Fmt = (n) => formatNumber(Math.round(n * 100) / 100);

function base(p: ChartPalette): EChartsOption {
  return {
    textStyle: { fontFamily: FONT, color: p.ink },
    animationDuration: 300,
    tooltip: {
      confine: true,
      backgroundColor: p.panel,
      borderColor: p.line,
      textStyle: { color: p.ink, fontFamily: FONT, fontSize: 12 },
      extraCssText: 'direction: rtl; text-align: right; box-shadow: 0 4px 12px -2px rgba(16,24,40,.12); border-radius: 8px;',
    },
  };
}

export function Chart({ option, height, label }: { option: EChartsOption; height: number; label: string }) {
  return (
    // dir=ltr: ECharts anchors SVG text with start/end, which flips under an inherited rtl. The
    // RTL layout is set in the axis options instead.
    <div role="img" aria-label={label} dir="ltr" className="rp-chart">
      <ReactEChartsCore echarts={echarts} option={option} notMerge style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />
    </div>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  /** dashed = a reference line (the budget). */
  dashed?: boolean;
  value?: string;
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="rp-legend">
      {items.map((it) => (
        <li key={it.label}>
          <span className={it.dashed ? 'rp-legend-sw rp-legend-sw--line' : 'rp-legend-sw'} style={{ '--sw': it.color } as CSSProperties} aria-hidden />
          <span>{it.label}</span>
          {it.value ? <b className="num">{it.value}</b> : null}
        </li>
      ))}
    </ul>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ------------------------------------------------------------------ donut

export function DonutChart({
  rows,
  label,
  height = 220,
  center,
}: {
  rows: { name: string; value: number; color: string }[];
  label: string;
  height?: number;
  center?: { value: string; caption: string };
}) {
  const p = useChartPalette();
  const option = useMemo<EChartsOption>(
    () => ({
      ...base(p),
      tooltip: {
        ...(base(p).tooltip as object),
        trigger: 'item',
        formatter: (x) => {
          const d = x as unknown as { name: string; value: number; percent: number };
          return `${esc(d.name)}<br/><b>${plain(d.value)}</b> · ${formatNumber(Math.round(d.percent))}٪`;
        },
      },
      title: center
        ? {
            text: center.value,
            subtext: center.caption,
            left: 'center',
            top: 'center',
            itemGap: 2,
            textStyle: { fontFamily: FONT, fontSize: 22, fontWeight: 600, color: p.ink },
            subtextStyle: { fontFamily: FONT, fontSize: 11, color: p.dim },
          }
        : undefined,
      series: [
        {
          type: 'pie',
          radius: ['62%', '86%'],
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderColor: p.panel, borderWidth: 2, borderRadius: 4 },
          data: rows.filter((r) => r.value > 0).map((r) => ({ name: r.name, value: r.value, itemStyle: { color: r.color } })),
        },
      ],
    }),
    [p, rows, center],
  );
  return <Chart option={option} height={height} label={label} />;
}

// ------------------------------------------------------------------ horizontal bars

export interface SeriesSpec {
  name: string;
  color: string;
  data: (number | null)[];
  /** Per-bar colour override (e.g. red when the actual exceeds the plan). */
  colors?: (string | null)[];
}

/**
 * Horizontal grouped bars, RTL: category names on the right, values growing to the left. One
 * series = ranked bars. `refLine` draws a dashed vertical reference (e.g. the budget).
 */
export function HBars({
  categories,
  series,
  label,
  format = plain,
  axisFormat,
  max,
  refLine,
  labelWidth = 150,
  showValues,
  extraTooltip,
}: {
  categories: string[];
  series: SeriesSpec[];
  label: string;
  format?: Fmt;
  axisFormat?: Fmt;
  max?: number;
  refLine?: { value: number; label: string; color: string };
  labelWidth?: number;
  showValues?: boolean;
  extraTooltip?: (index: number) => string;
}) {
  const p = useChartPalette();
  const option = useMemo<EChartsOption>(() => {
    const single = series.length === 1;
    return {
      ...base(p),
      grid: { top: 8, bottom: 8, left: showValues ? 56 : 12, right: 8, containLabel: true },
      xAxis: {
        type: 'value',
        inverse: true,
        max,
        axisLabel: { color: p.dim2, formatter: (v: number) => (axisFormat ?? format)(v), hideOverlap: true },
        splitLine: { lineStyle: { color: p.line } },
      },
      yAxis: {
        type: 'category',
        position: 'right',
        inverse: true,
        data: categories,
        axisLabel: { color: p.ink, width: labelWidth, overflow: 'truncate' },
        axisLine: { lineStyle: { color: p.line } },
        axisTick: { show: false },
      },
      tooltip: {
        ...(base(p).tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: p.panel2, opacity: 0.6 } },
        formatter: (params) => {
          const list = (Array.isArray(params) ? params : [params]) as unknown as { seriesName: string; value: number | null; color: string; dataIndex: number; axisValue: string }[];
          const head = list[0];
          if (!head) return '';
          const lines = list
            .filter((x) => x.value !== null && x.value !== undefined)
            .map((x) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${x.color};margin-inline-end:6px"></span>${single ? '' : `${esc(x.seriesName)}: `}<b>${format(Number(x.value))}</b>`);
          const extra = extraTooltip ? extraTooltip(head.dataIndex) : '';
          return `<b>${esc(head.axisValue)}</b><br/>${lines.join('<br/>')}${extra ? `<br/>${extra}` : ''}`;
        },
      },
      series: series.map((s, si) => ({
        type: 'bar',
        name: s.name,
        barMaxWidth: single ? 20 : 12,
        barGap: '25%',
        data: s.data.map((v, i) => ({
          value: v,
          itemStyle: { color: s.colors?.[i] ?? s.color, borderRadius: [3, 0, 0, 3] },
        })),
        label: showValues
          ? { show: true, position: 'left', color: p.ink, fontSize: 11, formatter: (x) => format(Number((x as { value: number }).value)) }
          : undefined,
        markLine:
          refLine && si === 0
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: refLine.color, type: 'dashed', width: 1.5 },
                label: { show: true, formatter: refLine.label, color: refLine.color, fontFamily: FONT, fontSize: 11, position: 'end' },
                data: [{ xAxis: refLine.value }],
              }
            : undefined,
      })),
    };
  }, [p, categories, series, format, axisFormat, max, refLine, labelWidth, showValues, extraTooltip]);
  const rowH = series.length > 1 ? 18 * series.length + 14 : 34;
  return <Chart option={option} height={Math.max(140, categories.length * rowH + 40)} label={label} />;
}

// ------------------------------------------------------------------ budget burn

const shortDay = () =>
  new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDisplayPrefs().digits}`, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Cumulative planned cost by Sunday week (indigo area) against the budget (red dashed line) and
 * the actual cost so far (green dashed line). Time runs right-to-left.
 */
export function BurnChart({
  weeks,
  budget,
  actual,
  label,
  format,
  axisFormat,
  names,
}: {
  weeks: { weekStart: string; planned: number; cumulative: number }[];
  budget: number | null;
  actual: number;
  label: string;
  format: Fmt;
  axisFormat: Fmt;
  names: { planned: string; weekly: string; budget: string; actual: string; weekOf: (d: string) => string };
}) {
  const p = useChartPalette();
  const option = useMemo<EChartsOption>(() => {
    const f = shortDay();
    const day = (d: string) => f.format(new Date(`${d}T00:00:00Z`));
    const lines: { yAxis: number; name: string; lineStyle: { color: string }; label: { color: string } }[] = [];
    if (budget !== null) lines.push({ yAxis: budget, name: names.budget, lineStyle: { color: p.red }, label: { color: p.red } });
    lines.push({ yAxis: actual, name: names.actual, lineStyle: { color: p.live }, label: { color: p.live } });
    const top = Math.max(budget ?? 0, actual, ...weeks.map((w) => w.cumulative));
    return {
      ...base(p),
      grid: { top: 24, bottom: 8, left: 12, right: 8, containLabel: true },
      xAxis: {
        type: 'category',
        inverse: true,
        data: weeks.map((w) => w.weekStart),
        axisLabel: { color: p.dim2, formatter: (d: string) => day(d), hideOverlap: true },
        axisLine: { lineStyle: { color: p.line } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        position: 'right',
        max: top > 0 ? Math.ceil((top * 1.08) / 1000) * 1000 || undefined : undefined,
        axisLabel: { color: p.dim2, formatter: (v: number) => axisFormat(v) },
        splitLine: { lineStyle: { color: p.line } },
      },
      tooltip: {
        ...(base(p).tooltip as object),
        trigger: 'axis',
        formatter: (params) => {
          const list = (Array.isArray(params) ? params : [params]) as unknown as { dataIndex: number }[];
          const w = weeks[list[0]?.dataIndex ?? 0];
          if (!w) return '';
          return `<b>${esc(names.weekOf(day(w.weekStart)))}</b><br/>${esc(names.weekly)}: <b>${format(w.planned)}</b><br/>${esc(names.planned)}: <b>${format(w.cumulative)}</b>`;
        },
      },
      series: [
        {
          type: 'bar',
          name: names.weekly,
          data: weeks.map((w) => w.planned),
          barMaxWidth: 14,
          itemStyle: { color: p.tint, borderRadius: [3, 3, 0, 0] },
        },
        {
          type: 'line',
          name: names.planned,
          data: weeks.map((w) => w.cumulative),
          smooth: 0.2,
          symbol: 'circle',
          symbolSize: 5,
          showSymbol: weeks.length <= 30,
          lineStyle: { color: p.primary, width: 2.5 },
          itemStyle: { color: p.primary },
          areaStyle: { color: p.primary, opacity: 0.08 },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: true, position: 'insideStartTop', fontFamily: FONT, fontSize: 11, formatter: (x) => (x as unknown as { name: string }).name },
            lineStyle: { type: 'dashed', width: 1.5 },
            data: lines,
          },
        },
      ],
    };
  }, [p, weeks, budget, actual, format, axisFormat, names]);
  return <Chart option={option} height={280} label={label} />;
}
