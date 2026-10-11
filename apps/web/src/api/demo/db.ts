import Dexie, { type Table } from 'dexie';
import type { Role, UserPreferences, UserStatus } from '@nuzli/shared';

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

export class DemoDb extends Dexie {
  users!: Table<DemoUser, string>;
  notifications!: Table<DemoNotification, string>;
  audit!: Table<DemoAudit, string>;
  sessions!: Table<DemoSession, string>;
  kv!: Table<KeyValue, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      users: 'id, &email, &mobile, &nationalId, role, status, createdAt',
      notifications: 'id, userId, createdAt',
      audit: 'id, at, action, entityType, actorId',
      sessions: 'token, userId',
      kv: 'key',
    });
  }
}
