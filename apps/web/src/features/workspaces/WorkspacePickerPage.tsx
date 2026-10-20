import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Loader, Stack } from '@mantine/core';
import { IconBuildingCommunity, IconChevronRight, IconLogout } from '@tabler/icons-react';
import type { WorkspaceSummaryDto } from '@nuzli/shared';
import { AuthLayout } from '../../pages/auth/AuthLayout';
import { needsWorkspacePick, useAuthStore } from '../../stores/auth';
import { useSessionActions } from '../../app/useSessionActions';
import { roleLabel } from '../../components/ui';
import { t, tCount } from '../../i18n';
import { useOutboxElsewhere } from '../violations/offline/runtime';
import { useWorkspaceSwitch } from './useWorkspaceSwitch';
import './workspaces.css';

/** The roles of a workspace card: pills, or «مالك النظام» for an owner without a membership there. */
function RolePills({ ws, owner }: { ws: WorkspaceSummaryDto; owner: boolean }) {
  if (!ws.roles.length) {
    return <span className="pill brand">{owner ? t('workspacePick.ownerAll') : t('common.none')}</span>;
  }
  return (
    <>
      {ws.roles.map((r) => (
        <span key={r} className="pill grey">
          {roleLabel(r)}
        </span>
      ))}
      {owner ? <span className="pill brand">{t('role.OWNER')}</span> : null}
    </>
  );
}

/**
 * «اختر القسم» (owner A12): after sign-in a user with several workspaces chooses one; switching
 * later is in the top-bar menu on their name. Never shown in single-workspace mode.
 */
export function WorkspacePickerPage() {
  const state = useAuthStore();
  const { enter, busyId } = useWorkspaceSwitch();
  const { logout } = useSessionActions();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string; lost?: boolean } | null)?.from ?? '/';
  const lost = Boolean((location.state as { lost?: boolean } | null)?.lost);
  const [entering, setEntering] = useState(false);
  // A12 security review H3: unsynced violations recorded on this device, by workspace. They are
  // kept whatever is picked here; the notice says where they will be sent.
  const waiting = useOutboxElsewhere(state.user?.id ?? null, null);
  const waitingBy = new Map(waiting.map((w) => [w.workspaceId, w.count]));

  useEffect(() => {
    if (state.status === 'authenticated' && state.workspaces.length === 1 && !state.activeWorkspace && !entering) {
      setEntering(true);
      void enter(state.workspaces[0]!.id, { quiet: true }).then((s) => {
        if (s) navigate(from, { replace: true });
        else setEntering(false);
      });
    }
  }, [state.status, state.workspaces, state.activeWorkspace, entering, enter, navigate, from]);

  if (state.status === 'loading') return null;
  if (state.status !== 'authenticated') return <Navigate to="/login" replace />;
  if (!needsWorkspacePick(state) && state.activeWorkspace && !lost) return <Navigate to={from} replace />;

  const owner = state.user?.accountRole === 'OWNER';

  return (
    <AuthLayout title={t('workspacePick.title')} subtitle={t('workspacePick.sub')} width={520}>
      <Stack gap="md">
        {lost ? (
          <Alert color="signal" variant="light">
            {t('workspacePick.lost')}
          </Alert>
        ) : null}
        {state.workspaces.length === 0 ? <Alert color="gray">{t('workspacePick.empty')}</Alert> : null}
        {waiting.length ? (
          <Alert color="signal" variant="light" data-testid="ws-pick-unsynced">
            {t('workspacePick.unsyncedNotice')}
          </Alert>
        ) : null}
        {entering ? (
          <Stack align="center" py="md">
            <Loader size="sm" />
            <span>{t('workspacePick.entering')}</span>
          </Stack>
        ) : (
          <div className="nz-ws-pick" role="list">
            {state.workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="listitem"
                className="nz-ws-card"
                aria-busy={busyId === ws.id}
                aria-label={t('workspacePick.enter', { name: ws.name })}
                disabled={busyId !== null}
                onClick={async () => {
                  const s = await enter(ws.id);
                  if (s) navigate(from, { replace: true });
                }}
              >
                <span className="nz-ws-ic" aria-hidden>
                  <IconBuildingCommunity size={22} stroke={1.7} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <b>{ws.name}</b>
                  <span className="nz-ws-roles">
                    <RolePills ws={ws} owner={owner} />
                    {waitingBy.get(ws.id) ? (
                      <span className="pill wait" data-testid={`ws-unsynced-${ws.code}`}>
                        {tCount('workspacePick.unsynced', waitingBy.get(ws.id)!)}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="nz-ws-go" aria-hidden>
                  {busyId === ws.id ? <Loader size={16} /> : <IconChevronRight size={20} className="mirror-rtl" />}
                </span>
              </button>
            ))}
          </div>
        )}
        <Button variant="subtle" color="gray" leftSection={<IconLogout size={16} className="mirror-rtl" />} onClick={() => void logout()}>
          {t('workspacePick.signOut')}
        </Button>
      </Stack>
    </AuthLayout>
  );
}
