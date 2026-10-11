import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Button, Paper, Stack, Text, TextInput } from '@mantine/core';
import { IconMailCheck } from '@tabler/icons-react';
import { forgotPasswordSchema } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useZodForm } from '../../forms/useZodForm';
import { FormError } from '../../components/ui';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

export function ForgotPasswordPage() {
  const api = useApi();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(forgotPasswordSchema, { email: '' });

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.auth.forgotPassword(data);
      setDone(true);
    } catch (err) {
      setError(err);
    }
  });

  return (
    <AuthLayout title={t('forgot.title')} subtitle={t('forgot.body')}>
      <Paper component="form" onSubmit={submit} p="lg" withBorder shadow="sm" noValidate>
        <Stack>
          {done ? (
            <Alert color="ok" icon={<IconMailCheck size={18} />}>
              {t('forgot.done')}
            </Alert>
          ) : null}
          {done && api.demo ? (
            <Text size="sm" c="dimmed">
              {t('forgot.demoNote')}
            </Text>
          ) : null}
          <FormError error={error} />
          <TextInput
            label={t('forgot.email')}
            type="email"
            autoComplete="email"
            dir="ltr"
            styles={{ input: { textAlign: 'start' } }}
            {...form.getInputProps('email')}
          />
          <Button type="submit" loading={form.submitting}>
            {t('forgot.submit')}
          </Button>
          <Anchor component={Link} to="/login" size="sm" ta="center">
            {t('forgot.back')}
          </Anchor>
        </Stack>
      </Paper>
    </AuthLayout>
  );
}
