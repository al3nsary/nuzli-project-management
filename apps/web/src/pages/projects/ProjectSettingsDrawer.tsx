/**
 * Project settings (admin): general fields, scheduling and calendar, the duration unit, and —
 * owner request A9 — the project's labels, custom fields and budget (ADR-093). Tabs live in the
 * URL (`?stab=`). The old «منح المشرفين العرض» section is gone: since A9 (ADR-092) a project grant
 * opens nothing, supervisors work only through the tasks assigned to them.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  ColorInput,
  Drawer,
  Group,
  NumberInput,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  Title,
  useDirection,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconPencil, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { CUSTOM_FIELD_TYPES, type CustomFieldDto, type CustomFieldType, type LabelDto, type ProjectStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qk4, useCalendars } from '../../api/projectQueries';
import { invalidateProjectReads } from '../../api/a9Queries';
import { unitOf, type GanttView, type ProjectView } from '../../api/hoursWire';
import { FormError } from '../../components/ui';
import { formatMoney, formatNumber, t } from '../../i18n';
import { useTabParam } from '../../lib/useUrlState';
import { PROJECT_STATUSES, projectStatusLabel } from './parts';

const SWATCHES = ['#303F9F', '#1565C0', '#00838F', '#2E7D32', '#9E9D24', '#F9A825', '#EF6C00', '#C62828', '#AD1457', '#6A1B9A', '#5D4037', '#546E7A'];

export function ProjectSettingsDrawer({ opened, onClose, project, data }: { opened: boolean; onClose(): void; project: ProjectView; data: GanttView }) {
  const { dir } = useDirection();
  const phone = useMediaQuery('(max-width: 600px)') ?? false;
  const [tab, setTab] = useTabParam('stab', ['general', 'labels', 'fields', 'budget'] as const, 'general');
  return (
    <Drawer opened={opened} onClose={onClose} position={dir === 'rtl' ? 'left' : 'right'} size={phone ? '100%' : 'lg'} title={t('projects.settings')}>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="general">{t('settings.tab.general')}</Tabs.Tab>
          <Tabs.Tab value="labels">{t('settings.tab.labels')}</Tabs.Tab>
          <Tabs.Tab value="fields">{t('settings.tab.fields')}</Tabs.Tab>
          <Tabs.Tab value="budget">{t('settings.tab.budget')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="general">
          <GeneralPanel project={project} onClose={onClose} opened={opened} />
        </Tabs.Panel>
        <Tabs.Panel value="labels">
          <LabelsPanel projectId={project.id} labels={data.labels ?? []} />
        </Tabs.Panel>
        <Tabs.Panel value="fields">
          <FieldsPanel projectId={project.id} fields={data.customFields ?? []} />
        </Tabs.Panel>
        <Tabs.Panel value="budget">
          <BudgetPanel project={project} />
        </Tabs.Panel>
      </Tabs>
    </Drawer>
  );
}

// ---------------------------------------------------------------- duration unit (A9, ADR-109)

/**
 * «تحويل إلى ساعات / أيام» through `POST /projects/:id/convert`: a confirmation that says what
 * happens (each task keeps its working days; lags follow the standard day) and the milestone
 * caveat, then the conversion in one transaction (audited `project.converted`).
 */
function UnitConvert({ project, onDone }: { project: ProjectView; onDone(): Promise<void> }) {
  const api = useApi();
  const unit = unitOf(project);
  const target = unit === 'HOUR' ? 'DAY' : 'HOUR';
  const [busy, setBusy] = useState(false);
  const ask = () =>
    modals.openConfirmModal({
      title: t(target === 'HOUR' ? 'convert.toHoursTitle' : 'convert.toDaysTitle'),
      children: (
        <Stack gap="xs">
          <Text size="sm">{t(target === 'HOUR' ? 'convert.toHoursBody' : 'convert.toDaysBody', { count: project.taskCount })}</Text>
          <Alert color="signal" variant="light">
            <Text size="sm">{t('convert.milestoneCaveat')}</Text>
          </Alert>
        </Stack>
      ),
      labels: { confirm: t(target === 'HOUR' ? 'convert.toHours' : 'convert.toDays'), cancel: t('common.cancel') },
      onConfirm: async () => {
        setBusy(true);
        try {
          await api.projects.convert(project.id, target);
          await onDone();
          notifications.show({ color: 'ok', message: t(target === 'HOUR' ? 'convert.doneHours' : 'convert.doneDays') });
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        } finally {
          setBusy(false);
        }
      },
    });
  return (
    <div>
      <Text size="sm" fw={500} mb={4}>
        {t('createProject.unit')}
      </Text>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <span className="pill brand" data-testid="project-unit">
          {t(unit === 'HOUR' ? 'createProject.unit.HOUR' : 'createProject.unit.DAY')}
        </span>
        <Button size="xs" variant="light" loading={busy} onClick={ask}>
          {t(target === 'HOUR' ? 'convert.toHours' : 'convert.toDays')}
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {t('convert.hint')}
      </Text>
    </div>
  );
}

// ---------------------------------------------------------------- general

function GeneralPanel({ project, onClose, opened }: { project: ProjectView; onClose(): void; opened: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const calendars = useCalendars(opened);
  const initial = () => ({
    name: project.name,
    description: project.description ?? '',
    startDate: project.startDate,
    status: project.status,
    calendarId: project.calendarId,
    autoSchedule: project.autoSchedule,
  });
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opened) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, project]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.gantt(project.id) });
    invalidateProjectReads(qc, project.id);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (form.name.trim() !== project.name) patch.name = form.name.trim();
      if (form.description.trim() && form.description !== (project.description ?? '')) patch.description = form.description;
      if (form.startDate !== project.startDate) patch.startDate = form.startDate;
      if (form.status !== project.status) patch.status = form.status;
      if (form.calendarId !== project.calendarId) patch.calendarId = form.calendarId;
      if (form.autoSchedule !== project.autoSchedule) patch.autoSchedule = form.autoSchedule;
      if (Object.keys(patch).length) {
        await api.projects.update(project.id, patch);
        await refresh();
        notifications.show({ color: 'ok', message: patch.calendarId || patch.autoSchedule === true ? t('projects.savedRescheduled') : t('common.saved') });
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const archive = () =>
    modals.openConfirmModal({
      title: t('projects.archiveTitle'),
      children: <Text size="sm">{t('projects.archiveBody', { name: project.name })}</Text>,
      labels: { confirm: t('projects.archive'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.projects.archive(project.id);
          await qc.invalidateQueries({ queryKey: ['projects'] });
          onClose();
          navigate('/projects');
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });

  return (
    <Stack>
      <FormError error={error} />
      <TextInput label={t('projects.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
      <Textarea label={t('projects.description')} autosize minRows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <TextInput type="date" label={t('projects.startDate')} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.currentTarget.value })} />
        <Select
          label={t('projects.status')}
          data={PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => ({ value: s, label: projectStatusLabel(s) }))}
          value={form.status}
          onChange={(v) => v && setForm({ ...form, status: v as ProjectStatus })}
          allowDeselect={false}
        />
      </SimpleGrid>
      <UnitConvert project={project} onDone={refresh} />
      <Select
        label={t('projects.calendar')}
        description={t('projects.calendarChangeHint')}
        data={(calendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        value={form.calendarId}
        onChange={(v) => v && setForm({ ...form, calendarId: v })}
        allowDeselect={false}
      />
      <Switch label={t('projects.autoSchedule')} description={t('projects.autoScheduleHint')} checked={form.autoSchedule} onChange={(e) => setForm({ ...form, autoSchedule: e.currentTarget.checked })} />
      <Group justify="flex-end">
        <Button onClick={() => void save()} loading={busy}>
          {t('projects.saveSettings')}
        </Button>
      </Group>
      <Alert color="gray" variant="light" mt="md">
        <Text size="sm">{t('projects.archiveHint', { count: project.taskCount })}</Text>
        <Button mt="xs" size="xs" color="breach" variant="light" onClick={archive}>
          {t('projects.archive')}
        </Button>
      </Alert>
    </Stack>
  );
}

// ---------------------------------------------------------------- labels

function LabelsPanel({ projectId, labels }: { projectId: string; labels: LabelDto[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]!);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', color: '' });
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
    invalidateProjectReads(qc, projectId);
  };
  const add = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      await api.labels.create(projectId, { name: name.trim(), color });
      setName('');
      await refresh();
      notifications.show({ color: 'ok', message: t('labels.saved') });
    } catch (err) {
      setError(err);
    }
  };
  const saveEdit = async (id: string) => {
    setError(null);
    try {
      await api.labels.update(id, { name: draft.name.trim(), color: draft.color });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const remove = (l: LabelDto) =>
    modals.openConfirmModal({
      title: t('labels.delete', { name: l.name }),
      children: <Text size="sm">{t('labels.deleteBody', { name: l.name })}</Text>,
      labels: { confirm: t('labels.delete', { name: l.name }), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.labels.remove(l.id);
          await refresh();
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });
  return (
    <Stack>
      <div>
        <Title order={3} fz="md">
          {t('labels.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('labels.lead')}
        </Text>
      </div>
      <FormError error={error} />
      <Stack gap={6}>
        {labels.length ? (
          labels.map((l) =>
            editing === l.id ? (
              <Group key={l.id} gap="xs" wrap="nowrap" align="flex-end">
                <TextInput aria-label={t('labels.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} style={{ flex: 1 }} />
                <ColorInput aria-label={t('labels.color')} value={draft.color} onChange={(v) => setDraft({ ...draft, color: v })} swatches={SWATCHES} format="hex" w={130} />
                <ActionIcon variant="light" color="ok" size="lg" aria-label={t('common.save')} onClick={() => void saveEdit(l.id)}>
                  <IconCheck size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" size="lg" aria-label={t('common.cancel')} onClick={() => setEditing(null)}>
                  <IconX size={16} />
                </ActionIcon>
              </Group>
            ) : (
              <Group key={l.id} justify="space-between" wrap="nowrap" className="nz-set-row">
                <Group gap={8} wrap="nowrap">
                  <span className="nz-label-swatch" style={{ background: l.color }} aria-hidden />
                  <Text size="sm" fw={500}>
                    {l.name}
                  </Text>
                </Group>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" aria-label={`${t('common.edit')}: ${l.name}`} onClick={() => (setEditing(l.id), setDraft({ name: l.name, color: l.color }))}>
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="breach" aria-label={t('labels.delete', { name: l.name })} onClick={() => remove(l)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
            ),
          )
        ) : (
          <Text size="sm" c="dimmed">
            {t('labels.empty')}
          </Text>
        )}
      </Stack>
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <TextInput
          label={t('labels.name')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void add();
          }}
          style={{ flex: 1 }}
        />
        <ColorInput label={t('labels.color')} value={color} onChange={setColor} swatches={SWATCHES} format="hex" w={140} />
        <Button leftSection={<IconPlus size={16} />} onClick={() => void add()} disabled={!name.trim()}>
          {t('labels.add')}
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------- custom fields

function FieldsPanel({ projectId, fields }: { projectId: string; fields: CustomFieldDto[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('TEXT');
  const [options, setOptions] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; options: string[] }>({ name: '', options: [] });
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
    invalidateProjectReads(qc, projectId);
  };
  const add = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      await api.customFields.create(projectId, { name: name.trim(), type, ...(type === 'DROPDOWN' ? { options } : {}) });
      setName('');
      setOptions([]);
      await refresh();
      notifications.show({ color: 'ok', message: t('fields.saved') });
    } catch (err) {
      setError(err);
    }
  };
  const saveEdit = async (f: CustomFieldDto) => {
    setError(null);
    try {
      await api.customFields.update(f.id, { name: draft.name.trim(), ...(f.type === 'DROPDOWN' ? { options: draft.options } : {}) });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const remove = (f: CustomFieldDto) =>
    modals.openConfirmModal({
      title: t('fields.delete', { name: f.name }),
      children: <Text size="sm">{t('fields.deleteBody', { name: f.name })}</Text>,
      labels: { confirm: t('fields.delete', { name: f.name }), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await api.customFields.remove(f.id);
          await refresh();
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });
  return (
    <Stack>
      <div>
        <Title order={3} fz="md">
          {t('fields.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('fields.lead')}
        </Text>
      </div>
      <FormError error={error} />
      <Stack gap={6}>
        {fields.length ? (
          fields.map((f) =>
            editing === f.id ? (
              <Stack key={f.id} gap={6} className="nz-set-row">
                <TextInput aria-label={t('fields.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
                {f.type === 'DROPDOWN' ? <TagsInput aria-label={t('fields.options')} description={t('fields.optionsHint')} value={draft.options} onChange={(v) => setDraft({ ...draft, options: v })} /> : null}
                <Text size="xs" c="dimmed">
                  {t('fields.typeFixed')}
                </Text>
                <Group gap="xs" justify="flex-end">
                  <Button size="xs" variant="default" onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button size="xs" onClick={() => void saveEdit(f)}>
                    {t('common.save')}
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Group key={f.id} justify="space-between" wrap="nowrap" className="nz-set-row">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6}>
                    <Text size="sm" fw={500}>
                      {f.name}
                    </Text>
                    <Badge size="sm" variant="light" color="gray">
                      {t(`fields.type.${f.type}`)}
                    </Badge>
                  </Group>
                  {f.type === 'DROPDOWN' ? (
                    <Text size="xs" c="dimmed" truncate>
                      {f.options.join('، ')}
                    </Text>
                  ) : null}
                </div>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" aria-label={`${t('common.edit')}: ${f.name}`} onClick={() => (setEditing(f.id), setDraft({ name: f.name, options: f.options }))}>
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="breach" aria-label={t('fields.delete', { name: f.name })} onClick={() => remove(f)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
            ),
          )
        ) : (
          <Text size="sm" c="dimmed">
            {t('fields.empty')}
          </Text>
        )}
      </Stack>
      <Stack gap="xs" className="surface-card" p="sm">
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <TextInput label={t('fields.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Select
            label={t('fields.type')}
            data={CUSTOM_FIELD_TYPES.map((x) => ({ value: x, label: t(`fields.type.${x}`) }))}
            value={type}
            onChange={(v) => v && setType(v as CustomFieldType)}
            allowDeselect={false}
          />
        </SimpleGrid>
        {type === 'DROPDOWN' ? <TagsInput label={t('fields.options')} description={t('fields.optionsHint')} value={options} onChange={setOptions} /> : null}
        <Group justify="flex-end">
          <Button leftSection={<IconPlus size={16} />} onClick={() => void add()} disabled={!name.trim()}>
            {t('fields.add')}
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------- budget

function BudgetPanel({ project }: { project: ProjectView }) {
  const api = useApi();
  const qc = useQueryClient();
  const [amount, setAmount] = useState<number | ''>(project.budget ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setAmount(project.budget ?? ''), [project.budget]);
  const pct = project.budgetUsedPct ?? null;
  const tone = pct === null ? 'field' : pct > 100 ? 'breach' : pct > 90 ? 'signal' : 'field';
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.projects.update(project.id, { budget: amount === '' ? null : Number(amount) });
      await qc.invalidateQueries({ queryKey: qk4.gantt(project.id) });
      invalidateProjectReads(qc, project.id);
      notifications.show({ color: 'ok', message: t('budget.saved') });
    } catch (err) {
      setError(err instanceof ApiError ? err : err);
    } finally {
      setBusy(false);
    }
  };
  const remaining = project.budget != null ? project.budget - (project.actualCost ?? 0) : null;
  return (
    <Stack>
      <div>
        <Title order={3} fz="md">
          {t('budget.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('budget.lead')}
        </Text>
      </div>
      <FormError error={error} />
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <NumberInput
          label={t('budget.amount')}
          placeholder={t('budget.none')}
          min={0}
          decimalScale={2}
          thousandSeparator=","
          rightSection={<Text size="xs" c="dimmed" pe={8}>{t('money.sar')}</Text>}
          rightSectionWidth={44}
          value={amount}
          onChange={(v) => setAmount(v === '' ? '' : Number(v))}
          style={{ flex: 1 }}
        />
        <Button onClick={() => void save()} loading={busy}>
          {t('common.save')}
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 3 }} className="nz-budget-kpis">
        <div className="surface-card nz-budget-kpi">
          <Text size="xs" c="dimmed">
            {t('budget.planned')}
          </Text>
          <Text fw={700} className="num">
            {formatMoney(project.plannedCost ?? 0, project.currency)}
          </Text>
        </div>
        <div className="surface-card nz-budget-kpi">
          <Text size="xs" c="dimmed">
            {t('budget.actual')}
          </Text>
          <Text fw={700} className="num" c={pct !== null && pct > 100 ? 'var(--red)' : undefined}>
            {formatMoney(project.actualCost ?? 0, project.currency)}
          </Text>
        </div>
        <div className="surface-card nz-budget-kpi">
          <Text size="xs" c="dimmed">
            {t('budget.remaining')}
          </Text>
          <Text fw={700} className="num" c={remaining !== null && remaining < 0 ? 'var(--red)' : undefined}>
            {remaining === null ? t('budget.none') : formatMoney(remaining, project.currency)}
          </Text>
        </div>
      </SimpleGrid>
      {pct !== null ? (
        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm">{t('budget.usedPct', { pct: formatNumber(Math.round(pct)) })}</Text>
            {remaining !== null && remaining < 0 ? (
              <Text size="sm" c="var(--red)" fw={600}>
                {t('budget.over', { amount: formatMoney(-remaining, project.currency) })}
              </Text>
            ) : null}
          </Group>
          <Progress value={Math.min(100, pct)} color={tone} size="lg" radius="xl" aria-label={t('budget.used')} />
        </div>
      ) : null}
    </Stack>
  );
}
