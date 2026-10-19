/**
 * «إنشاء مشروع جديد» — the GanttPRO create-project form (owner screenshot 2), in this order:
 * اسم المشروع · تاريخ البدء · وحدة المدة (أيام/ساعات) · القالب · أيام العمل (الأحد…السبت) ·
 * ساعات العمل (فترات) · الميزانية · «إنشاء مشروع جديد» — then «أو» and the two import buttons
 * «استيراد Excel، CSV، MPP» and «استيراد من Jira», which open the import wizard (ADR-117).
 * No AI option (owner decision).
 *
 * Working days and hours are sent as `workingDays` / `workingHours` (ADR-109): the API reuses
 * the base calendar when they equal it, otherwise it creates one for the project.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconBrandTrello, IconFileImport, IconPlus, IconX } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useTemplates } from '../../api/a9Queries';
import { DEFAULT_WORKING_HOURS, type DurationUnit, type WorkingInterval } from '../../api/hoursWire';
import { FormError } from '../../components/ui';
import { formatClock, formatNumber, t } from '../../i18n';
import { riyadhToday } from '../../features/projects/engine';
import './a9-projects.css';

const WEEK = [0, 1, 2, 3, 4, 5, 6] as const;
const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];

const minutesOf = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Sorted, non-overlapping, each end after its start. */
export function intervalsValid(list: readonly WorkingInterval[]): boolean {
  if (!list.length) return false;
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    if (minutesOf(w.end) <= minutesOf(w.start)) return false;
    if (i > 0 && minutesOf(w.start) < minutesOf(sorted[i - 1]!.end)) return false;
  }
  return true;
}

export const hoursPerDay = (list: readonly WorkingInterval[]) =>
  list.reduce((s, w) => s + Math.max(0, minutesOf(w.end) - minutesOf(w.start)), 0) / 60;

export function CreateProjectDialog({ opened, onClose }: { opened: boolean; onClose(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const phone = useMediaQuery('(max-width: 600px)') ?? false;
  const templates = useTemplates(opened);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(riyadhToday());
  const [unit, setUnit] = useState<DurationUnit>('DAY');
  const [templateId, setTemplateId] = useState<string>('');
  const [workingDays, setWorkingDays] = useState<number[]>(DEFAULT_WORKING_DAYS);
  const [hours, setHours] = useState<WorkingInterval[]>(DEFAULT_WORKING_HOURS.map((w) => ({ ...w })));
  const [budget, setBudget] = useState<number | ''>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const hoursOk = intervalsValid(hours);
  const toggleDay = (d: number) => setWorkingDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const submit = async () => {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = t('common.required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) next.startDate = t('common.required');
    if (!workingDays.length) next.workingDays = t('createProject.noWorkingDay');
    if (!hoursOk) next.hours = t('createProject.intervalInvalid');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      // A9 (ADR-109): the API reuses the base calendar when the days and hours equal it, else it
      // creates «تقويم {name}» with its holidays — the form no longer builds calendars itself.
      const p = await api.projects.create({
        name: name.trim(),
        startDate,
        durationUnit: unit,
        workingDays: [...workingDays].sort((x, y) => x - y),
        workingHours: [...hours].sort((x, y) => x.start.localeCompare(y.start)),
        ...(budget === '' ? {} : { budget: Number(budget) }),
        ...(templateId ? { fromTemplateId: templateId } : {}),
      });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      notifications.show({ color: 'ok', message: t('createProject.created', { name: p.name }) });
      // Replace the ?create=1 entry: back from the new project returns to the list.
      navigate(`/projects/${p.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const templateOptions = useMemo(
    () => [{ value: '', label: t('createProject.template.default') }, ...(templates.data ?? []).map((p) => ({ value: p.id, label: p.name }))],
    [templates.data],
  );

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        title={t('createProject.title')}
        size={520}
        fullScreen={phone}
        centered
        classNames={{ title: 'nz-cp-title' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
          className="nz-cp"
        >
          <Stack gap="md">
            <FormError error={error instanceof ApiError && Object.keys(error.fieldErrors).length ? null : error} />
            <TextInput
              label={t('createProject.name')}
              placeholder={t('createProject.namePlaceholder')}
              required
              data-autofocus
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={errors.name}
            />
            <TextInput
              type="date"
              label={t('createProject.start')}
              required
              value={startDate}
              onChange={(e) => setStartDate(e.currentTarget.value)}
              error={errors.startDate}
            />
            <div>
              <Text component="label" className="nz-cp-label" id="cp-unit">
                {t('createProject.unit')}
              </Text>
              <SegmentedControl
                aria-labelledby="cp-unit"
                fullWidth
                value={unit}
                onChange={(v) => setUnit(v as DurationUnit)}
                data={[
                  { value: 'DAY', label: t('createProject.unit.DAY') },
                  { value: 'HOUR', label: t('createProject.unit.HOUR') },
                ]}
              />
              {unit === 'HOUR' ? (
                <Text size="xs" c="dimmed" mt={4}>
                  {t('createProject.unitHint')}
                </Text>
              ) : null}
            </div>
            <Select
              label={t('createProject.template')}
              data={templateOptions}
              value={templateId}
              onChange={(v) => setTemplateId(v ?? '')}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
            <div role="group" aria-labelledby="cp-days">
              <Text className="nz-cp-label" id="cp-days">
                {t('createProject.workingDays')}
              </Text>
              <div className="nz-cp-days">
                {WEEK.map((d) => {
                  const on = workingDays.includes(d);
                  return (
                    <UnstyledButton
                      key={d}
                      className="nz-cp-day"
                      data-on={on || undefined}
                      aria-pressed={on}
                      aria-label={t(`weekday.${d}` as 'weekday.0')}
                      onClick={() => toggleDay(d)}
                    >
                      {t(`weekdayShort.${d}` as 'weekdayShort.0')}
                    </UnstyledButton>
                  );
                })}
              </div>
              {errors.workingDays ? (
                <Text size="xs" c="var(--red)" mt={4} role="alert">
                  {errors.workingDays}
                </Text>
              ) : null}
            </div>
            <div role="group" aria-labelledby="cp-hours">
              <Group justify="space-between" gap={4}>
                <Text className="nz-cp-label" id="cp-hours">
                  {t('createProject.workingHours')}
                </Text>
                <Text size="xs" c="dimmed" className="num">
                  {t('createProject.hoursPerDay', { hours: formatNumber(hoursPerDay(hours)) })}
                </Text>
              </Group>
              <div className="nz-cp-hours">
                {hours.map((w, i) => (
                  <IntervalChip
                    key={i}
                    value={w}
                    onChange={(v) => setHours((cur) => cur.map((x, j) => (j === i ? v : x)))}
                    onRemove={hours.length > 1 ? () => setHours((cur) => cur.filter((_, j) => j !== i)) : undefined}
                  />
                ))}
                {hours.length < 4 ? (
                  <ActionIcon
                    variant="light"
                    size={34}
                    radius="xl"
                    aria-label={t('createProject.addInterval')}
                    onClick={() => {
                      const last = [...hours].sort((a, b) => a.end.localeCompare(b.end)).at(-1);
                      const start = last ? last.end : '09:00';
                      const s = Math.min(minutesOf(start), 22 * 60);
                      const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                      setHours((cur) => [...cur, { start: hm(s), end: hm(Math.min(24 * 60, s + 120)) }]);
                    }}
                  >
                    <IconPlus size={16} />
                  </ActionIcon>
                ) : null}
              </div>
              {errors.hours || !hoursOk ? (
                <Text size="xs" c="var(--red)" mt={4} role="alert">
                  {t('createProject.intervalInvalid')}
                </Text>
              ) : null}
            </div>
            <NumberInput
              label={t('createProject.budget')}
              description={t('createProject.budgetHint')}
              min={0}
              max={999_999_999_999}
              decimalScale={2}
              thousandSeparator=","
              rightSection={<Text size="xs" c="dimmed" pe={8}>{t('money.sar')}</Text>}
              rightSectionWidth={44}
              value={budget}
              onChange={(v) => setBudget(v === '' ? '' : Number(v))}
              error={errors.budget}
            />
            <Button type="submit" size="md" fullWidth loading={busy}>
              {t('createProject.submit')}
            </Button>
            <Divider label={t('createProject.or')} labelPosition="center" />
            <Button variant="default" fullWidth leftSection={<IconFileImport size={18} />} onClick={() => navigate('/projects/import', { replace: true })}>
              {t('createProject.importFile')}
            </Button>
            <Button variant="default" fullWidth leftSection={<IconBrandTrello size={18} />} onClick={() => navigate('/projects/import?source=jira-cloud&step=2', { replace: true })}>
              {t('createProject.importJira')}
            </Button>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

/** «٩:٠٠ ص – ١:٠٠ م ×» — click to edit the interval in a small popover. */
function IntervalChip({ value, onChange, onRemove }: { value: WorkingInterval; onChange(v: WorkingInterval): void; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const label = `${formatClock(value.start)} – ${formatClock(value.end)}`;
  return (
    <Popover opened={open} onChange={setOpen} position="bottom" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <span className="nz-cp-chip" data-invalid={minutesOf(value.end) <= minutesOf(value.start) || undefined}>
          <UnstyledButton className="nz-cp-chip-btn" onClick={() => setOpen((o) => !o)} aria-label={`${t('createProject.workingHours')}: ${label}`}>
            {label}
          </UnstyledButton>
          {onRemove ? (
            <UnstyledButton className="nz-cp-chip-x" aria-label={t('createProject.removeInterval', { range: label })} onClick={onRemove}>
              <IconX size={14} />
            </UnstyledButton>
          ) : null}
        </span>
      </Popover.Target>
      <Popover.Dropdown>
        <Group gap="xs" wrap="nowrap">
          <TextInput type="time" step={900} label={t('createProject.intervalFrom')} value={value.start} onChange={(e) => onChange({ ...value, start: e.currentTarget.value || value.start })} w={120} />
          <TextInput type="time" step={900} label={t('createProject.intervalTo')} value={value.end === '24:00' ? '23:59' : value.end} onChange={(e) => onChange({ ...value, end: e.currentTarget.value || value.end })} w={120} />
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

