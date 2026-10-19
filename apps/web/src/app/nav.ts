import { matchPath } from 'react-router-dom';
import { can, canAny, type Permission, type Role, type UserDto } from '@nuzli/shared';
import {
  IconAlertOctagon,
  IconBriefcase,
  IconClockHour4,
  IconFileReport,
  IconFolders,
  IconMessages,
  IconPaperclip,
  IconSitemap,
  IconArrowsExchange,
  IconBell,
  IconCalendarCog,
  IconCamera,
  IconChartArcs,
  IconChartBar,
  IconChecklist,
  IconClipboardList,
  IconCloudUpload,
  IconHistory,
  IconId,
  IconIdBadge2,
  IconLayoutDashboard,
  IconListDetails,
  IconPrinter,
  IconSettings,
  IconShieldCheck,
  IconTemplate,
  IconUserCheck,
  IconUserCircle,
  IconUsers,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import type { MessageKey } from '../i18n';

/*
 * The single navigation registry (design skill, navigation rule 1). The sidebar, the mini rail,
 * the phone drawer, the role bottom bars, the breadcrumbs, the command palette, the shortcut
 * sheet and the document titles all read it — and nothing else.
 */

export type NavGroupId = 'home' | 'projects' | 'collab' | 'teams' | 'violations' | 'admin';
export type BadgeKind = 'registrations' | 'pendingTeams' | 'outbox' | 'overdueTasks';
export type EntityKind = 'team' | 'project' | 'task';

/**
 * Groups in the order of GanttPRO's left nav (owner request A9): the project pages first, then
 * communication, then the field operations and administration. `quiet` groups have no visible
 * heading (a hairline separates them), but keep their name for screen readers and breadcrumbs.
 */
export const NAV_GROUPS: { id: NavGroupId; label: MessageKey; quiet?: boolean }[] = [
  { id: 'home', label: 'navGroup.home', quiet: true },
  { id: 'projects', label: 'navGroup.projects', quiet: true },
  { id: 'collab', label: 'navGroup.collab', quiet: true },
  { id: 'teams', label: 'navGroup.teams' },
  { id: 'violations', label: 'navGroup.violations' },
  { id: 'admin', label: 'navGroup.admin' },
];

export interface NavNode {
  id: string;
  /** Leaves navigate; a container (with `children`) only opens and closes. */
  path?: string;
  /** The label in the side navigation. */
  label: MessageKey;
  /** Page title, breadcrumb and document title, when different from the side label. */
  title?: MessageKey;
  icon: Icon;
  group: NavGroupId;
  /** Hidden unless `can(user, permission)`. Omit for every signed-in user. */
  permission?: Permission;
  /** Any of these permissions (instead of `permission`). */
  anyOf?: Permission[];
  /** Shown only to this role (in addition to the permission). */
  role?: Role;
  /** For these roles the item leads the navigation (first item of the first group). */
  lead?: Role[];
  /** A page announced by A9 whose screen is still being built (placeholder page). */
  soon?: boolean;
  /** Data-dependent rule (the API still enforces): supervisor violation visibility. */
  gate?: 'teamViolations';
  badge?: BadgeKind;
  /** Active only on an exact match (a parent of other pages, e.g. /teams vs /teams/formation). */
  end?: boolean;
  /** `g` then this key (shortcut sheet and palette hints). */
  key?: string;
  children?: NavNode[];
}

export const NAV: NavNode[] = [
  // ------------------------------------------------------------------ الرئيسية
  { id: 'dashboard', path: '/', label: 'nav.dashboard', icon: IconLayoutDashboard, group: 'home', end: true, key: 'h' },
  // ------------------------------------------------------------------ المشاريع (GanttPRO order, A9)
  // Supervisors do not see project management (A9): only «مهامي», which leads their navigation.
  {
    id: 'projects',
    path: '/projects',
    label: 'nav.allProjects',
    title: 'nav.projects',
    icon: IconFolders,
    group: 'projects',
    permission: 'projects.readAll',
    key: 'p',
  },
  {
    id: 'portfolios',
    path: '/portfolios',
    label: 'nav.portfolios',
    icon: IconBriefcase,
    group: 'projects',
    permission: 'projects.readAll',
  },
  {
    id: 'myTasks',
    path: '/my-tasks',
    label: 'nav.myTasks',
    icon: IconChecklist,
    group: 'projects',
    permission: 'tasks.readAssigned',
    lead: ['SUPERVISOR'],
    badge: 'overdueTasks',
    key: 'm',
  },
  {
    id: 'timeLog',
    path: '/time-log',
    label: 'nav.timeLog',
    icon: IconClockHour4,
    group: 'projects',
    permission: 'tasks.updateAssigned',
  },
  {
    id: 'reports',
    path: '/reports',
    label: 'nav.reports',
    icon: IconFileReport,
    group: 'projects',
    permission: 'projects.readAll',
  },
  {
    id: 'workload',
    path: '/workload',
    label: 'nav.workload',
    icon: IconChartArcs,
    group: 'projects',
    permission: 'projects.readAll',
  },
  // ------------------------------------------------------------------ التواصل (A9)
  // Supervisors see both too, scoped to the tasks assigned to them (ADR-092, ADR-097).
  {
    id: 'communication',
    path: '/hub',
    label: 'nav.communication',
    icon: IconMessages,
    group: 'collab',
    permission: 'tasks.comment',
  },
  {
    id: 'attachments',
    path: '/attachments',
    label: 'nav.attachments',
    icon: IconPaperclip,
    group: 'collab',
    anyOf: ['projects.readAll', 'tasks.readAssigned'],
  },
  {
    id: 'notifications',
    path: '/notifications',
    label: 'nav.notifications',
    icon: IconBell,
    group: 'collab',
    permission: 'notifications.read',
    key: 'n',
  },
  // ------------------------------------------------------------------ الفرق والكروت (phase 2)
  {
    id: 'teamsGroup',
    label: 'nav.teamsGroup',
    icon: IconUsersGroup,
    group: 'teams',
    children: [
      {
        id: 'teams',
        path: '/teams',
        label: 'nav.allTeams',
        title: 'nav.teams',
        icon: IconUsersGroup,
        group: 'teams',
        permission: 'teams.readOwn',
        badge: 'pendingTeams',
        end: true,
        key: 't',
      },
      {
        id: 'formation',
        path: '/teams/formation',
        label: 'nav.formation',
        icon: IconArrowsExchange,
        group: 'teams',
        permission: 'members.move',
        key: 'f',
      },
      { id: 'members', path: '/members', label: 'nav.members', icon: IconId, group: 'teams', permission: 'teams.readOwn' },
    ],
  },
  {
    id: 'orgStructure',
    path: '/org',
    label: 'nav.orgStructure',
    icon: IconSitemap,
    group: 'teams',
    permission: 'org.read',
  },
  {
    id: 'cardsGroup',
    label: 'nav.cards',
    icon: IconIdBadge2,
    group: 'teams',
    children: [
      {
        id: 'cards',
        path: '/cards',
        label: 'nav.printCards',
        title: 'nav.cards',
        icon: IconPrinter,
        group: 'teams',
        permission: 'cards.print',
        end: true,
        key: 'c',
      },
      {
        id: 'cardTemplates',
        path: '/cards/templates',
        label: 'nav.cardTemplates',
        icon: IconTemplate,
        group: 'teams',
        permission: 'cards.manageTemplates',
      },
      {
        id: 'cardHistory',
        path: '/cards/history',
        label: 'nav.cardHistory',
        icon: IconHistory,
        group: 'teams',
        permission: 'cards.print',
      },
    ],
  },
  // ------------------------------------------------------------------ المخالفات (phase 3)
  {
    id: 'recordViolation',
    path: '/violations/new',
    label: 'nav.recordViolation',
    icon: IconCamera,
    group: 'violations',
    permission: 'violations.create',
    key: 'r',
  },
  {
    id: 'myViolations',
    path: '/violations/mine',
    label: 'nav.myViolations',
    icon: IconClipboardList,
    group: 'violations',
    permission: 'violations.create',
  },
  {
    id: 'pendingSync',
    path: '/violations/pending',
    label: 'nav.pendingSync',
    icon: IconCloudUpload,
    group: 'violations',
    permission: 'violations.create',
    badge: 'outbox',
  },
  {
    id: 'violationsGroup',
    label: 'nav.violations',
    icon: IconAlertOctagon,
    group: 'violations',
    children: [
      {
        id: 'violations',
        path: '/violations',
        label: 'nav.violationsLog',
        title: 'nav.violations',
        icon: IconAlertOctagon,
        group: 'violations',
        permission: 'violations.readAll',
        end: true,
        key: 'v',
      },
      {
        id: 'violationsDashboard',
        path: '/violations/dashboard',
        label: 'nav.violationsDashboard',
        icon: IconChartBar,
        group: 'violations',
        permission: 'violations.stats',
        key: 'd',
      },
    ],
  },
  {
    id: 'teamViolations',
    path: '/violations/team',
    label: 'nav.teamViolations',
    icon: IconShieldCheck,
    group: 'violations',
    permission: 'violations.readOwnTeams',
    gate: 'teamViolations',
    key: 'v',
  },
  // ------------------------------------------------------------------ الإدارة
  {
    id: 'registrations',
    path: '/registrations',
    label: 'nav.registrations',
    icon: IconUserCheck,
    group: 'admin',
    permission: 'registrations.review',
    badge: 'registrations',
  },
  { id: 'users', path: '/users', label: 'nav.users', icon: IconUsers, group: 'admin', permission: 'users.read', key: 'u' },
  { id: 'audit', path: '/audit', label: 'nav.audit', icon: IconHistory, group: 'admin', permission: 'audit.read', key: 'a' },
  {
    id: 'settingsGroup',
    label: 'nav.settingsGroup',
    icon: IconSettings,
    group: 'admin',
    children: [
      {
        id: 'settings',
        path: '/settings',
        label: 'nav.settings',
        icon: IconSettings,
        group: 'admin',
        permission: 'settings.manage',
        end: true,
        key: 's',
      },
      {
        id: 'calendars',
        path: '/settings/calendars',
        label: 'nav.calendars',
        icon: IconCalendarCog,
        group: 'admin',
        permission: 'projects.manage',
      },
      {
        id: 'reference',
        path: '/settings/reference',
        label: 'nav.reference',
        icon: IconListDetails,
        group: 'admin',
        permission: 'reference.manage',
      },
    ],
  },
];

/** Pages that are reached from other pages, not from the side navigation. */
export interface RouteMeta {
  pattern: string;
  title: MessageKey;
  /** Logical parent page (breadcrumbs, back button). */
  parent?: string;
  /** The last crumb and the title come from this entity's name. */
  entity?: EntityKind;
  /** The nav item that stays active on this page. */
  activeId?: string;
  icon?: Icon;
}

export const ROUTE_META: RouteMeta[] = [
  { pattern: '/teams/:id', title: 'nav.teams', parent: '/teams', entity: 'team', activeId: 'teams' },
  // A9 imports (ADR-117): before '/projects/:id' so the static path wins.
  { pattern: '/projects/import', title: 'nav.importProject', parent: '/projects', activeId: 'projects' },
  { pattern: '/projects/:id', title: 'nav.projects', parent: '/projects', entity: 'project', activeId: 'projects' },
  // A9: the supervisor's task page (chat-style notes thread) under «مهامي».
  { pattern: '/my-tasks/:id', title: 'nav.myTasks', parent: '/my-tasks', entity: 'task', activeId: 'myTasks' },
  { pattern: '/profile', title: 'nav.profile', icon: IconUserCircle },
];

// ---------------------------------------------------------------------------- helpers

export interface NavContext {
  /** Supervisor violation visibility (data gate). */
  teamViolations: boolean;
}

/** Every leaf (navigable item) of the registry, depth-first. */
export function navLeaves(nodes: NavNode[] = NAV): NavNode[] {
  return nodes.flatMap((n) => (n.children ? navLeaves(n.children) : n.path ? [n] : []));
}

export function allowed(node: NavNode, user: UserDto | null, ctx: NavContext): boolean {
  if (!user) return false;
  if (node.permission && !can(user, node.permission)) return false;
  if (node.anyOf && !canAny(user, node.anyOf)) return false;
  if (node.role && node.role !== user.role) return false;
  if (node.gate === 'teamViolations' && (can(user, 'violations.readAll') || !ctx.teamViolations)) return false;
  return true;
}

/**
 * The registry as this user sees it (navigation rule 12): forbidden items are not rendered;
 * an empty container disappears and a container with one visible child becomes that child.
 */
export function visibleNav(user: UserDto | null, ctx: NavContext, nodes: NavNode[] = NAV): NavNode[] {
  const out: NavNode[] = [];
  for (const n of nodes) {
    if (n.children) {
      const kids = visibleNav(user, ctx, n.children);
      if (kids.length === 1) out.push({ ...kids[0]!, label: kids[0]!.title ?? kids[0]!.label });
      else if (kids.length > 1) out.push({ ...n, children: kids });
    } else if (allowed(n, user, ctx)) out.push(n);
  }
  // An item that leads for this role moves to the very top, into the first group (A9:
  // supervisors open on «مهامي»).
  // A9: whoever cannot see projects (the supervisor) never reads «المشاريع» either — what is left
  // of that group («سجل وقتي») joins the home group in the menu, the palette and the top bar.
  if (user && !can(user, 'projects.readAll')) {
    for (let i = 0; i < out.length; i++) if (out[i]!.group === 'projects') out[i] = { ...out[i]!, group: 'home' };
  }
  const lead = user ? out.findIndex((n) => n.lead?.includes(user.role)) : -1;
  if (lead > 0) {
    const [n] = out.splice(lead, 1);
    out.unshift({ ...n!, group: out[0]!.group });
  }
  return out;
}

const pathOf = (n: NavNode) => n.path ?? '';

/** Does `pathname` belong to this leaf? Exact for `end` leaves, otherwise the path and below. */
export function leafMatches(n: NavNode, pathname: string): boolean {
  const p = pathOf(n);
  if (!p) return false;
  if (pathname === p) return true;
  if (n.end || p === '/') return false;
  return pathname.startsWith(p + '/');
}

export interface Resolved {
  /** The deepest nav leaf for this path (rule 2), if any. */
  leaf: NavNode | null;
  /** Route meta for detail pages, if any. */
  meta: RouteMeta | null;
  params: Record<string, string>;
}

/** Deepest match: the longest leaf path wins, so /teams/formation beats /teams. */
export function resolvePath(pathname: string, leaves: NavNode[] = navLeaves()): Resolved {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const m of ROUTE_META) {
    const hit = matchPath({ path: m.pattern, end: true }, clean);
    if (hit) {
      // A literal leaf (e.g. /teams/formation) wins over the pattern (/teams/:id).
      const literal = leaves.find((l) => l.path === clean);
      if (literal) return { leaf: literal, meta: null, params: {} };
      const active = m.activeId ? (leaves.find((l) => l.id === m.activeId) ?? null) : null;
      return { leaf: active, meta: m, params: (hit.params ?? {}) as Record<string, string> };
    }
  }
  let best: NavNode | null = null;
  for (const l of leaves) {
    if (leafMatches(l, clean) && (!best || pathOf(l).length > pathOf(best).length)) best = l;
  }
  return { leaf: best, meta: null, params: {} };
}

/** The id chain from the top of the tree to the active leaf (containers auto-expand). */
export function activeChain(nodes: NavNode[], leafId: string | null | undefined): string[] {
  if (!leafId) return [];
  for (const n of nodes) {
    if (n.id === leafId) return [n.id];
    if (n.children) {
      const sub = activeChain(n.children, leafId);
      if (sub.length) return [n.id, ...sub];
    }
  }
  return [];
}

export interface Crumb {
  label: string;
  to?: string;
}

export interface Trail {
  /** The page title (top bar, h1 fallback, document title). */
  title: string;
  /** Ancestors only; empty on top-level pages (rule 3). */
  crumbs: Crumb[];
  /** Where the back button goes when there is no in-app history (rule 5). */
  parent: string | null;
  /** Group label for top-level pages (shown instead of crumbs). */
  group: string | null;
  /** Forbidden and missing pages show their own state card; the top bar stays quiet. */
  status?: 'ok' | 'forbidden' | 'missing';
}

/**
 * Breadcrumbs and title for a path (rules 3–5). `entityName` is the resolved name of a detail
 * page's entity (team, project); `extra` appends a last crumb for URL-driven drawers (a task).
 * `translate` is `t` (injected so this stays a pure function for tests).
 */
export function trailFor(
  pathname: string,
  opts: {
    user: UserDto | null;
    ctx: NavContext;
    translate: (key: MessageKey) => string;
    entityName?: string | null;
    extra?: string | null;
  },
): Trail {
  const { translate: tr } = opts;
  const visibleLeaves = navLeaves(visibleNav(opts.user, opts.ctx));
  const allLeaves = navLeaves();
  const { leaf, meta } = resolvePath(pathname, allLeaves);
  const titleOf = (n: NavNode) => tr(n.title ?? n.label);
  const groupOf = (n: NavNode | null) =>
    n ? tr(NAV_GROUPS.find((g) => g.id === n.group)?.label ?? 'navGroup.home') : null;

  // Parent pages from the URL: the nearest visible leaf above this path.
  const ancestors = (p: string): Crumb[] => {
    const out: Crumb[] = [];
    let cur = p;
    while (cur.lastIndexOf('/') > 0) {
      cur = cur.slice(0, cur.lastIndexOf('/'));
      const hit = visibleLeaves.find((l) => l.path === cur);
      if (hit) out.unshift({ label: titleOf(hit), to: hit.path });
    }
    return out;
  };

  if (meta) {
    const parentLeaf = meta.parent ? visibleLeaves.find((l) => l.path === meta.parent) : undefined;
    const base = parentLeaf ? [{ label: titleOf(parentLeaf), to: parentLeaf.path }] : [];
    const name = opts.entityName || tr(meta.title);
    if (!meta.parent) return { title: tr(meta.title), crumbs: [], parent: null, group: null };
    const crumbs = opts.extra ? [...base, { label: name, to: pathname }] : base;
    return {
      title: opts.extra ?? name,
      crumbs,
      parent: parentLeaf?.path ?? '/',
      group: groupOf(parentLeaf ?? null),
    };
  }
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (leaf && leaf.path === clean) {
    if (!visibleLeaves.some((l) => l.id === leaf.id)) {
      return { title: tr('error.forbiddenTitle'), crumbs: [], parent: '/', group: null, status: 'forbidden' };
    }
    const above = ancestors(clean);
    return {
      title: titleOf(leaf),
      crumbs: above,
      parent: above.length ? (above[above.length - 1]!.to ?? null) : null,
      // The group as this user sees it (a leading item moves group).
      group: groupOf(visibleLeaves.find((l) => l.id === leaf.id) ?? leaf),
    };
  }
  return { title: tr('error.notFoundTitle'), crumbs: [], parent: '/', group: null, status: 'missing' };
}

/** `g` sequences: the first leaf this user can see for each key. */
export function shortcutTargets(nodes: NavNode[]): Map<string, NavNode> {
  const map = new Map<string, NavNode>();
  for (const l of navLeaves(nodes)) if (l.key && !map.has(l.key)) map.set(l.key, l);
  return map;
}

/** «{الصفحة} · نُزلي» (rule 4). */
export function documentTitle(page: string, app: string): string {
  return page ? `${page} · ${app}` : app;
}
