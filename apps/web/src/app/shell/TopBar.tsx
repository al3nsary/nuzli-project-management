import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Group, Menu, Modal, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconArrowLeft,
  IconChevronDown,
  IconCloudUpload,
  IconKeyboard,
  IconLogout,
  IconDeviceMobileDown,
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
import { formatNumber, t, tCount } from '../../i18n';
import { useWorkspaceMenu } from '../../features/workspaces/WorkspaceName';
import { workspaceRoleText } from '../../features/workspaces/roles';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { NotificationBell } from '../NotificationBell';
import { useSessionActions } from '../useSessionActions';
import { useShellStore } from './store';
import { useLogoutFlow } from './useLogoutFlow';
import { NozolyLogo } from '../../components/Brand';
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
  const setSheet = useShellStore((s) => s.setSheet);
  const { scheme, toggle: toggleScheme } = useThemeToggle();
  const [demoReset, setDemoReset] = useState(false);
  const wsMenu = useWorkspaceMenu();
  const logoutFlow = useLogoutFlow();
  if (!user) return null;
  return (
    <>
      {logoutFlow.dialog}
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
          {/* A12: install, updates and the app version live in «المزيد». */}
          <Menu.Item component={Link} to="/more#app" leftSection={<IconDeviceMobileDown size={18} />}>
            {t('more.appMenu')}
          </Menu.Item>
          {api.demo ? (
            <Menu.Item leftSection={<IconRefresh size={18} />} onClick={() => setDemoReset(true)}>
              {t('shell.demoReset')}
            </Menu.Item>
          ) : null}
          <Menu.Divider />
          <Menu.Item color="breach" leftSection={<IconLogout size={18} className="mirror-rtl" />} onClick={() => void logoutFlow.request()}>
            {t('shell.logout')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}

/**
 * A12 — the compact top bar of phones and portrait tablets: light, 56px, on the page grey. The
 * start holds Back (pages below the top level) or the Nozoly logo; the end holds the sync chip
 * (offline / waiting only), search and the bell as round white buttons. The page's own h1 is the
 * large title; once it scrolls away, its name settles into the bar (like iOS large titles).
 * The home page has no bar: its greeting header (avatar, «مرحبًا، …», workspace, bell) replaces it.
 */
function CompactTopBar({ trail, home }: { trail: Trail; home: boolean }) {
  const setPalette = useShellStore((s) => s.setPalette);
  const location = useLocation();
  const [deep, setDeep] = useState(false);
  useEffect(() => {
    const el = document.getElementById('nz-stage');
    if (!el) return;
    const onScroll = () => setDeep(el.scrollTop > 52);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [location.pathname]);
  const below = Boolean(trail.parent) && (trail.crumbs.length > 0 || trail.status === 'forbidden' || trail.status === 'missing');
  const parentLabel = trail.crumbs[trail.crumbs.length - 1]?.label ?? t('nav.dashboard');
  const title = trail.status && trail.status !== 'ok' ? '' : trail.title;
  if (home) {
    return (
      <h2 className="sr-only" key={location.pathname}>
        {title}
      </h2>
    );
  }
  return (
    <header className={deep ? 'nz-mtop deep' : 'nz-mtop'}>
      <div className="nz-mtop-start">
        {below ? (
          <BackButton parent={trail.parent!} label={t('nav.backTo', { page: parentLabel })} />
        ) : (
          <Link to="/" className="nz-mtop-logo" aria-label={t('nav.homeAria')}>
            <NozolyLogo width={84} decorative />
          </Link>
        )}
      </div>
      <h2 className="nz-mtop-title" aria-hidden={!deep || undefined} key={location.pathname}>
        <span className="sr-only">{title}</span>
        <span aria-hidden>{title}</span>
      </h2>
      <div className="nz-mtop-end">
        <SyncChip />
        <button type="button" className="nz-iconbtn nz-round" onClick={() => setPalette(true)} aria-label={t('palette.openAria')}>
          <IconSearch size={20} stroke={1.7} aria-hidden />
        </button>
        <NotificationBell />
      </div>
    </header>
  );
}

/**
 * The top bar (the Figma dashboard): the search field on the inline start (it opens the command
 * palette, Ctrl+K), then sync, shortcuts, bell and the user. The page title is the page's own h1;
 * breadcrumbs and Back sit in a quiet strip under the bar on pages below the top level.
 * Phones and portrait tablets (`mobile`) get the compact bar above.
 */
export function TopBar({ trail, mobile, home = false }: { trail: Trail; mobile: boolean; home?: boolean }) {
  if (mobile) return <CompactTopBar trail={trail} home={home} />;
  return <DesktopTopBar trail={trail} />;
}

function DesktopTopBar({ trail }: { trail: Trail }) {
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
