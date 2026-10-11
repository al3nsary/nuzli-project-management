import { DEFAULT_PREFERENCES, type Role, type UserStatus } from '@nuzli/shared';
// Demo data lives at the repository root (seed/demo), clearly marked and replaceable.
import usersSeed from '../../../../../seed/demo/users.json';
import notificationsSeed from '../../../../../seed/demo/notifications.json';
import auditSeed from '../../../../../seed/demo/audit.json';
import type { DemoAudit, DemoNotification, DemoUser } from './db';

export interface SeedData {
  users: Omit<DemoUser, 'passwordHash'>[];
  notifications: DemoNotification[];
  audit: DemoAudit[];
}

export function loadSeed(): SeedData {
  return {
    users: usersSeed.users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      mobile: u.mobile,
      nationalId: u.nationalId,
      role: u.role as Role,
      requestedRole: (u.requestedRole as Role | null) ?? null,
      requestedTeamName: u.requestedTeamName ?? null,
      status: u.status as UserStatus,
      rejectionReason: u.rejectionReason ?? null,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: null,
      createdAt: u.createdAt,
      preferences: { ...DEFAULT_PREFERENCES, emailNotifications: {} },
    })),
    notifications: notificationsSeed.notifications.map((n) => ({
      ...n,
      payload: n.payload as Record<string, unknown>,
    })),
    audit: auditSeed.audit.map((a) => ({ ...a })),
  };
}
