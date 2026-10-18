import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Anchor,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCamera, IconLogin2, IconShieldCheck, IconUser, IconUsersGroup, type Icon } from '@tabler/icons-react';
import { loginSchema, type AuthSession, type Role } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useAuthStore } from '../../stores/auth';
import { useZodForm } from '../../forms/useZodForm';
import { FormError, roleLabel } from '../../components/ui';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

const ROLE_ICON: Partial<Record<Role, Icon>> = {
  ADMIN: IconShieldCheck,
  SUPERVISOR: IconUsersGroup,
  MONITOR: IconCamera,
};

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
          <div>
            <PasswordInput
              label={t('login.password')}
              autoComplete="current-password"
              visibilityToggleButtonProps={{ 'aria-label': t('login.showPassword') }}
              {...form.getInputProps('password')}
            />
            <Group justify="flex-end" mt={8}>
              <Anchor component={Link} to="/forgot-password" size="sm" fw={600}>
                {t('login.forgot')}
              </Anchor>
            </Group>
          </div>
          <Button
            type="submit"
            size="md"
            fullWidth
            loading={form.submitting}
            disabled={waitSeconds > 0}
            leftSection={<IconLogin2 size={18} className="mirror-rtl" />}
          >
            {t('login.submit')}
          </Button>
          <Text size="sm" ta="center" c="dimmed">
            {t('login.noAccount')}{' '}
            <Anchor component={Link} to="/register" fw={600}>
              {t('login.register')}
            </Anchor>
          </Text>
        </Stack>
      </Paper>

      {api.demo ? (
        <section className="nz-demo" aria-labelledby="nz-demo-title">
          <div className="nz-demo-sep" id="nz-demo-title">
            {t('login.demoTitle')}
          </div>
          <div className="nz-demo-roles">
              {api.demo.accounts.map((a) => {
                const RoleIcon = ROLE_ICON[a.role] ?? IconUser;
                return (
                  <button
                    key={a.role}
                    type="button"
                    className="nz-rolebtn"
                    data-busy={demoBusy === a.role || undefined}
                    disabled={demoBusy !== null}
                    aria-label={t('login.demoAs', { role: roleLabel(a.role) })}
                    onClick={() => void demoLogin(a.role, a.identifier)}
                  >
                    <span className="ci">
                      {demoBusy === a.role ? <Loader size={15} color="currentColor" /> : <RoleIcon size={17} stroke={1.8} />}
                    </span>
                    <span>{roleLabel(a.role)}</span>
                  </button>
                );
              })}
          </div>
          <p className="nz-demo-note">
            {t('login.demoBody')} <Code className="ltr">{api.demo.password}</Code>
            {api.demo.pendingExample ? (
              <>
                <br />
                {t('login.demoPendingHint', { email: api.demo.pendingExample })}
              </>
            ) : null}
          </p>
        </section>
      ) : null}
    </AuthLayout>
  );
}
