import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Group, SegmentedControl, Select, Text } from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { CalibrationCard } from '@nuzli/ui-print';
import type { CardOrientation } from '@nuzli/shared';
import { useCardSizes } from '../../api/queries';
import { ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatNumber, t } from '../../i18n';
import { waitForPrintAssets } from './cardUtils';

const PAGE_CSS = `
html, body, #root { background: #fff !important; }
.nz-print-toolbar { position: sticky; top: 0; z-index: 10; background: var(--surface); border-block-end: 1px solid var(--line); padding: 8px 16px; }
.nz-calibration { display: flex; justify-content: center; padding: 16px; }
@media print { .nz-print-toolbar, .mantine-Notifications-root { display: none !important; } .nz-calibration { padding: 0; display: block; } }
`;

/** «كروت العمل ← المقاسات ← طباعة تجريبية» (docs/printing.md §4). */
export function CalibrationPage() {
  const [params, setParams] = useSearchParams();
  const sizes = useCardSizes();
  const sizeId = params.get('sizeId') ?? sizes.data?.[0]?.id ?? null;
  const orientation = (params.get('orientation') as CardOrientation | null) ?? 'LANDSCAPE';
  const size = sizes.data?.find((s) => s.id === sizeId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!size) return;
    setReady(false);
    let cancelled = false;
    void waitForPrintAssets().then(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [size, orientation]);

  if (sizes.isLoading) return <LoadingBlock />;
  if (sizes.isError) return <ErrorBlock error={sizes.error} />;

  const update = (patch: Record<string, string>) =>
    setParams({ sizeId: sizeId ?? '', orientation, ...patch }, { replace: true });

  return (
    <div dir="rtl" lang="ar">
      <style>{PAGE_CSS}</style>
      <div className="nz-print-toolbar">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text fw={600}>{t('calibration.title')}</Text>
          <Group gap="xs" wrap="wrap">
            <Select
              aria-label={t('templates.size')}
              data={(sizes.data ?? []).map((s) => ({
                value: s.id,
                label: `${s.name} — ${formatNumber(s.widthMm)} × ${formatNumber(s.heightMm)}`,
              }))}
              value={sizeId}
              onChange={(v) => v && update({ sizeId: v })}
              allowDeselect={false}
              w={260}
            />
            <SegmentedControl
              value={orientation}
              onChange={(v) => update({ orientation: v })}
              data={[
                { value: 'LANDSCAPE', label: t('cards.orientation.LANDSCAPE') },
                { value: 'PORTRAIT', label: t('cards.orientation.PORTRAIT') },
              ]}
            />
            <Button leftSection={<IconPrinter size={18} />} disabled={!ready} onClick={() => window.print()}>
              {t('calibration.print')}
            </Button>
            <Button variant="subtle" component={Link} to="/cards/templates?tab=sizes">
              {t('print.back')}
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('calibration.hint')}
        </Text>
      </div>
      {size ? (
        <div className="nz-calibration">
          <CalibrationCard size={size} orientation={orientation} />
        </div>
      ) : null}
    </div>
  );
}
