import { useEffect, useMemo, useState } from 'react';
import { useComputedColorScheme } from '@mantine/core';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart as EHeatmapChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { ViolationStats } from '@nuzli/shared';
import { formatNumber, getDisplayPrefs, t } from '../../i18n';
import { severityLabel } from './parts';

echarts.use([BarChart, LineChart, EHeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

/**
 * Chart styling (design skill + dataviz guidance): team series in the team colours, everything
 * else in --field / --signal / --breach and the neutrals, read from the live tokens so both
 * light and dark schemes stay legible. RTL: category axes sit on the right, value axes grow
 * right-to-left and time runs right-to-left, like the Gantt.
 */
interface Palette {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  ground: string;
  field: string;
  signal: string;
  breach: string;
  ok: string;
}

function readPalette(): Palette {
  const cs = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--ink', '#0D1A13'),
    muted: v('--muted', '#4C635A'),
    line: v('--line', '#DDE9E1'),
    surface: v('--surface', '#FFFFFF'),
    ground: v('--ground', '#EDF4EF'),
    field: v('--field', '#14593F'),
    signal: v('--signal', '#B8791A'),
    breach: v('--breach', '#C0392B'),
    ok: v('--ok', '#0B8A4B'),
  };
}

export function usePalette(): Palette {
  const scheme = useComputedColorScheme('light');
  const [p, setP] = useState(readPalette);
  useEffect(() => {
    // Tokens switch with the scheme attribute; read them after it applied.
    const id = requestAnimationFrame(() => setP(readPalette()));
    return () => cancelAnimationFrame(id);
  }, [scheme]);
  return p;
}

const FONT = "'IBM Plex Sans Arabic', system-ui, sans-serif";
const fmt = (n: number) => formatNumber(n);

function base(p: Palette): EChartsOption {
  return {
    textStyle: { fontFamily: FONT, color: p.ink },
    animationDuration: 300,
    tooltip: {
      confine: true,
      backgroundColor: p.surface,
      borderColor: p.line,
      textStyle: { color: p.ink, fontFamily: FONT },
      extraCssText: 'direction: rtl; text-align: right; box-shadow: 0 4px 12px rgb(20 35 43 / .12);',
    },
  };
}

function Chart({ option, height, label }: { option: EChartsOption; height: number; label: string }) {
  return (
    // dir=ltr: ECharts anchors SVG text with start/end, which flips under an inherited rtl and
    // pushes axis labels over the bars. The RTL layout is set in the axis options instead.
    <div role="img" aria-label={label} dir="ltr">
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        notMerge
        style={{ height, width: '100%' }}
        opts={{ renderer: 'svg' }}
      />
    </div>
  );
}

/** Horizontal ranked bars, RTL: names on the right, bars growing to the left. */
function rankedBar(
  p: Palette,
  rows: { name: string; value: number; color?: string }[],
  opts: { decimals?: number } = {},
): EChartsOption {
  const d = opts.decimals ?? 0;
  const show = (n: number) => (d ? formatNumber(Math.round(n * 10 ** d) / 10 ** d) : fmt(n));
  return {
    ...base(p),
    grid: { top: 8, bottom: 8, left: 48, right: 8, containLabel: true },
    xAxis: {
      type: 'value',
      inverse: true,
      axisLabel: { color: p.muted, formatter: (v: number) => show(v) },
      splitLine: { lineStyle: { color: p.line } },
    },
    yAxis: {
      type: 'category',
      position: 'right',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLabel: { color: p.ink, width: 150, overflow: 'truncate' },
      axisLine: { lineStyle: { color: p.line } },
      axisTick: { show: false },
    },
    tooltip: { ...(base(p).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => show(Number(v)) },
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        data: rows.map((r) => ({
          value: r.value,
          itemStyle: { color: r.color ?? p.field, borderRadius: [4, 0, 0, 4] },
        })),
        label: { show: true, position: 'left', color: p.ink, formatter: (x) => show(Number((x as { value: number }).value)) },
      },
    ],
  };
}

export function TeamsChart({ stats, mode }: { stats: ViolationStats; mode: 'count' | 'perMember' }) {
  const p = usePalette();
  const rows = useMemo(() => {
    const list = stats.byTeam.map((r) => ({
      name: r.teamName,
      value: mode === 'count' ? r.count : r.perMember,
      color: r.color,
    }));
    return mode === 'perMember' ? list.sort((a, b) => b.value - a.value) : list;
  }, [stats, mode]);
  const option = useMemo(() => rankedBar(p, rows, { decimals: mode === 'perMember' ? 2 : 0 }), [p, rows, mode]);
  return <Chart option={option} height={Math.max(160, rows.length * 40 + 24)} label={t('vdash.teamsAria')} />;
}

export function MonitorsChart({ stats }: { stats: ViolationStats }) {
  const p = usePalette();
  const rows = stats.byMonitor.map((r) => ({ name: r.fullName, value: r.count }));
  const option = useMemo(() => rankedBar(p, rows), [p, rows]);
  return <Chart option={option} height={Math.max(140, rows.length * 36 + 24)} label={t('vdash.monitorsAria')} />;
}

export function TypesChart({ stats }: { stats: ViolationStats }) {
  const p = usePalette();
  const rows = stats.byType.map((r) => ({ name: r.name, value: r.count }));
  const option = useMemo(() => rankedBar(p, rows), [p, rows]);
  return <Chart option={option} height={Math.max(140, rows.length * 36 + 24)} label={t('vdash.typesAria')} />;
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];

export function SeverityChart({ stats }: { stats: ViolationStats }) {
  const p = usePalette();
  const colors: Record<string, string> = {
    CRITICAL: p.breach,
    HIGH: p.breach,
    MEDIUM: p.signal,
    LOW: p.field,
    NONE: p.muted,
  };
  const rows = [...stats.bySeverity]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .map((r) => ({
      name: severityLabel(r.severity === 'NONE' ? null : r.severity),
      value: r.count,
      color: colors[r.severity] ?? p.muted,
    }));
  const option = useMemo(() => {
    const o = rankedBar(p, rows);
    // HIGH is the same hue as CRITICAL; lighten it so the two never rely on colour alone
    // (their names are on the axis anyway).
    const series = (o.series as { data: { itemStyle: { color: string; opacity?: number } }[] }[])[0]!;
    rows.forEach((r, i) => {
      if (r.name === severityLabel('HIGH')) series.data[i]!.itemStyle.opacity = 0.7;
    });
    return o;
  }, [p, rows]);
  return <Chart option={option} height={Math.max(140, rows.length * 36 + 24)} label={t('vdash.severityAria')} />;
}

const dayFmt = () =>
  new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDisplayPrefs().digits}`, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export function TrendChart({ stats }: { stats: ViolationStats }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const f = dayFmt();
    return {
      ...base(p),
      grid: { top: 16, bottom: 8, left: 8, right: 8, containLabel: true },
      xAxis: {
        type: 'category',
        inverse: true,
        boundaryGap: false,
        data: stats.trend.map((r) => r.date),
        axisLabel: { color: p.muted, formatter: (d: string) => f.format(new Date(`${d}T00:00:00Z`)), hideOverlap: true },
        axisLine: { lineStyle: { color: p.line } },
      },
      yAxis: {
        type: 'value',
        position: 'right',
        minInterval: 1,
        axisLabel: { color: p.muted, formatter: (v: number) => fmt(v) },
        splitLine: { lineStyle: { color: p.line } },
      },
      tooltip: {
        ...(base(p).tooltip as object),
        trigger: 'axis',
        formatter: (params) => {
          const x = (Array.isArray(params) ? params[0] : params) as unknown as { axisValue: string; value: number };
          return `${f.format(new Date(`${x.axisValue}T00:00:00Z`))}<br/><b>${fmt(Number(x.value))}</b> ${t('vdash.violationsWord')}`;
        },
      },
      series: [
        {
          type: 'line',
          data: stats.trend.map((r) => r.count),
          smooth: 0.25,
          symbol: 'circle',
          symbolSize: 5,
          showSymbol: stats.trend.length <= 45,
          lineStyle: { color: p.field, width: 2.5 },
          itemStyle: { color: p.field },
          areaStyle: { color: p.field, opacity: 0.1 },
        },
      ],
    };
  }, [p, stats]);
  return <Chart option={option} height={260} label={t('vdash.trendAria')} />;
}

/** Weekday × hour, Sunday first (the Saudi week), hours running right-to-left. */
export function HeatmapChart({ stats }: { stats: ViolationStats }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`vdash.day.${d}` as 'vdash.day.0'));
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const max = Math.max(1, ...stats.heatmap.map((c) => c.count));
    const byCell = new Map(stats.heatmap.map((c) => [`${c.weekday}:${c.hour}`, c.count]));
    const cells: [number, number, number][] = [];
    for (let d = 0; d < 7; d++) for (const h of hours) cells.push([h, d, byCell.get(`${d}:${h}`) ?? 0]);
    return {
      ...base(p),
      grid: { top: 8, bottom: 48, left: 8, right: 8, containLabel: true },
      xAxis: {
        type: 'category',
        inverse: true,
        data: hours.map((h) => formatNumber(h)),
        splitArea: { show: false },
        axisLabel: { color: p.muted, interval: 1 },
        axisLine: { lineStyle: { color: p.line } },
        axisTick: { show: false },
        name: t('vdash.hour'),
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: { color: p.muted },
      },
      yAxis: {
        type: 'category',
        position: 'right',
        inverse: true,
        data: days,
        axisLabel: { color: p.ink },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      visualMap: {
        min: 0,
        max,
        show: false,
        inRange: { color: [p.ground, p.field] },
      },
      tooltip: {
        ...(base(p).tooltip as object),
        formatter: (x) => {
          const v = (x as unknown as { value: [number, number, number] }).value;
          return `${days[v[1]]} · ${t('vdash.hourAt', { h: v[0] })}<br/><b>${fmt(v[2])}</b> ${t('vdash.violationsWord')}`;
        },
      },
      series: [
        {
          type: 'heatmap',
          data: cells,
          itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: p.ink, borderWidth: 1 } },
        },
      ],
    };
  }, [p, stats]);
  return <Chart option={option} height={300} label={t('vdash.heatmapAria')} />;
}
