import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
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
  // ADR-062: throttled logins answer 429 RATE_LIMITED with details.retryAfterSeconds.
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const waitSeconds = retryUntil ? Math.max(0, Math.ceil((retryUntil - now) / 1000)) : 0;
  useEffect(() => {
    if (!retryUntil) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [retryUntil]);

  const finish = (session: AuthSession) => {
    api.setAccessToken(session.accessToken);
    setSession(session);
    navigate(session.user.mustChangePassword ? '/change-password' : from, { replace: true });
  };

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
      const seconds = Number((err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
      setNow(Date.now());
      setRetryUntil(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
      setError(null);
      return;
    }
    if (err instanceof ApiError && err.code === 'ACCOUNT_PENDING') {
      navigate('/pending');
      return;
    }
    setError(err);
  };

  const submit = form.onSubmit(async (data) => {
    if (waitSeconds > 0) return;
    setError(null);
    setRetryUntil(null);
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
          {retryUntil ? (
            <Alert color={waitSeconds > 0 ? 'signal' : 'ok'} role="status" aria-live="polite">
              {waitSeconds > 0 ? t('login.rateLimited', { seconds: waitSeconds }) : t('login.retryNow')}
            </Alert>
          ) : null}
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
            disabled={waitSeconds > 0}
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
