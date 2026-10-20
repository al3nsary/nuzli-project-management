import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Loader, Switch } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBuildingCommunity,
  IconCheck,
  IconChevronLeft,
  IconDeviceMobileDown,
  IconDeviceMobileCheck,
  IconInfoCircle,
  IconLogout,
  IconMoon,
  IconRefresh,
  IconRotate2,
  type Icon,
} from '@tabler/icons-react';
import { useAuthStore } from '../stores/auth';
import { useApi } from '../api/context';
import { formatDateTime, formatNumber, t } from '../i18n';
import { NAV_GROUPS, navLeaves, type BadgeKind } from '../app/nav';
import { useNavBadges, useNavModel } from '../app/shell/useNavModel';
import { tabIds, tabsFor } from '../app/shell/tabs';
import { useCompactShell } from '../app/shell/viewport';
import { useLogoutFlow } from '../app/shell/useLogoutFlow';
import { uiRoleOf, workspaceRoleText } from '../features/workspaces/roles';
import { useWorkspaceMenu, WorkspaceName } from '../features/workspaces/WorkspaceName';
import { DualRoleBadge } from '../features/workspaces/DualRole';
import { UserPhotoAvatar } from '../components/UserAvatar';
import { useThemeToggle } from '../theme/colorScheme';
import { usePwaStore } from '../app/pwaStore';
import { APP_BUILT_AT, versionLabel } from '../app/pwa/version';
import { promptInstall, useInstallMode, useInstallStore } from '../app/pwa/install';
import { DemoResetDialog } from '../app/shell/TopBar';

const QUIET: BadgeKind[] = ['outbox'];

function Row({
  icon: Glyph,
  label,
  hint,
  to,
  onClick,
  end,
  tone,
  testId,
}: {
  icon: Icon;
  label: string;
  hint?: ReactNode;
  to?: string;
  onClick?: () => void;
  end?: ReactNode;
  tone?: 'red';
  testId?: string;
}) {
  const body = (
    <>
      <span className="nz-more-ic" data-tone={tone} aria-hidden>
        <Glyph size={20} stroke={1.7} />
      </span>
      <span className="nz-more-text">
        <b>{label}</b>
        {hint ? <span>{hint}</span> : null}
      </span>
      {end ?? (to ? <IconChevronLeft size={18} stroke={1.8} className="nz-more-chev" aria-hidden /> : null)}
    </>
  );
  if (to)
    return (
      <Link to={to} className="nz-more-row" data-testid={testId}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" className="nz-more-row" onClick={onClick} data-tone={tone} data-testid={testId}>
        {body}
      </button>
    );
  return (
    <div className="nz-more-row" data-testid={testId}>
      {body}
    </div>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section className="nz-more-sec" aria-label={title} id={id}>
      <h2 className="nz-more-h">{title}</h2>
      <div className="nz-more-card">{children}</div>
    </section>
  );
}

/** Install on this device: Android/desktop prompt, the iPhone guide, or «installed». */
function InstallRow() {
  const mode = useInstallMode();
  const iosSafari = useInstallStore((s) => s.iosSafari);
  if (mode === 'installed') {
    return <Row icon={IconDeviceMobileCheck} label={t('install.installed')} hint={t('install.installedBody')} testId="more-installed" />;
  }
  if (mode === 'prompt') {
    return (
      <Row
        icon={IconDeviceMobileDown}
        label={t('install.button')}
        hint={t('install.cardBody')}
        testId="more-install"
        onClick={async () => {
          const r = await promptInstall();
          if (r === 'accepted') notifications.show({ color: 'ok', message: t('install.accepted') });
        }}
      />
    );
  }
  if (mode === 'ios-guide') {
    return <Row icon={IconDeviceMobileDown} label={t('install.iosButton')} hint={iosSafari ? t('install.cardBody') : t('install.guide.notSafari')} to="/install" testId="more-install-ios" />;
  }
  return <Row icon={IconDeviceMobileDown} label={t('install.howTo')} hint={t('install.manualBody')} to="/install" testId="more-install-manual" />;
}

/** Version, «البحث عن تحديث», and «حدّث الآن» when a new version waits. */
function UpdateRows() {
  const { needRefresh, status, lastCheckedAt, check, update, updating, waitingForSync } = usePwaStore();
  const statusText =
    status === 'checking'
      ? t('pwa.checking')
      : status === 'upToDate'
        ? t('pwa.upToDate')
        : status === 'error'
          ? t('pwa.checkError')
          : status === 'unsupported' || !check
            ? t('pwa.unsupported')
            : lastCheckedAt
              ? t('pwa.lastChecked', { at: formatDateTime(new Date(lastCheckedAt).toISOString()) })
              : null;
  return (
    <>
      <Row
        icon={IconInfoCircle}
        label={t('pwa.version', { version: versionLabel() })}
        hint={APP_BUILT_AT ? t('pwa.builtAt', { date: formatDateTime(APP_BUILT_AT) }) : undefined}
        testId="more-version"
      />
      {needRefresh ? (
        <Row
          icon={IconRefresh}
          label={t('pwa.available')}
          hint={waitingForSync ? t('pwa.waitingForSync') : t('pwa.updateBody')}
          testId="more-update-now"
          end={
            <Button size="xs" onClick={() => void update?.()} loading={updating}>
              {t('pwa.updateNow')}
            </Button>
          }
        />
      ) : (
        <Row
          icon={IconRotate2}
          label={t('pwa.checkNow')}
          hint={<span role="status">{statusText}</span>}
          testId="more-check"
          onClick={check && status !== 'checking' ? () => void check() : undefined}
          end={status === 'checking' ? <Loader size={18} /> : status === 'upToDate' ? <IconCheck size={18} color="var(--live)" aria-hidden /> : undefined}
        />
      )}
    </>
  );
}

/**
 * «المزيد» (A12): everything the bottom bar does not show, grouped like the side navigation, then
 * the profile, the workspace switch (several workspaces), the theme, install and updates (with
 * the version and build date) and sign-out. On desktop it is reachable from the user menu
 * («التطبيق والتحديثات»).
 */
export function MorePage() {
  const user = useAuthStore((s) => s.user);
  const api = useApi();
  const { tree } = useNavModel();
  const badges = useNavBadges();
  const compact = useCompactShell();
  const { scheme, toggle } = useThemeToggle();
  const ws = useWorkspaceMenu();
  const logoutFlow = useLogoutFlow();
  const [demoReset, setDemoReset] = useState(false);
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
  }, [hash]);

  if (!user) return null;
  const hide = compact ? tabIds(tabsFor(uiRoleOf(user), tree)) : new Set<string>();
  const leaves = navLeaves(tree).filter((n) => !hide.has(n.id) && n.id !== 'dashboard');

  return (
    <div className="nz-more">
      <h1 className="nz-more-title" tabIndex={-1}>
        {t('more.title')}
      </h1>

      <Link to="/profile" className="nz-more-me" data-testid="more-profile">
        <UserPhotoAvatar user={user} self size={56} ring />
        <span className="nz-more-me-text">
          <b>{user.fullName}</b>
          <span>{workspaceRoleText(user)}</span>
          <span className="nz-more-me-ws">
            <WorkspaceName />
            <DualRoleBadge user={user} />
          </span>
        </span>
        <IconChevronLeft size={18} stroke={1.8} className="nz-more-chev" aria-hidden />
      </Link>

      {ws.visible ? (
        <Section title={t('more.workspaces')}>
          {ws.workspaces.map((w) => {
            const active = w.id === ws.activeId;
            return (
              <Row
                key={w.id}
                icon={IconBuildingCommunity}
                label={w.name}
                hint={active ? t('workspaceSwitch.active') : t('more.workspacesHint')}
                onClick={active || ws.busyId ? undefined : () => void ws.pick(w.id)}
                end={active ? <IconCheck size={18} color="var(--accent)" aria-label={t('workspaceSwitch.active')} /> : ws.busyId === w.id ? <Loader size={18} /> : undefined}
                testId={`more-ws-${w.code}`}
              />
            );
          })}
        </Section>
      ) : null}

      {NAV_GROUPS.map((g) => {
        const items = leaves.filter((n) => n.group === g.id);
        if (!items.length) return null;
        return (
          <Section key={g.id} title={t(g.label)}>
            {items.map((n) => {
              const count = n.badge ? (badges[n.badge] ?? 0) : 0;
              return (
                <Row
                  key={n.id}
                  icon={n.icon}
                  label={t(n.label)}
                  to={n.path!}
                  testId={`more-page-${n.id}`}
                  end={
                    count ? (
                      <span className={n.badge && QUIET.includes(n.badge) ? 'nz-more-n q' : 'nz-more-n'} aria-label={t('nav.countAria', { n: count })}>
                        {formatNumber(count)}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </Section>
        );
      })}

      <Section title={t('more.appearance')}>
        <label className="nz-more-row" data-testid="more-theme">
          <span className="nz-more-ic" aria-hidden>
            <IconMoon size={20} stroke={1.7} />
          </span>
          <span className="nz-more-text">
            <b>{t('more.darkMode')}</b>
          </span>
          <Switch checked={scheme === 'dark'} onChange={toggle} aria-label={t('more.darkMode')} size="md" />
        </label>
      </Section>

      <Section title={t('more.app')} id="app">
        <InstallRow />
        <UpdateRows />
      </Section>

      <Section title={t('more.account')}>
        {api.demo ? <Row icon={IconRefresh} label={t('more.demoReset')} onClick={() => setDemoReset(true)} /> : null}
        <Row icon={IconLogout} label={t('more.logout')} tone="red" onClick={() => void logoutFlow.request()} testId="more-logout" />
      </Section>

      {logoutFlow.dialog}
      {ws.dialog}
      {api.demo ? <DemoResetDialog opened={demoReset} onClose={() => setDemoReset(false)} /> : null}
    </div>
  );
}
