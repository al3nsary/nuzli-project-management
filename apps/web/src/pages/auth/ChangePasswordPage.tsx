import { useNavigate } from 'react-router-dom';
import { Alert, Paper } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/auth';
import { t } from '../../i18n';
import { AuthLayout } from './AuthLayout';
import { ChangePasswordForm } from '../../components/ChangePasswordForm';

/** Forced after an admin-created account or the bootstrap admin's first login. */
export function ChangePasswordPage() {
  const navigate = useNavigate();
  const forced = useAuthStore((s) => s.user?.mustChangePassword ?? false);
  return (
    <AuthLayout title={t('change.title')}>
      {forced ? (
        <Alert color="signal" icon={<IconKey size={18} />}>
          {t('change.forcedBody')}
        </Alert>
      ) : null}
      <Paper p="lg" withBorder shadow="sm">
        <ChangePasswordForm onDone={() => navigate('/', { replace: true })} />
      </Paper>
    </AuthLayout>
  );
}
