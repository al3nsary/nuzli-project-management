import type { ImportCommitResultDto, ImportPreviewDto } from '@nuzli/shared';
import type {
  AuthSession,
  Paginated,
  Settings,
  UserDto,
  AuditEntryDto,
  NotificationDto,
  CardPreviewDto,
  CardSizeDto,
  CardTemplateDto,
  ImportMembersResultDto,
  LogoDto,
  MemberDto,
  MembershipHistoryDto,
  PresignedUpload,
  PresignUploadInput,
  PhotoUrlDto,
  PrintBatchCreatedDto,
  PrintBatchDetailDto,
  PrintBatchDto,
  ReferenceItemDto,
  SupervisorHistoryDto,
  TeamColorDto,
  TeamColorPaletteDto,
  TeamDetailDto,
  TeamDto,
  RosterResponse,
  ViolationDto,
  ViolationStats,
  ViolationTypeDto,
} from '@nuzli/shared';
import type {
  ActivityDto,
  CreatedDependencyDto,
  CreatedTaskDto,
  MyTaskDto,
  ProjectAccessDto,
  TaskArchiveResult,
  TaskAttachmentDto,
  TaskBatchResult,
  TaskCommentDto,
  TaskDto,
  TaskUpdateResult,
} from '@nuzli/shared';
import type {
  AttachmentBrowseDto,
  BudgetReportDto,
  ChecklistItemDto,
  CommentReadDto,
  CustomFieldDto,
  CustomValueDto,
  DuplicateTaskResult,
  HubPageDto,
  LabelDto,
  PortfolioDto,
  PortfolioSummaryDto,
  ProjectCalendarDto,
  ProjectDashboardDto,
  ProjectPersonDto,
  ProjectReportRow,
  TaskBulkArchiveResult,
  TaskBulkResult,
  TaskPreviousMap,
  TaskRestoreResult,
  TimeEntryDto,
  ViewPrefDto,
  WorkloadDto,
  TeamSupervisorsDto,
  OrgTreeDto,
  OrgUnitDto,
  OrgPositionDto,
  ViolationOcrDto,
  RegisterViolationMemberResultDto,
} from '@nuzli/shared';
import type { GanttView, ProjectView } from './hoursWire';
import { ERRORS } from '@nuzli/shared';
import { ApiError } from './errors';
import { t } from '../i18n';
import {
  toQueryString,
  type ApiClient,
  type CalendarListView,
  type PhotoTarget,
  type ReferenceRemoveResult,
  type SessionListener,
} from './client';
import { toViolationQueryString } from './violationQuery';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RequestOptions {
  body?: unknown;
  /** Send the `X-CSRF-Token` header from the `nz_csrf` cookie (refresh, logout). */
  csrf?: boolean;
  /** Retry once after a refresh on 401. Off for the auth endpoints themselves. */
  retryOn401?: boolean;
}

/** Paths whose 401 means "wrong credentials", not "expired access token". */
const NO_REFRESH = [
  '/auth/login',
  '/auth/refresh',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/reset-password',
];

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/**
 * The real backend adapter (ADR-010): Bearer access token kept in memory only, refresh token
 * in an httpOnly cookie, single-flight refresh on 401 with the double-submit CSRF header.
 */
export class HttpApi implements ApiClient {
  readonly mode = 'http' as const;
  private accessToken: string | null = null;
  private refreshing: Promise<AuthSession | null> | null = null;
  private listeners = new Set<SessionListener>();

  constructor(
    private readonly baseUrl: string = import.meta.env.VITE_API_BASE || '/api/v1',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  onSessionChange(listener: SessionListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(session: AuthSession | null) {
    for (const l of this.listeners) l(session);
  }

  private async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, opts)).body;
  }

  /** Like `request`, plus the HTTP status (violation create answers 201 or 200). */
  private async requestWithStatus<T>(
    method: Method,
    path: string,
    opts: RequestOptions = {},
  ): Promise<{ body: T; status: number }> {
    const retry = opts.retryOn401 ?? !NO_REFRESH.some((p) => path.startsWith(p));
    let res = await this.send(method, path, opts);
    if (res.status === 401 && retry) {
      const session = await this.refreshOnce();
      if (!session) throw ApiError.of('UNAUTHENTICATED', 401);
      res = await this.send(method, path, opts);
    }
    return { body: await this.parse<T>(res), status: res.status };
  }

  private async send(method: Method, path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (opts.csrf) {
      const csrf = readCookie('nz_csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        credentials: 'include',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', t('error.network'));
    }
  }

  /** A binary response (PDF). Errors still arrive as the JSON error body. */
  private async requestBlob(path: string): Promise<Blob> {
    let res = await this.send('GET', path, {});
    if (res.status === 401) {
      const session = await this.refreshOnce();
      if (!session) throw ApiError.of('UNAUTHENTICATED', 401);
      res = await this.send('GET', path, {});
    }
    if (!res.ok) return this.parse<Blob>(res);
    return res.blob();
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) throw ApiError.fromBody(res.status, body as never);
    return body as T;
  }

  /** Concurrent 401s share one refresh call. */
  private refreshOnce(): Promise<AuthSession | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<AuthSession | null> {
    try {
      const res = await this.send('POST', '/auth/refresh', { csrf: true });
      if (!res.ok) {
        this.accessToken = null;
        this.emit(null);
        return null;
      }
      const session = (await this.parse<AuthSession>(res)) ?? null;
      this.accessToken = session?.accessToken ?? null;
      this.emit(session);
      return session;
    } catch (err) {
      // Offline is not "signed out": the caller keeps its offline session (docs/offline.md).
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') throw err;
      return null;
    }
  }

  auth: ApiClient['auth'] = {
    register: (input) => this.request('POST', '/auth/register', { body: input }),
    login: async (input) => {
      const s = await this.request<AuthSession>('POST', '/auth/login', { body: input });
      this.accessToken = s.accessToken;
      return s;
    },
    refresh: async () => {
      const res = await this.refreshOnce();
      return res;
    },
    logout: async () => {
      try {
        await this.request<void>('POST', '/auth/logout', { csrf: true, retryOn401: false });
      } finally {
        this.accessToken = null;
      }
    },
    forgotPassword: (input) => this.request('POST', '/auth/forgot-password', { body: input }),
    resetPassword: (input) => this.request('POST', '/auth/reset-password', { body: input }),
    changePassword: async (input) => {
      const s = await this.request<AuthSession>('POST', '/auth/change-password', { body: input });
      this.accessToken = s.accessToken;
      return s;
    },
    me: () => this.request<UserDto>('GET', '/auth/me'),
  };

  me: ApiClient['me'] = {
    update: (input) => this.request<UserDto>('PATCH', '/me', { body: input }),
  };

  users: ApiClient['users'] = {
    list: (q) => this.request<Paginated<UserDto>>('GET', `/users${toQueryString(q)}`),
    get: (id) => this.request<UserDto>('GET', `/users/${encodeURIComponent(id)}`),
    create: (input) => this.request<UserDto>('POST', '/users', { body: input }),
    changeRole: (id, input) =>
      this.request<UserDto>('PATCH', `/users/${encodeURIComponent(id)}/role`, { body: input }),
    suspend: (id, input) =>
      this.request<UserDto>('POST', `/users/${encodeURIComponent(id)}/suspend`, { body: input }),
    reactivate: (id) =>
      this.request<UserDto>('POST', `/users/${encodeURIComponent(id)}/reactivate`),
    supervisors: (q) => this.request<UserDto[]>('GET', `/users/supervisors${toQueryString({ q })}`),
    search: (input) => this.request<Paginated<UserDto>>('POST', '/users/search', { body: input }),
  };

  registrations: ApiClient['registrations'] = {
    list: (q) => this.request<Paginated<UserDto>>('GET', `/registrations${toQueryString(q)}`),
    approve: (id, input) =>
      this.request<UserDto>('POST', `/registrations/${encodeURIComponent(id)}/approve`, {
        body: input,
      }),
    reject: (id, input) =>
      this.request<UserDto>('POST', `/registrations/${encodeURIComponent(id)}/reject`, {
        body: input,
      }),
  };

  audit: ApiClient['audit'] = {
    list: (q) => this.request<Paginated<AuditEntryDto>>('GET', `/audit${toQueryString(q)}`),
  };

  notifications: ApiClient['notifications'] = {
    list: (q) =>
      this.request<Paginated<NotificationDto>>('GET', `/notifications${toQueryString(q)}`),
    unreadCount: () => this.request<{ count: number }>('GET', '/notifications/unread-count'),
    markRead: (id) => this.request<void>('POST', `/notifications/${encodeURIComponent(id)}/read`),
    markAllRead: () => this.request<void>('POST', '/notifications/read-all'),
  };

  settings: ApiClient['settings'] = {
    get: () => this.request<Settings>('GET', '/settings'),
    update: (input) => this.request<Settings>('PATCH', '/settings', { body: input }),
  };

  // ---------------------------------------------------------------- Phase 2

  colors: ApiClient['colors'] = {
    available: (excludeTeamId) =>
      this.request<TeamColorDto[]>('GET', `/colors/available${toQueryString({ excludeTeamId })}`),
    list: () => this.request<TeamColorPaletteDto[]>('GET', '/colors'),
    create: (input) => this.request<TeamColorDto>('POST', '/colors', { body: input }),
    update: (id, input) =>
      this.request<TeamColorDto>('PATCH', `/colors/${enc(id)}`, { body: input }),
  };

  teams: ApiClient['teams'] = {
    list: (q) => this.request<TeamDto[]>('GET', `/teams${toQueryString(q)}`),
    get: (id) => this.request<TeamDetailDto>('GET', `/teams/${enc(id)}`),
    create: (input) => this.request<TeamDto>('POST', '/teams', { body: input }),
    update: (id, input) => this.request<TeamDto>('PATCH', `/teams/${enc(id)}`, { body: input }),
    approve: (id) => this.request<TeamDto>('POST', `/teams/${enc(id)}/approve`),
    reject: (id, input) =>
      this.request<TeamDto>('POST', `/teams/${enc(id)}/reject`, { body: input }),
    archive: (id, input) =>
      this.request<TeamDto>('POST', `/teams/${enc(id)}/archive`, { body: input }),
    changeSupervisor: (id, input) =>
      this.request<TeamDto>('POST', `/teams/${enc(id)}/supervisor`, { body: input }),
    supervisorHistory: (id) =>
      this.request<SupervisorHistoryDto[]>('GET', `/teams/${enc(id)}/supervisor-history`),
    setViolationVisibility: (id, mode) =>
      this.request<TeamDto>('PUT', `/teams/${enc(id)}/violation-visibility`, { body: { mode } }),
    addMember: (teamId, input) =>
      this.request<MemberDto>('POST', `/teams/${enc(teamId)}/members`, { body: input }),
    importMembers: (input) =>
      this.request<ImportMembersResultDto>('POST', '/members/import', { body: input }),
    supervisorsOf: (id) => this.request<TeamSupervisorsDto>('GET', `/teams/${enc(id)}/supervisors`),
    addSupervisor: (id, input) =>
      this.request<TeamDto>('POST', `/teams/${enc(id)}/supervisors`, { body: input }),
    removeSupervisor: (id, userId, input) =>
      this.request<TeamDto>('DELETE', `/teams/${enc(id)}/supervisors/${enc(userId)}`, { body: input }),
    setPrimarySupervisor: (id, userId, input) =>
      this.request<TeamDto>('POST', `/teams/${enc(id)}/supervisors/${enc(userId)}/primary`, { body: input ?? {} }),
    setForeman: (id, memberId) =>
      this.request<TeamDetailDto>('POST', `/teams/${enc(id)}/foreman`, { body: { memberId } }),
    clearForeman: (id) => this.request<TeamDetailDto>('DELETE', `/teams/${enc(id)}/foreman`),
  };

  org: ApiClient['org'] = {
    tree: (q) =>
      this.request<OrgTreeDto>('GET', `/org${toQueryString({ includeArchived: q?.includeArchived ? 'true' : undefined })}`),
    createUnit: (input) => this.request<OrgUnitDto>('POST', '/org/units', { body: input }),
    updateUnit: (id, input) => this.request<OrgUnitDto>('PATCH', `/org/units/${enc(id)}`, { body: input }),
    moveUnit: (id, input) => this.request<OrgUnitDto>('POST', `/org/units/${enc(id)}/move`, { body: input }),
    deleteUnit: (id) => this.request<void>('DELETE', `/org/units/${enc(id)}`),
    createPosition: (input) => this.request<OrgPositionDto>('POST', '/org/positions', { body: input }),
    updatePosition: (id, input) =>
      this.request<OrgPositionDto>('PATCH', `/org/positions/${enc(id)}`, { body: input }),
    movePosition: (id, input) =>
      this.request<OrgPositionDto>('POST', `/org/positions/${enc(id)}/move`, { body: input }),
    deletePosition: (id) => this.request<void>('DELETE', `/org/positions/${enc(id)}`),
  };

  members: ApiClient['members'] = {
    list: (q) => this.request<Paginated<MemberDto>>('GET', `/members${toQueryString(q)}`),
    get: (id) => this.request<MemberDto>('GET', `/members/${enc(id)}`),
    update: (id, input) =>
      this.request<MemberDto>('PATCH', `/members/${enc(id)}`, { body: input }),
    history: (id) => this.request<MembershipHistoryDto[]>('GET', `/members/${enc(id)}/history`),
    move: (input) => this.request<MemberDto[]>('POST', '/members/move', { body: input }),
    search: (input) => this.request<Paginated<MemberDto>>('POST', '/members/search', { body: input }),
  };

  reference: ApiClient['reference'] = {
    list: (kind) => this.request<ReferenceItemDto[]>('GET', `/reference/${kind}`),
    create: (kind, input) =>
      this.request<ReferenceItemDto>('POST', `/reference/${kind}`, { body: input }),
    update: (kind, id, input) =>
      this.request<ReferenceItemDto>('PATCH', `/reference/${kind}/${enc(id)}`, { body: input }),
    remove: (kind, id) =>
      this.request<ReferenceRemoveResult>('DELETE', `/reference/${kind}/${enc(id)}`),
  };

  cards: ApiClient['cards'] = {
    sizes: () => this.request<CardSizeDto[]>('GET', '/cards/sizes'),
    createSize: (input) => this.request<CardSizeDto>('POST', '/cards/sizes', { body: input }),
    deleteSize: (id) => this.request<void>('DELETE', `/cards/sizes/${enc(id)}`),
    templates: () => this.request<CardTemplateDto[]>('GET', '/cards/templates'),
    createTemplate: (input) =>
      this.request<CardTemplateDto>('POST', '/cards/templates', { body: input }),
    updateTemplate: (id, input) =>
      this.request<CardTemplateDto>('PATCH', `/cards/templates/${enc(id)}`, { body: input }),
    archiveTemplate: (id) => this.request<void>('DELETE', `/cards/templates/${enc(id)}`),
    preview: (input) => this.request<CardPreviewDto>('POST', '/cards/preview', { body: input }),
    createBatch: (input) =>
      this.request<PrintBatchCreatedDto>('POST', '/cards/batches', { body: input }),
    batches: (q) =>
      this.request<Paginated<PrintBatchDto>>('GET', `/cards/batches${toQueryString(q)}`),
    batch: (id) => this.request<PrintBatchDetailDto>('GET', `/cards/batches/${enc(id)}`),
    pdf: (id) => this.requestBlob(`/cards/batches/${enc(id)}/pdf`),
  };

  // ---------------------------------------------------------------- Phase 3

  files: ApiClient['files'] = {
    presign: (input) => this.request<PresignedUpload>('POST', '/files/presign', { body: input }),
    /** Straight to object storage with exactly the presigned headers (no auth header, no cookies). */
    upload: async (presigned, blob, opts) => {
      // Progress needs XMLHttpRequest (fetch has no upload progress); same request otherwise.
      if (opts?.onProgress && typeof XMLHttpRequest !== 'undefined') {
        await putWithProgress(presigned, blob, opts.onProgress);
        return;
      }
      let put: Response;
      try {
        put = await this.fetchImpl(presigned.url, {
          method: presigned.method,
          headers: presigned.headers,
          body: blob,
        });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', t('error.network'));
      }
      if (!put.ok) {
        // 403 from the bucket usually means the URL expired: the engine presigns again.
        throw new ApiError(put.status, 'FILE_NOT_UPLOADED', ERRORS.FILE_NOT_UPLOADED);
      }
    },
    confirm: (fileId) =>
      this.request<{ id: string; status: 'READY' }>('POST', `/files/${enc(fileId)}/confirm`),
  };

  // ---------------------------------------------------------------- personal photos (A8)

  photos: ApiClient['photos'] = {
    url: (target) => this.request<PhotoUrlDto>('GET', `${photoBase(target)}/photo-url`),
    upload: async (target, blob, opts) => {
      const presigned = await this.files.presign({
        entityType: target.kind === 'member' ? 'member_photo' : 'user_photo',
        entityId: target.id,
        kind: 'PHOTO',
        contentType: blob.type as PresignUploadInput['contentType'],
        sizeBytes: blob.size,
        ...(await sha256Hex(blob)),
      });
      await this.files.upload(presigned, blob, opts);
      opts?.onProgress?.(1);
      await this.files.confirm(presigned.fileId);
      return { fileId: presigned.fileId };
    },
    remove: (target) => this.request<void>('DELETE', `${photoBase(target)}/photo`),
  };

  violationTypes: ApiClient['violationTypes'] = {
    list: (q) =>
      this.request<ViolationTypeDto[]>(
        'GET',
        `/violation-types${toQueryString(q?.active ? { active: 'true' } : {})}`,
      ),
    create: (input) => this.request<ViolationTypeDto>('POST', '/violation-types', { body: input }),
    update: (id, input) =>
      this.request<ViolationTypeDto>('PATCH', `/violation-types/${enc(id)}`, { body: input }),
  };

  violations: ApiClient['violations'] = {
    roster: () => this.request<RosterResponse>('GET', '/violations/roster'),
    create: async (input) => {
      const { body, status } = await this.requestWithStatus<ViolationDto>('POST', '/violations', {
        body: input,
      });
      return { violation: body, created: status === 201 };
    },
    list: (q) =>
      this.request<Paginated<ViolationDto>>('GET', `/violations${toViolationQueryString(q)}`),
    mine: (q) =>
      this.request<Paginated<ViolationDto>>('GET', `/violations/mine${toViolationQueryString(q)}`),
    get: (id) => this.request<ViolationDto>('GET', `/violations/${enc(id)}`),
    fileUrl: (id, fileId) =>
      this.request<{ url: string; expiresAt: string }>(
        'GET',
        `/violations/${enc(id)}/files/${enc(fileId)}/url`,
      ),
    update: (id, input) =>
      this.request<ViolationDto>('PATCH', `/violations/${enc(id)}`, { body: input }),
    setStatus: (id, input) =>
      this.request<ViolationDto>('POST', `/violations/${enc(id)}/status`, { body: input }),
    respond: (id, input) =>
      this.request<ViolationDto>('POST', `/violations/${enc(id)}/responses`, { body: input }),
    stats: (f) => this.request<ViolationStats>('GET', `/violations/stats${toViolationQueryString(f)}`),
    exportXlsx: (f) => this.requestBlob(`/violations/export.xlsx${toViolationQueryString(f)}`),
    dashboardPdf: (f) => this.requestBlob(`/violations/dashboard.pdf${toViolationQueryString(f)}`),
    ocr: (id) => this.request<ViolationOcrDto>('GET', `/violations/${enc(id)}/ocr`),
    retryOcr: (id) => this.request<{ queued: true }>('POST', `/violations/${enc(id)}/ocr/retry`),
    assign: (id, input) => this.request<ViolationDto>('POST', `/violations/${enc(id)}/assign`, { body: input }),
    unassign: (id, input) => this.request<ViolationDto>('POST', `/violations/${enc(id)}/unassign`, { body: input ?? {} }),
    registerMember: (id, input) =>
      this.request<RegisterViolationMemberResultDto>('POST', `/violations/${enc(id)}/register-member`, { body: input }),
  };

  logos: ApiClient['logos'] = {
    list: async () => {
      const logos = await this.request<LogoDto[]>('GET', '/logos');
      return Promise.all(
        logos.map(async (logo) => {
          if (logo.url) return logo;
          try {
            const { url } = await this.request<{ url: string }>(
              'GET',
              `/files/${enc(logo.fileId)}/url`,
            );
            return { ...logo, url };
          } catch {
            return logo;
          }
        }),
      );
    },
    upload: async ({ name, file, isDefault }) => {
      const presigned = await this.request<PresignedUpload>('POST', '/files/presign', {
        body: { entityType: 'logo', kind: 'LOGO', contentType: file.type, sizeBytes: file.size },
      });
      let put: Response;
      try {
        put = await this.fetchImpl(presigned.url, {
          method: presigned.method,
          headers: presigned.headers,
          body: file,
        });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', t('error.network'));
      }
      if (!put.ok) throw ApiError.of('FILE_NOT_UPLOADED', 400);
      await this.request('POST', `/files/${enc(presigned.fileId)}/confirm`);
      return this.request<LogoDto>('POST', '/logos', {
        body: { name, fileId: presigned.fileId, isDefault: Boolean(isDefault) },
      });
    },
    setDefault: (id) => this.request<LogoDto>('POST', `/logos/${enc(id)}/default`),
    remove: (id) => this.request<void>('DELETE', `/logos/${enc(id)}`),
  };

  // ---------------------------------------------------------------- Phase 4 + A9

  projects: ApiClient['projects'] = {
    list: (q) => this.request<ProjectView[]>('GET', `/projects${toQueryString(q)}`),
    get: (id) => this.request<ProjectView>('GET', `/projects/${enc(id)}`),
    create: (input) => this.request<ProjectView>('POST', '/projects', { body: input }),
    update: (id, input) => this.request<ProjectView>('PATCH', `/projects/${enc(id)}`, { body: input }),
    archive: (id) => this.request<ProjectView>('DELETE', `/projects/${enc(id)}`),
    access: (id) => this.request<ProjectAccessDto[]>('GET', `/projects/${enc(id)}/access`),
    grantAccess: (id, input) =>
      this.request<ProjectAccessDto>('POST', `/projects/${enc(id)}/access`, { body: input }),
    revokeAccess: (id, userId) =>
      this.request<void>('DELETE', `/projects/${enc(id)}/access/${enc(userId)}`),
    gantt: (id) => this.request<GanttView>('GET', `/projects/${enc(id)}/gantt`),
    exportXlsx: (id) => this.requestBlob(`/projects/${enc(id)}/export.xlsx`),
    export: (id, format) => this.requestBlob(`/projects/${enc(id)}/export?format=${enc(format)}`),
    convert: (id, durationUnit) => this.request<ProjectView>('POST', `/projects/${enc(id)}/convert`, { body: { durationUnit } }),
    budget: (id) => this.request<BudgetReportDto>('GET', `/projects/${enc(id)}/budget`),
    people: (id) => this.request<ProjectPersonDto[]>('GET', `/projects/${enc(id)}/people`),
    dashboard: (id) => this.request<ProjectDashboardDto>('GET', `/projects/${enc(id)}/dashboard`),
    calendar: (id, range) =>
      this.request<ProjectCalendarDto>('GET', `/projects/${enc(id)}/calendar${toQueryString(range)}`),
    saveAsTemplate: (id, input) =>
      this.request<ProjectView>('POST', `/projects/${enc(id)}/save-as-template`, { body: input }),
    templates: () => this.request<ProjectView[]>('GET', '/project-templates'),
    report: (q) => this.request<ProjectReportRow[]>('GET', `/reports/projects${toQueryString(q)}`),
  };

  tasks: ApiClient['tasks'] = {
    create: (projectId, input) =>
      this.request<CreatedTaskDto>('POST', `/projects/${enc(projectId)}/tasks`, { body: input }),
    get: (id) => this.request<TaskDto>('GET', `/tasks/${enc(id)}`),
    update: (id, input) => this.request<TaskUpdateResult>('PATCH', `/tasks/${enc(id)}`, { body: input }),
    batch: (projectId, input) =>
      this.request<TaskBatchResult>('POST', `/projects/${enc(projectId)}/tasks/batch`, { body: input }),
    archive: (id) => this.request<TaskArchiveResult>('DELETE', `/tasks/${enc(id)}`),
    mine: () => this.request<MyTaskDto[]>('GET', '/tasks/mine'),
    comments: (id) => this.request<TaskCommentDto[]>('GET', `/tasks/${enc(id)}/comments`),
    addComment: (id, input) =>
      this.request<TaskCommentDto>('POST', `/tasks/${enc(id)}/comments`, { body: input }),
    markRead: (id) => this.request<CommentReadDto>('POST', `/tasks/${enc(id)}/comments/read`),
    activity: (id) => this.request<ActivityDto[]>('GET', `/tasks/${enc(id)}/activity`),
    attachments: (id) => this.request<TaskAttachmentDto[]>('GET', `/tasks/${enc(id)}/attachments`),
    attach: (id, fileId) =>
      this.request<TaskAttachmentDto>('POST', `/tasks/${enc(id)}/attachments`, { body: { fileId } }),
    attachmentUrl: (id, fileId) =>
      this.request<{ url: string; expiresAt: string }>(
        'GET',
        `/tasks/${enc(id)}/attachments/${enc(fileId)}/url`,
      ),
    removeAttachment: (id, fileId) =>
      this.request<void>('DELETE', `/tasks/${enc(id)}/attachments/${enc(fileId)}`),
    duplicate: (id, input) =>
      this.request<DuplicateTaskResult>('POST', `/tasks/${enc(id)}/duplicate`, { body: input ?? {} }),
    bulk: (projectId, input) =>
      this.request<TaskBulkResult>('POST', `/projects/${enc(projectId)}/tasks/bulk`, { body: input }),
    bulkArchive: (projectId, input) =>
      this.request<TaskBulkArchiveResult>('POST', `/projects/${enc(projectId)}/tasks/bulk-archive`, {
        body: input,
      }),
    restore: (projectId, ids) =>
      this.request<TaskRestoreResult>('POST', `/projects/${enc(projectId)}/tasks/restore`, { body: { ids } }),
    labels: (id) => this.request<LabelDto[]>('GET', `/tasks/${enc(id)}/labels`),
    addLabel: (id, labelId) =>
      this.request<TaskUpdateResult>('POST', `/tasks/${enc(id)}/labels`, { body: { labelId } }),
    removeLabel: (id, labelId) =>
      this.request<TaskUpdateResult>('DELETE', `/tasks/${enc(id)}/labels/${enc(labelId)}`),
    customFields: (id) =>
      this.request<Array<CustomFieldDto & { value: unknown }>>('GET', `/tasks/${enc(id)}/custom-fields`),
    setCustomValue: (id, fieldId, value) =>
      this.request<CustomValueDto>('PUT', `/tasks/${enc(id)}/custom-values/${enc(fieldId)}`, { body: { value } }),
    checklist: (id) => this.request<ChecklistItemDto[]>('GET', `/tasks/${enc(id)}/checklist`),
    addChecklistItem: (id, input) =>
      this.request<ChecklistItemDto>('POST', `/tasks/${enc(id)}/checklist`, { body: input }),
    updateChecklistItem: (id, itemId, input) =>
      this.request<ChecklistItemDto>('PATCH', `/tasks/${enc(id)}/checklist/${enc(itemId)}`, { body: input }),
    removeChecklistItem: (id, itemId) =>
      this.request<void>('DELETE', `/tasks/${enc(id)}/checklist/${enc(itemId)}`),
    reorderChecklist: (id, input) =>
      this.request<ChecklistItemDto[]>('POST', `/tasks/${enc(id)}/checklist/reorder`, { body: input }),
    timeEntries: (id) => this.request<TimeEntryDto[]>('GET', `/tasks/${enc(id)}/time-entries`),
    addTimeEntry: (id, input) =>
      this.request<TimeEntryDto>('POST', `/tasks/${enc(id)}/time-entries`, { body: input }),
  };

  dependencies: ApiClient['dependencies'] = {
    create: (projectId, input) =>
      this.request<CreatedDependencyDto>('POST', `/projects/${enc(projectId)}/dependencies`, {
        body: input,
      }),
    remove: (id) => this.request<void>('DELETE', `/dependencies/${enc(id)}`),
  };

  calendars: ApiClient['calendars'] = {
    list: () => this.request<CalendarListView[]>('GET', '/calendars'),
    get: (id) => this.request<CalendarListView>('GET', `/calendars/${enc(id)}`),
    create: (input) => this.request<CalendarListView>('POST', '/calendars', { body: input }),
    update: (id, input) =>
      this.request<CalendarListView>('PATCH', `/calendars/${enc(id)}`, { body: input }),
    addException: (id, input) =>
      this.request<CalendarListView>('POST', `/calendars/${enc(id)}/exceptions`, { body: input }),
    removeException: (id, exId) =>
      this.request<void>('DELETE', `/calendars/${enc(id)}/exceptions/${enc(exId)}`),
  };

  labels: ApiClient['labels'] = {
    list: (projectId) => this.request<LabelDto[]>('GET', `/projects/${enc(projectId)}/labels`),
    create: (projectId, input) =>
      this.request<LabelDto>('POST', `/projects/${enc(projectId)}/labels`, { body: input }),
    update: (id, input) => this.request<LabelDto>('PATCH', `/labels/${enc(id)}`, { body: input }),
    remove: (id) => this.request<{ affected: TaskDto[]; previous: TaskPreviousMap }>('DELETE', `/labels/${enc(id)}`),
  };

  customFields: ApiClient['customFields'] = {
    list: (projectId) => this.request<CustomFieldDto[]>('GET', `/projects/${enc(projectId)}/custom-fields`),
    create: (projectId, input) =>
      this.request<CustomFieldDto>('POST', `/projects/${enc(projectId)}/custom-fields`, { body: input }),
    update: (id, input) => this.request<CustomFieldDto>('PATCH', `/custom-fields/${enc(id)}`, { body: input }),
    remove: (id) => this.request<void>('DELETE', `/custom-fields/${enc(id)}`),
  };

  timeEntries: ApiClient['timeEntries'] = {
    mine: (range) => this.request<TimeEntryDto[]>('GET', `/me/time-entries${toQueryString(range)}`),
    update: (id, input) => this.request<TimeEntryDto>('PATCH', `/time-entries/${enc(id)}`, { body: input }),
    remove: (id) => this.request<void>('DELETE', `/time-entries/${enc(id)}`),
  };

  viewPrefs: ApiClient['viewPrefs'] = {
    list: (q) => this.request<ViewPrefDto[]>('GET', `/me/view-prefs${toQueryString(q)}`),
    put: (input) => this.request<ViewPrefDto>('PUT', '/me/view-prefs', { body: input }),
    remove: (q) => this.request<void>('DELETE', `/me/view-prefs${toQueryString(q)}`),
  };

  portfolios: ApiClient['portfolios'] = {
    list: () => this.request<PortfolioDto[]>('GET', '/portfolios'),
    get: (id) => this.request<PortfolioSummaryDto>('GET', `/portfolios/${enc(id)}`),
    create: (input) => this.request<PortfolioDto>('POST', '/portfolios', { body: input }),
    update: (id, input) => this.request<PortfolioDto>('PATCH', `/portfolios/${enc(id)}`, { body: input }),
    remove: (id) => this.request<void>('DELETE', `/portfolios/${enc(id)}`),
    addProject: (id, projectId) =>
      this.request<PortfolioDto>('POST', `/portfolios/${enc(id)}/projects`, { body: { projectId } }),
    removeProject: (id, projectId) =>
      this.request<PortfolioDto>('DELETE', `/portfolios/${enc(id)}/projects/${enc(projectId)}`),
  };

  workload: ApiClient['workload'] = (q) =>
    this.request<WorkloadDto>(
      'GET',
      `/workload${toQueryString({ from: q.from, to: q.to, userIds: q.userIds?.length ? q.userIds.join(',') : undefined })}`,
    );

  imports: ApiClient['imports'] = {
    upload: async (file, contentType, opts) => {
      const presigned = await this.files.presign({
        entityType: 'import',
        contentType,
        sizeBytes: file.size,
        ...(await sha256Hex(file)),
      });
      // Exactly the canonical type the presign signed (never the browser's guess).
      await this.files.upload(presigned, new Blob([file], { type: contentType }), opts);
      opts?.onProgress?.(1);
      await this.files.confirm(presigned.fileId);
      return { fileId: presigned.fileId };
    },
    preview: (input) => this.request<ImportPreviewDto>('POST', '/projects/import', { body: input }),
    jira: (input) => this.request<ImportPreviewDto>('POST', '/projects/import/jira', { body: input }),
    commit: (input) => this.request<ImportCommitResultDto>('POST', '/projects/import/commit', { body: input }),
  };

  hub: ApiClient['hub'] = {
    list: (q) => this.request<HubPageDto>('GET', `/hub${toQueryString(q)}`),
    attachments: (q) => this.request<Paginated<AttachmentBrowseDto>>('GET', `/attachments${toQueryString(q)}`),
  };
}

const enc = encodeURIComponent;

/** `/me`, `/users/:id` or `/members/:id` (owner request A8). */
function photoBase(target: PhotoTarget): string {
  if (target.kind === 'me') return '/me';
  return target.kind === 'member' ? `/members/${enc(target.id)}` : `/users/${enc(target.id)}`;
}

/** `{ sha256 }` for the presign body when WebCrypto exists (checked again on confirm). */
async function sha256Hex(blob: Blob): Promise<{ sha256?: string }> {
  try {
    if (!globalThis.crypto?.subtle) return {};
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return { sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') };
  } catch {
    return {};
  }
}

/** The presigned PUT through XMLHttpRequest for upload progress; no credentials, exact headers. */
function putWithProgress(presigned: PresignedUpload, blob: Blob, onProgress: (f: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(presigned.method, presigned.url);
    for (const [k, v] of Object.entries(presigned.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, 'FILE_NOT_UPLOADED', ERRORS.FILE_NOT_UPLOADED));
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', t('error.network')));
    xhr.send(blob);
  });
}
