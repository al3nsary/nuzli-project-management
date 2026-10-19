import { useEffect, useState } from 'react';
import { Button, Card, Group, NumberInput, Stack, Switch, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  SETTINGS_SCHEMA,
  updateSettingsSchema,
  type SettingKey,
  type Settings,
} from '@nuzli/shared';
import { useApi } from '../api/context';
import { qk, useSettings } from '../api/queries';
import { zodResolver, type FieldErrors } from '../forms/useZodForm';
import { ErrorBlock, FormError, LoadingBlock, PageHeader } from '../components/ui';
import { t, tKey, type MessageKey } from '../i18n';

const GROUPS: { title: MessageKey; keys: SettingKey[] }[] = [
  {
    title: 'settings.group.teams',
    keys: ['REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS', 'ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR'],
  },
  {
    title: 'settings.group.violations',
    keys: [
      'SUPERVISORS_CAN_SEE_VIOLATIONS',
      'VIOLATION_EDIT_WINDOW_MINUTES',
      'VIOLATION_MAX_PHOTOS',
      'CLOCK_DRIFT_THRESHOLD_MINUTES',
      'GPS_ACCURACY_WARN_METERS',
      'VIOLATION_PHOTO_RETENTION_DAYS',
      'VIOLATION_REGISTER_MAX_AGE_DAYS',
    ],
  },
  { title: 'settings.group.files', keys: ['PRESIGNED_URL_TTL_SECONDS'] },
];

/** Min/max straight from the shared schema, so the UI and the API agree. */
function bounds(key: SettingKey): { min?: number; max?: number } {
  // Duck-typed so it works whichever zod copy built the schema.
  const field = SETTINGS_SCHEMA.shape[key] as unknown as { _def: { innerType?: unknown } };
  const inner = (field._def.innerType ?? field) as {
    minValue?: number | null;
    maxValue?: number | null;
  };
  return { min: inner.minValue ?? undefined, max: inner.maxValue ?? undefined };
}

const resolve = zodResolver(updateSettingsSchema);

export function SettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useSettings();
  const [values, setValues] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.data) setValues(q.data);
  }, [q.data]);

  if (q.isLoading || (!values && !q.isError)) return <LoadingBlock variant="form" header />;
  if (q.isError || !values) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;

  const dirty = q.data
    ? (Object.keys(values) as SettingKey[]).some((k) => values[k] !== q.data[k])
    : false;

  const save = async () => {
    setError(null);
    const { data, errors: errs } = resolve(values);
    setErrors(errs);
    if (!data) return;
    setBusy(true);
    try {
      const next = await api.settings.update(data);
      qc.setQueryData(qk.settings, next);
      await qc.invalidateQueries({ queryKey: ['audit'] });
      notifications.show({ color: 'ok', message: t('common.saved') });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('settings.title')} lead={t('settings.lead')} />
      <Stack maw={760}>
        <FormError error={error} />
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <Title order={2} fz="lg" mb="md">
              {t(g.title)}
            </Title>
            <Stack gap="lg">
              {g.keys.map((key) => {
                const value = values[key];
                const label = tKey(`settings.${key}`, 'settings.title');
                const hint = tKey(`settings.${key}.hint`, 'settings.lead');
                if (typeof value === 'boolean') {
                  return (
                    <Switch
                      key={key}
                      size="md"
                      label={label}
                      description={hint}
                      checked={value}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setValues((v) => (v ? { ...v, [key]: checked } : v));
                      }}
                    />
                  );
                }
                const { min, max } = bounds(key);
                return (
                  <NumberInput
                    key={key}
                    label={label}
                    description={`${hint} ${min !== undefined && max !== undefined ? t('settings.range', { min, max }) : ''}`}
                    value={value}
                    min={min}
                    max={max}
                    allowDecimal={false}
                    allowNegative={false}
                    error={errors[key]}
                    maw={320}
                    onChange={(v) =>
                      setValues((s) =>
                        s ? { ...s, [key]: typeof v === 'number' ? v : Number(v) } : s,
                      )
                    }
                  />
                );
              })}
            </Stack>
          </Card>
        ))}
        <Group>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty}>
            {t('settings.save')}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
