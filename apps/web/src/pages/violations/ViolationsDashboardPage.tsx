import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconChartBar,
  IconFileTypePdf,
  IconMinus,
  IconPrinter,
} from '@tabler/icons-react';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { useViolationStats } from '../../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { TeamBadge } from '../../theme/TeamBadge';
import { useViolationFilters } from '../../features/violations/filterStore';
import { riyadhDate } from '../../features/violations/time';
import { FilterBar } from './FilterBar';
import { ClusterMap } from './maps';
import { HeatmapChart, MonitorsChart, SeverityChart, TeamsChart, TrendChart, TypesChart } from './charts';
import { downloadBlob } from './ViolationsListPage';

function Kpi({ label, value, foot }: { label: string; value: ReactNode; foot?: ReactNode }) {
  return (
    <Card padding="md" className="nz-dash-card">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text className="display num" fz="2.25rem" lh={1.2} mt={4}>
        {value}
      </Text>
      {foot ? <Box mt={4}>{foot}</Box> : null}
    </Card>
  );
}

/** Week-over-week change. More violations is bad news (breach), fewer is good (ok). */
function Change({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) {
    return (
      <Group gap={4}>
        <IconMinus size={16} color="var(--muted)" />
        <Text size="sm" c="dimmed">
          {t('vdash.noChange')}
        </Text>
      </Group>
    );
  }
  if (prev === 0) {
    return (
      <Text size="sm" c="var(--breach)">
        {t('vdash.newThisWeek')}
      </Text>
    );
  }
  const pct = Math.round(((now - prev) / prev) * 100);
  const up = pct > 0;
  const Icon = pct === 0 ? IconMinus : up ? IconArrowUpRight : IconArrowDownRight;
  const color = pct === 0 ? 'var(--muted)' : up ? 'var(--breach)' : 'var(--ok)';
  return (
    <Group gap={4} wrap="nowrap">
      <Icon size={18} color={color} aria-hidden className={pct === 0 ? undefined : 'mirror-rtl'} />
      <Text size="sm" c={color} fw={600}>
        {t(up ? 'vdash.changeUp' : pct === 0 ? 'vdash.noChange' : 'vdash.changeDown', { pct: Math.abs(pct) })}
      </Text>
      <Text size="sm" c="dimmed">
        {t('vdash.vsPrev', { n: prev })}
      </Text>
    </Group>
  );
}

function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card padding="md" className="nz-dash-card">
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Title order={2} fz="md">
          {title}
        </Title>
        {actions}
      </Group>
      {children}
    </Card>
  );
}

/** The violations dashboard (brief §7.5). Every panel reads the same filtered statistics. */
export function ViolationsDashboardPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { filter, set, reset } = useViolationFilters();
  const q = useViolationStats(filter);
  const [teamMode, setTeamMode] = useState<'count' | 'perMember'>('count');
  const [pdfBusy, setPdfBusy] = useState(false);
  const s = q.data;

  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      const blob = await api.violations.dashboardPdf(filter);
      downloadBlob(blob, `violations-dashboard-${riyadhDate(new Date())}.pdf`);
    } catch (err) {
      const notConfigured = err instanceof ApiError && (err.status === 501 || err.code === 'PDF_NOT_CONFIGURED');
      notifications.show({
        color: notConfigured ? 'signal' : 'breach',
        title: notConfigured ? t('vdash.pdfUnavailable') : undefined,
        message: notConfigured ? t('vdash.pdfFallback') : errorMessage(err),
        autoClose: 8000,
      });
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <Box className="nz-dashboard">
      <PageHeader
        title={t('vdash.title')}
        lead={s?.generatedAt ? t('vdash.generated', { at: formatDateTime(s.generatedAt) }) : undefined}
        actions={
          <Group gap="xs" className="no-print">
            <Button variant="light" leftSection={<IconFileTypePdf size={18} />} loading={pdfBusy} onClick={() => void exportPdf()}>
              {t('vdash.exportPdf')}
            </Button>
            <Button variant="default" leftSection={<IconPrinter size={18} />} onClick={() => window.print()}>
              {t('vdash.print')}
            </Button>
          </Group>
        }
      />
      <FilterBar value={filter} onChange={set} onReset={reset} />
      <Text className="print-only" size="sm" mb="sm">
        {t('vdash.printFilters', { from: filter.from ?? '—', to: filter.to ?? '—' })}
      </Text>

      {q.isLoading ? <LoadingBlock variant="dashboard" /> : null}
      {q.isError ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : null}
      {s && s.total === 0 && s.thisWeek === 0 && s.previousWeek === 0 ? (
        <EmptyState
          icon={IconChartBar}
          title={t('vdash.emptyTitle')}
          body={t('vdash.emptyBody')}
          action={{ label: t('vfilter.reset'), onClick: reset }}
        />
      ) : null}

      {s ? (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
            <Kpi label={t('vdash.kpiTotal')} value={formatNumber(s.total)} foot={<Text size="sm" c="dimmed">{t('vdash.kpiTotalFoot')}</Text>} />
            <Kpi label={t('vdash.kpiWeek')} value={formatNumber(s.thisWeek)} foot={<Change now={s.thisWeek} prev={s.previousWeek} />} />
            <Kpi
              label={t('vdash.kpiPrevWeek')}
              value={formatNumber(s.previousWeek)}
              foot={<Text size="sm" c="dimmed">{t('vdash.kpiWeekFoot')}</Text>}
            />
            <Kpi
              label={t('vdash.kpiUnassigned')}
              value={formatNumber(s.unassigned ?? 0)}
              foot={
                <Anchor component={Link} to="/violations?assigned=false" size="sm" onClick={() => set({ assigned: 'false' })}>
                  {t('vdash.kpiUnassignedLink')}
                </Anchor>
              }
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Panel
              title={t('vdash.teams')}
              actions={
                <SegmentedControl
                  size="xs"
                  value={teamMode}
                  onChange={(v) => setTeamMode(v as 'count' | 'perMember')}
                  data={[
                    { value: 'count', label: t('vdash.modeCount') },
                    { value: 'perMember', label: t('vdash.modePerMember') },
                  ]}
                  className="no-print"
                />
              }
            >
              {s.byTeam.length ? (
                <>
                  <TeamsChart stats={s} mode={teamMode} />
                  <Group gap={6} mt="xs" wrap="wrap">
                    {s.byTeam.map((tm) => (
                      <TeamBadge key={tm.teamId} name={tm.teamName} color={tm.color} size="sm" />
                    ))}
                  </Group>
                  {teamMode === 'perMember' ? (
                    <Text size="xs" c="dimmed" mt="xs">
                      {t('vdash.perMemberHint')}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {t('vdash.noData')}
                </Text>
              )}
            </Panel>

            <Panel title={t('vdash.topMembers')}>
              {s.topMembers.length ? (
                <Stack gap={10}>
                  {s.topMembers.map((m) => (
                    <Box key={m.memberId}>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Box style={{ minWidth: 0 }}>
                          <Text size="sm" fw={600} truncate>
                            {m.fullName}
                          </Text>
                        </Box>
                        <Group gap="xs" wrap="nowrap">
                          {m.teamName && m.color ? <TeamBadge name={m.teamName} color={m.color} size="sm" /> : null}
                          <Text size="sm" fw={700} className="num" miw={24} ta="end">
                            {formatNumber(m.count)}
                          </Text>
                        </Group>
                      </Group>
                      <Progress
                        value={(m.count / (s.topMembers[0]?.count || 1)) * 100}
                        color="breach"
                        size="sm"
                        mt={4}
                        aria-hidden
                      />
                    </Box>
                  ))}
                  <Text size="xs" c="dimmed">
                    {t('vdash.topMembersHint')}
                  </Text>
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  {t('vdash.noRepeat')}
                </Text>
              )}
            </Panel>
          </SimpleGrid>

          <Panel title={t('vdash.trend')}>
            {s.trend.length ? <TrendChart stats={s} /> : <Text size="sm" c="dimmed">{t('vdash.noData')}</Text>}
          </Panel>

          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
            <Panel title={t('vdash.byMonitor')}>
              {s.byMonitor.length ? <MonitorsChart stats={s} /> : <Text size="sm" c="dimmed">{t('vdash.noData')}</Text>}
            </Panel>
            <Panel title={t('vdash.byType')}>
              {s.byType.length ? <TypesChart stats={s} /> : <Text size="sm" c="dimmed">{t('vdash.noData')}</Text>}
            </Panel>
            <Panel title={t('vdash.bySeverity')}>
              {s.bySeverity.length ? <SeverityChart stats={s} /> : <Text size="sm" c="dimmed">{t('vdash.noData')}</Text>}
            </Panel>
          </SimpleGrid>

          <Panel title={t('vdash.heatmap')}>
            <HeatmapChart stats={s} />
            <Text size="xs" c="dimmed">
              {t('vdash.heatmapHint')}
            </Text>
          </Panel>

          <Panel title={t('vdash.map')}>
            <ClusterMap
              points={s.points}
              bbox={filter.bbox}
              onBbox={(bbox) => set({ bbox })}
              onSelect={(id) => navigate(`/violations?open=${encodeURIComponent(id)}`)}
              height={420}
            />
            {s.pointsTruncated ? (
              <Text size="xs" c="dimmed" mt="xs">
                {t('vlist.mapTruncated')}
              </Text>
            ) : null}
          </Panel>
        </Stack>
      ) : null}
    </Box>
  );
}
