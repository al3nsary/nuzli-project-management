import Dexie, { type Table } from 'dexie';
import { maskNationalId } from '@nuzli/shared';
import type { StoredTask } from '../../features/projects/engine';
import type {
  CardData,
  CardLayoutKey,
  CardOrientation,
  CardTemplateConfig,
  MemberStatus,
  ProjectStatus,
  PrintBatchItemDto,
  Role,
  Severity,
  TeamStatus,
  ViolationFileKind,
  ViolationStatus,
  UserPreferences,
  UserStatus,
  VisibilityMode,
  DependencyType,
  OcrStatus,
  OrgUnitKind,
  WorkspaceRole,
  AssistantPermissions,
  AssistantScope,
  ParticipantLevel,
} from '@nuzli/shared';
import type { ExtractedCard } from '../../features/violations/ocr/parse';

/** A user row as the demo stores it: full national ID and a password hash, never sent to screens as is. */
export interface DemoUser {
  id: string;
  fullName: string;
  email: string;
  mobile: string;
  nationalId: string;
  role: Role;
  requestedRole: Role | null;
  requestedTeamName: string | null;
  status: UserStatus;
  rejectionReason: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  preferences: UserPreferences;
  passwordHash: string;
  /** ADR-062: consecutive failures and the short silent lock. */
  failedLogins?: number;
  lockedUntil?: string | null;
  /** Owner request A8: the linked personal photo (`files` row, entityType user_photo). */
  photoFileId?: string | null;
  /**
   * A12: the login name (lower case, unique). The legacy `role` stays on the row only as the
   * role a registration asked for; rights come from `wsMemberships` (per workspace).
   */
  username?: string;
  /** A12: OWNER (مالك) sees every workspace; USER rights come from memberships. */
  accountRole?: 'OWNER' | 'USER';
  /** A12: the workspace a registration applies to. */
  requestedWorkspaceId?: string | null;
  /**
   * Security review A12 H2: the account was suspended by an OWNER in every workspace — only an
   * owner lifts it (a workspace admin answers SUSPENDED_BY_OWNER), like the API.
   */
  suspendedGlobally?: boolean;
}

/** A12: a workspace (قسم). Never deleted — archived. */
export interface DemoWorkspace {
  id: string;
  name: string;
  code: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  createdBy: string | null;
  archivedAt: string | null;
}

/** A12: a role of a user in a workspace (a person may hold several: «صلاحية مزدوجة»). */
export interface DemoWsMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  title: string | null;
  /** ASSISTANT: module → level. */
  permissions: AssistantPermissions;
  /** ASSISTANT: optional project / team limits. */
  scope: AssistantScope;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  createdBy: string | null;
  archivedAt: string | null;
}

/** A12 round 2: a project participant (محرّر / مساهم / مطّلع) — scoped. */
export interface DemoParticipant {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  level: ParticipantLevel;
  addedById: string | null;
  createdAt: string;
}

/** A12 round 2: a supervisor's request to add or remove a worker — scoped. */
export interface DemoMemberRequest {
  id: string;
  kind: 'ADD' | 'REMOVE';
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  teamId: string | null;
  memberId: string | null;
  /** ADD: what the supervisor entered; the full national ID is cleared on decision. */
  payload: {
    fullName?: string;
    nationalId?: string | null;
    jobTitleId?: string | null;
    jobTitleText?: string | null;
    departmentId?: string | null;
    departmentText?: string | null;
    /** After the decision: the masked number only. */
    nationalIdMasked?: string;
  };
  reason: string | null;
  decisionReason: string | null;
  requestedById: string | null;
  decidedById: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface DemoNotification {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface DemoAudit {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  at: string;
}

export interface DemoSession {
  token: string;
  userId: string;
  createdAt: string;
  /** A12: the workspace this session is bound to (null until one is chosen). */
  workspaceId?: string | null;
}

export interface KeyValue {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------- Phase 2 rows

export interface DemoColor {
  id: string;
  name: string;
  hex: string;
  isActive: boolean;
  sortOrder: number;
}

export interface DemoTeam {
  id: string;
  name: string;
  colorId: string;
  supervisorId: string;
  status: TeamStatus;
  createdAt: string;
  createdById: string | null;
  violationVisibility: VisibilityMode;
  archivedAt: string | null;
  archiveReason: string | null;
  /** A9 (ADR-102): optional organisational unit. */
  orgUnitId?: string | null;
}

/** A team member with the full national ID (screens only ever get the mask unless admin). */
export interface DemoMember {
  id: string;
  fullName: string;
  nationalId: string;
  jobTitleId: string | null;
  jobTitleText: string | null;
  departmentId: string | null;
  departmentText: string | null;
  status: MemberStatus;
  photoFileId: string | null;
  createdAt: string;
}

/** Half-open interval [validFrom, validTo); `validTo = null` is the one open row per member. */
export interface DemoMembership {
  id: string;
  memberId: string;
  teamId: string;
  validFrom: string;
  validTo: string | null;
  movedById: string | null;
  reason: string | null;
  /** A9 (ADR-101): WORKER (default) or the team's one FOREMAN (مشرف عمّال), on the open row. */
  role?: 'WORKER' | 'FOREMAN';
}

/**
 * A9 (ADR-100): one leadership row. "Leads the team" = an open row (primary or not); exactly one
 * open primary per live team; `teams.supervisorId` mirrors the primary.
 */
export interface DemoTeamSupervisor {
  id: string;
  teamId: string;
  userId: string;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  addedById: string | null;
  reason: string | null;
}

/** A9 (ADR-102): an organisational unit (tree by `parentId`). */
export interface DemoOrgUnit {
  id: string;
  parentId: string | null;
  name: string;
  kind: OrgUnitKind;
  code: string | null;
  sort: number;
  archivedAt: string | null;
  createdAt: string;
}

/** A9 (ADR-102): a position held by a user, a member, or nobody (vacant). */
export interface DemoOrgPosition {
  id: string;
  unitId: string;
  title: string;
  holderUserId: string | null;
  holderMemberId: string | null;
  reportsToPositionId: string | null;
  sort: number;
  createdAt: string;
}

/**
 * A9 (ADR-104): the ID-card reading of one violation. The demo runs tesseract.js in the browser;
 * the real API keeps the fields encrypted on the server. Raw OCR text is never stored.
 */
export interface DemoViolationOcr {
  violationId: string;
  fileId: string;
  status: OcrStatus;
  attempts: number;
  error: string | null;
  extracted: ExtractedCard | null;
  extractedAt: string | null;
  updatedAt: string;
}

export interface DemoSupervisorHistory {
  id: string;
  teamId: string;
  supervisorId: string;
  validFrom: string;
  validTo: string | null;
  changedById: string | null;
  reason: string | null;
}

export interface DemoReference {
  id: string;
  kind: 'departments' | 'job-titles';
  name: string;
  isActive: boolean;
}

export interface DemoCardSize {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  isBuiltin: boolean;
}

export interface DemoTemplate {
  id: string;
  name: string;
  sizeId: string;
  orientation: CardOrientation;
  layoutKey: CardLayoutKey;
  config: CardTemplateConfig;
  isDefault: boolean;
  logoId: string | null;
  archived: boolean;
}

export interface DemoLogo {
  id: string;
  name: string;
  fileId: string;
  isDefault: boolean;
  /** The image itself (PNG/JPEG/WebP only), kept in IndexedDB. */
  dataUrl: string;
  createdAt: string;
}

export interface DemoBatch {
  id: string;
  idempotencyKey: string;
  templateId: string;
  templateName: string;
  templateSnapshot: Record<string, unknown>;
  printedById: string;
  printedAt: string;
  items: (PrintBatchItemDto & { data: CardData })[];
}

// ---------------------------------------------------------------- Phase 3 rows

export interface DemoViolationType {
  id: string;
  name: string;
  severity: Severity | null;
  isActive: boolean;
  createdAt: string;
}

export interface DemoViolationResponse {
  id: string;
  supervisorId: string;
  body: string;
  createdAt: string;
}

/** A violation with its snapshots (ADR-014/046): team and supervisor at `capturedAt`. */
export interface DemoViolation {
  id: string;
  clientUuid: string;
  /** A9: null until the person is identified and assigned. */
  memberId: string | null;
  typeId: string;
  teamIdSnapshot: string | null;
  supervisorIdSnapshot: string | null;
  recordedById: string;
  description: string;
  notes: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
  receivedAt: string;
  clientSentAt: string | null;
  clockDriftSuspect: boolean;
  deviceInfo: Record<string, unknown>;
  expectedIdPhotos: number;
  expectedEvidence: number;
  /** A9: one PERSON photo is announced on every violation recorded since A9 (0 before). */
  expectedPersonPhotos?: number;
  /** A9: every supervisor of the team at `capturedAt` (primary first). */
  supervisorIdsSnapshot?: string[];
  assignedAt?: string | null;
  assignedById?: string | null;
  status: ViolationStatus;
  cancelReason: string | null;
  responses: DemoViolationResponse[];
}

/** A `files` row: PENDING after presign, READY after confirm; `violationId` once linked. */
export interface DemoFile {
  id: string;
  entityType: string;
  entityId: string | null;
  kind: ViolationFileKind | string | null;
  mimeType: string;
  sizeBytes: number;
  status: 'PENDING' | 'READY';
  createdById: string;
  createdAt: string;
  /** Presigned PUT expiry; a PENDING upload stops counting against the limit after it (ADR-048). */
  expiresAt: string;
  /** Set when linked to a violation (`violation_files`). */
  violationId: string | null;
  /** Task attachments removed by an admin or the uploader (ADR-058). */
  deletedAt?: string | null;
  /** Seeded photos are drawn on a canvas on first view (never real photos). */
  placeholder?: { label: string; hue: number; portrait?: boolean; variant?: number; card?: DemoIdCardFace } | null;
}

/** A9 demo seed: what a synthetic «بطاقة تجريبية» shows (drawn on a canvas, read by the in-browser OCR). */
export interface DemoIdCardFace {
  name: string;
  nameLatin?: string;
  nationalId: string;
  nationality: string;
  birthDate: string;
  expiryDate: string;
}

/** The fake bucket: object bytes by file id (ArrayBuffer, not Blob — see ADR-072). */
export interface DemoObject {
  key: string;
  data: ArrayBuffer;
  type: string;
}

// ---------------------------------------------------------------- Phase 4 rows

export interface DemoProject {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  status: ProjectStatus;
  calendarId: string;
  autoSchedule: boolean;
  ownerId: string;
  createdAt: string;
  archivedAt: string | null;
  // A9 (ADR-093/094, ADR-105). Optional: rows stored before A9 read as the defaults.
  budget?: number | null;
  currency?: string;
  isTemplate?: boolean;
  templateOfId?: string | null;
  durationUnit?: 'DAY' | 'HOUR';
  /** A12 round 2: the cover image (`files` row, entityType project_cover). */
  coverFileId?: string | null;
}

/** A task as the API stores it (StoredTask) plus archive and reminder columns (ADR-059). */
export interface DemoTask extends StoredTask {
  archivedAt: string | null;
  dueSoonNotifiedAt: string | null;
  overdueNotifiedAt: string | null;
  createdAt: string;
  /** A9: who created the task (the hub's «أنشأتها» tab). */
  createdById?: string | null;
  /** A9: TASK_DEADLINE_PASSED sent for the current deadline (reset when it changes). */
  deadlineNotifiedAt?: string | null;
  /** A9: custom field id → value (validated by normalizeCustomValue; not versioned). */
  customValues?: Record<string, unknown>;
}

export interface DemoDependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  /** A9 HOUR projects: lag in working minutes (`task_dependencies.lag_minutes`, ADR-109). */
  lagMinutes?: number;
  createdAt: string;
}

export interface DemoCalendar {
  id: string;
  name: string;
  weekendDays: number[];
  isDefault: boolean;
  createdAt: string;
  exceptions: { id: string; date: string; isWorking: boolean; name: string; workingHours?: { start: string; end: string }[] | null }[];
  /** A9 HOUR projects: working intervals of a normal day (absent = 09:00–13:00, 14:00–18:00). */
  workingHours?: { start: string; end: string }[];
}

export interface DemoProjectAccess {
  id: string;
  projectId: string;
  userId: string;
  level: 'VIEW';
  createdAt: string;
}

export interface DemoTaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: string;
  /** A9: the quoted comment of the same task. */
  replyToId?: string | null;
}

// ---------------------------------------------------------------- A9 rows (ADR-092..097)

export interface DemoLabel {
  id: string;
  projectId: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface DemoCustomField {
  id: string;
  projectId: string;
  name: string;
  type: 'TEXT' | 'NUMBER' | 'DROPDOWN' | 'DATE' | 'CHECKBOX';
  options: string[];
  sort: number;
  createdAt: string;
}

export interface DemoChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  sort: number;
  doneById: string | null;
  doneAt: string | null;
  createdAt: string;
}

export interface DemoViewPref {
  /** `${userId}|${projectId ?? ''}|${key}` */
  id: string;
  userId: string;
  projectId: string | null;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface DemoPortfolio {
  id: string;
  name: string;
  description: string | null;
  projectIds: string[];
  createdAt: string;
}

export interface DemoTimeEntry {
  id: string;
  taskId: string;
  userId: string;
  date: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

export interface DemoCommentRead {
  /** `${userId}|${taskId}` */
  id: string;
  userId: string;
  taskId: string;
  lastReadAt: string;
}

export class DemoDb extends Dexie {
  users!: Table<DemoUser, string>;
  notifications!: Table<DemoNotification, string>;
  audit!: Table<DemoAudit, string>;
  sessions!: Table<DemoSession, string>;
  kv!: Table<KeyValue, string>;
  colors!: Table<DemoColor, string>;
  teams!: Table<DemoTeam, string>;
  members!: Table<DemoMember, string>;
  memberships!: Table<DemoMembership, string>;
  supervisorHistory!: Table<DemoSupervisorHistory, string>;
  reference!: Table<DemoReference, string>;
  cardSizes!: Table<DemoCardSize, string>;
  cardTemplates!: Table<DemoTemplate, string>;
  logos!: Table<DemoLogo, string>;
  batches!: Table<DemoBatch, string>;
  violationTypes!: Table<DemoViolationType, string>;
  violations!: Table<DemoViolation, string>;
  files!: Table<DemoFile, string>;
  objects!: Table<DemoObject, string>;
  projects!: Table<DemoProject, string>;
  tasks!: Table<DemoTask, string>;
  dependencies!: Table<DemoDependency, string>;
  calendars!: Table<DemoCalendar, string>;
  projectAccess!: Table<DemoProjectAccess, string>;
  taskComments!: Table<DemoTaskComment, string>;
  labels!: Table<DemoLabel, string>;
  customFields!: Table<DemoCustomField, string>;
  checklist!: Table<DemoChecklistItem, string>;
  viewPrefs!: Table<DemoViewPref, string>;
  portfolios!: Table<DemoPortfolio, string>;
  timeEntries!: Table<DemoTimeEntry, string>;
  commentReads!: Table<DemoCommentRead, string>;
  teamSupervisors!: Table<DemoTeamSupervisor, string>;
  orgUnits!: Table<DemoOrgUnit, string>;
  orgPositions!: Table<DemoOrgPosition, string>;
  violationOcr!: Table<DemoViolationOcr, string>;
  workspaces!: Table<DemoWorkspace, string>;
  wsMemberships!: Table<DemoWsMembership, string>;
  participants!: Table<DemoParticipant, string>;
  memberRequests!: Table<DemoMemberRequest, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      users: 'id, &email, &mobile, &nationalId, role, status, createdAt',
      notifications: 'id, userId, createdAt',
      audit: 'id, at, action, entityType, actorId',
      sessions: 'token, userId',
      kv: 'key',
    });
    // Phase 2: teams, members, reference data and cards (seeded on first use, see DemoApi).
    this.version(2).stores({
      colors: 'id, &hex, sortOrder',
      teams: 'id, status, supervisorId, colorId',
      members: 'id, &nationalId',
      memberships: 'id, memberId, teamId',
      supervisorHistory: 'id, teamId',
      reference: 'id, kind',
      cardSizes: 'id',
      cardTemplates: 'id',
      logos: 'id',
      batches: 'id, &idempotencyKey, printedAt',
    });
    // Phase 3: violations, their files and the fake object storage.
    this.version(3).stores({
      violationTypes: 'id',
      violations: 'id, &clientUuid, capturedAt, recordedById, memberId, teamIdSnapshot',
      files: 'id, violationId, entityId',
      objects: 'key',
    });
    // Phase 4: projects, tasks, dependencies, calendars. Also masks print items stored before
    // ADR-064 (full IDs at rest) and flags them MASKED.
    this.version(4)
      .stores({
        projects: 'id, status',
        tasks: 'id, projectId, assigneeId',
        dependencies: 'id, projectId',
        calendars: 'id',
        projectAccess: 'id, projectId, userId',
        taskComments: 'id, taskId',
      })
      .upgrade((tx) =>
        tx
          .table('batches')
          .toCollection()
          .modify((b: DemoBatch) => {
            b.items = b.items.map((item) => ({
              ...item,
              nationalIdPrinted: item.nationalIdPrinted ?? 'MASKED',
              data: {
                ...item.data,
                nationalId: /^\d{10}$/.test(item.data.nationalId ?? '')
                  ? maskNationalId(item.data.nationalId!)
                  : item.data.nationalId,
              },
            }));
          }),
      );
    // A9: labels, custom fields, checklists, view preferences, portfolios, time log, read marks.
    // Tasks stored before A9 get the new columns' defaults.
    this.version(5)
      .stores({
        labels: 'id, projectId',
        customFields: 'id, projectId',
        checklist: 'id, taskId',
        viewPrefs: 'id, userId',
        portfolios: 'id',
        timeEntries: 'id, taskId, userId, date',
        commentReads: 'id, userId, taskId',
      })
      .upgrade((tx) =>
        tx
          .table('tasks')
          .toCollection()
          .modify((t: DemoTask) => {
            t.plannedCost ??= 0;
            t.actualCost ??= 0;
            t.deadline ??= null;
            t.barColor ??= null;
            t.labelIds ??= [];
          }),
      );
    // A9 teams/org/violations (ADR-100..104): several supervisors (the old one-row history is
    // copied as primary rows), the organisational structure and the ID-card reading.
    this.version(6)
      .stores({
        teamSupervisors: 'id, teamId, userId',
        orgUnits: 'id, parentId',
        orgPositions: 'id, unitId',
        violationOcr: 'violationId',
      })
      .upgrade(async (tx) => {
        const history = (await tx.table('supervisorHistory').toArray()) as DemoSupervisorHistory[];
        const rows: DemoTeamSupervisor[] = history.map((h) => ({
          id: h.id,
          teamId: h.teamId,
          userId: h.supervisorId,
          isPrimary: true,
          validFrom: h.validFrom,
          validTo: h.validTo,
          addedById: h.changedById,
          reason: h.reason,
        }));
        if (rows.length) await tx.table('teamSupervisors').bulkPut(rows);
      });
    // A12 (ADR-153): workspaces, memberships, participants and worker requests. Uniqueness that
    // was global becomes per workspace (a worker may exist in two workspaces; colours repeat).
    // Demo data only: the old rows are wiped and the new seed (version.json) is loaded on first use.
    this.version(7)
      .stores({
        users: 'id, &email, &mobile, &nationalId, &username, role, status, createdAt',
        sessions: 'token, userId, workspaceId',
        colors: 'id, hex, &[wid+hex], sortOrder',
        members: 'id, nationalId, &[wid+nationalId]',
        workspaces: 'id, &code, status',
        wsMemberships: 'id, workspaceId, userId',
        participants: 'id, projectId, userId',
        memberRequests: 'id, status, teamId',
      })
      .upgrade(async (tx) => {
        for (const table of tx.db.tables) await tx.table(table.name).clear();
      });
  }

  /** Every table, for reset and wide transactions. */
  get allTables() {
    return this.tables;
  }
}
