import { z } from 'zod';
import type { Permission } from './permissions';

/**
 * A12 round 2 — assistants (مساعد) and project participants (مشارك).
 *
 * An ASSISTANT membership carries `permissions` = one level per module ('none' | 'view' | 'edit')
 * and an optional `scope` = { projectIds?, teamIds? } that limits what they see and act on inside
 * those modules. Each module level maps to the fine-grained permissions of the matrix
 * (`ASSISTANT_MODULE_GRANTS`); the API adds them to the request as `grants` and applies the scope
 * to the data. The web reads the same tables to build the admin's checkbox grid.
 */

export const ASSISTANT_MODULES = [
  'projects',
  'tasks',
  'budget',
  'teams',
  'members',
  'formation',
  'cards',
  'cardTemplates',
  'violations',
  'violationStats',
  'reference',
  'calendars',
  'org',
  'users',
  'registrations',
  'reports',
  'audit',
  'settings',
] as const;
export type AssistantModule = (typeof ASSISTANT_MODULES)[number];

export const ASSISTANT_LEVELS = ['none', 'view', 'edit'] as const;
export type AssistantLevel = (typeof ASSISTANT_LEVELS)[number];

/** Arabic labels for the admin's grid (module → label). */
export const ASSISTANT_MODULE_LABELS: Record<AssistantModule, string> = {
  projects: 'المشاريع',
  tasks: 'المهام',
  budget: 'الميزانية والتكاليف',
  teams: 'الفرق',
  members: 'الأعضاء (العمّال)',
  formation: 'تشكيل الفرق (نقل الأعضاء)',
  cards: 'طباعة البطاقات',
  cardTemplates: 'قوالب البطاقات والشعارات',
  violations: 'المخالفات',
  violationStats: 'إحصاءات المخالفات وتصديرها',
  reference: 'البيانات المرجعية والألوان',
  calendars: 'التقاويم',
  org: 'الهيكل التنظيمي',
  users: 'المستخدمون',
  registrations: 'طلبات التسجيل وطلبات العمّال',
  reports: 'التقارير',
  audit: 'سجل التدقيق',
  settings: 'الإعدادات',
};

export const ASSISTANT_LEVEL_LABELS: Record<AssistantLevel, string> = { none: 'لا شيء', view: 'اطّلاع', edit: 'تعديل' };

/** Modules that can only be viewed by an assistant (owner rule: users view only; audit and settings view). */
export const VIEW_ONLY_MODULES: ReadonlySet<AssistantModule> = new Set<AssistantModule>(['users', 'audit', 'settings']);

/**
 * Module level → the matrix permissions it grants. `edit` always includes `view`.
 * Notes (docs/a12-roles.md):
 *  - `tasks` reading needs the projects that hold them, so tasks:view also opens project reading;
 *  - budget figures are hidden from anyone without `budget.read` (participants included);
 *  - `registrations:edit` = decide registrations AND supervisors' worker add/remove requests;
 *  - `settings:view` is the GET everyone in the workspace already has (nothing extra);
 *  - full national IDs (`nationalIds.readFull`) and the ID-card photo stay with admins and owners.
 */
export const ASSISTANT_MODULE_GRANTS: Record<AssistantModule, { view: readonly Permission[]; edit: readonly Permission[] }> = {
  projects: { view: ['projects.readAll'], edit: ['projects.readAll', 'projects.create', 'projects.manage'] },
  tasks: { view: ['projects.readAll'], edit: ['projects.readAll', 'tasks.manage', 'tasks.comment', 'tasks.updateAssigned'] },
  budget: { view: ['budget.read'], edit: ['budget.read', 'budget.manage'] },
  teams: { view: ['teams.readAll'], edit: ['teams.readAll', 'teams.create', 'teams.approve', 'teams.manageAll'] },
  members: { view: ['teams.readAll'], edit: ['teams.readAll', 'members.manage', 'members.import'] },
  formation: { view: ['teams.readAll'], edit: ['teams.readAll', 'members.move'] },
  cards: { view: ['cards.read'], edit: ['cards.read', 'cards.print'] },
  cardTemplates: { view: ['cards.read'], edit: ['cards.read', 'cards.manageTemplates', 'logos.manage'] },
  violations: { view: ['violations.readAll'], edit: ['violations.readAll', 'violations.manage', 'violations.respond'] },
  violationStats: { view: ['violations.stats'], edit: ['violations.stats', 'violations.export'] },
  reference: { view: [], edit: ['reference.manage', 'colors.manage'] },
  calendars: { view: ['calendars.read'], edit: ['calendars.read', 'calendars.manage'] },
  org: { view: ['org.read'], edit: ['org.read', 'org.manage'] },
  users: { view: ['users.read'], edit: ['users.read'] },
  registrations: { view: ['registrations.read'], edit: ['registrations.read', 'registrations.review'] },
  reports: { view: ['reports.read'], edit: ['reports.read'] },
  audit: { view: ['audit.read'], edit: ['audit.read'] },
  settings: { view: [], edit: [] },
};

export type AssistantPermissions = Partial<Record<AssistantModule, AssistantLevel>>;

export const assistantPermissionsSchema = z
  .record(z.enum(ASSISTANT_MODULES), z.enum(ASSISTANT_LEVELS))
  .superRefine((v, ctx) => {
    for (const [m, level] of Object.entries(v)) {
      if (level === 'edit' && VIEW_ONLY_MODULES.has(m as AssistantModule)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [m], message: 'هذه الوحدة للاطّلاع فقط' });
      }
    }
  });

export interface AssistantScope {
  /** Only these projects (and their tasks); absent = every project of the workspace. */
  projectIds?: string[];
  /** Only these teams (their members and violations); absent = every team of the workspace. */
  teamIds?: string[];
}

export const assistantScopeSchema = z
  .object({
    projectIds: z.array(z.string().uuid()).max(500).optional(),
    teamIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

/** The permissions an assistant's modules grant (deduplicated, stable order). */
export function assistantGrants(permissions: unknown): Permission[] {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return [];
  const out = new Set<Permission>();
  for (const m of ASSISTANT_MODULES) {
    const level = (permissions as Record<string, unknown>)[m];
    if (level !== 'view' && level !== 'edit') continue;
    const effective = level === 'edit' && VIEW_ONLY_MODULES.has(m) ? 'view' : level;
    for (const p of ASSISTANT_MODULE_GRANTS[m][effective]) out.add(p);
  }
  return [...out];
}

/** A parsed scope; `null` lists mean "no limit". */
export function assistantScopeOf(scope: unknown): { projectIds: string[] | null; teamIds: string[] | null } {
  const parsed = assistantScopeSchema.safeParse(scope ?? {});
  if (!parsed.success) return { projectIds: [], teamIds: [] }; // unreadable scope → fail closed
  return { projectIds: parsed.data.projectIds ?? null, teamIds: parsed.data.teamIds ?? null };
}

// ───────────────────────────────────────────── project participants (المشاركون)

/**
 * Intermediate rights on ONE project (owner A12, standard names):
 *  - EDITOR (محرّر): edits the project's tasks — not its settings, budget or participants;
 *  - CONTRIBUTOR (مساهم): sees the tasks, changes status/progress, comments and replies, checklist,
 *    attachments, time log;
 *  - VIEWER (مطّلع): read only, no comments.
 */
export const ParticipantLevel = { EDITOR: 'EDITOR', CONTRIBUTOR: 'CONTRIBUTOR', VIEWER: 'VIEWER' } as const;
export type ParticipantLevel = (typeof ParticipantLevel)[keyof typeof ParticipantLevel];
export const PARTICIPANT_LEVELS = Object.values(ParticipantLevel);

export const PARTICIPANT_LEVEL_LABELS: Record<ParticipantLevel, string> = {
  EDITOR: 'محرّر',
  CONTRIBUTOR: 'مساهم',
  VIEWER: 'مطّلع',
};

/** Permissions a level grants for requests about THAT project (the API binds them per request). */
export const PARTICIPANT_GRANTS: Record<ParticipantLevel, readonly Permission[]> = {
  VIEWER: ['projects.readGranted'],
  CONTRIBUTOR: ['projects.readGranted', 'tasks.comment', 'tasks.updateAssigned'],
  EDITOR: ['projects.readGranted', 'tasks.comment', 'tasks.updateAssigned', 'tasks.manage'],
};

/** Stronger first (for a user who is a participant through several grants). */
export const PARTICIPANT_RANK: Record<ParticipantLevel, number> = { VIEWER: 1, CONTRIBUTOR: 2, EDITOR: 3 };
