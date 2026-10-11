import type {
  AuditEntryDto,
  AuthSession,
  NotificationDto,
  Paginated,
  Role,
  Settings,
  UserDto,
  UserStatus,
} from '@nuzli/shared';
import type { z } from 'zod';
import type {
  approveRegistrationSchema,
  changePasswordSchema,
  changeRoleSchema,
  createUserSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  rejectRegistrationSchema,
  resetPasswordSchema,
  suspendUserSchema,
  updateProfileSchema,
  updateSettingsSchema,
} from '@nuzli/shared';

/**
 * The data contract between screens and the backend (docs/API.md, Phase 1).
 * Two implementations: `HttpApi` (the NestJS API) and `DemoApi` (in-browser, GitHub Pages).
 * Screens only see this interface, through `useApi()`.
 */

type In<S extends z.ZodTypeAny> = z.input<S>;

export interface PageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

export interface UserListQuery extends PageQuery {
  role?: Role;
  status?: UserStatus;
}

export interface AuditQuery extends PageQuery {
  action?: string;
  entityType?: string;
  actorId?: string;
  /** `YYYY-MM-DD`, inclusive, Asia/Riyadh day. */
  from?: string;
  to?: string;
}

export interface NotificationQuery extends PageQuery {
  unread?: boolean;
}

export interface DemoAccount {
  role: Role;
  identifier: string;
  fullName: string;
}

/** Only present on the demo adapter. */
export interface DemoControls {
  password: string;
  accounts: DemoAccount[];
  pendingExample: string;
  reset(): Promise<void>;
}

export type SessionListener = (session: AuthSession | null) => void;

export interface ApiClient {
  readonly mode: 'http' | 'demo';
  readonly demo?: DemoControls;

  /** The in-memory access token used for subsequent calls. */
  setAccessToken(token: string | null): void;
  /** Called when the adapter refreshes or loses the session on its own (e.g. 401 → refresh). */
  onSessionChange(listener: SessionListener): () => void;

  auth: {
    register(input: In<typeof registerSchema>): Promise<{ status: 'PENDING' }>;
    login(input: In<typeof loginSchema>): Promise<AuthSession>;
    /** Restores the session from the refresh cookie (or demo storage). Null when there is none. */
    refresh(): Promise<AuthSession | null>;
    logout(): Promise<void>;
    forgotPassword(input: In<typeof forgotPasswordSchema>): Promise<void>;
    resetPassword(input: In<typeof resetPasswordSchema>): Promise<void>;
    changePassword(input: In<typeof changePasswordSchema>): Promise<AuthSession>;
    me(): Promise<UserDto>;
  };

  me: {
    update(input: In<typeof updateProfileSchema>): Promise<UserDto>;
  };

  users: {
    list(query?: UserListQuery): Promise<Paginated<UserDto>>;
    get(id: string): Promise<UserDto>;
    create(input: In<typeof createUserSchema>): Promise<UserDto>;
    changeRole(id: string, input: In<typeof changeRoleSchema>): Promise<UserDto>;
    suspend(id: string, input: In<typeof suspendUserSchema>): Promise<UserDto>;
    reactivate(id: string): Promise<UserDto>;
    supervisors(q?: string): Promise<UserDto[]>;
  };

  registrations: {
    list(query?: PageQuery): Promise<Paginated<UserDto>>;
    approve(id: string, input: In<typeof approveRegistrationSchema>): Promise<UserDto>;
    reject(id: string, input: In<typeof rejectRegistrationSchema>): Promise<UserDto>;
  };

  audit: {
    list(query?: AuditQuery): Promise<Paginated<AuditEntryDto>>;
  };

  notifications: {
    list(query?: NotificationQuery): Promise<Paginated<NotificationDto>>;
    unreadCount(): Promise<{ count: number }>;
    markRead(id: string): Promise<void>;
    markAllRead(): Promise<void>;
  };

  settings: {
    get(): Promise<Settings>;
    update(input: In<typeof updateSettingsSchema>): Promise<Settings>;
  };
}

/** Builds `?a=1&b=x` from defined, non-empty values. */
export function toQueryString(query: object | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
