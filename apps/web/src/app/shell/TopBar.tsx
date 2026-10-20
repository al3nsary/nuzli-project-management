import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Group, Menu, Modal, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronDown,
  IconCloudUpload,
  IconKeyboard,
  IconLogout,
  IconMenu2,
  IconMessageQuestion,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSun,
  IconUserCircle,
  IconWifiOff,
} from '@tabler/icons-react';
import { can } from '@nuzli/shared';
import { useThemeToggle } from '../../theme/colorScheme';
import { useAuthStore } from '../../stores/auth';
import { useApi } from '../../api/context';
import { useOnline } from '../../lib/useOnline';
import { useOfflineStore, useUnsyncedCount } from '../../features/violations/offline/runtime';
import { offlineDb } from '../../features/violations/offline/db';
import { unsyncedCount } from '../../features/violations/offline/outbox';
import { formatNumber, t, tCount } from '../../i18n';
import { useWorkspaceMenu, WorkspaceName } from '../../features/workspaces/WorkspaceName';
import { workspaceRoleText } from '../../features/workspaces/roles';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { NotificationBell } from '../NotificationBell';
import { useSessionActions } from '../useSessionActions';
import { useShellStore } from './store';
import type { Trail } from '../nav';

/** In-app history exists when the router's history index is above the first entry. */
export function hasInAppHistory(): boolean {
  const state = typeof window !== 'undefined' ? (window.history.state as { idx?: number } | null) : null;
  return typeof state?.idx === 'number' && state.idx > 0;
}

/**
 * Back (rule 5): to the previous in-app page when there is one, otherwise to the parent route —
 * never out of the app. The arrow is mirrored in RTL.
 */
export function BackButton({ parent, label }: { parent: string; label: string }) {
  const navigate = useNavigate();
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="nz-iconbtn nz-back"
        aria-label={label}
        onClick={() => (hasInAppHistory() ? navigate(-1) : navigate(parent))}
      >
        <IconArrowLeft size={18} stroke={1.8} className="mirror-rtl" />
      </button>
    </Tooltip>
  );
}

/** Network and sync state (a chip with the live pulse). */
function SyncChip() {
  const online = useOnline();
  const user = useAuthStore((s) => s.user);
  const recorder = can(user, 'violations.create');
  const pending = useUnsyncedCount(recorder ? user?.id : undefined) ?? 0;
  const running = useOfflineStore((s) => s.running);
  if (!online) {
    return (
      <span className="nz-chip nz-chip--wait" role="status">
        <IconWifiOff size={15} stroke={1.8} aria-hidden />
        <span className="nz-chip-label">{t('shell.offline')}</span>
      </span>
    );
  }
  if (recorder && pending > 0) {
    return (
      <Link to="/violations/pending" className="nz-chip nz-chip--wait" aria-label={tCount('shell.syncPendingAria', pending)}>
        <IconCloudUpload size={15} stroke={1.8} aria-hidden className={running ? 'nz-spin-soft' : undefined} />
        <b className="num">{formatNumber(pending)}</b>
        <span className="nz-chip-label">{running ? t('shell.syncing') : t('nav.pendingSync')}</span>
      </Link>
    );
  }
  return (
    <span className="nz-chip" role="status">
      <i className="nz-pulse" aria-hidden />
      <span className="nz-chip-label">{t('shell.online')}</span>
    </span>
  );
}

export function DemoResetDialog({ opened, onClose }: { opened: boolean; onClose(): void }) {
  const { resetDemo } = useSessionActions();
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title={t('shell.demoResetConfirmTitle')}>
      <Stack>
        <Text>{t('shell.demoResetConfirmBody')}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            color="breach"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resetDemo();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {t('shell.demoReset')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const api = useApi();
  const { logout } = useSessionActions();
  const setSheet = useShellStore((s) => s.setSheet);
  const { scheme, toggle: toggleScheme } = useThemeToggle();
  const [unsynced, setUnsynced] = useState(0);
  const [busy, setBusy] = useState(false);
  const [demoReset, setDemoReset] = useState(false);
  const wsMenu = useWorkspaceMenu();
  if (!user) return null;
  // Brief §7.4: warn before logout wipes violations that never reached the server.
  const requestLogout = async () => {
    const n = await unsyncedCount(offlineDb()).catch(() => 0);
    if (n > 0) setUnsynced(n);
    else void logout();
  };
  return (
    <>
      <Modal opened={unsynced > 0} onClose={() => setUnsynced(0)} title={t('shell.logoutUnsyncedTitle')}>
        <Stack>
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <IconAlertTriangle size={24} color="var(--red)" style={{ flexShrink: 0 }} aria-hidden />
            <Text>{tCount('shell.logoutUnsyncedBody', unsynced)}</Text>
          </Group>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setUnsynced(0)}>
              {t('shell.logoutStay')}
            </Button>
            <Button
              color="breach"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await logout();
                } finally {
                  setBusy(false);
                  setUnsynced(0);
                }
              }}
            >
              {tCount('shell.logoutWipe', unsynced)}
            </Button>
          </Group>
        </Stack>
      </Modal>
      {wsMenu.dialog}
      {api.demo ? <DemoResetDialog opened={demoReset} onClose={() => setDemoReset(false)} /> : null}
      <Menu position="bottom-end" width={250}>
        <Menu.Target>
          <UnstyledButton className="nz-who" aria-label={t('shell.userMenu')}>
            <UserPhotoAvatar user={user} self size={34} ring />
            <span className="nz-who-text">
              <b>{user.fullName}</b>
              <span>{workspaceRoleText(user)}</span>
            </span>
            <IconChevronDown size={15} stroke={1.8} className="nz-who-chev" aria-hidden />
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <div className="nz-who-head">
            <UserPhotoAvatar user={user} self size={40} ring />
            <div style={{ minWidth: 0 }}>
              <Text fw={700} size="sm" truncate>
                {user.fullName}
              </Text>
              <Text size="xs" c="dimmed">
                {workspaceRoleText(user)}
              </Text>
              <DualRoleBadge user={user} />
            </div>
          </div>
          <Menu.Divider />
          {wsMenu.items}
          <Menu.Item component={Link} to="/profile" leftSection={<IconUserCircle size={18} />}>
            {t('nav.profile')}
          </Menu.Item>
          <Menu.Item
            leftSection={scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            onClick={toggleScheme}
          >
            {scheme === 'dark' ? t('shell.lightMode') : t('shell.darkMode')}
          </Menu.Item>
          <Menu.Item leftSection={<IconKeyboard size={18} />} rightSection={<kbd className="nz-kbd">?</kbd>} onClick={() => setSheet(true)}>
            {t('shortcuts.title')}
          </Menu.Item>
          {api.demo ? (
            <Menu.Item leftSection={<IconRefresh size={18} />} onClick={() => setDemoReset(true)}>
              {t('shell.demoReset')}
            </Menu.Item>
          ) : null}
          <Menu.Divider />
          <Menu.Item color="breach" leftSection={<IconLogout size={18} className="mirror-rtl" />} onClick={() => void requestLogout()}>
            {t('shell.logout')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}

/**
 * The top bar (the Figma dashboard): the search field on the inline start (it opens the command
 * palette, Ctrl+K), then sync, shortcuts, bell and the user. The page title is the page's own h1;
 * breadcrumbs and Back sit in a quiet strip under the bar on pages below the top level.
 */
export function TopBar({ trail, mobile }: { trail: Trail; mobile: boolean }) {
  const setDrawer = useShellStore((s) => s.setDrawer);
  const drawer = useShellStore((s) => s.drawer);
  const setPalette = useShellStore((s) => s.setPalette);
  const location = useLocation();
  const [deep, setDeep] = useState(false);
  useEffect(() => {
    const el = document.getElementById('nz-stage');
    if (!el) return;
    const onScroll = () => setDeep(el.scrollTop > 4);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  const below = trail.crumbs.length > 0 && Boolean(trail.parent);
  const parentLabel = trail.crumbs[trail.crumbs.length - 1]?.label ?? '';
  const setSheet = useShellStore((s) => s.setSheet);

  return (
    <>
      <header className={deep ? 'nz-top deep' : 'nz-top'}>
        {mobile ? (
          <button
            type="button"
            className="nz-iconbtn"
            onClick={() => setDrawer(true)}
            aria-label={t('common.openMenu')}
            aria-expanded={drawer}
            aria-controls="nz-side"
          >
            <IconMenu2 size={20} stroke={1.8} />
          </button>
        ) : null}
        <button
          type="button"
          className="nz-searchbar"
          onClick={() => setPalette(true)}
          aria-label={t('palette.openAria')}
          aria-keyshortcuts="Control+K"
        >
          <IconSearch size={20} stroke={1.5} aria-hidden />
          <span className="nz-searchbar-label">{t('palette.searchAnything')}</span>
          <kbd className="nz-kbd nz-search-kbd">{`${t('kbd.ctrl')} K`}</kbd>
        </button>
        <h2 className="sr-only" key={location.pathname}>
          {trail.status && trail.status !== 'ok' ? '' : trail.title}
        </h2>
        {mobile ? <WorkspaceName variant="chip" /> : null}
        <div className="nz-top-sp" />
        <div className="nz-top-chips">
          <SyncChip />
          <Tooltip label={t('shortcuts.title')}>
            <button type="button" className="nz-iconbtn nz-help" onClick={() => setSheet(true)} aria-label={t('shortcuts.title')}>
              <IconMessageQuestion size={22} stroke={1.5} aria-hidden />
            </button>
          </Tooltip>
          <NotificationBell />
          <UserMenu />
        </div>
      </header>
      {below ? (
        <div className="nz-crumbbar">
          <BackButton parent={trail.parent!} label={t('nav.backTo', { page: parentLabel })} />
          <nav aria-label={t('nav.breadcrumbs')} className="nz-crumb">
            <ol>
              {trail.crumbs.map((c, i) => (
                <li key={`${c.to ?? ''}-${i}`}>{c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}</li>
              ))}
              <li className="sr-only" aria-current="page">
                {trail.title}
              </li>
            </ol>
          </nav>
        </div>
      ) : null}
    </>
  );
}

/** Rule 9: a banner when there is no network. */
export function OfflineBanner() {
  const online = useOnline();
  const user = useAuthStore((s) => s.user);
  if (online) return null;
  return (
    <div className="nz-offline" role="status">
      <IconWifiOff size={16} stroke={1.8} aria-hidden />
      <span>{can(user, 'violations.create') ? t('shell.offlineBannerRecorder') : t('shell.offlineBanner')}</span>
    </div>
  );
}
