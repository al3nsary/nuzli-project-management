import type { Permission } from '@nuzli/shared';
import {
  IconArrowsExchange,
  IconBell,
  IconId,
  IconIdBadge2,
  IconListDetails,
  IconTemplate,
  IconUsersGroup,
  IconHistory,
  IconLayoutDashboard,
  IconSettings,
  IconUserCheck,
  IconUsers,
  type Icon,
} from '@tabler/icons-react';
import type { MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  label: MessageKey;
  icon: Icon;
  /** Hidden unless `can(user, permission)`. Omit for every signed-in user. */
  permission?: Permission;
  /** Show the pending-registrations count next to the item. */
  badge?: 'registrations';
  /** Active only on an exact match (a parent of other items, e.g. /teams vs /teams/formation). */
  end?: boolean;
}

/**
 * The single navigation registry. Later phases append their items here
 * (projects, my tasks, teams, team formation, violations, work cards…) — and nowhere else.
 */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: IconLayoutDashboard, end: true },
  // Phase 2 — teams and work cards (brief §5, §8)
  { to: '/teams', label: 'nav.teams', icon: IconUsersGroup, permission: 'teams.readOwn', end: true },
  { to: '/teams/formation', label: 'nav.formation', icon: IconArrowsExchange, permission: 'members.move' },
  { to: '/members', label: 'nav.members', icon: IconId, permission: 'teams.readOwn' },
  { to: '/cards', label: 'nav.cards', icon: IconIdBadge2, permission: 'cards.print', end: true },
  {
    to: '/cards/templates',
    label: 'nav.cardTemplates',
    icon: IconTemplate,
    permission: 'cards.manageTemplates',
  },
  {
    to: '/registrations',
    label: 'nav.registrations',
    icon: IconUserCheck,
    permission: 'registrations.review',
    badge: 'registrations',
  },
  { to: '/users', label: 'nav.users', icon: IconUsers, permission: 'users.read' },
  { to: '/audit', label: 'nav.audit', icon: IconHistory, permission: 'audit.read' },
  {
    to: '/notifications',
    label: 'nav.notifications',
    icon: IconBell,
    permission: 'notifications.read',
  },
  {
    to: '/settings/reference',
    label: 'nav.reference',
    icon: IconListDetails,
    permission: 'reference.manage',
  },
  {
    to: '/settings',
    label: 'nav.settings',
    icon: IconSettings,
    permission: 'settings.manage',
    end: true,
  },
];
