import { useEffect, useState, type ReactNode } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { DirectionProvider, MantineProvider, useMantineColorScheme } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { t } from '../i18n';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import { ApiProvider } from '../api/context';
import { ApiError } from '../api/errors';
import { useAuthStore } from '../stores/auth';
import { cssVariablesResolver, theme } from '../theme/theme';
import { effectiveScheme, nzColorSchemeManager } from '../theme/colorScheme';
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
    // A10 (ADR-128): stale demo data was replaced by the new seed during the first request.
    const upgradeNotice = () => {
      if (alive && api.demo?.consumeUpgradeNotice?.()) {
        notifications.show({ id: 'demo-upgraded', color: 'field', autoClose: 9000, title: t('demo.upgraded.title'), message: t('demo.upgraded.body') });
      }
    };
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
        upgradeNotice();
        api.setAccessToken(session?.accessToken ?? null);
        setSession(session);
      })
      .catch(async (err: unknown) => {
        if (!alive) return;
        upgradeNotice();
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

  // A12 (docs/API.md «What the web must change» 6): a workspace that is no longer available
  // (membership removed, workspace archived, none chosen) → re-read the session; the guard then
  // shows «اختر القسم» or the sign-in page. Cached data of that workspace is dropped.
  useEffect(() => {
    let inFlight = false;
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const err = event.action.error;
      if (!(err instanceof ApiError) || !WORKSPACE_LOST.has(err.code) || inFlight) return;
      inFlight = true;
      void api.auth
        .refresh()
        .then((session) => {
          qc.clear();
          dropPrintRun();
          api.setAccessToken(session?.accessToken ?? null);
          setSession(session);
        })
        .catch(() => setSession(null))
        .finally(() => {
          inFlight = false;
        });
    });
  }, [api, qc, setSession]);
  return <>{children}</>;
}

const WORKSPACE_LOST = new Set<string>(['WORKSPACE_REQUIRED', 'WORKSPACE_FORBIDDEN', 'WORKSPACE_ARCHIVED']);

/** Keeps <html dir="rtl" lang="ar"> even if a host page or test renders without index.html. */
function DocumentDirection() {
  useEffect(() => {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
  }, []);
  return null;
}

/**
 * Applies the user's theme preference. A10 (ADR-127): only an explicit «داكن» is dark; the old
 * default `auto` and anything else is light — the device setting never decides.
 */
function ColorSchemeSync() {
  const pref = useAuthStore((s) => s.user?.preferences.theme);
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (pref) setColorScheme(effectiveScheme(pref));
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
  const [schemeManager] = useState(() => nzColorSchemeManager());
  return (
    <DirectionProvider initialDirection="rtl" detectDirection={false}>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="light"
        colorSchemeManager={schemeManager}
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
