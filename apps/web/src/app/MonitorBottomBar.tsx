import { Link } from 'react-router-dom';
import { IconDots } from '@tabler/icons-react';
import type { Role } from '@nuzli/shared';
import { formatNumber, t, type MessageKey } from '../i18n';
import { navLeaves, type BadgeKind, type NavNode } from './nav';
import { useShellStore } from './shell/store';

/** Each role's phone bar, by registry id (design skill «Mobile»), plus «المزيد». */
const BARS: Partial<Record<Role, { id: string; label?: MessageKey; primary?: boolean }[]>> = {
  MONITOR: [{ id: 'recordViolation', primary: true }, { id: 'myViolations' }, { id: 'pendingSync' }],
  // A9: supervisors open on «مهامي».
  SUPERVISOR: [{ id: 'myTasks' }, { id: 'dashboard' }, { id: 'teams', label: 'nav.myTeams' }],
};

export function hasBottomBar(role: Role | undefined): boolean {
  return Boolean(role && BARS[role]);
}

/**
 * The bottom tab bar (phones only, < 768px): the role's three destinations and
 * «المزيد», which opens the side drawer. Safe-area insets.
 */
export function RoleBottomBar({
  role,
  tree,
  chain,
  badges,
}: {
  role: Role;
  tree: NavNode[];
  chain: string[];
  badges: Record<BadgeKind, number>;
}) {
  const setDrawer = useShellStore((s) => s.setDrawer);
  const drawer = useShellStore((s) => s.drawer);
  const leaves = navLeaves(tree);
  const items = (BARS[role] ?? [])
    .map((b) => ({ ...b, node: leaves.find((l) => l.id === b.id) }))
    .filter((b): b is typeof b & { node: NavNode } => Boolean(b.node));
  const activeId = chain[chain.length - 1];
  const inBar = items.some((b) => b.node.id === activeId);
  return (
    <nav className="nz-tabs" aria-label={t('nav.bottomBar')}>
      {items.map(({ node, label, primary }) => {
        const on = node.id === activeId;
        const count = node.badge ? badges[node.badge] : 0;
        return (
          <Link
            key={node.id}
            to={node.path!}
            className={['nz-tab', on ? 'on' : '', primary ? 'primary' : ''].filter(Boolean).join(' ')}
            aria-current={on ? 'page' : undefined}
          >
            <span className={primary ? 'nz-tab-ic nz-tab-hb' : 'nz-tab-ic'}>
              <node.icon size={primary ? 20 : 21} stroke={1.7} aria-hidden />
              {count ? (
                <span className="nz-tab-badge" aria-label={t('nav.countAria', { n: count })}>
                  {formatNumber(count)}
                </span>
              ) : null}
            </span>
            <span className="nz-tab-label">{t(label ?? node.label)}</span>
          </Link>
        );
      })}
      <button
        type="button"
        className={['nz-tab', !inBar ? 'on' : ''].filter(Boolean).join(' ')}
        onClick={() => setDrawer(true)}
        aria-expanded={drawer}
        aria-controls="nz-side"
      >
        <span className="nz-tab-ic">
          <IconDots size={21} stroke={1.7} aria-hidden />
        </span>
        <span className="nz-tab-label">{t('nav.more')}</span>
      </button>
    </nav>
  );
}
