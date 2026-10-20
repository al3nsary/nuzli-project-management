import { useEffect, useLayoutEffect, useRef } from 'react';
import { uiRoleOf } from '../features/workspaces/roles';
import { Outlet, useLocation, useMatches, useNavigationType } from 'react-router-dom';
import { can } from '@nuzli/shared';
import { IS_DEMO } from '../api';
import { t } from '../i18n';
import { documentTitle } from './nav';
import { Sidebar } from './shell/Sidebar';
import { OfflineBanner, TopBar } from './shell/TopBar';
import { CommandPalette } from './shell/CommandPalette';
import { ShortcutSheet, useShortcuts } from './shell/shortcuts';
import { selectMini, useShellStore } from './shell/store';
import { useNavBadges, useNavModel } from './shell/useNavModel';
import { TabBar } from './shell/TabBar';
import { useCompactShell, useKeyboardInset, usePhone, useTabletLandscape } from './shell/viewport';

/** Scroll positions per history entry (rule 6): restored on back/forward, top on a new page. */
const scrollPositions = new Map<string, number>();

/** The stage scrolls, so the side and the top bar never move. */
export function stageScroller(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('nz-stage');
}

function safeScrollTo(y: number) {
  const el = stageScroller();
  try {
    if (el) el.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });
  } catch {
    if (el) el.scrollTop = y;
  }
}

/** Moves focus to the page h1 once it renders (lazy pages and skeletons render it later). */
function focusPageHeading(signal: { cancelled: boolean }) {
  let tries = 0;
  const tick = () => {
    if (signal.cancelled) return;
    const h1 = document.querySelector<HTMLElement>('#main h1');
    if (h1) {
      if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
      return;
    }
    if (++tries < 40) window.setTimeout(tick, 75);
    else document.getElementById('main')?.focus({ preventScroll: true });
  };
  tick();
}

/**
 * Navigation lifecycle: document title (rule 4), scroll and focus (rule 6), recent items.
 * Only a change of path counts as a new page; drawers and tabs live in the query string.
 */
function usePageLifecycle(title: string, recent: { kind: 'team' | 'project'; id: string; name: string } | null) {
  const location = useLocation();
  const navType = useNavigationType();
  const lastPath = useRef<string | null>(null);
  const lastKey = useRef(location.key);
  const pushRecent = useShellStore((s) => s.pushRecent);

  useEffect(() => {
    document.title = documentTitle(title, t('app.name'));
  }, [title]);

  useEffect(() => {
    if (recent) pushRecent({ ...recent, path: `/${recent.kind === 'team' ? 'teams' : 'projects'}/${recent.id}` });
  }, [recent?.id, recent?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    } catch {
      /* ignore */
    }
    const el = stageScroller();
    if (!el) return;
    const onScroll = () => scrollPositions.set(lastKey.current, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    lastKey.current = location.key;
    const first = lastPath.current === null;
    const changed = lastPath.current !== location.pathname;
    lastPath.current = location.pathname;
    if (first || !changed) return;
    const signal = { cancelled: false };
    const saved = scrollPositions.get(location.key);
    if (navType === 'POP' && saved !== undefined) {
      // Restore once the page is tall enough again (data from the cache or the network), for up
      // to 1.5 s; a wheel or touch by the user stops it.
      const el = stageScroller();
      let tries = 0;
      const stop = () => {
        signal.cancelled = true;
      };
      el?.addEventListener('wheel', stop, { once: true, passive: true });
      el?.addEventListener('touchstart', stop, { once: true, passive: true });
      const tick = () => {
        if (signal.cancelled || !el) return;
        safeScrollTo(saved);
        if (el.scrollHeight - el.clientHeight >= saved - 1 || ++tries > 30) return;
        window.setTimeout(tick, 50);
      };
      tick();
    } else {
      safeScrollTo(0);
    }
    focusPageHeading(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [location.key, location.pathname, navType]);
}

export function Layout() {
  const { user, tree, chain, trail, resolved, entityName } = useNavModel();
  const badges = useNavBadges();
  // A12: phones and portrait tablets get the compact shell (bottom bar, drawer side, light top
  // bar); landscape tablets open on the rail. Pages keep their own phone checks.
  const phone = usePhone();
  const mobile = useCompactShell();
  const tabletLandscape = useTabletLandscape();
  const setAutoMini = useShellStore((s) => s.setAutoMini);
  useEffect(() => setAutoMini(tabletLandscape), [tabletLandscape, setAutoMini]);
  useKeyboardInset();
  const mini = useShellStore(selectMini) && !mobile;
  const drawer = useShellStore((s) => s.drawer);
  const setDrawer = useShellStore((s) => s.setDrawer);
  const bindUser = useShellStore((s) => s.bindUser);
  const location = useLocation();

  useEffect(() => bindUser(user?.id ?? null), [user?.id, bindUser]);
  // Any navigation closes the phone drawer.
  useEffect(() => setDrawer(false), [location.pathname, setDrawer]);
  useEffect(() => {
    if (!mobile) setDrawer(false);
  }, [mobile, setDrawer]);

  useShortcuts(tree, { mobile });
  // Recent items (palette) remember teams and projects; a supervisor task page is not one of them.
  const kind = resolved.meta?.entity;
  const entity = kind && kind !== 'task' && entityName && resolved.params.id
    ? { kind, id: resolved.params.id, name: entityName }
    : null;
  usePageLifecycle(trail.title, entity);

  // Boards and wide grids (route handle fullWidth) use the whole width; forms stay at 1200px.
  const matches = useMatches();
  const fullWidth = matches.some((m) => (m.handle as { fullWidth?: boolean } | undefined)?.fullWidth === true);
  const uiRole = uiRoleOf(user);
  const bottomBar = mobile && Boolean(user);

  return (
    <div
      className={['nz-room', mini ? 'is-mini' : '', bottomBar ? 'nz-has-bottombar' : '', mobile ? 'is-compact' : '', phone ? 'is-phone' : '']
        .filter(Boolean)
        .join(' ')}
      data-home={location.pathname === '/' || undefined}
    >
      <a href="#main" className="nz-skip">
        {t('app.skipToContent')}
      </a>
      <Sidebar tree={tree} chain={chain} badges={badges} mobile={mobile} canCreate={can(user, 'projects.create')} />
      {mobile && drawer ? <div className="nz-scrim" onClick={() => setDrawer(false)} aria-hidden /> : null}
      <div className="nz-stage" id="nz-stage">
        {IS_DEMO ? (
          <div className="demo-strip" role="note">
            {t('shell.demoStrip')}
          </div>
        ) : null}
        <TopBar trail={trail} mobile={mobile} home={location.pathname === '/'} />
        <OfflineBanner />
        <main id="main" tabIndex={-1} className="nz-main">
          <div className={fullWidth ? 'nz-page nz-page--wide' : 'nz-page'} key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>
      {bottomBar ? <TabBar role={uiRole} tree={tree} chain={chain} badges={badges} /> : null}
      <CommandPalette user={user} tree={tree} />
      <ShortcutSheet tree={tree} />
    </div>
  );
}
