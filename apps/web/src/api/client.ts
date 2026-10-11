import type {
  AuditEntryDto,
  AuthSession,
  CardPreviewDto,
  CardSizeDto,
  CardTemplateDto,
  ImportMembersResultDto,
  LogoDto,
  MemberDto,
  MembershipHistoryDto,
  NotificationDto,
  Paginated,
  PrintBatchDetailDto,
  PrintBatchDto,
  ReferenceItemDto,
  Role,
  Settings,
  SupervisorHistoryDto,
  TeamColorDto,
  TeamColorPaletteDto,
  TeamDetailDto,
  TeamDto,
  TeamStatus,
  UserDto,
  UserStatus,
  VisibilityMode,
  PresignUploadInput,
  PresignedUpload,
  RosterResponse,
  ViolationDto,
  ViolationFilter,
  ViolationStats,
  ViolationTypeDto,
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
  archiveTeamSchema,
  cardPreviewSchema,
  cardSizeSchema,
  cardTemplateSchema,
  changeSupervisorSchema,
  createTeamSchema,
  importMembersSchema,
  memberInputSchema,
  moveMembersSchema,
  printBatchSchema,
  referenceItemSchema,
  rejectTeamSchema,
  teamColorSchema,
  updateCardTemplateSchema,
  updateMemberSchema,
  updateReferenceItemSchema,
  updateTeamColorSchema,
  updateTeamSchema,
  createViolationSchema,
  updateViolationSchema,
  changeViolationStatusSchema,
  violationResponseSchema,
  violationTypeSchema,
  updateViolationTypeSchema,
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
  /** One record's history (the API accepts `entityId`). */
  entityId?: string;
  actorId?: string;
  /** `YYYY-MM-DD`, inclusive, Asia/Riyadh day. */
  from?: string;
  to?: string;
}

export interface NotificationQuery extends PageQuery {
  unread?: boolean;
}

export interface TeamListQuery {
  /** Omitted = ACTIVE + PENDING_APPROVAL (as built, ADR-039..045); `ALL` includes archived. */
  status?: TeamStatus | 'ALL';
  q?: string;
}

export interface MemberListQuery extends PageQuery {
  teamId?: string;
  unassigned?: boolean;
}

/** `/reference/departments` and `/reference/job-titles`. */
export type ReferenceKind = 'departments' | 'job-titles';

/**
 * Logo upload as one call for screens. HttpApi runs presign → PUT → confirm → POST /logos;
 * DemoApi stores the image as a data URL. Only PNG, JPEG and WebP are accepted (never SVG).
 */
export interface LogoUploadInput {
  name: string;
  file: Blob & { name?: string; type: string };
  isDefault?: boolean;
}

/** `DELETE /reference/:kind/:id` → 200 (as built; not in @nuzli/shared, defined here). */
export interface ReferenceRemoveResult {
  result: 'DELETED' | 'DEACTIVATED';
  item: ReferenceItemDto;
}

/** `GET /violations` and `/violations/mine`: the shared filters plus pagination, `q` and `sort`. */
export interface ViolationListQuery extends ViolationFilter, PageQuery {
  /** `capturedAt|receivedAt|status:asc|desc`; default `capturedAt:desc`. */
  sort?: string;
}

/** `POST /violations`: 201 = created, 200 = the same clientUuid was already recorded. */
export interface CreateViolationResult {
  violation: ViolationDto;
  created: boolean;
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

  // ---------------------------------------------------------------- Phase 2

  colors: {
    /** Colours no ACTIVE/PENDING team holds; the edited team's own colour is included. */
    available(excludeTeamId?: string): Promise<TeamColorDto[]>;
    /** ADMIN: the whole palette with the team that holds each colour. */
    list(): Promise<TeamColorPaletteDto[]>;
    create(input: In<typeof teamColorSchema>): Promise<TeamColorDto>;
    update(id: string, input: In<typeof updateTeamColorSchema>): Promise<TeamColorDto>;
  };

  teams: {
    list(query?: TeamListQuery): Promise<TeamDto[]>;
    get(id: string): Promise<TeamDetailDto>;
    create(input: In<typeof createTeamSchema>): Promise<TeamDto>;
    update(id: string, input: In<typeof updateTeamSchema>): Promise<TeamDto>;
    approve(id: string): Promise<TeamDto>;
    reject(id: string, input: In<typeof rejectTeamSchema>): Promise<TeamDto>;
    archive(id: string, input: In<typeof archiveTeamSchema>): Promise<TeamDto>;
    changeSupervisor(id: string, input: In<typeof changeSupervisorSchema>): Promise<TeamDto>;
    supervisorHistory(id: string): Promise<SupervisorHistoryDto[]>;
    setViolationVisibility(id: string, mode: VisibilityMode): Promise<TeamDto>;
    addMember(teamId: string, input: In<typeof memberInputSchema>): Promise<MemberDto>;
    importMembers(input: In<typeof importMembersSchema>): Promise<ImportMembersResultDto>;
  };

  members: {
    list(query?: MemberListQuery): Promise<Paginated<MemberDto>>;
    get(id: string): Promise<MemberDto>;
    update(id: string, input: In<typeof updateMemberSchema>): Promise<MemberDto>;
    history(id: string): Promise<MembershipHistoryDto[]>;
    move(input: In<typeof moveMembersSchema>): Promise<MemberDto[]>;
  };

  reference: {
    list(kind: ReferenceKind): Promise<ReferenceItemDto[]>;
    create(kind: ReferenceKind, input: In<typeof referenceItemSchema>): Promise<ReferenceItemDto>;
    update(
      kind: ReferenceKind,
      id: string,
      input: In<typeof updateReferenceItemSchema>,
    ): Promise<ReferenceItemDto>;
    /** Deletes, or deactivates when members still reference the item. */
    remove(kind: ReferenceKind, id: string): Promise<ReferenceRemoveResult>;
  };

  cards: {
    sizes(): Promise<CardSizeDto[]>;
    createSize(input: In<typeof cardSizeSchema>): Promise<CardSizeDto>;
    deleteSize(id: string): Promise<void>;
    templates(): Promise<CardTemplateDto[]>;
    createTemplate(input: In<typeof cardTemplateSchema>): Promise<CardTemplateDto>;
    updateTemplate(id: string, input: In<typeof updateCardTemplateSchema>): Promise<CardTemplateDto>;
    archiveTemplate(id: string): Promise<void>;
    preview(input: In<typeof cardPreviewSchema>): Promise<CardPreviewDto>;
    /** Idempotent by `idempotencyKey`: repeating it returns the original batch. */
    createBatch(input: In<typeof printBatchSchema>): Promise<PrintBatchDto>;
    batches(query?: PageQuery): Promise<Paginated<PrintBatchDto>>;
    batch(id: string): Promise<PrintBatchDetailDto>;
    /** Server PDF (ADR-024). Throws `PDF_NOT_CONFIGURED` (501) until the pdf service exists. */
    pdf(id: string): Promise<Blob>;
  };

  // ---------------------------------------------------------------- Phase 3

  /**
   * Object-storage uploads (docs/API.md Phase 1 + 3). The sync engine runs presign → upload →
   * confirm per photo. HttpApi PUTs the blob straight to the presigned URL with exactly the
   * returned headers; DemoApi keeps the blob in IndexedDB (a fake bucket).
   */
  files: {
    presign(input: PresignUploadInput): Promise<PresignedUpload>;
    upload(presigned: PresignedUpload, blob: Blob): Promise<void>;
    confirm(fileId: string): Promise<{ id: string; status: 'READY' }>;
  };

  violationTypes: {
    /** Non-admins always get the active ones. */
    list(query?: { active?: boolean }): Promise<ViolationTypeDto[]>;
    create(input: In<typeof violationTypeSchema>): Promise<ViolationTypeDto>;
    update(id: string, input: In<typeof updateViolationTypeSchema>): Promise<ViolationTypeDto>;
  };

  violations: {
    /** MONITOR/ADMIN: the minimal member list cached on the device (masked IDs only). */
    roster(): Promise<RosterResponse>;
    /** Idempotent by `clientUuid` (ADR-046). */
    create(input: In<typeof createViolationSchema>): Promise<CreateViolationResult>;
    list(query?: ViolationListQuery): Promise<Paginated<ViolationDto>>;
    mine(query?: ViolationListQuery): Promise<Paginated<ViolationDto>>;
    get(id: string): Promise<ViolationDto>;
    /** Presigned GET. ID-card photos are audited (`violation.id_photo_viewed`). */
    fileUrl(id: string, fileId: string): Promise<{ url: string; expiresAt: string }>;
    update(id: string, input: In<typeof updateViolationSchema>): Promise<ViolationDto>;
    setStatus(id: string, input: In<typeof changeViolationStatusSchema>): Promise<ViolationDto>;
    respond(id: string, input: In<typeof violationResponseSchema>): Promise<ViolationDto>;
    stats(filter?: ViolationFilter): Promise<ViolationStats>;
    /** RTL workbook without freeze panes (ADR-019). */
    exportXlsx(filter?: ViolationFilter): Promise<Blob>;
    /** Throws `PDF_NOT_CONFIGURED` (501) until the pdf service exists. */
    dashboardPdf(filter?: ViolationFilter): Promise<Blob>;
  };

  logos: {
    /** Each logo carries a displayable `url`. */
    list(): Promise<LogoDto[]>;
    upload(input: LogoUploadInput): Promise<LogoDto>;
    setDefault(id: string): Promise<LogoDto>;
    remove(id: string): Promise<void>;
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
