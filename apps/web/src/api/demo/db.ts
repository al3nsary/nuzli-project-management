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
} from '@nuzli/shared';

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
  memberId: string;
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
  placeholder?: { label: string; hue: number; portrait?: boolean } | null;
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
}

/** A task as the API stores it (StoredTask) plus archive and reminder columns (ADR-059). */
export interface DemoTask extends StoredTask {
  archivedAt: string | null;
  dueSoonNotifiedAt: string | null;
  overdueNotifiedAt: string | null;
  createdAt: string;
}

export interface DemoDependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  createdAt: string;
}

export interface DemoCalendar {
  id: string;
  name: string;
  weekendDays: number[];
  isDefault: boolean;
  createdAt: string;
  exceptions: { id: string; date: string; isWorking: boolean; name: string }[];
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
  }

  /** Every table, for reset and wide transactions. */
  get allTables() {
    return this.tables;
  }
}
