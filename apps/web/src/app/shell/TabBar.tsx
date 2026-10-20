import { Link, useLocation } from 'react-router-dom';
import type { Role } from '@nuzli/shared';
import { formatNumber, t } from '../../i18n';
import type { BadgeKind, NavNode } from '../nav';
import { MORE_ICON, tabsFor, type TabSpec } from './tabs';

/** Waiting work is amber (sync); work to act on is red (design skill pills). */
const QUIET: BadgeKind[] = ['outbox'];

function Badge({ n, quiet }: { n: number; quiet?: boolean }) {
  if (!n) return null;
  return (
    <span className={quiet ? 'nz-tb-badge q' : 'nz-tb-badge'} aria-hidden>
      {formatNumber(Math.min(n, 99))}
    </span>
  );
}

function Tab({ tab, on, count, quiet }: { tab: TabSpec; on: boolean; count: number; quiet: boolean }) {
  const Glyph = on && tab.iconOn ? tab.iconOn : tab.icon;
  const label = t(tab.label);
  return (
    <Link
      to={tab.node.path!}
      className={['nz-tb', on ? 'on' : '', tab.primary ? 'primary' : ''].filter(Boolean).join(' ')}
      aria-current={on ? 'page' : undefined}
      aria-label={count ? `${label} — ${t('nav.countAria', { n: count })}` : undefined}
      data-tab={tab.id}
    >
      <span className={tab.primary ? 'nz-tb-ic nz-tb-raise' : 'nz-tb-ic'}>
        <Glyph size={tab.primary ? 26 : 23} stroke={tab.primary ? 1.8 : 1.6} aria-hidden />
        <Badge n={count} quiet={quiet} />
      </span>
      <span className="nz-tb-label">{label}</span>
    </Link>
  );
}

/**
 * The bottom bar of phones and portrait tablets (A12): four destinations of the user's role and
 * «المزيد» (a page with everything else, the profile, the workspace switch, the theme, install and
 * updates, and sign-out). Icon and label on every tab; the active tab is filled and violet; counts
 * as badges; safe-area insets; the monitor's «تسجيل مخالفة» is the raised violet centre.
 */
export function TabBar({
  role,
  tree,
  chain,
  badges,
}: {
  role: Role | null;
  tree: NavNode[];
  chain: string[];
  badges: Record<BadgeKind, number>;
}) {
  const { pathname } = useLocation();
  const tabs = tabsFor(role, tree);
  const activeId = chain[chain.length - 1];
  const inBar = tabs.some((x) => x.id === activeId);
  const moreOn = pathname === '/more' || (!inBar && pathname !== '/');
  const MoreGlyph = moreOn ? MORE_ICON.iconOn : MORE_ICON.icon;
  // «المزيد» carries the counts of what it hides (approvals, pending teams…).
  const shown = new Set(tabs.map((x) => x.node.badge).filter(Boolean));
  const hidden = (Object.keys(badges) as BadgeKind[]).filter((k) => !shown.has(k) && k !== 'hubUnread' && hasBadge(tree, k));
  const moreCount = hidden.reduce((a, k) => a + (badges[k] ?? 0), 0);
  return (
    <nav className="nz-tbar" aria-label={t('nav.bottomBar')} data-count={tabs.length + 1} style={{ ['--tabs' as string]: tabs.length + 1 }}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          on={tab.id === activeId && pathname !== '/more'}
          count={tab.node.badge ? (badges[tab.node.badge] ?? 0) : 0}
          quiet={Boolean(tab.node.badge && QUIET.includes(tab.node.badge))}
        />
      ))}
      <Link
        to="/more"
        className={moreOn ? 'nz-tb on' : 'nz-tb'}
        aria-current={moreOn ? 'page' : undefined}
        aria-label={moreCount ? `${t('nav.more')} — ${t('nav.countAria', { n: moreCount })}` : undefined}
        data-tab="more"
      >
        <span className="nz-tb-ic">
          <MoreGlyph size={23} stroke={1.6} aria-hidden />
          <Badge n={moreCount} />
        </span>
        <span className="nz-tb-label">{t('nav.more')}</span>
      </Link>
    </nav>
  );
}

function hasBadge(nodes: NavNode[], kind: BadgeKind): boolean {
  return nodes.some((n) => n.badge === kind || (n.children ? hasBadge(n.children, kind) : false));
}
