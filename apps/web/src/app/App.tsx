import { useEffect, useState, type ReactNode } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { DirectionProvider, MantineProvider, useMantineColorScheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import { ApiProvider } from '../api/context';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/auth';
import { cssVariablesResolver, theme } from '../theme/theme';

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

/** Restores the session on load (refresh cookie, or demo storage) and follows adapter-driven changes. */
function AuthBootstrap({ api, children }: { api: ApiClient; children: ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  useEffect(() => {
    let alive = true;
    const off = api.onSessionChange((session) => {
      if (alive) setSession(session);
    });
    api.auth
      .refresh()
      .then((session) => {
        if (!alive) return;
        api.setAccessToken(session?.accessToken ?? null);
        setSession(session);
      })
      .catch(() => alive && setSession(null));
    return () => {
      alive = false;
      off();
    };
  }, [api, setSession]);
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
        <QueryClientProvider client={qc}>
          <ApiProvider api={api}>
            <AuthBootstrap api={api}>{children}</AuthBootstrap>
          </ApiProvider>
        </QueryClientProvider>
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
