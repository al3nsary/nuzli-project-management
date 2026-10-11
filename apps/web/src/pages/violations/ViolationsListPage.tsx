import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Pagination,
  SegmentedControl,
  SimpleGrid,
  Table,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconClockExclamation,
  IconFileSpreadsheet,
  IconLayoutGrid,
  IconListDetails,
  IconMap2,
  IconPhoto,
  IconTable,
} from '@tabler/icons-react';
import { can, type ViolationDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useViolationStats, useViolations } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { useViolationFilters } from '../../features/violations/filterStore';
import { riyadhDate } from '../../features/violations/time';
import { FilterBar } from './FilterBar';
import { ClusterMap } from './maps';
import { SeverityBadge, SnapshotTeam, ViolationStatusBadge } from './parts';
import { ViolationDrawer } from './ViolationDrawer';
import { ViolationRowCard } from './MyViolationsPage';

const PAGE_SIZE = 25;

/** Saves a Blob under a file name (no personal data in the name). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function photoCount(v: ViolationDto) {
  return v.files.filter((f) => f.kind === 'EVIDENCE').length;
}

/** Admin list of violations (brief §7.5): filters, table and card views, map, export. */
export function ViolationsListPage() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const { filter, set, reset } = useViolationFilters();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'table' | 'cards'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'cards' : 'table',
  );
  // Phones get the list first; the map is one tap away.
  const [showMap, setShowMap] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);
  const [exporting, setExporting] = useState(false);
  const openId = params.get('open');
  const setOpen = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });

  useEffect(() => setPage(1), [filter]);
  const query = useMemo(() => ({ ...filter, page, pageSize: PAGE_SIZE }), [filter, page]);
  const list = useViolations(query);
  const stats = useViolationStats(filter, showMap);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const blob = await api.violations.exportXlsx(filter);
      downloadBlob(blob, `violations-${riyadhDate(new Date())}.xlsx`);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title={t('vlist.title')}
        lead={data ? t('vlist.lead', { n: data.total }) : undefined}
        actions={
          can(user, 'violations.export') ? (
            <Button
              variant="light"
              leftSection={<IconFileSpreadsheet size={18} />}
              onClick={() => void exportXlsx()}
              loading={exporting}
            >
              {t('vlist.export')}
            </Button>
          ) : undefined
        }
      />
      <FilterBar value={filter} onChange={set} onReset={reset} />

      <Card padding="md" mb="md">
        <Group justify="space-between" wrap="nowrap" mb={showMap ? 'sm' : 0}>
          <Group gap="xs">
            <IconMap2 size={18} aria-hidden />
            <Text fw={600}>{t('vlist.map')}</Text>
            {stats.data?.pointsTruncated ? (
              <Text size="xs" c="dimmed">
                {t('vlist.mapTruncated')}
              </Text>
            ) : null}
          </Group>
          <Button variant="subtle" size="compact-sm" onClick={() => setShowMap((s) => !s)} aria-expanded={showMap}>
            {showMap ? t('vlist.hideMap') : t('vlist.showMap')}
          </Button>
        </Group>
        <Collapse in={showMap}>
          {showMap ? (
            <ClusterMap
              points={stats.data?.points ?? []}
              bbox={filter.bbox}
              onBbox={(bbox) => set({ bbox })}
              onSelect={(id) => setOpen(id)}
              height={340}
            />
          ) : null}
        </Collapse>
      </Card>

      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Text size="sm" c="dimmed">
          {data ? t('common.total', { count: data.total }) : ''}
        </Text>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as 'table' | 'cards')}
          data={[
            {
              value: 'table',
              label: (
                <Group gap={4} wrap="nowrap">
                  <IconTable size={14} />
                  {t('vlist.viewTable')}
                </Group>
              ),
            },
            {
              value: 'cards',
              label: (
                <Group gap={4} wrap="nowrap">
                  <IconLayoutGrid size={14} />
                  {t('vlist.viewCards')}
                </Group>
              ),
            },
          ]}
        />
      </Group>

      {list.isLoading ? <LoadingBlock /> : null}
      {list.isError ? <ErrorBlock error={list.error} onRetry={() => void list.refetch()} /> : null}
      {data && data.total === 0 ? (
        <EmptyState
          icon={IconListDetails}
          title={t('vlist.emptyTitle')}
          body={t('vlist.emptyBody')}
          action={{ label: t('vfilter.reset'), onClick: reset }}
        />
      ) : null}

      {data && data.total > 0 && view === 'table' ? (
        <Card padding={0}>
          <Table.ScrollContainer minWidth={900}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('vlist.col.time')}</Table.Th>
                  <Table.Th>{t('vlist.col.member')}</Table.Th>
                  <Table.Th>{t('vlist.col.team')}</Table.Th>
                  <Table.Th>{t('vlist.col.type')}</Table.Th>
                  <Table.Th>{t('vlist.col.monitor')}</Table.Th>
                  <Table.Th>{t('vlist.col.status')}</Table.Th>
                  <Table.Th>
                    <VisuallyHidden>{t('vlist.col.flags')}</VisuallyHidden>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.items.map((v) => (
                  <Table.Tr key={v.id} onClick={() => setOpen(v.id)} style={{ cursor: 'pointer' }}>
                    <Table.Td>
                      <Text size="sm" className="num">
                        {formatDateTime(v.capturedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {v.member.fullName}
                      </Text>
                      <Text size="xs" c="dimmed" className="mono ltr">
                        {v.member.nationalIdMasked}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <SnapshotTeam team={v.team} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">{v.type.name}</Text>
                        <SeverityBadge severity={v.type.severity} />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{v.recordedBy.fullName}</Text>
                    </Table.Td>
                    <Table.Td>
                      <ViolationStatusBadge status={v.status} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={8} wrap="nowrap" justify="flex-end">
                        {v.clockDriftSuspect ? (
                          <Tooltip label={t('violations.drift')}>
                            <IconClockExclamation size={18} color="var(--signal)" aria-label={t('violations.drift')} />
                          </Tooltip>
                        ) : null}
                        <Group gap={2} wrap="nowrap">
                          <IconPhoto size={16} color="var(--muted)" aria-hidden />
                          <Text size="xs" c="dimmed">
                            {formatNumber(photoCount(v))}
                          </Text>
                        </Group>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(v.id);
                          }}
                        >
                          {t('common.details')}
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ) : null}

      {data && data.total > 0 && view === 'cards' ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
          {data.items.map((v) => (
            <Box key={v.id}>
              <ViolationRowCard v={v} onOpen={() => setOpen(v.id)} />
            </Box>
          ))}
        </SimpleGrid>
      ) : null}

      {data && pages > 1 ? <Pagination value={page} onChange={setPage} total={pages} mt="md" /> : null}

      <ViolationDrawer id={openId} onClose={() => setOpen(null)} />
    </>
  );
}
