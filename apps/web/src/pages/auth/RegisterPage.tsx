import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Anchor,
  Box,
  Button,
  Group,
  Paper,
  PasswordInput,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconBuildingCommunity, IconEye, IconUsersGroup } from '@tabler/icons-react';
import { registerSchema, usernameSchema } from '@nuzli/shared';
import { z } from 'zod';
import { usePublicWorkspaces } from '../../api/a12Queries';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useZodForm } from '../../forms/useZodForm';
import { FormError } from '../../components/ui';
import { PasswordStrength } from '../../components/PasswordStrength';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

type AccountType = 'SUPERVISOR' | 'MONITOR';

/** A12: the optional username and the workspace may be left empty in the form ('' → not sent). */
const formSchema = registerSchema.extend({
  username: usernameSchema.optional().or(z.literal('')),
  workspaceId: z.string().uuid().optional().or(z.literal('')),
});

const TYPES: { value: AccountType; icon: typeof IconEye }[] = [
  { value: 'SUPERVISOR', icon: IconUsersGroup },
  { value: 'MONITOR', icon: IconEye },
];

export function RegisterPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  // A12: the workspace step — only when more than one active workspace exists (single-workspace
  // mode looks exactly as before).
  const workspaces = usePublicWorkspaces();
  const several = (workspaces.data?.length ?? 0) > 1;
  const form = useZodForm(formSchema, {
    workspaceId: '',
    username: '',
    accountType: 'SUPERVISOR' as AccountType,
    fullName: '',
    email: '',
    mobile: '',
    nationalId: '',
    password: '',
    requestedTeamName: '',
  });

  const submit = form.onSubmit(async (data) => {
    setError(null);
    if (several && !data.workspaceId) {
      form.setErrors({ workspaceId: t('register.workspacePlaceholder') });
      return;
    }
    try {
      await api.auth.register({
        ...data,
        workspaceId: several && data.workspaceId ? data.workspaceId : undefined,
        username: data.username ? data.username : undefined,
        requestedTeamName: data.accountType === 'SUPERVISOR' ? data.requestedTeamName : undefined,
      });
      // ADR-063: the API answers PENDING for new and duplicate details alike; never claim an account was created.
      navigate('/pending', { replace: true, state: { submitted: true } });
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.fieldErrors;
        if (Object.keys(fields).length) {
          form.setErrors(fields);
          if (err.code === 'VALIDATION_FAILED') return;
        }
      }
      setError(err);
    }
  });

  const ltr = { dir: 'ltr' as const, styles: { input: { textAlign: 'start' as const } } };

  return (
    <AuthLayout title={t('register.title')} subtitle={t('register.subtitle')} width={560}>
      <Paper component="form" onSubmit={submit} p="lg" withBorder shadow="sm" noValidate>
        <Stack>
          <FormError error={error} />
          {several ? (
            <Select
              label={t('register.workspace')}
              placeholder={t('register.workspacePlaceholder')}
              description={t('register.workspaceHint')}
              data={(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
              leftSection={<IconBuildingCommunity size={17} stroke={1.7} aria-hidden />}
              withAsterisk
              allowDeselect={false}
              data-testid="register-workspace"
              {...form.getInputProps('workspaceId')}
            />
          ) : null}
          <Radio.Group
            label={t('register.accountType')}
            value={form.values.accountType}
            onChange={(v) => form.setFieldValue('accountType', v as AccountType)}
            error={form.errors.accountType}
          >
            <SimpleGrid cols={{ base: 1, xs: 2 }} mt="xs" spacing="sm">
              {TYPES.map(({ value, icon: Icon }) => {
                const selected = form.values.accountType === value;
                return (
                  <Radio.Card
                    key={value}
                    value={value}
                    radius="lg"
                    p="md"
                    style={{
                      borderColor: selected ? 'var(--field)' : 'var(--line)',
                      borderWidth: selected ? 2 : 1,
                      background: selected
                        ? 'color-mix(in srgb, var(--field) 6%, var(--surface))'
                        : 'var(--surface)',
                    }}
                  >
                    <Group wrap="nowrap" align="flex-start" gap="sm">
                      <Radio.Indicator mt={4} />
                      <Box>
                        <Group gap={6}>
                          <Icon size={18} stroke={1.7} aria-hidden />
                          <Text fw={600}>{t(`register.type.${value}`)}</Text>
                        </Group>
                        <Text size="sm" c="dimmed" mt={2}>
                          {t(`register.type.${value}.desc`)}
                        </Text>
                      </Box>
                    </Group>
                  </Radio.Card>
                );
              })}
            </SimpleGrid>
          </Radio.Group>

          <TextInput
            label={t('register.fullName')}
            autoComplete="name"
            withAsterisk
            {...form.getInputProps('fullName')}
          />
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
            <TextInput
              label={t('register.email')}
              placeholder={t('register.emailPlaceholder')}
              type="email"
              autoComplete="email"
              withAsterisk
              {...ltr}
              {...form.getInputProps('email')}
            />
            <TextInput
              label={t('register.mobile')}
              placeholder={t('register.mobilePlaceholder')}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              withAsterisk
              {...ltr}
              {...form.getInputProps('mobile')}
            />
          </SimpleGrid>
          <TextInput
            label={t('register.username')}
            description={t('register.usernameHint')}
            autoComplete="username"
            {...ltr}
            {...form.getInputProps('username')}
          />
          <TextInput
            label={t('register.nationalId')}
            description={t('register.nationalIdHint')}
            inputMode="numeric"
            maxLength={10}
            autoComplete="off"
            withAsterisk
            {...ltr}
            {...form.getInputProps('nationalId')}
          />
          {form.values.accountType === 'SUPERVISOR' ? (
            <TextInput
              label={t('register.requestedTeamName')}
              description={t('register.requestedTeamNameHint')}
              {...form.getInputProps('requestedTeamName')}
            />
          ) : null}
          <Box>
            <PasswordInput
              label={t('register.password')}
              autoComplete="new-password"
              withAsterisk
              {...form.getInputProps('password')}
            />
            <PasswordStrength value={form.values.password} />
          </Box>
          <Button type="submit" size="md" loading={form.submitting}>
            {t('register.submit')}
          </Button>
          <Text size="sm" ta="center">
            {t('register.haveAccount')}{' '}
            <Anchor component={Link} to="/login">
              {t('register.login')}
            </Anchor>
          </Text>
        </Stack>
      </Paper>
    </AuthLayout>
  );
}
