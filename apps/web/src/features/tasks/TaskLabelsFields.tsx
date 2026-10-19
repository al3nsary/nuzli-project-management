/**
 * Labels and custom field values of a task (A9). `TaskLabelsFieldsView` is the read-only block
 * (supervisors); `TaskLabelsFieldsEditor` is the admin editor in the task drawer: toggling a label
 * goes through the versioned task write (undoable), field values through `PUT custom-values`.
 */
import { useEffect, useState } from 'react';
import { Badge, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconCheck, IconTag } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeCustomValue, type CustomFieldDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qkA9, useTaskFields, useTaskLabels } from '../../api/a9Queries';
import { qk4 } from '../../api/projectQueries';
import type { GanttView, TaskView } from '../../api/hoursWire';
import type { ProjectWrites } from '../../api/projectWrites';
import { inverseOf } from '../projects/undo';
import { formatDate, formatNumber, t } from '../../i18n';

type FieldWithValue = CustomFieldDto & { value: unknown };

/** A label chip: the colour always next to the name. */
export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="nz-label-chip">
      <span className="nz-label-dot" style={{ background: color }} aria-hidden />
      {name}
    </span>
  );
}

export function displayValue(field: CustomFieldDto, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'CHECKBOX') return value ? t('a9s.fields.yes') : t('a9s.fields.no');
  if (field.type === 'NUMBER' && typeof value === 'number') return formatNumber(value);
  if (field.type === 'DATE' && typeof value === 'string') return formatDate(value);
  return String(value);
}

export function TaskLabelsFieldsView({ taskId }: { taskId: string }) {
  const labels = useTaskLabels(taskId);
  const fields = useTaskFields(taskId);
  if (labels.isLoading || fields.isLoading) {
    return (
      <Text size="sm" c="dimmed">
        {t('app.loading')}
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      <div>
        <Text size="xs" c="dimmed" mb={4}>
          {t('a9s.labels.title')}
        </Text>
        {labels.data?.length ? (
          <Group gap={6}>
            {labels.data.map((l) => (
              <LabelChip key={l.id} name={l.name} color={l.color} />
            ))}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {t('a9s.labels.none')}
          </Text>
        )}
      </div>
      {fields.data?.length ? (
        <dl className="nz-field-list">
          {fields.data.map((f) => (
            <div key={f.id} className="nz-field-row">
              <dt>{f.name}</dt>
              <dd>{displayValue(f, f.value) || <span className="nz-dim">{t('a9s.fields.empty')}</span>}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- admin editor

export function TaskLabelsFieldsEditor({ data, task, writes }: { data: GanttView; task: TaskView; writes: ProjectWrites }) {
  const api = useApi();
  const qc = useQueryClient();
  const projectLabels = data.labels ?? [];
  const fields = useTaskFields(task.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = new Set(task.labelIds ?? []);

  const toggle = async (labelId: string) => {
    setBusy(labelId);
    setError(null);
    try {
      const res = await writes.run(() => (on.has(labelId) ? api.tasks.removeLabel(task.id, labelId) : api.tasks.addLabel(task.id, labelId)));
      writes.merge([res.task, ...res.affected]);
      writes.record(t('undo.label.edit'), inverseOf(res.previous, [res.task, ...res.affected]));
      void qc.invalidateQueries({ queryKey: qkA9.taskLabels(task.id) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="lg">
      <section aria-labelledby="nz-labels-h">
        <Group gap={6} mb={6}>
          <IconTag size={16} aria-hidden style={{ color: 'var(--accent)' }} />
          <Text id="nz-labels-h" fw={600} size="sm">
            {t('a9s.labels.title')}
          </Text>
        </Group>
        {projectLabels.length ? (
          <Group gap={8} role="group" aria-label={t('a9s.labels.title')}>
            {projectLabels.map((l) => {
              const active = on.has(l.id);
              return (
                <UnstyledButton
                  key={l.id}
                  className="nz-label-toggle"
                  data-on={active || undefined}
                  aria-pressed={active}
                  disabled={busy !== null}
                  onClick={() => void toggle(l.id)}
                >
                  <span className="nz-label-dot" style={{ background: l.color }} aria-hidden />
                  {l.name}
                  {active ? <IconCheck size={14} aria-hidden /> : null}
                </UnstyledButton>
              );
            })}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {t('a9s.labels.noneInProject')}
          </Text>
        )}
        {error ? (
          <Text size="sm" c="var(--red)" role="alert" mt={6}>
            {error}
          </Text>
        ) : null}
      </section>

      <section aria-labelledby="nz-fields-h">
        <Text id="nz-fields-h" fw={600} size="sm" mb={6}>
          {t('a9s.fields.title')}
        </Text>
        {fields.isLoading ? (
          <Text size="sm" c="dimmed">
            {t('app.loading')}
          </Text>
        ) : fields.isError ? (
          <Text size="sm" c="var(--red)">
            {errorMessage(fields.error)}
          </Text>
        ) : !fields.data?.length ? (
          <Text size="sm" c="dimmed">
            {t('a9s.fields.noneInProject')}
          </Text>
        ) : (
          <Stack gap="sm">
            {fields.data.map((f) => (
              <FieldEditor
                key={f.id}
                field={f}
                onSave={async (value) => {
                  const res = await api.tasks.setCustomValue(task.id, f.id, value);
                  qc.setQueryData<FieldWithValue[]>(qkA9.taskFields(task.id), (cur = []) => cur.map((x) => (x.id === f.id ? { ...x, value: res.value } : x)));
                  qc.setQueryData<GanttView>(qk4.gantt(task.projectId), (g) => {
                    if (!g) return g;
                    return {
                      ...g,
                      tasks: g.tasks.map((x) => {
                        if (x.id !== task.id) return x;
                        const values = { ...(x.customValues ?? {}) };
                        if (res.value === null || res.value === undefined) delete values[f.id];
                        else values[f.id] = res.value;
                        return { ...x, customValues: values };
                      }),
                    };
                  });
                }}
              />
            ))}
          </Stack>
        )}
      </section>
    </Stack>
  );
}

function FieldEditor({ field, onSave }: { field: FieldWithValue; onSave(value: unknown): Promise<void> }) {
  const [draft, setDraft] = useState<unknown>(field.value ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(field.value ?? null), [field.value]);

  const commit = async (raw: unknown) => {
    setError(null);
    setSaved(false);
    const norm = normalizeCustomValue(field, raw === '' ? null : raw);
    if (!norm.ok) {
      setError(norm.message);
      return;
    }
    if (norm.value === (field.value ?? null)) return;
    try {
      await onSave(norm.value);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.fieldErrors.value ?? errorMessage(err) : errorMessage(err));
    }
  };

  const desc = saved ? (
    <Badge size="xs" variant="light" color="ok" radius="sm">
      {t('common.saved')}
    </Badge>
  ) : undefined;

  switch (field.type) {
    case 'TEXT':
      return (
        <TextInput
          label={field.name}
          description={desc}
          value={typeof draft === 'string' ? draft : ''}
          maxLength={2000}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void commit(typeof draft === 'string' ? draft : null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit(typeof draft === 'string' ? draft : null);
          }}
          error={error}
        />
      );
    case 'NUMBER':
      return (
        <NumberInput
          label={field.name}
          description={desc}
          value={typeof draft === 'number' ? draft : ''}
          onChange={(v) => setDraft(v === '' ? null : Number(v))}
          onBlur={() => void commit(draft)}
          thousandSeparator=","
          error={error}
        />
      );
    case 'DROPDOWN':
      return (
        <Select
          label={field.name}
          description={desc}
          data={field.options}
          value={typeof draft === 'string' ? draft : null}
          onChange={(v) => {
            setDraft(v);
            void commit(v);
          }}
          clearable
          placeholder={t('a9s.fields.choose')}
          error={error}
        />
      );
    case 'DATE':
      return (
        <TextInput
          type="date"
          label={field.name}
          description={desc}
          value={typeof draft === 'string' ? draft : ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft(v || null);
            void commit(v || null);
          }}
          error={error}
        />
      );
    case 'CHECKBOX':
      return (
        <Checkbox
          size="md"
          label={field.name}
          description={desc}
          checked={draft === true}
          onChange={(e) => {
            const v = e.currentTarget.checked;
            setDraft(v);
            void commit(v);
          }}
          error={error}
        />
      );
    default:
      return null;
  }
}
