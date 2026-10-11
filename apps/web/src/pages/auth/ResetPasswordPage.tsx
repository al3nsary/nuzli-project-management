import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Anchor, Box, Button, Paper, PasswordInput, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { resetPasswordSchema } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useZodForm } from '../../forms/useZodForm';
import { FormError } from '../../components/ui';
import { PasswordStrength } from '../../components/PasswordStrength';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

export function ResetPasswordPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(resetPasswordSchema, { token, password: '' });

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.auth.resetPassword(data);
      notifications.show({ color: 'ok', message: t('reset.done') });
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err);
    }
  });

  return (
    <AuthLayout title={t('reset.title')}>
      <Paper component="form" onSubmit={submit} p="lg" withBorder shadow="sm" noValidate>
        <Stack>
          {!token || form.errors.token ? (
            <Alert color="signal">
              {t('reset.missingToken')}{' '}
              <Anchor component={Link} to="/forgot-password">
                {t('reset.requestNew')}
              </Anchor>
            </Alert>
          ) : null}
          <FormError error={error} />
          <Box>
            <PasswordInput
              label={t('reset.password')}
              autoComplete="new-password"
              {...form.getInputProps('password')}
            />
            <PasswordStrength value={form.values.password} />
          </Box>
          <Button type="submit" loading={form.submitting} disabled={!token}>
            {t('reset.submit')}
          </Button>
        </Stack>
      </Paper>
    </AuthLayout>
  );
}
