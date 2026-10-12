import { Suspense, lazy, type ComponentType } from 'react';
import { createBrowserRouter, createMemoryRouter, type RouteObject } from 'react-router-dom';
import { LoadingBlock } from '../components/ui';

function lazyPage<K extends string>(
  load: () => Promise<{ [P in K]: ComponentType }>,
  name: K,
): ComponentType {
  const Page = lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
  return function LazyPage() {
    return (
      <Suspense fallback={<LoadingBlock />}>
        <Page />
      </Suspense>
    );
  };
}
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


// Phase 2 screens are split out of the main bundle (dnd-kit, exceljs, card templates).
const TeamsPage = lazyPage(() => import('../pages/teams/TeamsPage'), 'TeamsPage');
const TeamDetailPage = lazyPage(() => import('../pages/teams/TeamDetailPage'), 'TeamDetailPage');
const FormationPage = lazyPage(() => import('../pages/teams/FormationPage'), 'FormationPage');
const MembersPage = lazyPage(() => import('../pages/members/MembersPage'), 'MembersPage');
const CardsPage = lazyPage(() => import('../pages/cards/CardsPage'), 'CardsPage');
const CardHistoryPage = lazyPage(() => import('../pages/cards/CardHistoryPage'), 'CardHistoryPage');
const TemplatesPage = lazyPage(() => import('../pages/cards/TemplatesPage'), 'TemplatesPage');
const PrintView = lazyPage(() => import('../pages/cards/PrintView'), 'PrintView');
const CalibrationPage = lazyPage(() => import('../pages/cards/CalibrationPage'), 'CalibrationPage');
const ReferencePage = lazyPage(() => import('../pages/settings/ReferencePage'), 'ReferencePage');
// Phase 3: violations (Leaflet, ECharts and image compression stay out of the main bundle).
const RecordViolationPage = lazyPage(
  () => import('../pages/violations/RecordViolationPage'),
  'RecordViolationPage',
);
const MyViolationsPage = lazyPage(() => import('../pages/violations/MyViolationsPage'), 'MyViolationsPage');
const PendingSyncPage = lazyPage(() => import('../pages/violations/MyViolationsPage'), 'PendingSyncPage');
const ViolationsListPage = lazyPage(
  () => import('../pages/violations/ViolationsListPage'),
  'ViolationsListPage',
);
const ViolationsDashboardPage = lazyPage(
  () => import('../pages/violations/ViolationsDashboardPage'),
  'ViolationsDashboardPage',
);
const TeamViolationsPage = lazyPage(
  () => import('../pages/violations/TeamViolationsPage'),
  'TeamViolationsPage',
);

// Phase 4: projects and the Gantt (dnd-kit, exceljs and the scheduling engine stay lazy).
const ProjectsPage = lazyPage(() => import('../pages/projects/ProjectsPage'), 'ProjectsPage');
const ProjectPage = lazyPage(() => import('../pages/projects/ProjectPage'), 'ProjectPage');
const MyTasksPage = lazyPage(() => import('../pages/projects/MyTasksPage'), 'MyTasksPage');
const CalendarsPage = lazyPage(() => import('../pages/settings/CalendarsPage'), 'CalendarsPage');

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
  // Print pages render without the app shell: only the cards and a screen-only toolbar.
  {
    path: '/cards/print/:batchId',
    element: (
      <RequireAuth>
        <RequirePermission permission="cards.print">
          <PrintView />
        </RequirePermission>
      </RequireAuth>
    ),
    errorElement: <RouteError />,
  },
  {
    path: '/cards/calibration',
    element: (
      <RequireAuth>
        <RequirePermission permission="cards.manageTemplates">
          <CalibrationPage />
        </RequirePermission>
      </RequireAuth>
    ),
    errorElement: <RouteError />,
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
      // Phase 2
      {
        path: 'teams',
        element: (
          <RequirePermission permission="teams.readOwn">
            <TeamsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'teams/formation',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="members.move">
            <FormationPage />
          </RequirePermission>
        ),
      },
      {
        path: 'teams/:id',
        element: (
          <RequirePermission permission="teams.readOwn">
            <TeamDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'members',
        element: (
          <RequirePermission permission="teams.readOwn">
            <MembersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'cards',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="cards.print">
            <CardsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'cards/history',
        element: (
          <RequirePermission permission="cards.print">
            <CardHistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: 'cards/templates',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="cards.manageTemplates">
            <TemplatesPage />
          </RequirePermission>
        ),
      },
      // Phase 3
      {
        path: 'violations/new',
        element: (
          <RequirePermission permission="violations.create">
            <RecordViolationPage />
          </RequirePermission>
        ),
      },
      {
        path: 'violations/mine',
        element: (
          <RequirePermission permission="violations.create">
            <MyViolationsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'violations/pending',
        element: (
          <RequirePermission permission="violations.create">
            <PendingSyncPage />
          </RequirePermission>
        ),
      },
      {
        path: 'violations',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="violations.readAll">
            <ViolationsListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'violations/dashboard',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="violations.stats">
            <ViolationsDashboardPage />
          </RequirePermission>
        ),
      },
      {
        path: 'violations/team',
        element: (
          <RequirePermission permission="violations.readOwnTeams">
            <TeamViolationsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'projects',
        element: (
          <RequirePermission permission="projects.readGranted">
            <ProjectsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'projects/:id',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="projects.readGranted">
            <ProjectPage />
          </RequirePermission>
        ),
      },
      {
        path: 'my-tasks',
        element: (
          <RequirePermission permission="tasks.readAssigned">
            <MyTasksPage />
          </RequirePermission>
        ),
      },
      {
        path: 'settings/calendars',
        element: (
          <RequirePermission permission="projects.manage">
            <CalendarsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'settings/reference',
        element: (
          <RequirePermission permission="reference.manage">
            <ReferencePage />
          </RequirePermission>
        ),
      },
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
