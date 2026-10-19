/**
 * Step 3 of the import wizard (ADR-117): what the project will be — name and start (editable;
 * a new start re-bases every task by its working offset), unit, the calendar with its working
 * days and hours, the numbers, the warnings in Arabic, a read-only Gantt of the imported tasks
 * (hierarchy, bars, milestones, links, working hours), and «تعيين المسؤولين»: every assignee name
 * of the file → an ACTIVE supervisor (an exact-name match preselected) or «بلا مسؤول». Then the
 * commit creates the project in one transaction and opens it.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconScanEye, IconUserQuestion } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportPreviewDto } from '@nuzli/shared';
import { useApi } from '../../../api/context';
import { ApiError } from '../../../api/errors';
import { useSupervisors } from '../../../api/queries';
import { useAuthStore } from '../../../stores/auth';
import { Gantt } from '../../../features/gantt/Gantt';
import { zoomsFor, type Zoom } from '../../../features/gantt/geometry';
import type { ColumnPref } from '../../../features/gantt/columns';
import {
  previewGantt,
  workingDaysOf,
  type MappedAssignee,
} from '../../../features/imports/previewGantt';
import { warningLabel } from '../../../features/imports/messages';
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatHours,
  formatLocalTime,
  formatNumber,
  getDisplayPrefs,
  hasKey,
  t,
  tKey,
  type MessageKey,
  tCount,
} from '../../../i18n';
import { ImportErrorAlert } from './ImportWizardPage';

const NONE = '__none__';
/** The API's name when neither the file nor the options give one. */
const DEFAULT_NAME = 'مشروع مستورد';
const COLUMNS: ColumnPref[] = [
  { id: 'wbs', width: 56 },
  { id: 'name', width: 230 },
  { id: 'start', width: 96 },
  { id: 'end', width: 96 },
  { id: 'duration', width: 76 },
  { id: 'assignee', width: 140 },
];
const PHONE_COLUMNS: ColumnPref[] = [{ id: 'name', width: 150 }];
const noop = () => undefined;

export function ImportPreview({
  preview,
  onBack,
  onCommitting,
  onExpired,
  fileName,
}: {
  preview: ImportPreviewDto;
  /** The uploaded file's name: the default project name when the file carries no title. */
  fileName?: string;
  onBack(): void;
  onCommitting(on: boolean): void;
  onExpired(): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const phone = useMediaQuery('(max-width: 600px)') ?? false;
  const user = useAuthStore((s) => s.user);
  const supervisors = useSupervisors();
  const pv = preview;
  const hours = pv.project.durationUnit === 'HOUR';
  const [name, setName] = useState(() => {
    const base =
      fileName
        ?.replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .trim() ?? '';
    return pv.project.name === DEFAULT_NAME && base.length >= 2
      ? base.slice(0, 160)
      : pv.project.name;
  });
  const [startDate, setStartDate] = useState(pv.project.startDate.slice(0, 10));
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(pv.unmappedAssignees.map((a) => [a.name, a.suggestedUserId ?? NONE])),
  );
  const [zoom, setZoom] = useState<Zoom>(hours ? 'day' : 'week');
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const active = useMemo(
    () => (supervisors.data ?? []).filter((u) => u.status === 'ACTIVE' && u.role === 'SUPERVISOR'),
    [supervisors.data],
  );
  const options = useMemo(
    () => [
      { value: NONE, label: t('import.map.none') },
      ...active.map((u) => ({ value: u.id, label: u.fullName })),
    ],
    [active],
  );
  const mapped = useMemo(() => {
    const byId = new Map(active.map((u) => [u.id, u]));
    const out = new Map<string, MappedAssignee | null>();
    for (const [n, id] of Object.entries(map)) {
      const u = id === NONE ? null : byId.get(id);
      out.set(n, u ? { id: u.id, fullName: u.fullName } : null);
    }
    return out;
  }, [map, active]);
  const data = useMemo(() => previewGantt(pv, mapped), [pv, mapped]);
  const unmapped = Object.values(map).filter((v) => v === NONE).length;

  const cal = pv.project.calendar;
  const firstStart = pv.tasks.reduce<string | null>(
    (m, x) => (m === null || x.startDate < m ? x.startDate : m),
    null,
  );
  /** `YYYY-MM-DD` or a local `YYYY-MM-DDTHH:MM` (HOUR) as «١ نوفمبر ٢٠٢٦ ٨:٠٠ ص». */
  const localLabel = (v: string) =>
    v.length > 10 ? `${formatDate(v.slice(0, 10))} ${formatLocalTime(v)}` : formatDate(v);
  const holidays = cal.exceptions.filter((e) => !e.isWorking).length;
  // A10: the format the content was recognised as (a GanttPRO export chosen as «Excel», …).
  const detected = pv.detectedFormat ?? pv.format;
  const formatName = (f: string) => tKey(`import.format.${f}`, 'import.format.other');
  const sourceTypes = Object.entries(pv.stats.sourceTypes ?? {});
  const warnings = showAllWarnings ? pv.warnings : pv.warnings.slice(0, 6);

  const commit = async () => {
    if (name.trim().length < 2) {
      setError(new ApiError(400, 'VALIDATION_FAILED', t('import.preview.nameRequired')));
      return;
    }
    setBusy(true);
    setError(null);
    onCommitting(true);
    try {
      const assigneeMap = Object.fromEntries(
        Object.entries(map).map(([n, id]) => [n, id === NONE ? null : id]),
      );
      const res = await api.imports.commit({
        previewId: pv.previewId,
        assigneeMap,
        ...(name.trim() !== pv.project.name ? { name: name.trim() } : {}),
        ...(startDate && startDate !== pv.project.startDate.slice(0, 10) ? { startDate } : {}),
      });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      notifications.show({
        color: 'ok',
        message: t('import.done', {
          name: name.trim(),
          tasks: formatNumber(res.taskCount),
          links: formatNumber(res.dependencyCount),
        }),
      });
      navigate(`/projects/${res.projectId}`, { replace: true });
    } catch (err) {
      setError(err);
      onCommitting(false);
    } finally {
      setBusy(false);
    }
  };

  const expired = error instanceof ApiError && error.code === 'IMPORT_PREVIEW_EXPIRED';

  return (
    <Stack gap="lg" className="nz-imp-preview">
      {detected !== pv.format || detected === 'ganttpro' ? (
        <Alert
          color="ok"
          variant="light"
          icon={<IconScanEye size={18} />}
          title={
            detected === 'ganttpro'
              ? t('import.detected.ganttpro')
              : detected === 'xml'
                ? t('import.detected.xml')
                : t('import.detected.other', { format: formatName(detected) })
          }
          data-testid="import-detected"
        >
          <Stack gap={4}>
            {detected !== pv.format ? (
              <Text size="sm">{t('import.detected.differs', { chosen: formatName(pv.format) })}</Text>
            ) : null}
            {detected === 'ganttpro' ? (
              <Text size="sm">{t('import.detected.ganttproBody')}</Text>
            ) : null}
          </Stack>
        </Alert>
      ) : null}
      {/* Summary */}
      <section className="nz-imp-card surface-card" aria-labelledby="imp-sum">
        <Text id="imp-sum" fw={600} mb="sm">
          {t('import.preview.project')}
        </Text>
        <div className="nz-imp-sum">
          <TextInput
            label={t('import.preview.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={160}
            required
          />
          <TextInput
            type="date"
            label={t('import.preview.start')}
            description={t('import.preview.startHint')}
            value={startDate}
            onChange={(e) => setStartDate(e.currentTarget.value)}
          />
          <div className="nz-imp-fact">
            <span className="nz-imp-fact-label">{t('import.preview.unit')}</span>
            <span className="pill brand" data-testid="import-unit">
              {t(hours ? 'createProject.unit.HOUR' : 'createProject.unit.DAY')}
            </span>
          </div>
          <div className="nz-imp-fact">
            <span className="nz-imp-fact-label">{t('import.preview.format')}</span>
            <span data-testid="import-format">{formatName(detected)}</span>
          </div>
        </div>
        <div className="nz-imp-cal" aria-label={t('import.preview.calendar')}>
          <Text size="sm" fw={600}>
            {t('import.preview.calendar')}: <span className="nz-imp-dim">{cal.name}</span>
          </Text>
          <div className="nz-imp-days" role="list" aria-label={t('createProject.workingDays')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = workingDaysOf(cal.weekendDays).includes(d);
              return (
                <span
                  key={d}
                  role="listitem"
                  className="nz-cp-day nz-imp-day"
                  data-on={on || undefined}
                  aria-label={`${t(`weekday.${d}` as 'weekday.0')}: ${on ? t('import.preview.workDay') : t('import.preview.offDay')}`}
                >
                  {t(`weekdayShort.${d}` as 'weekdayShort.0')}
                </span>
              );
            })}
          </div>
          <Text size="sm" data-testid="import-hours">
            {t('createProject.workingHours')}:{' '}
            {cal.workingHours
              .map((w) => `${formatClock(w.start)} – ${formatClock(w.end)}`)
              .join('، ')}
          </Text>
          {holidays ? (
            <Text size="xs" c="dimmed">
              {t('import.preview.holidays', { n: formatNumber(holidays) })}
            </Text>
          ) : null}
        </div>
        <div className="nz-imp-stats" role="list">
          <Stat label={t('import.stats.tasks')} value={pv.stats.taskCount} />
          <Stat label={t('import.stats.groups')} value={pv.stats.groupCount} />
          <Stat label={t('import.stats.milestones')} value={pv.stats.milestoneCount} />
          <Stat label={t('import.stats.links')} value={pv.stats.dependencyCount} />
          {pv.stats.maxLevel ? <Stat label={t('import.stats.levels')} value={pv.stats.maxLevel} /> : null}
          {pv.stats.colorCount ? <Stat label={t('import.stats.colors')} value={pv.stats.colorCount} /> : null}
          {pv.stats.deadlineCount ? (
            <Stat label={t('import.stats.deadlines')} value={pv.stats.deadlineCount} />
          ) : null}
          <Stat
            label={t('import.stats.warnings')}
            value={pv.warnings.length}
            tone={pv.warnings.length ? 'wait' : undefined}
          />
        </div>
        {sourceTypes.length ? (
          <Text size="xs" c="dimmed" mt="xs" data-testid="import-source-types">
            {t('import.stats.sourceTypes', {
              list: sourceTypes
                .map(([k, n]) =>
                  hasKey(`import.stats.sourceType.${k}`)
                    ? t(`import.stats.sourceType.${k}` as MessageKey, { n: formatNumber(n) })
                    : `${k}: ${formatNumber(n)}`,
                )
                .join('، '),
            })}
            {pv.stats.estimatedHours || pv.stats.timeLogMinutes
              ? ` · ${t('import.stats.notImported', { hours: formatNumber(pv.stats.estimatedHours ?? 0), minutes: formatNumber(pv.stats.timeLogMinutes ?? 0) })}`
              : ''}
          </Text>
        ) : null}
      </section>

      {/* Warnings */}
      {pv.warnings.length ? (
        <section className="nz-imp-card surface-card" aria-labelledby="imp-warn">
          <Group gap={8} mb="xs">
            <IconAlertTriangle size={18} color="var(--amber)" aria-hidden />
            <Text id="imp-warn" fw={600}>
              {t('import.warnings.title', { n: formatNumber(pv.warnings.length) })}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mb="sm">
            {t('import.warnings.lead')}
          </Text>
          <ul className="nz-imp-warnings">
            {warnings.map((w, i) => (
              <li key={i}>
                <Badge size="sm" variant="light" color="signal" className="nz-imp-warn-code">
                  {warningLabel(w.code)}
                </Badge>
                <span>{isolateRanges(w.message_ar)}</span>
                {w.row ? (
                  <span className="nz-imp-dim num">
                    {t('import.warnings.row', { n: formatNumber(w.row) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {pv.warnings.length > 6 ? (
            <Button
              size="compact-sm"
              variant="subtle"
              mt={6}
              onClick={() => setShowAllWarnings((s) => !s)}
            >
              {showAllWarnings
                ? t('import.warnings.less')
                : t('import.warnings.all', { n: formatNumber(pv.warnings.length) })}
            </Button>
          ) : null}
        </section>
      ) : null}

      {/* Gantt */}
      <section className="nz-imp-card surface-card" aria-labelledby="imp-gantt">
        <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
          <Text id="imp-gantt" fw={600}>
            {t('import.preview.gantt')}
          </Text>
          <SegmentedControl
            size="xs"
            value={zoom}
            onChange={(v) => setZoom(v as Zoom)}
            data={zoomsFor(pv.project.durationUnit).map((z) => ({
              value: z,
              label: t(`zoom.${z}` as 'zoom.day'),
            }))}
            aria-label={t('import.preview.zoom')}
          />
        </Group>
        <Text size="xs" c="dimmed" mb="xs">
          {hours
            ? t('import.preview.ganttHintHours', { links: formatNumber(pv.stats.dependencyCount) })
            : t('import.preview.ganttHint', { links: formatNumber(pv.stats.dependencyCount) })}
        </Text>
        <div className="nz-imp-gantt" data-testid="import-gantt">
          <Gantt
            data={data}
            zoom={zoom}
            showHijri={user?.preferences.showHijri ?? false}
            digits={getDisplayPrefs().digits}
            editable={false}
            columns={phone ? PHONE_COLUMNS : COLUMNS}
            onOpenTask={noop}
            onCommit={noop}
            onLink={noop}
            onLinkRefused={noop}
          />
        </div>
        <Text size="xs" c="dimmed" mt="xs">
          {t('import.preview.range', {
            from: localLabel(firstStart ?? pv.project.startDate),
            to: data.project.endDate ? localLabel(data.project.endDate) : '—',
          })}
          {hours
            ? ` · ${t('import.preview.totalHours', { h: formatHours(pv.tasks.filter((x) => x.type === 'TASK').reduce((s, x) => s + (x.durationHours ?? 0), 0)) })}`
            : ''}
        </Text>
      </section>

      {/* Assignees */}
      <section className="nz-imp-card surface-card" aria-labelledby="imp-map">
        <Group gap={8} mb={4}>
          <IconUserQuestion size={18} aria-hidden />
          <Text id="imp-map" fw={600}>
            {t('import.map.title')}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          {t('import.map.lead')}
        </Text>
        {pv.unmappedAssignees.length ? (
          <Table.ScrollContainer minWidth={320}>
            <Table verticalSpacing="xs" className="nz-imp-map">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('import.map.name')}</Table.Th>
                  <Table.Th>{t('import.map.tasks')}</Table.Th>
                  <Table.Th>{t('import.map.supervisor')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pv.unmappedAssignees.map((a) => (
                  <Table.Tr key={a.name}>
                    <Table.Td>
                      <span dir="auto">{a.name}</span>
                      {a.suggestedUserId && map[a.name] === a.suggestedUserId ? (
                        <Badge size="xs" variant="light" color="ok" ms={6}>
                          {t('import.map.suggested')}
                        </Badge>
                      ) : null}
                    </Table.Td>
                    <Table.Td className="num">{formatNumber(a.taskCount)}</Table.Td>
                    <Table.Td miw={200}>
                      <Select
                        aria-label={t('import.map.selectFor', { name: a.name })}
                        data={options}
                        value={map[a.name] ?? NONE}
                        onChange={(v) => setMap((m) => ({ ...m, [a.name]: v ?? NONE }))}
                        searchable
                        allowDeselect={false}
                        nothingFoundMessage={t('import.map.noMatch')}
                        comboboxProps={{ withinPortal: true }}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Text size="sm" c="dimmed">
            {t('import.map.empty')}
          </Text>
        )}
        {unmapped ? (
          <Text size="xs" c="dimmed" mt="xs">
            {t('import.map.unassignedNote', { n: formatNumber(unmapped) })}
          </Text>
        ) : null}
      </section>

      {error ? (
        <ImportErrorAlert error={error}>
          {expired ? (
            <>
              <Text size="xs">{t('import.err.evicted')}</Text>
              <Button
                size="xs"
                variant="light"
                color="breach"
                onClick={onExpired}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('import.preview.reupload')}
              </Button>
            </>
          ) : null}
        </ImportErrorAlert>
      ) : null}
      <Text size="xs" c="dimmed">
        {t('import.preview.expires', { at: formatDateTime(pv.expiresAt) })}
      </Text>
      <Group justify="space-between" className="nz-imp-actions">
        <Button variant="default" onClick={onBack} disabled={busy}>
          {t('import.preview.back')}
        </Button>
        <Button onClick={() => void commit()} loading={busy} disabled={expired}>
          {t('import.preview.commit', { n: tCount('projects.taskCount', pv.stats.taskCount) })}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * Time and number ranges in the server's Arabic text («10:00–14:00») are isolated left-to-right,
 * else the bidi algorithm shows them reversed («14:00–10:00») inside the Arabic sentence.
 */
export const isolateRanges = (s: string): string =>
  s.replace(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/g, (m) => `⁦${m}⁩`);

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'wait' }) {
  return (
    <div className="nz-imp-stat" role="listitem" data-tone={tone}>
      <span className="nz-imp-stat-value num">{formatNumber(value)}</span>
      <span className="nz-imp-stat-label">{label}</span>
    </div>
  );
}
