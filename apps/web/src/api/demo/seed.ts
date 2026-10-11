import {
  DEFAULT_PREFERENCES,
  cardTemplateConfigSchema,
  type CardLayoutKey,
  type CardOrientation,
  type MemberStatus,
  type Role,
  type TeamStatus,
  type UserStatus,
  type VisibilityMode,
} from '@nuzli/shared';
// Demo data lives at the repository root (seed/demo), clearly marked and replaceable.
import usersSeed from '../../../../../seed/demo/users.json';
import notificationsSeed from '../../../../../seed/demo/notifications.json';
import auditSeed from '../../../../../seed/demo/audit.json';
import colorsSeed from '../../../../../seed/demo/colors.json';
import teamsSeed from '../../../../../seed/demo/teams.json';
import membersSeed from '../../../../../seed/demo/members.json';
import referenceSeed from '../../../../../seed/demo/reference.json';
import cardsSeed from '../../../../../seed/demo/cards.json';
import type {
  DemoAudit,
  DemoCardSize,
  DemoColor,
  DemoLogo,
  DemoMember,
  DemoMembership,
  DemoNotification,
  DemoReference,
  DemoSupervisorHistory,
  DemoTeam,
  DemoTemplate,
  DemoUser,
} from './db';

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

export interface Phase2Seed {
  colors: DemoColor[];
  teams: DemoTeam[];
  supervisorHistory: DemoSupervisorHistory[];
  members: DemoMember[];
  memberships: DemoMembership[];
  reference: DemoReference[];
  cardSizes: DemoCardSize[];
  cardTemplates: DemoTemplate[];
  logos: DemoLogo[];
}

/** Teams, members, palette, reference lists and card templates for the demo (seed/demo). */
export function loadPhase2Seed(): Phase2Seed {
  return {
    colors: colorsSeed.colors.map((c) => ({ ...c })),
    teams: teamsSeed.teams.map((t) => ({
      id: t.id,
      name: t.name,
      colorId: t.colorId,
      supervisorId: t.supervisorId,
      status: t.status as TeamStatus,
      createdAt: t.createdAt,
      createdById: t.createdById,
      violationVisibility: t.violationVisibility as VisibilityMode,
      archivedAt: t.archivedAt,
      archiveReason: t.archiveReason,
    })),
    supervisorHistory: teamsSeed.supervisorHistory.map((h) => ({ ...h })),
    members: membersSeed.members.map((m) => ({ ...m, status: m.status as MemberStatus })),
    memberships: membersSeed.memberships.map((m) => ({ ...m })),
    reference: [
      ...referenceSeed.departments.map((d) => ({ ...d, kind: 'departments' as const })),
      ...referenceSeed.jobTitles.map((d) => ({ ...d, kind: 'job-titles' as const })),
    ],
    cardSizes: cardsSeed.sizes.map((s) => ({ ...s })),
    cardTemplates: cardsSeed.templates.map((tpl) => ({
      id: tpl.id,
      name: tpl.name,
      sizeId: tpl.sizeId,
      orientation: tpl.orientation as CardOrientation,
      layoutKey: tpl.layoutKey as CardLayoutKey,
      config: cardTemplateConfigSchema.parse(tpl.config),
      isDefault: tpl.isDefault,
      logoId: tpl.logoId,
      archived: tpl.archived,
    })),
    logos: cardsSeed.logos.map((l) => ({ ...l })),
  };
}
