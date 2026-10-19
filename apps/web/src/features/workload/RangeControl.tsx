import { SegmentedControl, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { formatNumber, t } from '../../i18n';
import { MAX_RANGE_DAYS, clampRange, presetOf, presetRange, type Range, type RangePreset } from './math';

/**
 * Date range of the workload grid: presets (this week, next 2 weeks, this month) and two date
 * fields. The range is ordered and kept within 92 days (the API limit), with a note when cut.
 */
export function RangeControl({
  range,
  onChange,
  today,
  presets = true,
  clamped,
}: {
  range: Range;
  onChange(range: Range & { clamped: boolean }): void;
  today: string;
  presets?: boolean;
  clamped?: boolean;
}) {
  const preset = presetOf(range, today);
  // A9 QA: at 360 px the four presets used to scroll «فترة مخصّصة» out of sight.
  const phone = useMediaQuery('(max-width: 30em)') ?? false;
  const set = (from: string, to: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
    onChange(clampRange(from, to));
  };
  return (
    <div className="wl-toolbar">
      {presets ? (
        <SegmentedControl
          className="rp-seg"
          size={phone ? 'xs' : 'sm'}
          fullWidth={phone}
          aria-label={t('a9r.wl.presets')}
          value={preset ?? 'custom'}
          onChange={(v) => {
            if (v === 'custom') return;
            onChange({ ...presetRange(v as RangePreset, today), clamped: false });
          }}
          data={[
            { value: 'week', label: t('a9r.wl.preset.week') },
            { value: 'twoWeeks', label: t('a9r.wl.preset.twoWeeks') },
            { value: 'month', label: t('a9r.wl.preset.month') },
            { value: 'custom', label: t('a9r.wl.preset.custom'), disabled: preset !== null },
          ]}
        />
      ) : null}
      <div className="wl-dates">
        <TextInput type="date" label={t('a9r.wl.from')} value={range.from} onChange={(e) => set(e.currentTarget.value, range.to)} size="sm" />
        <TextInput type="date" label={t('a9r.wl.to')} value={range.to} onChange={(e) => set(range.from, e.currentTarget.value)} size="sm" />
      </div>
      {clamped ? (
        <Text size="xs" c="var(--amber)" fw={500} style={{ flexBasis: '100%' }} role="status">
          {t('a9r.wl.clamped', { n: formatNumber(MAX_RANGE_DAYS) })}
        </Text>
      ) : null}
    </div>
  );
}
