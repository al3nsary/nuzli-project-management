import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { can, type MemberRequestDto, type MyParticipationDto, type ParticipantLevel } from '@nuzli/shared';
import { useApi } from './context';
import { useAuthStore } from '../stores/auth';
import type { PageQuery } from './client';
import { ApiError } from './errors';

/**
 * A12 query hooks (docs/API.md «A12 — workspaces & session» and «A12 — round 2»). Keys live in
 * `a12k` so mutations invalidate the right lists. Every key is per workspace by construction:
 * switching workspaces clears the whole query cache (useWorkspaceSwitch).
 */
export const a12k = {
  systemInfo: ['a12', 'system-info'] as const,
  publicWorkspaces: ['a12', 'public-workspaces'] as const,
  participations: ['a12', 'me', 'participations'] as const,
  owners: ['a12', 'owners'] as const,
  workspaces: (status?: string) => ['a12', 'workspaces', status ?? 'ALL'] as const,
  workspaceSummary: (id: string) => ['a12', 'workspace-summary', id] as const,
  workspaceAdmins: (id: string) => ['a12', 'workspace-admins', id] as const,
  workspaceMembers: (id: string) => ['a12', 'workspace-members', id] as const,
  allUsers: (q?: object) => ['a12', 'all-users', q ?? {}] as const,
  memberRequests: (q?: object) => ['a12', 'member-requests', q ?? {}] as const,
  participants: (projectId: string) => ['a12', 'participants', projectId] as const,
  cover: (projectId: string) => ['a12', 'cover', projectId] as const,
};

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

/** `GET /system/info` — single-workspace mode and (owners) the workspace list. */
export function useSystemInfo() {
  const api = useApi();
  return useQuery({ queryKey: a12k.systemInfo, queryFn: () => api.system.info(), enabled: useSignedIn(), staleTime: 60_000 });
}

/** `GET /public/workspaces` — the registration step (only shown when there is more than one). */
export function usePublicWorkspaces() {
  const api = useApi();
  return useQuery({ queryKey: a12k.publicWorkspaces, queryFn: () => api.system.publicWorkspaces(), staleTime: 60_000 });
}

/**
 * `GET /me/participations` — the projects where the user is a participant (محرّر/مساهم/مطّلع).
 * The web shows a project's actions from the level here (the API binds it per request).
 */
export function useMyParticipations() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: a12k.participations,
    queryFn: () => api.me.participations(),
    enabled: useSignedIn() && Boolean(user),
    staleTime: 60_000,
  });
}

/** The caller's level on one project (undefined when not a participant). */
export function useParticipationLevel(projectId: string | undefined): ParticipantLevel | undefined {
  const { data } = useMyParticipations();
  return projectId ? data?.find((p: MyParticipationDto) => p.projectId === projectId)?.level : undefined;
}

export function useOwners(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: a12k.owners, queryFn: () => api.owners.list(), enabled: useSignedIn() && enabled });
}

export function useWorkspacesAdmin(status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ALL', enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: a12k.workspaces(status), queryFn: () => api.workspaces.list({ status }), enabled: useSignedIn() && enabled });
}

export function useWorkspaceSummary(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: a12k.workspaceSummary(id ?? ''), queryFn: () => api.workspaces.summary(id!), enabled: useSignedIn() && Boolean(id) });
}

export function useWorkspaceAdmins(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: a12k.workspaceAdmins(id ?? ''), queryFn: () => api.workspaces.admins(id!), enabled: useSignedIn() && Boolean(id) });
}

/** Memberships of a workspace (owners: any; admins and assistants with users:view: their own). */
export function useWorkspaceMembers(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: a12k.workspaceMembers(id ?? ''), queryFn: () => api.workspaces.members(id!), enabled: useSignedIn() && Boolean(id) });
}

export function useAllUsers(q: PageQuery & { status?: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED'; accountRole?: 'OWNER' | 'USER' }, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: a12k.allUsers(q),
    queryFn: () => api.users.all(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

export function useMemberRequests(
  q: PageQuery & { status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'; teamId?: string },
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: a12k.memberRequests(q),
    queryFn: () => api.memberRequests.list(q),
    placeholderData: keepPreviousData,
    enabled: useSignedIn() && enabled,
  });
}

/** Pending worker requests for the nav badge (approvers only). */
export function usePendingMemberRequestCount(): number {
  const user = useAuthStore((s) => s.user);
  const approver = can(user, 'registrations.review') || can(user, 'registrations.read');
  const { data } = useMemberRequests({ status: 'PENDING', pageSize: 1 }, approver);
  return approver ? (data?.total ?? 0) : 0;
}

export function useParticipants(projectId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: a12k.participants(projectId ?? ''),
    queryFn: () => api.participants.list(projectId!),
    enabled: useSignedIn() && Boolean(projectId),
  });
}

/** The cover image URL of a project (null when it has none — the generated cover is drawn instead). */
export function useProjectCoverUrl(projectId: string | undefined, hasCover: boolean | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: a12k.cover(projectId ?? ''),
    queryFn: async () => {
      try {
        return (await api.projects.coverUrl(projectId!)).url;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: useSignedIn() && Boolean(projectId) && Boolean(hasCover),
    staleTime: 4 * 60_000,
  });
}

/** Labels for a worker request row (ADD / REMOVE). */
export type MemberRequestRow = MemberRequestDto;
