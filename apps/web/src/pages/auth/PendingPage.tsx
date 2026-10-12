import { Link, useLocation } from 'react-router-dom';
import { Button, List, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconHourglassHigh } from '@tabler/icons-react';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

export function PendingPage() {
  // After a registration (ADR-063) the wording must not say an account exists or was created.
  const submitted = Boolean((useLocation().state as { submitted?: boolean } | null)?.submitted);
  return (
    <AuthLayout title={submitted ? t('pending.submittedTitle') : t('pending.title')}>
      <Paper p="lg" withBorder shadow="sm">
        <Stack>
          <ThemeIcon size={48} radius="xl" color="signal" variant="light" aria-hidden>
            <IconHourglassHigh size={26} />
          </ThemeIcon>
          <Text>{submitted ? t('pending.submitted') : t('pending.body')}</Text>
          <Title order={3}>{t('pending.next')}</Title>
          <List type="ordered" spacing="xs">
            <List.Item>{t('pending.step1')}</List.Item>
            <List.Item>{t('pending.step2')}</List.Item>
            <List.Item>{t('pending.step3')}</List.Item>
          </List>
          <Button component={Link} to="/login" variant="light">
            {t('pending.backToLogin')}
          </Button>
        </Stack>
      </Paper>
    </AuthLayout>
  );
}
