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
  PrintBatchCreatedDto,
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
  PhotoUrlDto,
  RosterResponse,
  ViolationDto,
  ViolationFilter,
  ViolationStats,
  ViolationTypeDto,
  MemberSearchInput,
  UserSearchInput,
  ActivityDto,
  CalendarDto,
  CreatedDependencyDto,
  CreatedTaskDto,
  GanttDto,
  MyTaskDto,
  ProjectAccessDto,
  ProjectDto,
  ProjectListQuery,
  TaskArchiveResult,
  TaskAttachmentDto,
  TaskBatchResult,
  TaskCommentDto,
  TaskDto,
  TaskUpdateResult,
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
  calendarExceptionSchema,
  calendarSchema,
  createDependencySchema,
  createProjectSchema,
  createTaskSchema,
  grantProjectAccessSchema,
  taskBatchSchema,
  taskCommentSchema,
  updateCalendarSchema,
  updateProjectSchema,
  updateTaskSchema,
  attachmentBrowseQuerySchema,
  checklistItemSchema,
  checklistReorderSchema,
  customFieldSchema,
  duplicateTaskSchema,
  hubQuerySchema,
  labelSchema,
  portfolioSchema,
  putViewPrefSchema,
  saveAsTemplateSchema,
  taskBulkArchiveSchema,
  taskBulkSchema,
  taskCommentSchema as commentSchemaA9,
  timeEntrySchema,
  updateChecklistItemSchema,
  updateCustomFieldSchema,
  updateLabelSchema,
  updatePortfolioSchema,
  updateTimeEntrySchema,
  addTeamSupervisorSchema,
  removeTeamSupervisorSchema,
  setPrimarySupervisorSchema,
  createOrgUnitSchema,
  updateOrgUnitSchema,
  moveOrgUnitSchema,
  createOrgPositionSchema,
  updateOrgPositionSchema,
  moveOrgPositionSchema,
  assignViolationSchema,
  unassignViolationSchema,
  registerViolationMemberSchema,
} from '@nuzli/shared';
import type {
  CalendarView,
  GanttView,
  ProjectView,
  TaskView,
  calendarSchemaH,
  createProjectSchemaH,
  createTaskSchemaH,
  taskBatchSchemaH,
  updateCalendarSchemaH,
  updateProjectSchemaH,
  updateTaskSchemaH,
} from './hoursWire';

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

/** Calendars as built: `CalendarDto` plus `isDefault` (docs/phase-4-backend.md). */
export type CalendarListDto = CalendarDto & { isDefault: boolean };

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

/**
 * Whose personal photo (owner request A8, docs/photos.md). `me` is the signed-in user's own photo
 * (`/me/photo…`); `id` is still their user id, the presign `entityId`. `user` is another
 * user's (admin writes; any active user reads ACTIVE users), `member` a team member's.
 */
export type PhotoTarget =
  | { kind: 'me'; id: string }
  | { kind: 'user'; id: string }
  | { kind: 'member'; id: string };

export interface UploadOptions {
  /** 0…1 while the bytes go to storage. */
  onProgress?(fraction: number): void;
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
    /**
     * `POST /users/search`: the same filters in the body. Use it whenever the term holds a full
     * national ID (`isFullNationalIdTerm`) — those never go in a URL (ADR-067); GET answers 400.
     */
    search(input: UserSearchInput): Promise<Paginated<UserDto>>;
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
    // A9 (ADR-100/101): several supervisors and the worker foreman.
    /** `GET /teams/:id/supervisors` — current supervisors (primary first) and the full history. */
    supervisorsOf(id: string): Promise<TeamSupervisorsDto>;
    /** Admin. 409 SUPERVISOR_ALREADY_IN_TEAM, 400 NOT_A_SUPERVISOR. */
    addSupervisor(id: string, input: In<typeof addTeamSupervisorSchema>): Promise<TeamDto>;
    /** Admin. The primary needs `newPrimaryUserId` (409 PRIMARY_SUPERVISOR_REQUIRED); the last one → 409 LAST_SUPERVISOR. */
    removeSupervisor(id: string, userId: string, input: In<typeof removeTeamSupervisorSchema>): Promise<TeamDto>;
    setPrimarySupervisor(id: string, userId: string, input?: In<typeof setPrimarySupervisorSchema>): Promise<TeamDto>;
    /** Admin or a leading supervisor. 409 FOREMAN_NOT_MEMBER / FOREMAN_HAS_ACCOUNT. */
    setForeman(id: string, memberId: string): Promise<TeamDetailDto>;
    clearForeman(id: string): Promise<TeamDetailDto>;
  };

  /** A9 organisational structure (ADR-102): admins manage, admins and supervisors read. */
  org: {
    tree(query?: { includeArchived?: boolean }): Promise<OrgTreeDto>;
    createUnit(input: In<typeof createOrgUnitSchema>): Promise<OrgUnitDto>;
    updateUnit(id: string, input: In<typeof updateOrgUnitSchema>): Promise<OrgUnitDto>;
    /** 409 ORG_CYCLE under itself or a descendant. */
    moveUnit(id: string, input: In<typeof moveOrgUnitSchema>): Promise<OrgUnitDto>;
    /** 409 ORG_UNIT_NOT_EMPTY while it has child units, positions or teams. */
    deleteUnit(id: string): Promise<void>;
    createPosition(input: In<typeof createOrgPositionSchema>): Promise<OrgPositionDto>;
    /** 409 ORG_REPORTS_CYCLE. */
    updatePosition(id: string, input: In<typeof updateOrgPositionSchema>): Promise<OrgPositionDto>;
    movePosition(id: string, input: In<typeof moveOrgPositionSchema>): Promise<OrgPositionDto>;
    deletePosition(id: string): Promise<void>;
  };

  members: {
    list(query?: MemberListQuery): Promise<Paginated<MemberDto>>;
    get(id: string): Promise<MemberDto>;
    update(id: string, input: In<typeof updateMemberSchema>): Promise<MemberDto>;
    history(id: string): Promise<MembershipHistoryDto[]>;
    move(input: In<typeof moveMembersSchema>): Promise<MemberDto[]>;
    /** `POST /members/search` — for full national IDs (ADR-067). */
    search(input: MemberSearchInput): Promise<Paginated<MemberDto>>;
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
    /**
     * Idempotent by `idempotencyKey`: repeating it returns the original batch. The answer
     * carries `cards` — the only place with full national IDs (ADR-064): print from it, keep it
     * in memory, never re-read full IDs from the batch detail.
     */
    createBatch(input: In<typeof printBatchSchema>): Promise<PrintBatchCreatedDto>;
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
    upload(presigned: PresignedUpload, blob: Blob, opts?: UploadOptions): Promise<void>;
    confirm(fileId: string): Promise<{ id: string; status: 'READY' }>;
  };

  /**
   * Personal photos (owner request A8, ADR-083). `upload` runs presign (`user_photo` /
   * `member_photo`, kind PHOTO) → PUT → confirm; confirm links the file and deletes the previous
   * one. `url` is a short-lived signed GET (404 when there is none or it is out of scope) —
   * never store it. Writes: self or admin (users); admin or the leading supervisor (members).
   */
  photos: {
    url(target: PhotoTarget): Promise<PhotoUrlDto>;
    upload(target: PhotoTarget, blob: Blob, opts?: UploadOptions): Promise<{ fileId: string }>;
    remove(target: PhotoTarget): Promise<void>;
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
    // A9 (ADR-103/104): violations without a person and the ID-card reading.
    /** Admin or the recorder; audited `violation.ocr_viewed`; the number is masked without `nationalIds.readFull`. */
    ocr(id: string): Promise<ViolationOcrDto>;
    /** Admin: read the card again. */
    retryOcr(id: string): Promise<{ queued: true }>;
    /** Admin or the recorder (any time). Team and supervisors resolved at captured_at. 409 VIOLATION_ALREADY_ASSIGNED. */
    assign(id: string, input: In<typeof assignViolationSchema>): Promise<ViolationDto>;
    /** Admin. */
    unassign(id: string, input?: In<typeof unassignViolationSchema>): Promise<ViolationDto>;
    /** Admin, or a supervisor leading `teamId`: creates the member from the card and assigns. */
    registerMember(id: string, input: In<typeof registerViolationMemberSchema>): Promise<RegisterViolationMemberResultDto>;
  };

  logos: {
    /** Each logo carries a displayable `url`. */
    list(): Promise<LogoDto[]>;
    upload(input: LogoUploadInput): Promise<LogoDto>;
    setDefault(id: string): Promise<LogoDto>;
    remove(id: string): Promise<void>;
  };

  // ---------------------------------------------------------------- Phase 4

  /**
   * Projects (docs/API.md "Phase 4" + "A9 — projects"). Admins only since A9 (ADR-092): every
   * project route answers 403 to a supervisor, who reaches only the tasks assigned to them.
   */
  projects: {
    list(query?: ProjectListQuery): Promise<ProjectView[]>;
    get(id: string): Promise<ProjectView>;
    create(input: In<typeof createProjectSchemaH>): Promise<ProjectView>;
    update(id: string, input: In<typeof updateProjectSchemaH>): Promise<ProjectView>;
    /** `DELETE /projects/:id` archives and answers the archived project. */
    archive(id: string): Promise<ProjectView>;
    access(id: string): Promise<ProjectAccessDto[]>;
    grantAccess(id: string, input: In<typeof grantProjectAccessSchema>): Promise<ProjectAccessDto>;
    revokeAccess(id: string, userId: string): Promise<void>;
    /** The whole chart in one call: project, tasks (WBS order), dependencies, calendar, labels, fields. */
    gantt(id: string): Promise<GanttView>;
    /** Tasks to Excel (ADR-019): RTL sheets, no freeze panes. */
    exportXlsx(id: string): Promise<Blob>;
    // A9
    budget(id: string): Promise<BudgetReportDto>;
    people(id: string): Promise<ProjectPersonDto[]>;
    dashboard(id: string): Promise<ProjectDashboardDto>;
    /** Tasks overlapping [from, to] (≤ 366 days) or with a deadline in it. */
    calendar(id: string, range: { from: string; to: string }): Promise<ProjectCalendarDto>;
    saveAsTemplate(id: string, input: In<typeof saveAsTemplateSchema>): Promise<ProjectView>;
    templates(): Promise<ProjectView[]>;
    /** `GET /reports/projects`. */
    report(query?: { status?: ProjectListQuery['status'] }): Promise<ProjectReportRow[]>;
  };

  tasks: {
    create(projectId: string, input: In<typeof createTaskSchemaH>): Promise<CreatedTaskDto>;
    get(id: string): Promise<TaskView>;
    /** The server re-runs the engine; `affected` lists every other task it changed. 409 CONFLICT_VERSION. */
    update(id: string, input: In<typeof updateTaskSchemaH>): Promise<TaskUpdateResult>;
    /** One drag-end (or one undo/redo step, ADR-095) = one request with every changed task and its version. */
    batch(projectId: string, input: In<typeof taskBatchSchemaH>): Promise<TaskBatchResult>;
    /** Archives the task and its subtree. */
    archive(id: string): Promise<TaskArchiveResult>;
    /** Assigned tasks across projects with due flags (the supervisor «مهامي»). */
    mine(): Promise<MyTaskDto[]>;
    comments(id: string): Promise<TaskCommentDto[]>;
    addComment(id: string, input: In<typeof taskCommentSchema>): Promise<TaskCommentDto>;
    /** `POST /tasks/:id/comments/read` — the thread is read up to now. */
    markRead(id: string): Promise<CommentReadDto>;
    activity(id: string): Promise<ActivityDto[]>;
    attachments(id: string): Promise<TaskAttachmentDto[]>;
    /** Links a READY file uploaded with `entityType: 'task'` (presign → upload → confirm first). */
    attach(id: string, fileId: string): Promise<TaskAttachmentDto>;
    attachmentUrl(id: string, fileId: string): Promise<{ url: string; expiresAt: string }>;
    removeAttachment(id: string, fileId: string): Promise<void>;
    // A9
    duplicate(id: string, input?: In<typeof duplicateTaskSchema>): Promise<DuplicateTaskResult>;
    bulk(projectId: string, input: In<typeof taskBulkSchema>): Promise<TaskBulkResult>;
    bulkArchive(projectId: string, input: In<typeof taskBulkArchiveSchema>): Promise<TaskBulkArchiveResult>;
    restore(projectId: string, ids: string[]): Promise<TaskRestoreResult>;
    labels(id: string): Promise<LabelDto[]>;
    addLabel(id: string, labelId: string): Promise<TaskUpdateResult>;
    removeLabel(id: string, labelId: string): Promise<TaskUpdateResult>;
    customFields(id: string): Promise<Array<CustomFieldDto & { value: unknown }>>;
    /** `null` clears the value. */
    setCustomValue(id: string, fieldId: string, value: unknown): Promise<CustomValueDto>;
    checklist(id: string): Promise<ChecklistItemDto[]>;
    addChecklistItem(id: string, input: In<typeof checklistItemSchema>): Promise<ChecklistItemDto>;
    /** Admins edit; the assignee ticks (`done` only). */
    updateChecklistItem(id: string, itemId: string, input: In<typeof updateChecklistItemSchema>): Promise<ChecklistItemDto>;
    removeChecklistItem(id: string, itemId: string): Promise<void>;
    reorderChecklist(id: string, input: In<typeof checklistReorderSchema>): Promise<ChecklistItemDto[]>;
    timeEntries(id: string): Promise<TimeEntryDto[]>;
    addTimeEntry(id: string, input: In<typeof timeEntrySchema>): Promise<TimeEntryDto>;
  };

  dependencies: {
    /** Only FS from the UI. DEPENDENCY_CYCLE (409, details.path), DEPENDENCY_SELF, DEPENDENCY_EXISTS. */
    create(projectId: string, input: In<typeof createDependencySchema>): Promise<CreatedDependencyDto>;
    remove(id: string): Promise<void>;
  };

  calendars: {
    list(): Promise<CalendarListView[]>;
    get(id: string): Promise<CalendarListView>;
    create(input: In<typeof calendarSchemaH>): Promise<CalendarListView>;
    update(id: string, input: In<typeof updateCalendarSchemaH>): Promise<CalendarListView>;
    /** Answers the whole calendar (201); a duplicate date → 409 CALENDAR_DATE_EXISTS. */
    addException(id: string, input: In<typeof calendarExceptionSchema>): Promise<CalendarListView>;
    removeException(id: string, exceptionId: string): Promise<void>;
  };

  // ---------------------------------------------------------------- A9 (ADR-092..097)

  labels: {
    list(projectId: string): Promise<LabelDto[]>;
    create(projectId: string, input: In<typeof labelSchema>): Promise<LabelDto>;
    update(id: string, input: In<typeof updateLabelSchema>): Promise<LabelDto>;
    /** Takes the label off its tasks through the versioned write path. */
    remove(id: string): Promise<{ affected: TaskDto[]; previous: TaskPreviousMap }>;
  };

  customFields: {
    list(projectId: string): Promise<CustomFieldDto[]>;
    create(projectId: string, input: In<typeof customFieldSchema>): Promise<CustomFieldDto>;
    update(id: string, input: In<typeof updateCustomFieldSchema>): Promise<CustomFieldDto>;
    remove(id: string): Promise<void>;
  };

  timeEntries: {
    /** `GET /me/time-entries?from&to` (default: the last 31 days). */
    mine(range?: { from?: string; to?: string }): Promise<TimeEntryDto[]>;
    update(id: string, input: In<typeof updateTimeEntrySchema>): Promise<TimeEntryDto>;
    remove(id: string): Promise<void>;
  };

  /** Personal UI state (ADR-097): columns, saved views, favourites. Not audited. */
  viewPrefs: {
    list(query?: { projectId?: string; key?: string }): Promise<ViewPrefDto[]>;
    put(input: In<typeof putViewPrefSchema>): Promise<ViewPrefDto>;
    remove(query: { projectId?: string; key: string }): Promise<void>;
  };

  portfolios: {
    list(): Promise<PortfolioDto[]>;
    get(id: string): Promise<PortfolioSummaryDto>;
    create(input: In<typeof portfolioSchema>): Promise<PortfolioDto>;
    update(id: string, input: In<typeof updatePortfolioSchema>): Promise<PortfolioDto>;
    remove(id: string): Promise<void>;
    addProject(id: string, projectId: string): Promise<PortfolioDto>;
    removeProject(id: string, projectId: string): Promise<PortfolioDto>;
  };

  /** `GET /workload?from&to&userIds` (≤ 92 days). */
  workload(query: { from: string; to: string; userIds?: string[] }): Promise<WorkloadDto>;

  /** Communication hub (`GET /hub`) and the attachments browser (`GET /attachments`). */
  hub: {
    list(query?: In<typeof hubQuerySchema>): Promise<HubPageDto>;
    attachments(query?: In<typeof attachmentBrowseQuerySchema>): Promise<Paginated<AttachmentBrowseDto>>;
  };
}

/** A calendar as listed: `CalendarDto` + `isDefault` + the A9 working hours. */
export type CalendarListView = CalendarListDto & CalendarView;

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
