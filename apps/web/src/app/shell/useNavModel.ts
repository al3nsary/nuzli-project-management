import { useMemo } from 'react';
import { useTask } from '../../api/a9Queries';
import { useLocation } from 'react-router-dom';
import { can } from '@nuzli/shared';
import { useAuthStore } from '../../stores/auth';
import { useRegistrations, useTeam, useTeams, useTeamViolationsVisible } from '../../api/queries';
import { useGantt, useMyTasks } from '../../api/projectQueries';
import { useUnsyncedCount } from '../../features/violations/offline/runtime';
import { t } from '../../i18n';
import {
  activeChain,
  resolvePath,
  trailFor,
  visibleNav,
  type BadgeKind,
  type NavContext,
  type NavNode,
} from '../nav';

/** Count pills (navigation rule 11). Each query runs only for users who can see its item. */
export function useNavBadges(): Record<BadgeKind, number> {
  const user = useAuthStore((s) => s.user);
  const reg = useRegistrations({ pageSize: 1 }, can(user, 'registrations.review'));
  const pendingTeams = useTeams({ status: 'PENDING_APPROVAL' }, can(user, 'teams.approve'));
  const outbox = useUnsyncedCount(can(user, 'violations.create') ? user?.id : undefined);
  const mine = useMyTasks(can(user, 'tasks.readAssigned'));
  return {
    registrations: reg.data?.total ?? 0,
    pendingTeams: pendingTeams.data?.length ?? 0,
    outbox: outbox ?? 0,
    overdueTasks: mine.data?.filter((x) => x.overdue).length ?? 0,
  };
}

export function useNavContext(): NavContext {
  const user = useAuthStore((s) => s.user);
  const gate = useTeamViolationsVisible(can(user, 'violations.readOwnTeams') && !can(user, 'violations.readAll'));
  return { teamViolations: gate.visible };
}

/** The visible registry, the active leaf with its open containers, and the page trail. */
export function useNavModel() {
  const user = useAuthStore((s) => s.user);
  const ctx = useNavContext();
  const location = useLocation();
  const tree = useMemo(() => visibleNav(user, ctx), [user, ctx.teamViolations]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => resolvePath(location.pathname), [location.pathname]);
  const chain = useMemo(() => activeChain(tree, resolved.leaf?.id), [tree, resolved.leaf?.id]);

  // Entity names come from data the page already loads (same query keys, no extra requests).
  const id = resolved.params.id ?? null;
  const team = useTeam(resolved.meta?.entity === 'team' ? id : null);
  const gantt = useGantt(resolved.meta?.entity === 'project' && can(user, 'projects.readAll') ? id : null);
  const myTask = useTask(resolved.meta?.entity === 'task' ? id : null);
  const taskId = resolved.meta?.entity === 'project' ? new URLSearchParams(location.search).get('task') : null;
  const entityName =
    resolved.meta?.entity === 'team'
      ? (team.data?.name ?? null)
      : resolved.meta?.entity === 'project'
        ? (gantt.data?.project.name ?? null)
        : resolved.meta?.entity === 'task'
          ? (myTask.data?.name ?? null)
          : null;
  const extra = taskId ? (gantt.data?.tasks.find((x) => x.id === taskId)?.name ?? null) : null;

  const trail = useMemo(
    () => trailFor(location.pathname, { user, ctx, translate: t, entityName, extra }),
    [location.pathname, user, ctx.teamViolations, entityName, extra], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return { user, ctx, tree, resolved, chain, trail, entityName, entityLoading: Boolean(resolved.meta?.entity) && !entityName };
}

export function sumBadges(n: NavNode, badges: Record<BadgeKind, number>): number {
  if (n.children) return n.children.reduce((a, c) => a + sumBadges(c, badges), 0);
  return n.badge ? badges[n.badge] : 0;
}
