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
  PrintBatchDetailDto,
  PrintBatchDto,
  ReferenceItemDto,
  SupervisorHistoryDto,
  TeamColorDto,
  TeamColorPaletteDto,
  TeamDetailDto,
  TeamDto,
} from '@nuzli/shared';
import { ApiError } from './errors';
import { t } from '../i18n';
import {
  toQueryString,
  type ApiClient,
  type ReferenceRemoveResult,
  type SessionListener,
} from './client';

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
    const retry = opts.retryOn401 ?? !NO_REFRESH.some((p) => path.startsWith(p));
    const res = await this.send(method, path, opts);
    if (res.status === 401 && retry) {
      const session = await this.refreshOnce();
      if (!session) throw ApiError.of('UNAUTHENTICATED', 401);
      const again = await this.send(method, path, opts);
      return this.parse<T>(again);
    }
    return this.parse<T>(res);
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
    } catch {
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
  };

  members: ApiClient['members'] = {
    list: (q) => this.request<Paginated<MemberDto>>('GET', `/members${toQueryString(q)}`),
    get: (id) => this.request<MemberDto>('GET', `/members/${enc(id)}`),
    update: (id, input) =>
      this.request<MemberDto>('PATCH', `/members/${enc(id)}`, { body: input }),
    history: (id) => this.request<MembershipHistoryDto[]>('GET', `/members/${enc(id)}/history`),
    move: (input) => this.request<MemberDto[]>('POST', '/members/move', { body: input }),
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
    createBatch: (input) => this.request<PrintBatchDto>('POST', '/cards/batches', { body: input }),
    batches: (q) =>
      this.request<Paginated<PrintBatchDto>>('GET', `/cards/batches${toQueryString(q)}`),
    batch: (id) => this.request<PrintBatchDetailDto>('GET', `/cards/batches/${enc(id)}`),
    pdf: (id) => this.requestBlob(`/cards/batches/${enc(id)}/pdf`),
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
}

const enc = encodeURIComponent;
