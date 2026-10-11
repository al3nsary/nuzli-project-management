import { Link } from 'react-router-dom';
import { Button, List, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconHourglassHigh } from '@tabler/icons-react';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';

export function PendingPage() {
  return (
    <AuthLayout title={t('pending.title')}>
      <Paper p="lg" withBorder shadow="sm">
        <Stack>
          <ThemeIcon size={48} radius="xl" color="signal" variant="light" aria-hidden>
            <IconHourglassHigh size={26} />
          </ThemeIcon>
          <Text>{t('pending.body')}</Text>
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
