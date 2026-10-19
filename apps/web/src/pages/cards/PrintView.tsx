import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Group, Loader, Text } from '@mantine/core';
import { IconFileTypePdf, IconPrinter } from '@tabler/icons-react';
import { PrintSheet } from '@nuzli/ui-print';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useBatch, useCardTemplates, useLogos } from '../../api/queries';
import { ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatDateTime, formatNumber, t, tCount } from '../../i18n';
import { logoFor, templateFromSnapshot, waitForPrintAssets } from './cardUtils';
import { dropPrintRun, getPrintRun } from '../../features/cards/printRun';

/** Screen-only chrome; the sheet itself is styled by `printCss()` from @nuzli/ui-print. */
const PAGE_CSS = `
html, body, #root { background: #fff !important; }
.nz-print-toolbar { position: sticky; top: 0; z-index: 10; background: var(--surface); border-block-end: 1px solid var(--line); padding: 8px 16px; }
@media print { .nz-print-toolbar, .mantine-Notifications-root { display: none !important; } }
`;

/**
 * The print page for one batch (brief §8.5, docs/printing.md): one card per page at the
 * template's exact size. `window.print()` runs only after the self-hosted fonts and every
 * image are ready, so cards never print in a fallback font.
 */
export function PrintView() {
  const { batchId = '' } = useParams();
  const [params] = useSearchParams();
  const api = useApi();
  const batch = useBatch(batchId);
  const templates = useCardTemplates();
  const logos = useLogos();
  const [ready, setReady] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const printed = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  // ADR-064: full IDs come only from the POST /cards/batches answer, held in memory for this run.
  const [runCards] = useState(() => getPrintRun(batchId));
  useEffect(() => () => dropPrintRun(batchId), [batchId]);
  // A8: a print run carries fresh photo URLs; a reprint from history asks for them now
  // (in memory only, never stored), and a missing one prints the initials.
  const [reprintPhotos, setReprintPhotos] = useState<Map<string, string | null> | null>(() =>
    runCards ? new Map() : null,
  );
  const items = batch.data?.items;
  useEffect(() => {
    if (runCards || !items) return;
    let cancelled = false;
    void Promise.all(
      items.map(async (item) => {
        const target = item.memberId
          ? ({ kind: 'member', id: item.memberId } as const)
          : item.userId
            ? ({ kind: 'user', id: item.userId } as const)
            : null;
        if (!item.data.photoFileId || !target) return [item.id, null] as const;
        const url = await api.photos
          .url(target)
          .then((r) => r.url)
          .catch(() => null);
        return [item.id, url] as const;
      }),
    ).then((pairs) => {
      if (!cancelled) setReprintPhotos(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [api, items, runCards]);

  const live = templates.data?.find((x) => x.id === batch.data?.template.id);
  const template = batch.data ? templateFromSnapshot(batch.data.templateSnapshot, live) : null;
  const logoUrl = template ? logoFor(template, logos.data) : null;
  const dataReady = Boolean(batch.data && template && !logos.isLoading && reprintPhotos);

  useEffect(() => {
    if (!dataReady) return;
    let cancelled = false;
    void waitForPrintAssets(sheetRef.current ?? document).then(() => {
      if (cancelled) return;
      setReady(true);
      if (params.get('auto') === '1' && !printed.current) {
        printed.current = true;
        window.print();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataReady, params]);

  const pdf = async () => {
    setPdfError(null);
    setPdfBusy(true);
    try {
      const blob = await api.cards.pdf(batchId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setPdfError(errorMessage(err));
    } finally {
      setPdfBusy(false);
    }
  };

  if (batch.isLoading || templates.isLoading) return <LoadingBlock variant="cards" />;
  if (batch.isError || !batch.data)
    return <ErrorBlock error={batch.error} onRetry={() => void batch.refetch()} />;

  return (
    <div dir="rtl" lang="ar">
      <style>{PAGE_CSS}</style>
      <div className="nz-print-toolbar">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <div>
            <Text fw={600}>
              {tCount('print.title', batch.data.cardCount, { template: batch.data.template.name })}
            </Text>
            <Text size="xs" c="dimmed">
              {t('print.meta', {
                by: batch.data.printedBy.fullName,
                at: formatDateTime(batch.data.printedAt),
              })}
            </Text>
          </div>
          <Group gap="xs">
            {!ready ? (
              <Group gap={6}>
                <Loader size="xs" color="field" />
                <Text size="sm">{t('print.preparing')}</Text>
              </Group>
            ) : null}
            <Button
              leftSection={<IconPrinter size={18} />}
              disabled={!ready}
              onClick={() => window.print()}
            >
              {t('print.print')}
            </Button>
            <Button
              variant="default"
              leftSection={<IconFileTypePdf size={18} />}
              loading={pdfBusy}
              onClick={() => void pdf()}
            >
              {t('print.pdf')}
            </Button>
            <Button variant="subtle" component={Link} to="/cards">
              {t('print.back')}
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('print.hint')}
        </Text>
        {!runCards && batch.data.items.some((i) => i.nationalIdPrinted === 'FULL') ? (
          <Alert color="signal" mt="xs">
            {t('print.maskedReprint')}
          </Alert>
        ) : null}
        {pdfError ? (
          <Alert color="signal" mt="xs" role="alert">
            {pdfError}
          </Alert>
        ) : null}
      </div>
      {template ? (
        <div ref={sheetRef}>
          <PrintSheet
            template={template}
            logoUrl={logoUrl}
            cards={
              runCards
                ? runCards.map((c, i) => ({
                    key: `${c.memberId ?? c.userId ?? 'card'}-${i}`,
                    data: c.data,
                    photoUrl: c.photoUrl ?? null,
                  }))
                : batch.data.items.map((item) => ({
                    key: item.id,
                    data: item.data,
                    photoUrl: reprintPhotos?.get(item.id) ?? null,
                  }))
            }
          />
        </div>
      ) : (
        <Alert color="breach" m="md">
          {t('print.noTemplate')}
        </Alert>
      )}
    </div>
  );
}
