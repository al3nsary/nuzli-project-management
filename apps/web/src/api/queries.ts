import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './context';
import { useAuthStore } from '../stores/auth';
import { isFullNationalIdTerm, type MemberDto, type ViolationFilter } from '@nuzli/shared';
import type {
  AuditQuery,
  MemberListQuery,
  NotificationQuery,
  PageQuery,
  ReferenceKind,
  TeamListQuery,
  UserListQuery,
  ViolationListQuery,
} from './client';

/** Query keys in one place so mutations invalidate the right lists. */
export const qk = {
  users: (q?: UserListQuery) => ['users', q ?? {}] as const,
  user: (id: string) => ['user', id] as const,
  registrations: (q?: PageQuery) => ['registrations', q ?? {}] as const,
  audit: (q?: AuditQuery) => ['audit', q ?? {}] as const,
  notifications: (q?: NotificationQuery) => ['notifications', q ?? {}] as const,
  unread: ['notifications', 'unread-count'] as const,
  settings: ['settings'] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export function useUsers(q: UserListQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.users(q),
    // ADR-067: a full national ID goes in a POST body, never in the query string.
    queryFn: () => (isFullNationalIdTerm(q.q) ? api.users.search({ ...q }) : api.users.list(q)),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useUser(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk.user(id ?? ''),
    queryFn: () => api.users.get(id as string),
    enabled: useSignedIn() && Boolean(id),
    staleTime: 0,
  });
}

export function useRegistrations(q: PageQuery = {}, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.registrations(q),
    queryFn: () => api.registrations.list(q),
    enabled: useSignedIn() && enabled,
  });
}

export function useAudit(q: AuditQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.audit(q),
    queryFn: () => api.audit.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useNotifications(q: NotificationQuery) {
  const api = useApi();
  return useQuery({
    queryKey: qk.notifications(q),
    queryFn: () => api.notifications.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn(),
  });
}

export function useUnreadCount() {
  const api = useApi();
  return useQuery({
    queryKey: qk.unread,
    queryFn: () => api.notifications.unreadCount(),
    enabled: useSignedIn(),
    refetchInterval: 60_000,
  });
}

export function useSettings() {
  const api = useApi();
  return useQuery({
    queryKey: qk.settings,
    queryFn: () => api.settings.get(),
    enabled: useSignedIn(),
  });
}

/** After any user/registration change: lists, counts, audit and notifications may all move. */
export function useInvalidateAccounts() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['users'] }),
      qc.invalidateQueries({ queryKey: ['user'] }),
      qc.invalidateQueries({ queryKey: ['registrations'] }),
      qc.invalidateQueries({ queryKey: ['audit'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
}

// ---------------------------------------------------------------- Phase 2

export const qk2 = {
  teams: (q?: TeamListQuery) => ['teams', q ?? {}] as const,
  team: (id: string) => ['team', id] as const,
  supervisorHistory: (id: string) => ['team', id, 'supervisor-history'] as const,
  availableColors: (excludeTeamId?: string) => ['colors', 'available', excludeTeamId ?? ''] as const,
  palette: ['colors', 'palette'] as const,
  members: (q?: MemberListQuery) => ['members', q ?? {}] as const,
  member: (id: string) => ['member', id] as const,
  memberHistory: (id: string) => ['member', id, 'history'] as const,
  reference: (kind: ReferenceKind) => ['reference', kind] as const,
  supervisors: ['supervisors'] as const,
  cardSizes: ['cards', 'sizes'] as const,
  cardTemplates: ['cards', 'templates'] as const,
  logos: ['logos'] as const,
  batches: (q?: PageQuery) => ['cards', 'batches', q ?? {}] as const,
  batch: (id: string) => ['cards', 'batch', id] as const,
};

export function useTeams(q: TeamListQuery = {}, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.teams(q),
    queryFn: () => api.teams.list(q),
    enabled: useSignedIn() && enabled,
  });
}

export function useTeam(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.team(id ?? ''),
    queryFn: () => api.teams.get(id as string),
    enabled: useSignedIn() && Boolean(id),
  });
}

export function useSupervisorHistory(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.supervisorHistory(id ?? ''),
    queryFn: () => api.teams.supervisorHistory(id as string),
    enabled: useSignedIn() && Boolean(id),
  });
}

/** Never cached for long: another user may take a colour at any moment (brief §5.2). */
export function useAvailableColors(excludeTeamId?: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.availableColors(excludeTeamId),
    queryFn: () => api.colors.available(excludeTeamId),
    enabled: useSignedIn() && enabled,
    staleTime: 0,
  });
}

export function usePalette(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.palette,
    queryFn: () => api.colors.list(),
    enabled: useSignedIn() && enabled,
  });
}

export function useMembers(q: MemberListQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.members(q),
    queryFn: () =>
      isFullNationalIdTerm(q.q)
        ? api.members.search({ ...q, unassigned: Boolean(q.unassigned) })
        : api.members.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

/** Every member the viewer may see, page by page (formation board, card picker). */
export function useAllMembers(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['members', 'all'] as const,
    queryFn: async () => {
      const items: MemberDto[] = [];
      for (let page = 1; page < 100; page++) {
        const res = await api.members.list({ page, pageSize: 200 });
        items.push(...res.items);
        if (items.length >= res.total || !res.items.length) break;
      }
      return items;
    },
    enabled: useSignedIn() && enabled,
  });
}

export function useMember(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.member(id ?? ''),
    queryFn: () => api.members.get(id as string),
    enabled: useSignedIn() && Boolean(id),
    staleTime: 0,
  });
}

export function useMemberHistory(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.memberHistory(id ?? ''),
    queryFn: () => api.members.history(id as string),
    enabled: useSignedIn() && Boolean(id),
  });
}

export function useReference(kind: ReferenceKind, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.reference(kind),
    queryFn: () => api.reference.list(kind),
    enabled: useSignedIn() && enabled,
  });
}

export function useSupervisors(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.supervisors,
    queryFn: () => api.users.supervisors(),
    enabled: useSignedIn() && enabled,
  });
}

export function useCardSizes(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.cardSizes,
    queryFn: () => api.cards.sizes(),
    enabled: useSignedIn() && enabled,
  });
}

export function useCardTemplates(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.cardTemplates,
    queryFn: () => api.cards.templates(),
    enabled: useSignedIn() && enabled,
  });
}

export function useLogos(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.logos,
    queryFn: () => api.logos.list(),
    enabled: useSignedIn() && enabled,
  });
}

export function useBatches(q: PageQuery = {}) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.batches(q),
    queryFn: () => api.cards.batches(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn(),
  });
}

export function useBatch(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk2.batch(id ?? ''),
    queryFn: () => api.cards.batch(id as string),
    enabled: useSignedIn() && Boolean(id),
  });
}

/** After any team/member change: lists, details, colours, history, audit and notifications. */
export function useInvalidateTeams() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['teams', 'team', 'members', 'member', 'colors', 'audit', 'notifications', 'supervisors'].map(
        (key) => qc.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

// ---------------------------------------------------------------- Phase 3

export const qk3 = {
  types: (all: boolean) => ['violation-types', all ? 'all' : 'active'] as const,
  list: (q: ViolationListQuery) => ['violations', 'list', q] as const,
  mine: (q: ViolationListQuery) => ['violations', 'mine', q] as const,
  one: (id: string) => ['violation', id] as const,
  stats: (f: ViolationFilter) => ['violations', 'stats', f] as const,
  history: (id: string) => ['violation', id, 'history'] as const,
};

export function useViolationTypes(all = false, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.types(all),
    queryFn: () => api.violationTypes.list(all ? {} : { active: true }),
    enabled: useSignedIn() && enabled,
  });
}

export function useViolations(q: ViolationListQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.list(q),
    queryFn: () => api.violations.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useMyViolations(q: ViolationListQuery, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.mine(q),
    queryFn: () => api.violations.mine(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
    retry: false,
  });
}

export function useViolation(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.one(id ?? ''),
    queryFn: () => api.violations.get(id as string),
    enabled: useSignedIn() && Boolean(id),
    staleTime: 0,
  });
}

export function useViolationStats(f: ViolationFilter, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.stats(f),
    queryFn: () => api.violations.stats(f),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useViolationHistory(id: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk3.history(id ?? ''),
    queryFn: () => api.audit.list({ entityType: 'violation', entityId: id as string, pageSize: 100 }),
    enabled: useSignedIn() && Boolean(id) && enabled,
  });
}

/**
 * Supervisor visibility as the API resolves it (ADR-047): any own, non-archived team whose
 * override is SHOW, or INHERIT with `SUPERVISORS_CAN_SEE_VIOLATIONS` on. Only hides the nav
 * item and explains the empty page — the API enforces it.
 */
export function useTeamViolationsVisible(enabled = true) {
  const user = useAuthStore((s) => s.user);
  const settings = useSettings();
  const teams = useTeams({}, enabled && Boolean(user));
  if (!enabled || !settings.data || !teams.data) return { visible: false, loading: settings.isLoading || teams.isLoading };
  const visible = teams.data.some(
    (tm) =>
      tm.status !== 'ARCHIVED' &&
      tm.supervisor?.id === user?.id &&
      (tm.violationVisibility === 'SHOW' ||
        (tm.violationVisibility !== 'HIDE' && settings.data.SUPERVISORS_CAN_SEE_VIOLATIONS)),
  );
  return { visible, loading: false };
}

/** After any violation change: lists, details, stats, audit and notifications. */
export function useInvalidateViolations() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['violations', 'violation', 'violation-types', 'audit', 'notifications'].map((key) =>
        qc.invalidateQueries({ queryKey: [key] }),
      ),
    );
}
