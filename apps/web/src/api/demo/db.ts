import Dexie, { type Table } from 'dexie';
import type {
  CardData,
  CardLayoutKey,
  CardOrientation,
  CardTemplateConfig,
  MemberStatus,
  PrintBatchItemDto,
  Role,
  TeamStatus,
  UserPreferences,
  UserStatus,
  VisibilityMode,
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
  }

  /** Every table, for reset and wide transactions. */
  get allTables() {
    return this.tables;
  }
}
