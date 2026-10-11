import type {
  AuthSession,
  Paginated,
  Settings,
  UserDto,
  AuditEntryDto,
  NotificationDto,
} from '@nuzli/shared';
import { ApiError } from './errors';
import { t } from '../i18n';
import { toQueryString, type ApiClient, type SessionListener } from './client';

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
}
