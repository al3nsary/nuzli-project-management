import { useState } from 'react';
import { Box, Button, PasswordInput, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { changePasswordSchema } from '@nuzli/shared';
import { useApi } from '../api/context';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/auth';
import { useZodForm } from '../forms/useZodForm';
import { FormError } from './ui';
import { PasswordStrength } from './PasswordStrength';
import { t } from '../i18n';

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const api = useApi();
  const setSession = useAuthStore((s) => s.setSession);
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(changePasswordSchema, { currentPassword: '', newPassword: '' });

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      const session = await api.auth.changePassword(data);
      api.setAccessToken(session.accessToken);
      setSession(session);
      form.reset();
      notifications.show({ color: 'ok', message: t('change.done') });
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        form.setErrors(err.fieldErrors);
        return;
      }
      setError(err);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <FormError error={error} />
        <PasswordInput
          label={t('change.current')}
          autoComplete="current-password"
          {...form.getInputProps('currentPassword')}
        />
        <Box>
          <PasswordInput
            label={t('change.new')}
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordStrength value={form.values.newPassword} />
        </Box>
        <Button type="submit" loading={form.submitting} style={{ alignSelf: 'flex-start' }}>
          {t('change.submit')}
        </Button>
      </Stack>
    </form>
  );
}
