import { Suspense, lazy, type ComponentType } from 'react';
import { Navigate, createBrowserRouter, createMemoryRouter, useLocation, type RouteObject } from 'react-router-dom';
import { LoadingBlock, type SkeletonVariant } from '../components/ui';

/** Lazy route with a skeleton shaped like the page (rule 9), never a lone spinner. */
function lazyPage<K extends string>(
  load: () => Promise<{ [P in K]: ComponentType }>,
  name: K,
  variant: SkeletonVariant = 'list',
): ComponentType {
  const Page = lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
  return function LazyPage() {
    return (
      <Suspense fallback={<LoadingBlock variant={variant} header />}>
        <Page />
      </Suspense>
    );
  };
}
import { Layout } from './Layout';
import { NotFound, PublicOnly, RequireAnyPermission, RequireAuth, RequireOwner, RequireProjectsAccess, RequirePermission, RouteError } from './guards';
import { LoginPage } from '../pages/auth/LoginPage';
import { RegisterPage } from '../pages/auth/RegisterPage';
import { PendingPage } from '../pages/auth/PendingPage';
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { ChangePasswordPage } from '../pages/auth/ChangePasswordPage';
import { WorkspacePickerPage } from '../features/workspaces/WorkspacePickerPage';
import { DashboardPage } from '../pages/DashboardPage';
import { MorePage } from '../pages/MorePage';
import { InstallGuidePage } from './pwa/InstallGuidePage';
import { RegistrationsPage } from '../pages/RegistrationsPage';
import { UsersPage } from '../pages/UsersPage';
import { AuditPage } from '../pages/AuditPage';
import { NotificationsPage } from '../pages/NotificationsPage';
import { ProfilePage } from '../pages/ProfilePage';
import { SettingsPage } from '../pages/SettingsPage';
import { ComingSoonPage } from '../pages/ComingSoonPage';
import { NAV, navLeaves } from './nav';


// Phase 2 screens are split out of the main bundle (dnd-kit, exceljs, card templates).
const TeamsPage = lazyPage(() => import('../pages/teams/TeamsPage'), 'TeamsPage', 'cards');
const TeamDetailPage = lazyPage(() => import('../pages/teams/TeamDetailPage'), 'TeamDetailPage', 'detail');
const FormationPage = lazyPage(() => import('../pages/teams/FormationPage'), 'FormationPage', 'board');
const MembersPage = lazyPage(() => import('../pages/members/MembersPage'), 'MembersPage', 'table');
const CardsPage = lazyPage(() => import('../pages/cards/CardsPage'), 'CardsPage', 'cards');
const CardHistoryPage = lazyPage(() => import('../pages/cards/CardHistoryPage'), 'CardHistoryPage', 'table');
const TemplatesPage = lazyPage(() => import('../pages/cards/TemplatesPage'), 'TemplatesPage', 'cards');
const PrintView = lazyPage(() => import('../pages/cards/PrintView'), 'PrintView', 'cards');
const CalibrationPage = lazyPage(() => import('../pages/cards/CalibrationPage'), 'CalibrationPage', 'form');
const ReferencePage = lazyPage(() => import('../pages/settings/ReferencePage'), 'ReferencePage', 'table');
// Phase 3: violations (Leaflet, ECharts and image compression stay out of the main bundle).
const RecordViolationPage = lazyPage(
  () => import('../pages/violations/RecordViolationPage'),
  'RecordViolationPage',
  'form',
);
const MyViolationsPage = lazyPage(() => import('../pages/violations/MyViolationsPage'), 'MyViolationsPage', 'list');
const PendingSyncPage = lazyPage(() => import('../pages/violations/MyViolationsPage'), 'PendingSyncPage', 'list');
const ViolationsListPage = lazyPage(
  () => import('../pages/violations/ViolationsListPage'),
  'ViolationsListPage',
  'table',
);
const ViolationsDashboardPage = lazyPage(
  () => import('../pages/violations/ViolationsDashboardPage'),
  'ViolationsDashboardPage',
  'dashboard',
);
const TeamViolationsPage = lazyPage(
  () => import('../pages/violations/TeamViolationsPage'),
  'TeamViolationsPage',
  'list',
);

// Phase 4: projects and the Gantt (dnd-kit, exceljs and the scheduling engine stay lazy).
const ProjectsPage = lazyPage(() => import('../pages/projects/ProjectsPage'), 'ProjectsPage', 'cards');
const ProjectPage = lazyPage(() => import('../pages/projects/ProjectPage'), 'ProjectPage', 'gantt');
// A9 imports (ADR-117): the parsers, exceljs and the Gantt load with the wizard only.
const ImportWizardPage = lazyPage(() => import('../pages/projects/import/ImportWizardPage'), 'ImportWizardPage', 'detail');
const MyTasksPage = lazyPage(() => import('../pages/projects/MyTasksPage'), 'MyTasksPage', 'tasks');
const CalendarsPage = lazyPage(() => import('../pages/settings/CalendarsPage'), 'CalendarsPage', 'form');
// A9: GanttPRO-style pages (owner request A9).
const MyTaskPage = lazyPage(() => import('../pages/projects/MyTaskPage'), 'MyTaskPage', 'detail');
const PortfoliosPage = lazyPage(() => import('../pages/portfolios/PortfoliosPage'), 'PortfoliosPage', 'cards');
const ReportsPage = lazyPage(() => import('../pages/reports/ReportsPage'), 'ReportsPage', 'dashboard');
const WorkloadPage = lazyPage(() => import('../pages/workload/WorkloadPage'), 'WorkloadPage', 'table');
const TimeLogPage = lazyPage(() => import('../pages/timelog/TimeLogPage'), 'TimeLogPage', 'table');
// A9 collaboration, teams and violations round.
const HubPage = lazyPage(() => import('../pages/hub/HubPage'), 'HubPage', 'list');
const AttachmentsPage = lazyPage(() => import('../pages/attachments/AttachmentsPage'), 'AttachmentsPage', 'cards');
// A12: owners area and worker requests.
const SystemWorkspacesPage = lazyPage(() => import('../pages/system/WorkspacesPage'), 'WorkspacesPage', 'table');
const SystemOwnersPage = lazyPage(() => import('../pages/system/OwnersPage'), 'OwnersPage', 'table');
const SystemAccountsPage = lazyPage(() => import('../pages/system/AccountsPage'), 'AccountsPage', 'table');
const WorkerRequestsPage = lazyPage(() => import('../pages/requests/WorkerRequestsPage'), 'WorkerRequestsPage', 'list');
const OrgPage = lazyPage(() => import('../pages/org/OrgPage'), 'OrgPage', 'list');

/** Old paths of the A9 placeholders keep working (bookmarks, e-mails): same query, new path. */
function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}

/** Placeholder routes for the registry's `soon` pages, guarded by the same permission. */
const SOON_ROUTES: RouteObject[] = navLeaves(NAV)
  .filter((n) => n.soon && n.path && n.permission)
  .map((n) => ({
    path: n.path!.slice(1),
    element: (
      <RequirePermission permission={n.permission!}>
        <ComingSoonPage id={n.id} />
      </RequirePermission>
    ),
  }));

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
  // A12: «أضف إلى الشاشة الرئيسية» — the iPhone install guide; public (works before sign-in).
  { path: '/install', element: <InstallGuidePage />, errorElement: <RouteError /> },
  // A12: «اختر القسم» after sign-in (several workspaces, none chosen) — outside the shell.
  {
    path: '/choose-workspace',
    element: (
      <RequireAuth>
        <WorkspacePickerPage />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
  },
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
          <RequireAnyPermission permissions={['registrations.review', 'registrations.read']}>
            <RegistrationsPage />
          </RequireAnyPermission>
        ),
      },
      // A12 round 2: a supervisor's worker requests.
      {
        path: 'worker-requests',
        element: (
          <RequirePermission permission="members.manageOwn">
            <WorkerRequestsPage />
          </RequirePermission>
        ),
      },
      // A12: owners only — «إدارة النظام».
      { path: 'system/workspaces', element: <RequireOwner><SystemWorkspacesPage /></RequireOwner> },
      { path: 'system/owners', element: <RequireOwner><SystemOwnersPage /></RequireOwner> },
      { path: 'system/accounts', element: <RequireOwner><SystemAccountsPage /></RequireOwner> },
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
      // A12: «المزيد» of the phone bar (also «التطبيق والتحديثات» in the desktop user menu).
      { path: 'more', element: <MorePage /> },
      // Phase 2
      {
        path: 'teams',
        element: (
          <RequireAnyPermission permissions={['teams.readOwn', 'teams.readAll']}>
            <TeamsPage />
          </RequireAnyPermission>
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
          <RequireAnyPermission permissions={['teams.readOwn', 'teams.readAll']}>
            <TeamDetailPage />
          </RequireAnyPermission>
        ),
      },
      {
        path: 'members',
        element: (
          <RequireAnyPermission permissions={['teams.readOwn', 'teams.readAll']}>
            <MembersPage />
          </RequireAnyPermission>
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
      // A9: the project list is project management, which supervisors no longer see.
      {
        path: 'projects',
        element: (
          <RequireProjectsAccess>
            <ProjectsPage />
          </RequireProjectsAccess>
        ),
      },
      {
        path: 'projects/import',
        element: (
          <RequirePermission permission="projects.create">
            <ImportWizardPage />
          </RequirePermission>
        ),
      },
      {
        path: 'projects/:id',
        handle: { fullWidth: true },
        element: (
          <RequireProjectsAccess project>
            <ProjectPage />
          </RequireProjectsAccess>
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
        path: 'my-tasks/:id',
        element: (
          <RequirePermission permission="tasks.readAssigned">
            <MyTaskPage />
          </RequirePermission>
        ),
      },
      {
        path: 'portfolios',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="projects.readAll">
            <PortfoliosPage />
          </RequirePermission>
        ),
      },
      {
        path: 'reports',
        handle: { fullWidth: true },
        element: (
          <RequireAnyPermission permissions={['projects.readAll', 'reports.read']}>
            <ReportsPage />
          </RequireAnyPermission>
        ),
      },
      {
        path: 'workload',
        handle: { fullWidth: true },
        element: (
          <RequireAnyPermission permissions={['projects.readAll', 'reports.read']}>
            <WorkloadPage />
          </RequireAnyPermission>
        ),
      },
      {
        path: 'time-log',
        handle: { fullWidth: true },
        element: (
          <RequirePermission permission="tasks.updateAssigned">
            <TimeLogPage />
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
      // A9: communication hub, attachments browser, organisational structure.
      {
        path: 'hub',
        element: (
          <RequirePermission permission="tasks.comment">
            <HubPage />
          </RequirePermission>
        ),
      },
      {
        path: 'attachments',
        element: (
          <RequirePermission permission="tasks.readAssigned">
            <AttachmentsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'org',
        element: (
          <RequirePermission permission="org.read">
            <OrgPage />
          </RequirePermission>
        ),
      },
      { path: 'communication', element: <Moved to="/hub" /> },
      { path: 'org-structure', element: <Moved to="/org" /> },
      // Registry pages still being built (none since this round): entry, route and guard are final.
      ...SOON_ROUTES,
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
