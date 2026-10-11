import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { can, type Permission } from '@nuzli/shared';
import { useAuthStore } from '../stores/auth';
import { FullPageLoader } from '../components/ui';
import { t } from '../i18n';

/** Signed-in users only; a forced password change comes before anything else. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuthStore();
  const location = useLocation();
  if (status === 'loading') return <FullPageLoader />;
  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

/** Public pages (login, register…) bounce signed-in users to the dashboard. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Mirrors the API guard. The API still enforces; this only avoids showing a dead page. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  if (!can(user, permission)) return <Forbidden />;
  return <>{children}</>;
}

export function Forbidden() {
  const navigate = useNavigate();
  return (
    <Center py={64}>
      <Stack align="center" ta="center" maw={420} gap="xs">
        <IconLock size={40} stroke={1.5} color="var(--muted)" aria-hidden />
        <Title order={2}>{t('error.forbiddenTitle')}</Title>
        <Text c="dimmed">{t('error.forbiddenBody')}</Text>
        <Button variant="light" mt="sm" onClick={() => navigate('/')}>
          {t('error.goHome')}
        </Button>
      </Stack>
    </Center>
  );
}

export function NotFound() {
  const navigate = useNavigate();
  return (
    <Center py={64} px="md">
      <Stack align="center" ta="center" maw={420} gap="xs">
        <Title order={2}>{t('error.notFoundTitle')}</Title>
        <Text c="dimmed">{t('error.notFoundBody')}</Text>
        <Button variant="light" mt="sm" onClick={() => navigate('/')}>
          {t('error.goHome')}
        </Button>
      </Stack>
    </Center>
  );
}

export function RouteError() {
  return (
    <Center h="100dvh" px="md">
      <Stack align="center" ta="center" maw={420} gap="xs">
        <Title order={2}>{t('error.crashTitle')}</Title>
        <Text c="dimmed">{t('error.crashBody')}</Text>
        <Button mt="sm" onClick={() => window.location.reload()}>
          {t('error.reload')}
        </Button>
      </Stack>
    </Center>
  );
}
