import type { Permission, Role } from '@nuzli/shared';
import {
  IconAlertOctagon,
  IconCalendarCog,
  IconChartArcs,
  IconChecklist,
  IconCamera,
  IconChartBar,
  IconClipboardList,
  IconCloudUpload,
  IconShieldCheck,
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
  /** Show a count next to the item: pending registrations, or unsynced violations on this device. */
  badge?: 'registrations' | 'outbox';
  /** Extra data-dependent rule (the API still enforces): supervisor violation visibility. */
  gate?: 'teamViolations';
  /** Shown only to this role (in addition to the permission). */
  role?: Role;
  /** Active only on an exact match (a parent of other items, e.g. /teams vs /teams/formation). */
  end?: boolean;
}

/**
 * The single navigation registry. Later phases append their items here
 * (projects, my tasks, teams, team formation, violations, work cards…) — and nowhere else.
 */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: IconLayoutDashboard, end: true },
  // Phase 4 — projects and the Gantt (brief §6)
  { to: '/projects', label: 'nav.projects', icon: IconChartArcs, permission: 'projects.readGranted' },
  // Admins hold every permission but are not assigned tasks: «مهامي» is for supervisors.
  { to: '/my-tasks', label: 'nav.myTasks', icon: IconChecklist, permission: 'tasks.updateAssigned', role: 'SUPERVISOR' },
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
  // Phase 3 — violations (brief §7)
  {
    to: '/violations/new',
    label: 'nav.recordViolation',
    icon: IconCamera,
    permission: 'violations.create',
  },
  {
    to: '/violations/mine',
    label: 'nav.myViolations',
    icon: IconClipboardList,
    permission: 'violations.create',
  },
  {
    to: '/violations/pending',
    label: 'nav.pendingSync',
    icon: IconCloudUpload,
    permission: 'violations.create',
    badge: 'outbox',
  },
  {
    to: '/violations',
    label: 'nav.violations',
    icon: IconAlertOctagon,
    permission: 'violations.readAll',
    end: true,
  },
  {
    to: '/violations/dashboard',
    label: 'nav.violationsDashboard',
    icon: IconChartBar,
    permission: 'violations.stats',
  },
  {
    to: '/violations/team',
    label: 'nav.teamViolations',
    icon: IconShieldCheck,
    permission: 'violations.readOwnTeams',
    gate: 'teamViolations',
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
    to: '/settings/calendars',
    label: 'nav.calendars',
    icon: IconCalendarCog,
    permission: 'projects.manage',
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
