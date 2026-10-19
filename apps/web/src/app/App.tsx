import { useEffect, useState, type ReactNode } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { DirectionProvider, MantineProvider, useMantineColorScheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { t } from '../i18n';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import { ApiProvider } from '../api/context';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/auth';
import { cssVariablesResolver, theme } from '../theme/theme';
import { OfflineRuntime } from '../features/violations/offline/OfflineRuntime';
import { offlineDb } from '../features/violations/offline/db';
import { loadOfflineUser } from '../features/violations/offline/session';
import { useOfflineStore } from '../features/violations/offline/runtime';
import { UpdatePrompt } from './UpdatePrompt';
import { dropPrintRun } from '../features/cards/printRun';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status > 0 && err.status < 500) return false;
          return count < 2;
        },
      },
    },
  });
}

/**
 * Restores the session on load (refresh cookie, or demo storage) and follows adapter-driven
 * changes. Offline (no network to refresh with), a recorder gets their cached profile back so
 * the record form and the outbox still open; the next request online renews the real session
 * through the cookie (ADR-073).
 */
function AuthBootstrap({ api, children }: { api: ApiClient; children: ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const qc = useQueryClient();
  useEffect(() => {
    let alive = true;
    const off = api.onSessionChange((session) => {
      if (!alive) return;
      if (!session) {
        // A session the server ended (refresh refused) drops cached server data and print runs too.
        qc.clear();
        dropPrintRun();
      }
      if (session) useOfflineStore.getState().set({ offlineSession: false });
      setSession(session);
    });
    api.auth
      .refresh()
      .then((session) => {
        if (!alive) return;
        api.setAccessToken(session?.accessToken ?? null);
        setSession(session);
      })
      .catch(async (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
          const user = await loadOfflineUser(offlineDb()).catch(() => null);
          if (alive && user) {
            useOfflineStore.getState().set({ offlineSession: true });
            setSession({ accessToken: '', expiresIn: 0, user });
            return;
          }
        }
        if (alive) setSession(null);
      });
    return () => {
      alive = false;
      off();
    };
  }, [api, setSession, qc]);
  return <>{children}</>;
}

/** Keeps <html dir="rtl" lang="ar"> even if a host page or test renders without index.html. */
function DocumentDirection() {
  useEffect(() => {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
  }, []);
  return null;
}

/** Applies the user's theme preference (auto / light / dark). */
function ColorSchemeSync() {
  const pref = useAuthStore((s) => s.user?.preferences.theme);
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (pref) setColorScheme(pref);
  }, [pref, setColorScheme]);
  return null;
}

export function AppProviders({
  api,
  queryClient,
  children,
}: {
  api: ApiClient;
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const [qc] = useState(() => queryClient ?? createQueryClient());
  return (
    <DirectionProvider initialDirection="rtl" detectDirection={false}>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="auto"
      >
        <Notifications position="top-center" zIndex={1000} />
        <DocumentDirection />
        <ColorSchemeSync />
        {/* Confirm dialogs (modals.openConfirmModal) need this provider. */}
        <ModalsProvider labels={{ confirm: t('common.yes'), cancel: t('common.cancel') }} modalProps={{ centered: true }}>
        <QueryClientProvider client={qc}>
          <ApiProvider api={api}>
            <AuthBootstrap api={api}>
              <OfflineRuntime />
              <UpdatePrompt />
              {children}
            </AuthBootstrap>
          </ApiProvider>
        </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </DirectionProvider>
  );
}

export function App({
  api,
  router,
}: {
  api: ApiClient;
  router: ReturnType<typeof createBrowserRouter>;
}) {
  return (
    <AppProviders api={api}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>
  );
}
