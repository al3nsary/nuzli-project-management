import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Anchor,
  Button,
  Code,
  Group,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconLogin2 } from '@tabler/icons-react';
import { loginSchema, type AuthSession, type Role } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useAuthStore } from '../../stores/auth';
import { useZodForm } from '../../forms/useZodForm';
import { FormError, roleLabel } from '../../components/ui';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const api = useApi();
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [error, setError] = useState<unknown>(null);
  const [demoBusy, setDemoBusy] = useState<Role | null>(null);
  const form = useZodForm(loginSchema, { identifier: '', password: '' });

  const finish = (session: AuthSession) => {
    api.setAccessToken(session.accessToken);
    setSession(session);
    navigate(session.user.mustChangePassword ? '/change-password' : from, { replace: true });
  };

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'ACCOUNT_PENDING') {
      navigate('/pending');
      return;
    }
    setError(err);
  };

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      finish(await api.auth.login(data));
    } catch (err) {
      handleError(err);
    }
  });

  const demoLogin = async (role: Role, identifier: string) => {
    if (!api.demo) return;
    setError(null);
    setDemoBusy(role);
    try {
      finish(await api.auth.login({ identifier, password: api.demo.password }));
    } catch (err) {
      handleError(err);
    } finally {
      setDemoBusy(null);
    }
  };

  return (
    <AuthLayout title={t('login.title')} subtitle={t('login.subtitle')}>
      <Paper component="form" onSubmit={submit} p="lg" withBorder shadow="sm" noValidate>
        <Stack>
          <FormError error={error} />
          <TextInput
            label={t('login.identifier')}
            placeholder={t('login.identifierPlaceholder')}
            autoComplete="username"
            dir="ltr"
            styles={{ input: { textAlign: 'start' } }}
            {...form.getInputProps('identifier')}
          />
          <PasswordInput
            label={t('login.password')}
            autoComplete="current-password"
            {...form.getInputProps('password')}
          />
          <Group justify="flex-end">
            <Anchor component={Link} to="/forgot-password" size="sm">
              {t('login.forgot')}
            </Anchor>
          </Group>
          <Button
            type="submit"
            size="md"
            loading={form.submitting}
            leftSection={<IconLogin2 size={18} className="mirror-rtl" />}
          >
            {t('login.submit')}
          </Button>
          <Text size="sm" ta="center">
            {t('login.noAccount')}{' '}
            <Anchor component={Link} to="/register">
              {t('login.register')}
            </Anchor>
          </Text>
        </Stack>
      </Paper>

      {api.demo ? (
        <Paper p="lg" withBorder style={{ borderStyle: 'dashed', borderColor: 'var(--signal)' }}>
          <Stack gap="sm">
            <Text fw={600}>{t('login.demoTitle')}</Text>
            <Text size="sm">
              {t('login.demoBody')} <Code className="ltr">{api.demo.password}</Code>
            </Text>
            <SimpleGrid cols={1} spacing="xs">
              {api.demo.accounts.map((a) => (
                <Button
                  key={a.role}
                  variant="light"
                  loading={demoBusy === a.role}
                  disabled={demoBusy !== null && demoBusy !== a.role}
                  onClick={() => void demoLogin(a.role, a.identifier)}
                >
                  {t('login.demoAs', { role: roleLabel(a.role) })}
                </Button>
              ))}
            </SimpleGrid>
            {api.demo.pendingExample ? (
              <Text size="xs" c="dimmed">
                {t('login.demoPendingHint', { email: api.demo.pendingExample })}
              </Text>
            ) : null}
          </Stack>
        </Paper>
      ) : null}
    </AuthLayout>
  );
}
