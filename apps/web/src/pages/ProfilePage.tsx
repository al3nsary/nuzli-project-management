import { useState } from 'react';
import {
  Button,
  Card,
  Grid,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  NOTIFICATION_TYPES,
  updateProfileSchema,
  type NotificationType,
  type Role,
  type UserPreferences,
} from '@nuzli/shared';
import { z } from 'zod';
import { useApi } from '../api/context';
import { errorMessage } from '../api/errors';
import { useAuthStore } from '../stores/auth';
import { useZodForm } from '../forms/useZodForm';
import { FormError, Ltr, Mobile, RoleBadge } from '../components/ui';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { formatDate, formatNumber, t, tKey } from '../i18n';

/** Which notification types can reach each role (brief §9). */
const TYPES_BY_ROLE: Record<Role, NotificationType[]> = {
  ADMIN: ['REGISTRATION_REQUESTED', 'TEAM_PENDING_APPROVAL', 'VIOLATION_OBJECTION'],
  SUPERVISOR: ['TASK_ASSIGNED', 'TASK_MENTIONED', 'TASK_DUE_SOON', 'TASK_OVERDUE'],
  MONITOR: [],
};

const nameSchema = z.object({ fullName: updateProfileSchema.shape.fullName.unwrap() });

function useSaveProfile() {
  const api = useApi();
  const setUser = useAuthStore((s) => s.setUser);
  return async (input: Parameters<typeof api.me.update>[0]) => {
    const user = await api.me.update(input);
    setUser(user);
    notifications.show({ color: 'ok', message: t('common.saved') });
    return user;
  };
}

function AccountCard() {
  const user = useAuthStore((s) => s.user)!;
  const save = useSaveProfile();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(nameSchema, { fullName: user.fullName });
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await save({ fullName: data.fullName });
    } catch (err) {
      setError(err);
    }
  });
  return (
    <Card>
      <Title order={2} fz="lg" mb="md">
        {t('profile.account')}
      </Title>
      <form onSubmit={submit} noValidate>
        <Stack>
          <FormError error={error} />
          <TextInput label={t('profile.fullName')} {...form.getInputProps('fullName')} />
          <Button
            type="submit"
            loading={form.submitting}
            disabled={form.values.fullName === user.fullName}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('profile.saveName')}
          </Button>
          <Stack gap={6} mt="xs">
            <Group gap="xs">
              <Text size="sm" c="dimmed" w={90}>
                {t('profile.role')}
              </Text>
              <RoleBadge role={user.role} />
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" c="dimmed" w={90}>
                {t('profile.email')}
              </Text>
              <Text size="sm" truncate>
                <Ltr>{user.email}</Ltr>
              </Text>
            </Group>
            <Group gap="xs">
              <Text size="sm" c="dimmed" w={90}>
                {t('profile.mobile')}
              </Text>
              <Text size="sm">
                <Mobile value={user.mobile} />
              </Text>
            </Group>
            <Group gap="xs">
              <Text size="sm" c="dimmed" w={90}>
                {t('profile.nationalId')}
              </Text>
              <Text size="sm">
                <Ltr mono>{user.nationalIdMasked}</Ltr>
              </Text>
            </Group>
          </Stack>
        </Stack>
      </form>
    </Card>
  );
}

function DisplayCard() {
  const user = useAuthStore((s) => s.user)!;
  const save = useSaveProfile();
  const [prefs, setPrefs] = useState<Pick<UserPreferences, 'digits' | 'showHijri' | 'theme'>>({
    digits: user.preferences.digits,
    showHijri: user.preferences.showHijri,
    theme: user.preferences.theme,
  });
  const [busy, setBusy] = useState(false);
  const dirty =
    prefs.digits !== user.preferences.digits ||
    prefs.showHijri !== user.preferences.showHijri ||
    prefs.theme !== user.preferences.theme;

  const submit = async () => {
    setBusy(true);
    try {
      await save({ preferences: prefs });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Title order={2} fz="lg" mb="md">
        {t('profile.display')}
      </Title>
      <Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('profile.digits')}
          </Text>
          <SegmentedControl
            value={prefs.digits}
            onChange={(v) => setPrefs((p) => ({ ...p, digits: v as 'latn' | 'arab' }))}
            data={[
              { value: 'latn', label: t('profile.digits.latn') },
              { value: 'arab', label: t('profile.digits.arab') },
            ]}
          />
        </Stack>
        <Switch
          checked={prefs.showHijri}
          onChange={(e) => {
            const showHijri = e.currentTarget.checked;
            setPrefs((p) => ({ ...p, showHijri }));
          }}
          label={t('profile.showHijri')}
          description={t('profile.showHijriHint')}
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('profile.theme')}
          </Text>
          <SegmentedControl
            value={prefs.theme}
            onChange={(v) => setPrefs((p) => ({ ...p, theme: v as UserPreferences['theme'] }))}
            data={(['auto', 'light', 'dark'] as const).map((v) => ({
              value: v,
              label: t(`profile.theme.${v}`),
            }))}
          />
        </Stack>
        <Text size="sm" c="dimmed">
          {t('profile.preview', {
            number: formatNumber(1234567, prefs),
            date: formatDate(new Date(), prefs),
          })}
        </Text>
        <Button
          onClick={() => void submit()}
          loading={busy}
          disabled={!dirty}
          style={{ alignSelf: 'flex-start' }}
        >
          {t('profile.savePrefs')}
        </Button>
      </Stack>
    </Card>
  );
}

function EmailCard() {
  const user = useAuthStore((s) => s.user)!;
  const save = useSaveProfile();
  const types = TYPES_BY_ROLE[user.role].filter((x) => NOTIFICATION_TYPES.includes(x));
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(types.map((ty) => [ty, user.preferences.emailNotifications[ty] ?? true])),
  );
  const [busy, setBusy] = useState(false);
  if (!types.length) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await save({ preferences: { emailNotifications: values } });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Title order={2} fz="lg" mb={4}>
        {t('profile.email.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        {t('profile.email.lead')}
      </Text>
      <Stack>
        {types.map((ty) => (
          <Switch
            key={ty}
            checked={values[ty] ?? true}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              setValues((v) => ({ ...v, [ty]: checked }));
            }}
            label={tKey(`notifType.${ty}`, 'notif.type.other')}
          />
        ))}
        <Button onClick={() => void submit()} loading={busy} style={{ alignSelf: 'flex-start' }}>
          {t('profile.email.save')}
        </Button>
      </Stack>
    </Card>
  );
}

export function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;
  return (
    <>
      <Title order={1} mb="lg">
        {t('profile.title')}
      </Title>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack>
            <AccountCard />
            <Card>
              <Title order={2} fz="lg" mb="md">
                {t('profile.password')}
              </Title>
              <ChangePasswordForm />
            </Card>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack>
            <DisplayCard />
            <EmailCard />
          </Stack>
        </Grid.Col>
      </Grid>
    </>
  );
}
