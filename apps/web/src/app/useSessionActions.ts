import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { useApi } from '../api/context';
import { useAuthStore } from '../stores/auth';
import { t } from '../i18n';

export function useSessionActions() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // The session is dropped locally either way.
    }
    api.setAccessToken(null);
    clear();
    qc.clear();
    navigate('/login', { replace: true });
  };

  const resetDemo = async () => {
    if (!api.demo) return;
    await api.demo.reset();
    api.setAccessToken(null);
    clear();
    qc.clear();
    notifications.show({ color: 'ok', message: t('shell.demoResetDone') });
    navigate('/login', { replace: true });
  };

  return { logout, resetDemo };
}
