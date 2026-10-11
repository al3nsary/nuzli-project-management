import { createBrowserRouter, createMemoryRouter, type RouteObject } from 'react-router-dom';
import { Layout } from './Layout';
import { NotFound, PublicOnly, RequireAuth, RequirePermission, RouteError } from './guards';
import { LoginPage } from '../pages/auth/LoginPage';
import { RegisterPage } from '../pages/auth/RegisterPage';
import { PendingPage } from '../pages/auth/PendingPage';
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { ChangePasswordPage } from '../pages/auth/ChangePasswordPage';
import { DashboardPage } from '../pages/DashboardPage';
import { RegistrationsPage } from '../pages/RegistrationsPage';
import { UsersPage } from '../pages/UsersPage';
import { AuditPage } from '../pages/AuditPage';
import { NotificationsPage } from '../pages/NotificationsPage';
import { ProfilePage } from '../pages/ProfilePage';
import { SettingsPage } from '../pages/SettingsPage';

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: (
      <PublicOnly>
        <LoginPage />
      </PublicOnly>
    ),
    errorElement: <RouteError />,
  },
  {
    path: '/register',
    element: (
      <PublicOnly>
        <RegisterPage />
      </PublicOnly>
    ),
  },
  { path: '/pending', element: <PendingPage /> },
  {
    path: '/forgot-password',
    element: (
      <PublicOnly>
        <ForgotPasswordPage />
      </PublicOnly>
    ),
  },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: 'registrations',
        element: (
          <RequirePermission permission="registrations.review">
            <RegistrationsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'users',
        element: (
          <RequirePermission permission="users.read">
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'audit',
        element: (
          <RequirePermission permission="audit.read">
            <AuditPage />
          </RequirePermission>
        ),
      },
      {
        path: 'notifications',
        element: (
          <RequirePermission permission="notifications.read">
            <NotificationsPage />
          </RequirePermission>
        ),
      },
      { path: 'profile', element: <ProfilePage /> },
      {
        path: 'settings',
        element: (
          <RequirePermission permission="settings.manage">
            <SettingsPage />
          </RequirePermission>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];

/** `/nuzli-project-management/` on GitHub Pages, `/` otherwise (no trailing slash for the router). */
export function basename(): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.length > 1 ? base.replace(/\/$/, '') : '/';
}

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: basename() });
}

export function createTestRouter(initialPath: string) {
  return createMemoryRouter(routes, { initialEntries: [initialPath] });
}
