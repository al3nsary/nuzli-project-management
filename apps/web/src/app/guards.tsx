import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMyParticipations } from '../api/a12Queries';
import { Button, Group } from '@mantine/core';
import { IconArrowLeft, IconHome, IconLock, IconMapOff, IconRefresh } from '@tabler/icons-react';
import { can, type Permission } from '@nuzli/shared';
import { needsWorkspacePick, useAuthStore } from '../stores/auth';
import { FullPageLoader } from '../components/ui';
import { t } from '../i18n';
import { hasInAppHistory } from './shell/TopBar';

/**
 * Signed-in users only; a forced password change comes before anything else, then (A12) the
 * «اختر القسم» screen when the user can enter several workspaces and none is chosen yet.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const state = useAuthStore();
  const { status, user } = state;
  const location = useLocation();
  if (status === 'loading') return <FullPageLoader />;
  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (!user.mustChangePassword && needsWorkspacePick(state) && location.pathname !== '/choose-workspace') {
    return <Navigate to="/choose-workspace" replace state={{ from: location.pathname + location.search }} />;
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

/** Any of the permissions (A12: registrations.review for admins, registrations.read for assistants). */
export function RequireAnyPermission({ permissions, children }: { permissions: Permission[]; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!permissions.some((p) => can(user, p))) return <Forbidden />;
  return <>{children}</>;
}

/** A12: owners (accountRole OWNER) only — the «إدارة النظام» pages. The API enforces it too. */
export function RequireOwner({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.accountRole !== 'OWNER') return <Forbidden />;
  return <>{children}</>;
}

/**
 * A12 round 2: projects for `projects.readAll`, and for project participants their projects
 * (`GET /me/participations`; another project's page shows «لا تملك صلاحية»). The API scopes too.
 */
export function RequireProjectsAccess({ children, project }: { children: ReactNode; project?: boolean }) {
  const user = useAuthStore((s) => s.user);
  const params = useParams();
  const parts = useMyParticipations();
  if (can(user, 'projects.readAll')) return <>{children}</>;
  if (parts.isLoading) return <FullPageLoader />;
  const list = parts.data ?? [];
  const ok = project ? list.some((p) => p.projectId === params.id) : list.length > 0;
  return ok ? <>{children}</> : <Forbidden />;
}

function StatePage({
  code,
  icon,
  title,
  body,
}: {
  code?: string;
  icon: ReactNode;
  title: string;
  body: string;
}) {
  const navigate = useNavigate();
  const back = hasInAppHistory();
  return (
    <div className="nz-state-page">
      <div className="nz-state-card">
        {code ? (
          <div className="nz-state-code num" aria-hidden>
            {code}
          </div>
        ) : (
          <div className="nz-empty-ic" aria-hidden>
            {icon}
          </div>
        )}
        <h1 tabIndex={-1} style={{ fontSize: 20, margin: '0 0 6px' }}>
          {title}
        </h1>
        <p className="nz-empty-body" style={{ marginBottom: 20 }}>
          {body}
        </p>
        <Group justify="center" gap="sm">
          <Button component={Link} to="/" leftSection={<IconHome size={17} />}>
            {t('error.goHome')}
          </Button>
          {back ? (
            <Button variant="default" leftSection={<IconArrowLeft size={17} className="mirror-rtl" />} onClick={() => navigate(-1)}>
              {t('error.goBack')}
            </Button>
          ) : null}
        </Group>
      </div>
    </div>
  );
}

/** «لا تملك صلاحية» (rule 12) with a way back. */
export function Forbidden() {
  return (
    <StatePage
      icon={<IconLock size={26} stroke={1.6} />}
      title={t('error.forbiddenTitle')}
      body={t('error.forbiddenBody')}
    />
  );
}

export function NotFound() {
  return (
    <StatePage
      code="404"
      icon={<IconMapOff size={26} stroke={1.6} />}
      title={t('error.notFoundTitle')}
      body={t('error.notFoundBody')}
    />
  );
}

export function RouteError() {
  return (
    <div className="nz-state-page" style={{ minHeight: '100dvh' }}>
      <div className="nz-state-card">
        <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>{t('error.crashTitle')}</h1>
        <p className="nz-empty-body" style={{ marginBottom: 20 }}>
          {t('error.crashBody')}
        </p>
        <Button leftSection={<IconRefresh size={17} />} onClick={() => window.location.reload()}>
          {t('error.reload')}
        </Button>
      </div>
    </div>
  );
}
