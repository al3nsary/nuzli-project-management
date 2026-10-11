import type { Permission } from '@nuzli/shared';
import {
  IconBell,
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
}

/**
 * The single navigation registry. Later phases append their items here
 * (projects, my tasks, teams, team formation, violations, work cards…) — and nowhere else.
 */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: IconLayoutDashboard },
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
  { to: '/settings', label: 'nav.settings', icon: IconSettings, permission: 'settings.manage' },
];
