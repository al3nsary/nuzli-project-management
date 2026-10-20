import Dexie from 'dexie';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  ERRORS,
  PARTICIPANT_GRANTS,
  addOwnerSchema,
  addWorkspaceAdminSchema,
  addWorkspaceMemberSchema,
  allUsersQuery,
  approveRegistrationSchema,
  assistantGrants,
  assistantScopeOf,
  can,
  changePasswordSchema,
  changeRoleSchema,
  changeUsernameSchema,
  createAccountSchema,
  createWorkspaceSchema,
  effectiveRole,
  forgotPasswordSchema,
  loginSchema,
  maskNationalId,
  normalizeSaudiMobile,
  registerSchema,
  rejectRegistrationSchema,
  renameWorkspaceSchema,
  resetPasswordSchema,
  setUserPasswordSchema,
  suspendUserSchema,
  isFullNationalIdTerm,
  toWesternDigits,
  updateMembershipSchema,
  updateProfileSchema,
  updateUserSchema,
  userSearchSchema,
  updateSettingsSchema,
  type AssistantPermissions,
  type AuditEntryDto,
  type AuthSession,
  type NotificationDto,
  type OwnerDto,
  type ParticipantLevel,
  type Permission,
  type Role,
  type Settings,
  type UserDto,
  type UserRoleEntryDto,
  type WorkspaceAdminDto,
  type WorkspaceMemberDto,
  type WorkspaceRole,
  type WorkspaceSummaryDto,
} from '@nuzli/shared';
import type { ApiClient, DemoAccount, DemoControls, SessionListener, UserListQuery } from '../client';
import { riyadhDay } from '../../i18n/format';
import {
  DemoDb,
  type DemoAudit,
  type DemoFile,
  type DemoUser,
  type DemoWorkspace,
  type DemoWsMembership,
} from './db';
import { loadPhase2Seed, loadPhase3Seed, loadSeed } from './seed';
import { createPhase2, type Phase2Api, type Phase2Hooks } from './phase2';
import { createPhase3, type Phase3Api } from './phase3';
import { createPhase4, type Phase4Api, type Phase4Hooks } from './phase4';
import { createA9, type A9Api } from './phaseA9';
import { seedA9 } from './seedA9';
import { createPhotos, type PhotoHooks } from './photos';
import { seedPhotos } from './seedPhotos';
import { buildProjectSeed } from './seedProjects';
import { seedViolations } from './seedViolations';
import { seedA9Teams } from './seedA9Teams';
import demoVersion from '../../../../../seed/demo/version.json';
import { ScopeHolder, scopingMiddleware, tagTransaction, type ScopeContext } from './scoping';
import type { Actor, ActorOptions, ProjectCtx } from './access';
import { A12_SEED, DEFAULT_WORKSPACE_ID, createA12Roles, seedA12Business, seedA12Identity, seedWorkspaceDefaults, type A12RolesApi } from './a12';

/**
 * Owner request A10 (ADR-128): the bundled demo-data version (seed/demo/version.json). A browser that
 * stored an older version (or none, from before A10) is reset to the new seed on first use, so a
 * returning visitor sees every new feature; the shell then shows «حُدِّثت بيانات العرض…».
 */
export const DEMO_DATA_VERSION: number = demoVersion.version;
const VERSION_KEY = 'demoDataVersion';
import { createOrg } from './org';
import { createImports, type ImportsApi } from './imports';
import type { OcrRunner } from './ocrRunner';
import { browserOcrEngine, type OcrEngine } from '../../features/violations/ocr/engine';
import { fail, hashPassword, newId, paginate, rejectFullIdInUrl, validate } from './util';
import { DEMO_DB_NAME, DEMO_EXPIRES_IN, DEMO_PASSWORD } from './constants';

const LOGIN_FREE_FAILURES = 5;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 5;

const byCreatedDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

const BYPASS: ScopeContext = { wid: null, bypass: true };

/** A username from an e-mail local part (the server's rule, ADR-146); not de-duplicated. */
export function usernameBase(email: string): string {
  let base = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!/^[a-z]/.test(base)) base = `u${base}`;
  base = base.slice(0, 28);
  if (base.length < 3) base = base.padEnd(3, '0');
  return base;
}

/**
 * In-browser implementation of the API for the GitHub Pages demo (ADR-020).
 * It enforces the same rules as the real API: the shared zod schemas, the `can()` matrix,
 * pending accounts cannot log in, uniqueness of email/mobile/national ID/username, last-admin
 * and last-owner protection, audit entries and notifications.
 *
 * A12 (ADR-153): workspaces (أقسام) are isolated exactly like the server — every business row
 * carries its workspace and ONE scoping layer (scoping.ts) filters every read and write by the
 * session's workspace, failing closed without one. Identity (accounts, sessions, workspaces,
 * memberships) is global.
 */
export class DemoApi implements ApiClient {
  readonly mode = 'demo' as const;
  readonly db: DemoDb;
  readonly demo: DemoControls;
  /** A12: the session's workspace and the membership copy the scoping layer reads. */
  readonly scope = new ScopeHolder();
  private token: string | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<SessionListener>();
  /** ADR-062: per-identifier delays, in memory like the API's LoginThrottleService. */
  private loginBuckets = new Map<string, { failures: number; until: number }>();
  /** A12: workspaces by id (refreshed with the memberships). */
  private workspaceRows = new Map<string, DemoWorkspace>();
  /** A12: raw account rows of owners (refreshed with the memberships). */
  private ownerIds = new Set<string>();

  colors!: Phase2Api['colors'];
  /** @internal A12 round 2: the members code reused by the worker requests. */
  phase2Hooks!: Phase2Hooks;
  teams!: Phase2Api['teams'];
  members!: Phase2Api['members'];
  reference!: Phase2Api['reference'];
  cards!: Phase2Api['cards'];
  logos!: Phase2Api['logos'];
  files!: Phase3Api['files'];
  violationTypes!: Phase3Api['violationTypes'];
  violations!: Phase3Api['violations'];
  /** @internal A9: the in-browser ID-card reading queue (tests: `await api.ocrRunner.idle()`). */
  ocrRunner!: OcrRunner;
  /** A9 (ADR-102). */
  org: ApiClient['org'];
  /**
   * A9 (ADR-104): the OCR engine — tesseract.js in the browser with self-hosted data. Tests
   * replace it with a fake that returns text.
   */
  ocrEngine: () => Promise<OcrEngine> = () => browserOcrEngine();
  projects!: Phase4Api['projects'] & A12RolesApi['projectCover'];
  tasks!: Phase4Api['tasks'];
  dependencies!: Phase4Api['dependencies'];
  calendars!: Phase4Api['calendars'];
  labels!: A9Api['labels'];
  customFields!: A9Api['customFields'];
  timeEntries!: A9Api['timeEntries'];
  viewPrefs!: A9Api['viewPrefs'];
  portfolios!: A9Api['portfolios'];
  workload!: A9Api['workload'];
  hub!: A9Api['hub'];
  /** A9 imports (ADR-117): parsed in the browser with the API's rules. */
  imports!: ImportsApi;
  /** @internal Phase 4 hooks used by the files module and tests. */
  phase4!: Phase4Hooks;
  photos!: ApiClient['photos'];
  /** @internal Owner request A8 hooks (presign/confirm of personal photos, card photo URLs). */
  photoHooks!: PhotoHooks;
  participants!: ApiClient['participants'];
  memberRequests!: ApiClient['memberRequests'];
  /** @internal A12 round 2 hooks (cover uploads through the files module). */
  a12!: A12RolesApi;

  /**
   * The demo has no network, so offline is simulated for the "network-shaped" violation
   * endpoints: they fail with NETWORK_ERROR while the browser is offline or `network.offline`
   * is set (tests, docs/offline.md). Everything else keeps working from IndexedDB.
   */
  readonly network = { offline: false };

  constructor(opts: { dbName?: string } = {}) {
    this.db = new DemoDb(opts.dbName ?? DEMO_DB_NAME);
    this.db.use(scopingMiddleware(this.scope));
    Object.assign(this, createPhase2(this));
    let a9: A9Api | null = null;
    const p4 = createPhase4(this, { templates: () => a9!.templateHook });
    a9 = createA9(this, p4.core);
    this.phase4 = p4;
    Object.assign(this, createPhase3(this));
    this.a12 = createA12Roles(this);
    Object.assign(this, {
      projects: { ...p4.projects, ...a9.projectsA9, ...this.a12.projectCover },
      tasks: { ...p4.tasks, ...a9.tasksA9 },
      dependencies: p4.dependencies,
      calendars: p4.calendars,
      labels: a9.labels,
      customFields: a9.customFields,
      timeEntries: a9.timeEntries,
      viewPrefs: a9.viewPrefs,
      portfolios: a9.portfolios,
      workload: a9.workload,
      hub: a9.hub,
      participants: this.a12.participants,
      memberRequests: this.a12.memberRequests,
    });
    // A12 round 2: supervisors' worker add/remove become requests; money hidden without budget.read.
    this.a12.decorate();
    this.imports = createImports(this as never, p4.core);
    this.org = createOrg(this);
    this.photoHooks = createPhotos(this);
    this.photos = this.photoHooks.photos;
    const seed = loadSeed();
    const first = (role: Role) => seed.users.find((u) => u.role === role && u.status === 'ACTIVE');
    const byId = (id: string) => A12_SEED.users.find((u) => u.id === id);
    const owner = byId(A12_SEED.owners[0]!);
    const accounts: DemoAccount[] = [
      ...(owner ? [{ role: 'ADMIN' as Role, kind: 'OWNER' as const, identifier: owner.username, fullName: owner.fullName }] : []),
      ...(['ADMIN', 'SUPERVISOR', 'MONITOR'] as Role[])
        .map((role) => first(role))
        .filter((u): u is NonNullable<typeof u> => Boolean(u))
        .map((u) => ({ role: u.role, kind: u.role, identifier: u.email, fullName: u.fullName })),
      ...A12_SEED.memberships
        .filter((m) => m.role === 'ASSISTANT' || m.role === 'MEMBER')
        .map((m) => {
          const u = byId(m.userId)!;
          const level = A12_SEED.participants.find((p) => p.userId === m.userId)?.level;
          const kind = m.role === 'ASSISTANT' ? ('ASSISTANT' as const) : level === 'EDITOR' ? ('EDITOR' as const) : ('VIEWER' as const);
          return { role: 'MONITOR' as Role, kind, identifier: u.username, fullName: u.fullName };
        }),
    ];
    this.demo = {
      password: DEMO_PASSWORD,
      accounts,
      pendingExample: seed.users.find((u) => u.status === 'PENDING')?.email ?? '',
      reset: () => this.reset(),
      consumeUpgradeNotice: () => {
        const v = this.upgradedFrom !== null;
        this.upgradedFrom = null;
        return v;
      },
    };
  }

  // ------------------------------------------------------------------ plumbing

  private init(): Promise<void> {
    if (!this.ready) this.ready = this.seedIfEmpty();
    return this.ready;
  }

  /** Set when `init` replaced stale demo data (the version it found, 0 = none); read once by the shell. */
  private upgradedFrom: number | null = null;

  /** The stored demo-data version (0 when the browser was seeded before versions existed). */
  async storedDataVersion(): Promise<number> {
    const v = (await this.db.kv.get(VERSION_KEY))?.value;
    return typeof v === 'number' ? v : 0;
  }

  /** Every table emptied, across workspaces (demo data only: reset and upgrades). */
  private async wipe() {
    await this.unscoped(async () => {
      await Promise.all(this.db.tables.map((table) => table.clear()));
    });
    this.scope.setMemberships([]);
  }

  /** A10: wipes demo data seeded by an older bundle (it is demo data only — nothing to keep). */
  private async upgradeIfStale() {
    if (!(await this.db.kv.get('seeded'))) return; // a fresh browser: nothing to upgrade
    const stored = await this.storedDataVersion();
    if (stored >= DEMO_DATA_VERSION) return;
    await this.wipe();
    this.token = null;
    this.upgradedFrom = stored;
  }

  private async seedIfEmpty() {
    const saved = this.scope.current;
    try {
      await this.upgradeIfStale();
      await this.seedPhase1();
      await seedA12Identity(this);
      await this.reloadIdentity();
      // Every existing seed is the «إدارة المشاريع» workspace's data (like the server migration).
      this.scope.current = { wid: DEFAULT_WORKSPACE_ID };
      await this.seedPhase1Business();
      await this.seedPhase2();
      await this.seedPhase3();
      await this.seedPhase4();
      await seedA9(this.db);
      await seedA9Teams(this.db);
      await seedPhotos(this.db);
      await seedA12Business(this);
      await this.db.kv.put({ key: VERSION_KEY, value: DEMO_DATA_VERSION });
    } finally {
      this.scope.current = saved.wid || saved.bypass ? saved : { wid: null };
    }
  }

  /** @internal A8 hooks for the files module (phase3.ts). */
  beforePhotoPresign(input: Parameters<PhotoHooks['beforePresign']>[0], actor: DemoUser) {
    return this.photoHooks.beforePresign(input, actor);
  }

  /** @internal */
  afterPhotoConfirm(file: DemoFile, actor: DemoUser) {
    return this.photoHooks.afterConfirm(file, actor);
  }

  /** @internal Card previews and print runs (phase2.ts). */
  photoUrlFor(fileId: string | null | undefined) {
    return this.photoHooks.urlForFile(fileId);
  }

  /** @internal Phase 3 → Phase 4 hooks (task uploads). */
  beforeTaskPresign(input: { entityId?: string; kind?: string }, actor: DemoUser) {
    return this.phase4.beforeTaskPresign(input, actor);
  }

  /** @internal */
  afterTaskConfirm(file: DemoFile, actor: DemoUser) {
    return this.phase4.afterTaskConfirm(file, actor);
  }

  /** @internal A12 round 2: project cover uploads (presign/confirm through the files module). */
  beforeCoverPresign(input: { entityId?: string; contentType?: string; sizeBytes?: number }, actor: DemoUser) {
    return this.a12.beforeCoverPresign(input, actor);
  }

  /** @internal */
  afterCoverConfirm(file: DemoFile, actor: DemoUser) {
    return this.a12.afterCoverConfirm(file, actor);
  }

  /** Calendars (with clearly marked sample holidays) and three projects, one with 2,000 tasks. */
  private async seedPhase4() {
    if (await this.db.kv.get('seededPhase4')) return;
    const seed = buildProjectSeed(new Date());
    const db = this.db;
    await db.transaction('rw', db.tables, async () => {
      await db.calendars.bulkPut(seed.calendars);
      await db.projects.bulkPut(seed.projects);
      await db.tasks.bulkPut(seed.tasks);
      await db.dependencies.bulkPut(seed.dependencies);
      await db.projectAccess.bulkPut(seed.access);
      await db.kv.put({ key: 'seededPhase4', value: new Date().toISOString() });
    });
  }

  /** @internal */
  isOffline(): boolean {
    if (this.network.offline) return true;
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** Violation types and ~60 violations relative to now, snapshots from membership history. */
  private async seedPhase3() {
    if (await this.db.kv.get('seededPhase3')) return;
    const seed = loadPhase3Seed();
    const db = this.db;
    await db.transaction('rw', db.tables, async () => {
      await db.violationTypes.bulkPut(seed.types);
      const { violations, files } = seedViolations(seed.violations, {
        memberships: await db.memberships.toArray(),
        supervisorHistory: await db.supervisorHistory.toArray(),
        now: new Date(),
      });
      await db.violations.bulkPut(violations);
      await db.files.bulkPut(files);
      await db.kv.put({ key: 'seededPhase3', value: new Date().toISOString() });
    });
  }

  /** Accounts (global). Their workspace rows (notifications, audit, settings) follow in seedPhase1Business. */
  private async seedPhase1() {
    const seeded = await this.db.kv.get('seeded');
    if (seeded) return;
    const seed = loadSeed();
    const hash = await hashPassword(DEMO_PASSWORD);
    await this.unscoped(async () => {
      await this.db.users.bulkPut(
        seed.users.map((u) => ({
          ...u,
          passwordHash: hash,
          username: usernameBase(u.email),
          accountRole: 'USER' as const,
          requestedWorkspaceId: u.status === 'PENDING' || u.status === 'REJECTED' ? DEFAULT_WORKSPACE_ID : null,
        })),
      );
      await this.db.kv.put({ key: 'seeded', value: new Date().toISOString() });
    });
  }

  private async seedPhase1Business() {
    if (await this.db.kv.get('seededPhase1Ws')) return;
    const seed = loadSeed();
    await this.db.transaction('rw', [this.db.notifications, this.db.audit, this.db.kv], async () => {
      await this.db.notifications.bulkPut(seed.notifications);
      await this.db.audit.bulkPut(seed.audit);
      await this.db.kv.put({ key: this.wsKey('settings'), value: { ...DEFAULT_SETTINGS } });
      await this.db.kv.put({ key: 'seededPhase1Ws', value: new Date().toISOString() });
    });
  }

  /** Teams, members, palette, reference lists and cards — also for browsers seeded in Phase 1. */
  private async seedPhase2() {
    if (await this.db.kv.get('seededPhase2')) return;
    const seed = loadPhase2Seed();
    const db = this.db;
    await db.transaction('rw', db.tables, async () => {
      await db.colors.bulkPut(seed.colors);
      await db.teams.bulkPut(seed.teams);
      await db.supervisorHistory.bulkPut(seed.supervisorHistory);
      // A9 (ADR-100): the same rows as leadership rows (each one the primary of its period).
      await db.teamSupervisors.bulkPut(
        seed.supervisorHistory.map((h) => ({
          id: h.id,
          teamId: h.teamId,
          userId: h.supervisorId,
          isPrimary: true,
          validFrom: h.validFrom,
          validTo: h.validTo,
          addedById: h.changedById,
          reason: h.reason,
        })),
      );
      await db.members.bulkPut(seed.members);
      await db.memberships.bulkPut(seed.memberships);
      await db.reference.bulkPut(seed.reference);
      await db.cardSizes.bulkPut(seed.cardSizes);
      await db.cardTemplates.bulkPut(seed.cardTemplates);
      await db.logos.bulkPut(seed.logos);
      await db.kv.put({ key: 'seededPhase2', value: new Date().toISOString() });
    });
  }

  async reset() {
    await this.wipe();
    this.token = null;
    this.scope.current = { wid: null };
    this.ready = null;
    await this.init();
    this.emit(null);
  }

  setAccessToken(token: string | null) {
    if (token !== this.token) this.scope.current = { wid: null };
    this.token = token;
  }

  onSessionChange(listener: SessionListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(session: AuthSession | null) {
    for (const l of this.listeners) l(session);
  }

  // ------------------------------------------------------------------ A12 scope plumbing

  /** @internal Identity/maintenance work in one bypass transaction (every table). */
  unscoped<T>(fn: () => Promise<T>, mode: 'r' | 'rw' = 'rw'): Promise<T> {
    const current = Dexie.currentTransaction as unknown as { idbtrans?: Record<string, unknown> } | null;
    if (current?.idbtrans) return this.retag(current.idbtrans, BYPASS, fn);
    return this.db.transaction(mode, this.db.tables, () => {
      tagTransaction(BYPASS);
      return fn();
    });
  }

  /** @internal Runs `fn` inside workspace `wid` (owner summaries, new workspaces, notifications there). */
  inWorkspace<T>(wid: string, fn: () => Promise<T>, mode: 'r' | 'rw' = 'rw'): Promise<T> {
    const current = Dexie.currentTransaction as unknown as { idbtrans?: Record<string, unknown> } | null;
    if (current?.idbtrans) return this.retag(current.idbtrans, { wid }, fn);
    return this.db.transaction(mode, this.db.tables, () => {
      tagTransaction({ wid });
      return fn();
    });
  }

  private async retag<T>(idb: Record<string, unknown>, ctx: ScopeContext, fn: () => Promise<T>): Promise<T> {
    const prev = idb.__nzScope;
    idb.__nzScope = ctx;
    try {
      return await fn();
    } finally {
      idb.__nzScope = prev;
    }
  }

  /** @internal A per-workspace key of the global key-value table (settings, reminder day). */
  wsKey(key: string, wid: string | null = this.scope.current.wid): string {
    if (!wid) fail('WORKSPACE_REQUIRED');
    return `${key}:${wid}`;
  }

  /** @internal Reloads memberships, workspaces and owners (the synchronous copies). */
  async reloadIdentity() {
    const [memberships, workspaces, owners] = await this.unscoped(
      async () =>
        [
          await this.db.wsMemberships.toArray(),
          await this.db.workspaces.toArray(),
          await this.db.users.filter((u) => u.accountRole === 'OWNER').toArray(),
        ] as const,
      'r',
    );
    this.scope.setMemberships(memberships);
    this.workspaceRows = new Map(workspaces.map((w) => [w.id, w]));
    this.ownerIds = new Set(owners.map((o) => o.id));
  }

  /** @internal Live memberships (any status) of a user, every workspace. */
  liveMemberships(userId: string): DemoWsMembership[] {
    return [...this.scope.memberships.values()].filter(
      (m) => m.userId === userId && !m.archivedAt,
    ) as DemoWsMembership[];
  }

  /** @internal Live memberships of a workspace. */
  workspaceMemberships(wid: string): DemoWsMembership[] {
    return [...this.scope.memberships.values()].filter(
      (m) => m.workspaceId === wid && !m.archivedAt,
    ) as DemoWsMembership[];
  }

  private activeWorkspaces(): DemoWorkspace[] {
    return [...this.workspaceRows.values()]
      .filter((w) => w.status === 'ACTIVE')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The workspaces a user may enter: owners every active one, others where a membership is ACTIVE. */
  private enterable(user: Pick<DemoUser, 'id' | 'accountRole'>): WorkspaceSummaryDto[] {
    const isOwner = user.accountRole === 'OWNER';
    return this.activeWorkspaces()
      .map((w) => {
        const roles = this.liveMemberships(user.id)
          .filter((m) => m.workspaceId === w.id && m.status === 'ACTIVE')
          .map((m) => m.role);
        return { w, roles };
      })
      .filter(({ roles }) => isOwner || roles.length > 0)
      .map(({ w, roles }) => ({ id: w.id, name: w.name, code: w.code, roles }));
  }

  /** 403 WORKSPACE_FORBIDDEN / WORKSPACE_ARCHIVED unless the user may enter `wid`. */
  private assertEnter(user: Pick<DemoUser, 'id' | 'accountRole'>, wid: string) {
    const w = this.workspaceRows.get(wid);
    const member = this.liveMemberships(user.id).some((m) => m.workspaceId === wid && m.status === 'ACTIVE');
    if (!w || (!member && user.accountRole !== 'OWNER')) fail('WORKSPACE_FORBIDDEN');
    if (w.status !== 'ACTIVE') fail('WORKSPACE_ARCHIVED');
  }

  /** @internal A raw account row (the users table outside any workspace view). */
  async rawUser(id: string): Promise<DemoUser | undefined> {
    return this.unscoped(() => this.db.users.get(id), 'r');
  }

  /** @internal Raw lookup by a unique column (uniqueness checks see every workspace). */
  async rawUserBy(field: 'email' | 'mobile' | 'nationalId' | 'username', value: string): Promise<DemoUser | undefined> {
    return this.unscoped(() => this.db.users.where(field).equals(value).first(), 'r');
  }

  /** @internal A free username from an e-mail (numeric suffix when taken). */
  async uniqueUsername(email: string): Promise<string> {
    const base = usernameBase(email);
    let candidate = base;
    for (let n = 2; await this.rawUserBy('username', candidate); n++) candidate = `${base.slice(0, 28)}${n}`;
    return candidate;
  }

  /**
   * @internal Gives a user a role in the current (or given) workspace — used when an admin creates
   * a supervisor inline with a team, and by registrations.
   */
  async grantRole(userId: string, role: WorkspaceRole, actorId: string | null, wid = this.scope.current.wid, title: string | null = null) {
    if (!wid) fail('WORKSPACE_REQUIRED');
    const row: DemoWsMembership = {
      id: newId(),
      workspaceId: wid,
      userId,
      role,
      title,
      permissions: {},
      scope: {},
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: actorId,
      archivedAt: null,
    };
    await this.unscoped(() => this.db.wsMemberships.add(row));
    return row;
  }

  /** The signed-in user as the API guard sees them in the active workspace (docs/a12-roles.md §6). */
  private async project(raw: DemoUser, wid: string | null, ctx?: ProjectCtx): Promise<Actor> {
    const isOwner = raw.accountRole === 'OWNER';
    const live = wid ? this.liveMemberships(raw.id).filter((m) => m.workspaceId === wid && m.status === 'ACTIVE') : [];
    const roles = live.map((m) => m.role);
    const strongest = effectiveRole(roles);
    const role = (isOwner ? (strongest ?? 'ADMIN') : strongest) as Role;
    const assistant = live.filter((m) => m.role === 'ASSISTANT');
    const merged: AssistantPermissions = {};
    for (const m of assistant) {
      for (const [mod, level] of Object.entries(m.permissions ?? {})) {
        const prev = merged[mod as keyof AssistantPermissions];
        if (!prev || prev === 'none' || (prev === 'view' && level === 'edit')) merged[mod as keyof AssistantPermissions] = level;
      }
    }
    const grants: string[] = assistantGrants(merged);
    const unlimited = isOwner || roles.includes('ADMIN');
    const limits = !unlimited && assistant.length ? assistantScopeOf(assistant[0]!.scope) : null;
    const parts: Record<string, ParticipantLevel> = {};
    let bound: string | null = null;
    if (wid) {
      const rows = await this.db.participants.where('userId').equals(raw.id).toArray();
      for (const p of rows) parts[p.projectId] = p.level;
      if (rows.length && !grants.includes('projects.readGranted')) grants.push('projects.readGranted');
      if (ctx) {
        bound = await this.projectOf(ctx);
        const level = bound ? parts[bound] : undefined;
        if (level) for (const g of PARTICIPANT_GRANTS[level]) if (!grants.includes(g)) grants.push(g);
      }
    }
    return {
      ...raw,
      role,
      status: 'ACTIVE',
      roles,
      grants,
      _wid: wid,
      _limits: limits,
      _parts: parts,
      _project: bound,
      _acct: { role: raw.role, status: raw.status },
      _view: { role, status: 'ACTIVE' },
    } as Actor;
  }

  /** The project behind a request (task, label, custom field, dependency, time entry). */
  private async projectOf(ctx: ProjectCtx): Promise<string | null> {
    if ('projectId' in ctx) return ctx.projectId;
    if ('taskId' in ctx) return (await this.db.tasks.get(ctx.taskId))?.projectId ?? null;
    if ('labelId' in ctx) return (await this.db.labels.get(ctx.labelId))?.projectId ?? null;
    if ('fieldId' in ctx) return (await this.db.customFields.get(ctx.fieldId))?.projectId ?? null;
    if ('dependencyId' in ctx) return (await this.db.dependencies.get(ctx.dependencyId))?.projectId ?? null;
    const entry = await this.db.timeEntries.get(ctx.timeEntryId);
    return entry ? ((await this.db.tasks.get(entry.taskId))?.projectId ?? null) : null;
  }

  /**
   * @internal The signed-in, active user (also used by every module), resolved like the API guard:
   * the session's workspace is checked against live memberships (owners: any active workspace) and
   * becomes the scope of every following read and write. Without a workspace only
   * `optionalWorkspace` calls proceed (403 WORKSPACE_REQUIRED otherwise).
   */
  async actor(permission?: Permission, opts: ActorOptions = {}): Promise<Actor> {
    await this.init();
    if (!this.token) fail('UNAUTHENTICATED');
    const inTransaction = Boolean(Dexie.currentTransaction);
    if (!inTransaction) await this.reloadIdentity();
    const token = this.token;
    const { session, raw } = await this.unscoped(async () => {
      const s = await this.db.sessions.get(token);
      return { session: s, raw: s ? await this.db.users.get(s.userId) : undefined };
    }, 'r');
    if (!session || !raw || raw.status !== 'ACTIVE') fail('UNAUTHENTICATED');
    let wid = session.workspaceId ?? null;
    if (wid) {
      this.assertEnter(raw, wid);
    } else {
      const list = this.enterable(raw);
      if (list.length === 1) {
        wid = list[0]!.id;
        await this.unscoped(() => this.db.sessions.update(token, { workspaceId: wid }));
      }
    }
    this.scope.current = { wid };
    if (!wid && !opts.optionalWorkspace) fail('WORKSPACE_REQUIRED');
    const user = await this.project(raw, wid, opts.project);
    if (permission) {
      if (user.mustChangePassword) fail('PASSWORD_CHANGE_REQUIRED');
      if (!can(user, permission)) fail('FORBIDDEN');
    }
    return user;
  }

  /** @internal Owners only (403 FORBIDDEN); works before a workspace is chosen. */
  async ownerActor(): Promise<Actor> {
    const user = await this.actor(undefined, { optionalWorkspace: true });
    if (user.mustChangePassword) fail('PASSWORD_CHANGE_REQUIRED');
    if (user.accountRole !== 'OWNER') fail('FORBIDDEN');
    return user;
  }

  // ------------------------------------------------------------------ users (DTOs)

  /** @internal The A12 user DTO: role/status/workspaceRoles of `wid`, the dual-role badge, every role. */
  toUserDto(
    u: DemoUser,
    opts: { full?: boolean; wid?: string | null; viewerIsOwner?: boolean; self?: boolean; grants?: string[] } = {},
  ): UserDto {
    const wid = opts.wid !== undefined ? opts.wid : this.scope.current.wid;
    const acct = (u as { _acct?: { role: Role; status: DemoUser['status'] } })._acct;
    const status = acct?.status ?? u.status;
    const storedRole = acct?.role ?? u.role;
    const live = this.liveMemberships(u.id);
    const here = wid ? live.filter((m) => m.workspaceId === wid) : [];
    const activeHere = here.filter((m) => m.status === 'ACTIVE').map((m) => m.role);
    const isOwner = u.accountRole === 'OWNER';
    const registration = status === 'PENDING' || status === 'REJECTED';
    const role: Role = isOwner
      ? 'ADMIN'
      : (effectiveRole(activeHere) ?? (registration ? (u.requestedRole ?? storedRole) : null) ?? 'MONITOR');
    let shownStatus = status;
    if (status === 'ACTIVE' && here.length && here.every((m) => m.status === 'SUSPENDED')) shownStatus = 'SUSPENDED';
    const allRoles: UserRoleEntryDto[] = live.map((m) => {
      const visible = Boolean(opts.viewerIsOwner) || m.workspaceId === wid;
      return {
        workspaceId: visible ? m.workspaceId : null,
        workspaceName: visible ? (this.workspaceRows.get(m.workspaceId)?.name ?? null) : null,
        role: m.role,
        title: visible ? m.title : null,
        status: m.status,
      };
    });
    const dto: UserDto = {
      id: u.id,
      username: u.username ?? usernameBase(u.email),
      accountRole: u.accountRole ?? 'USER',
      fullName: u.fullName,
      email: u.email,
      mobile: u.mobile,
      nationalIdMasked: maskNationalId(u.nationalId),
      ...(opts.full ? { nationalId: u.nationalId } : {}),
      role,
      workspaceRoles: activeHere,
      requestedRole: u.requestedRole,
      requestedTeamName: u.requestedTeamName,
      status: shownStatus,
      rejectionReason: u.rejectionReason,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      preferences: u.preferences,
      photoFileId: u.photoFileId ?? null,
      hasPhoto: Boolean(u.photoFileId),
      dualRole: live.length > 1,
      allRoles,
    };
    if (opts.self) dto.grants = opts.grants ?? [];
    return dto;
  }

  /** Kept for the older call sites (the caller's workspace view). */
  private toDto(u: DemoUser, opts: { full?: boolean } = {}): UserDto {
    return this.toUserDto(u, { full: opts.full });
  }

  private async getUser(id: string): Promise<DemoUser> {
    const u = await this.rawUser(id);
    if (!u) fail('NOT_FOUND');
    return u;
  }

  /** A user of the active workspace (live membership or a registration to it); 404 otherwise. */
  private async workspaceUser(id: string, viewer: Actor): Promise<DemoUser> {
    const u = await this.rawUser(id);
    if (!u) fail('NOT_FOUND');
    if (viewer.accountRole === 'OWNER') return u;
    if (!this.inWorkspaceList(u, viewer._wid ?? null)) fail('NOT_FOUND');
    return u;
  }

  private inWorkspaceList(u: DemoUser, wid: string | null): boolean {
    if (!wid) return false;
    if (this.liveMemberships(u.id).some((m) => m.workspaceId === wid)) return true;
    return (u.status === 'PENDING' || u.status === 'REJECTED') && u.requestedWorkspaceId === wid;
  }

  private async assertUnique(input: { email: string; mobile: string; nationalId: string; username?: string }, exceptId?: string) {
    const taken = async (field: 'email' | 'mobile' | 'nationalId' | 'username', value: string | undefined) => {
      if (!value) return false;
      const hit = await this.rawUserBy(field, value);
      return Boolean(hit && hit.id !== exceptId);
    };
    if (await taken('username', input.username)) fail('USERNAME_TAKEN', { fieldErrors: { username: [ERRORS.USERNAME_TAKEN] } });
    if (await taken('email', input.email)) fail('EMAIL_TAKEN');
    if (await taken('mobile', input.mobile)) fail('MOBILE_TAKEN');
    if (await taken('nationalId', input.nationalId)) fail('NATIONAL_ID_TAKEN');
  }

  /** @internal */
  writeAudit(entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>) {
    return this.db.audit.add({ ...entry, id: newId(), at: new Date().toISOString(), ip: null });
  }

  /** @internal An audit row in a given workspace (null = account level), from identity code. */
  writeAuditIn(wid: string | null, entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>) {
    return this.unscoped(() =>
      this.db.audit.add({ ...entry, id: newId(), at: new Date().toISOString(), ip: null, wid } as DemoAudit),
    );
  }

  /** @internal */
  notify(userId: string, type: string, payload: Record<string, unknown>) {
    return this.db.notifications.add({
      id: newId(),
      userId,
      type,
      payload,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  /** @internal A notification inside a given workspace (identity code). */
  notifyIn(wid: string, userId: string, type: string, payload: Record<string, unknown>) {
    return this.unscoped(() =>
      this.db.notifications.add({
        id: newId(),
        userId,
        type,
        payload,
        readAt: null,
        createdAt: new Date().toISOString(),
        wid,
      } as never),
    );
  }

  /** @internal The workspace's approvers: its admins, owners, and assistants with `registrations:edit`. */
  approversOf(wid: string, permission: Permission = 'registrations.review'): string[] {
    const out = new Set<string>(this.ownerIds);
    for (const m of this.workspaceMemberships(wid)) {
      if (m.status !== 'ACTIVE') continue;
      if (m.role === 'ADMIN') out.add(m.userId);
      if (m.role === 'ASSISTANT' && assistantGrants(m.permissions).includes(permission)) out.add(m.userId);
    }
    return [...out];
  }

  /** LAST_ADMIN when the change leaves `wid` without an active admin (ADR-009, per workspace). */
  private guardLastAdmin(wid: string, leaving: DemoWsMembership[]) {
    const ids = new Set(leaving.map((m) => m.id));
    if (!leaving.some((m) => m.role === 'ADMIN' && m.status === 'ACTIVE')) return;
    const remaining = this.workspaceMemberships(wid).filter(
      (m) => m.role === 'ADMIN' && m.status === 'ACTIVE' && !ids.has(m.id),
    );
    if (!remaining.length) fail('LAST_ADMIN');
  }

  private session(user: DemoUser, wid: string | null, grants?: string[]): AuthSession {
    if (!this.token) fail('UNAUTHENTICATED');
    const workspaces = this.enterable(user);
    const active = wid ? (workspaces.find((w) => w.id === wid) ?? null) : null;
    return {
      accessToken: this.token,
      expiresIn: DEMO_EXPIRES_IN,
      user: this.toUserDto(user, { wid, self: true, viewerIsOwner: user.accountRole === 'OWNER', grants }),
      workspaces,
      activeWorkspace: active,
      singleWorkspace: this.activeWorkspaces().length <= 1,
    };
  }

  /** The session for the current token, with the A12 workspace fields and the caller's grants. */
  private async sessionFor(raw: DemoUser, wid: string | null): Promise<AuthSession> {
    this.scope.current = { wid };
    const projected = wid ? await this.project(raw, wid) : null;
    return this.session(raw, wid, projected?.grants?.filter((g) => g !== 'projects.readGranted') ?? []);
  }

  /** Owners of an e-mail, mobile or national ID already registered (ADR-063). */
  private async duplicateOwners(input: { email: string; mobile: string; nationalId: string; username?: string }) {
    const hits = await Promise.all([
      this.rawUserBy('email', input.email),
      this.rawUserBy('mobile', input.mobile),
      this.rawUserBy('nationalId', input.nationalId),
    ]);
    return [...new Set(hits.filter((u): u is DemoUser => Boolean(u)).map((u) => u.id))];
  }

  /** 5 free failures per identifier, then 1 s doubling up to 60 s; 10 on an account lock it 5 min. */
  private async recordLoginFailure(key: string, user: DemoUser | undefined) {
    const b = this.loginBuckets.get(key) ?? { failures: 0, until: 0 };
    b.failures += 1;
    if (b.failures > LOGIN_FREE_FAILURES) {
      b.until = Date.now() + Math.min(60, 2 ** (b.failures - LOGIN_FREE_FAILURES - 1)) * 1000;
    }
    this.loginBuckets.set(key, b);
    if (!user) return;
    const failedLogins = (user.failedLogins ?? 0) + 1;
    if (failedLogins >= LOGIN_MAX_FAILURES) {
      const lockedUntil = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000).toISOString();
      await this.unscoped(() => this.db.users.update(user.id, { failedLogins: 0, lockedUntil }));
      // Account level (no workspace), like the API.
      await this.writeAuditIn(null, {
        actorId: null,
        action: 'auth.account_locked',
        entityType: 'user',
        entityId: user.id,
        before: null,
        after: { minutes: LOGIN_LOCK_MINUTES },
      });
    } else {
      await this.unscoped(() => this.db.users.update(user.id, { failedLogins }));
    }
  }

  /** A new session for the user, bound to `wid` (null = choose later). */
  private async openSession(user: DemoUser, wid: string | null): Promise<string> {
    const token = `demo.${newId()}`;
    const now = new Date().toISOString();
    await this.unscoped(async () => {
      await this.db.sessions.add({ token, userId: user.id, createdAt: now, workspaceId: wid });
      await this.db.kv.put({ key: 'currentToken', value: token });
    });
    this.token = token;
    return token;
  }

  // ------------------------------------------------------------------ auth

  auth: ApiClient['auth'] = {
    register: async (input) => {
      await this.init();
      await this.reloadIdentity();
      const data = validate(registerSchema, input);
      const active = this.activeWorkspaces();
      let wid = data.workspaceId ?? null;
      if (!wid) {
        if (active.length > 1) {
          fail('VALIDATION_FAILED', { fieldErrors: { workspaceId: ['اختر القسم الذي تتقدّم إليه'] } });
        }
        wid = active[0]?.id ?? null;
      }
      if (!wid || !active.some((w) => w.id === wid)) {
        fail('VALIDATION_FAILED', { fieldErrors: { workspaceId: ['اختر القسم الذي تتقدّم إليه'] } });
      }
      if (data.username && (await this.rawUserBy('username', data.username))) fail('USERNAME_TAKEN');
      const passwordHash = await hashPassword(data.password);
      const username = data.username ?? (await this.uniqueUsername(data.email));
      // ADR-063: duplicates create nothing and get the same answer; the attempt is audited.
      const owners = await this.duplicateOwners(data);
      if (owners.length) {
        for (const ownerId of owners) {
          await this.writeAuditIn(wid, {
            actorId: null,
            action: 'registration.duplicate_attempt',
            entityType: 'user',
            entityId: ownerId,
            before: null,
            after: null,
          });
        }
        return { status: 'PENDING' as const };
      }
      const user: DemoUser = {
        id: newId(),
        username,
        accountRole: 'USER',
        requestedWorkspaceId: wid,
        fullName: data.fullName,
        email: data.email,
        mobile: data.mobile,
        nationalId: data.nationalId,
        role: data.accountType,
        requestedRole: data.accountType,
        requestedTeamName: data.requestedTeamName ?? null,
        status: 'PENDING',
        rejectionReason: null,
        mustChangePassword: false,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        preferences: { ...DEFAULT_PREFERENCES, emailNotifications: {} },
        passwordHash,
      };
      await this.unscoped(() => this.db.users.add(user));
      await this.writeAuditIn(wid, {
        actorId: null,
        action: 'registration.requested',
        entityType: 'user',
        entityId: user.id,
        before: null,
        after: { status: 'PENDING', role: user.role },
      });
      for (const id of this.approversOf(wid)) {
        await this.notifyIn(wid, id, 'REGISTRATION_REQUESTED', {
          userId: user.id,
          fullName: user.fullName,
          requestedRole: user.role,
        });
      }
      return { status: 'PENDING' as const };
    },

    login: async (input) => {
      await this.init();
      await this.reloadIdentity();
      const data = validate(loginSchema, input);
      const identifier = toWesternDigits(data.identifier).trim();
      const mobile = identifier.includes('@') ? null : normalizeSaudiMobile(identifier);
      const key = identifier.includes('@') ? identifier.toLowerCase() : (mobile ?? identifier.toLowerCase());
      // ADR-062: while the identifier cools down, answer 429 before checking the password.
      const bucket = this.loginBuckets.get(key);
      const nowMs = Date.now();
      if (bucket && bucket.until > nowMs) {
        fail('RATE_LIMITED', { retryAfterSeconds: Math.ceil((bucket.until - nowMs) / 1000) });
      }
      // A12: username, e-mail or mobile.
      let user: DemoUser | undefined;
      if (identifier.includes('@')) user = await this.rawUserBy('email', identifier.toLowerCase());
      else if (mobile) user = await this.rawUserBy('mobile', mobile);
      if (!user) user = await this.rawUserBy('username', identifier.toLowerCase());
      const passwordOk = Boolean(user) && user!.passwordHash === (await hashPassword(data.password));
      // A locked account answers INVALID_CREDENTIALS even with the right password (no 423).
      const locked = Boolean(user?.lockedUntil && Date.parse(user.lockedUntil) > nowMs);
      if (!user || !passwordOk || locked) {
        await this.recordLoginFailure(key, user && !locked ? user : undefined);
        // Same answer for an unknown account, a wrong password and a locked one (no enumeration).
        fail('INVALID_CREDENTIALS');
      }
      this.loginBuckets.delete(key);
      const u = user;
      if (u.failedLogins) await this.unscoped(() => this.db.users.update(u.id, { failedLogins: 0, lockedUntil: null }));
      if (u.status === 'PENDING') fail('ACCOUNT_PENDING');
      if (u.status === 'REJECTED') fail('ACCOUNT_REJECTED');
      if (u.status === 'SUSPENDED') fail('ACCOUNT_SUSPENDED');
      const workspaces = this.enterable(u);
      const wid = workspaces.length === 1 ? workspaces[0]!.id : null;
      await this.openSession(u, wid);
      const now = new Date().toISOString();
      await this.unscoped(() => this.db.users.update(u.id, { lastLoginAt: now }));
      return this.sessionFor({ ...u, lastLoginAt: now }, wid);
    },

    refresh: async () => {
      await this.init();
      await this.reloadIdentity();
      const stored = (await this.db.kv.get('currentToken'))?.value;
      if (typeof stored !== 'string') return null;
      const { session, user } = await this.unscoped(async () => {
        const s = await this.db.sessions.get(stored);
        return { session: s, user: s ? await this.db.users.get(s.userId) : undefined };
      }, 'r');
      if (!session || !user || user.status !== 'ACTIVE') {
        await this.db.kv.delete('currentToken');
        this.token = null;
        this.scope.current = { wid: null };
        return null;
      }
      // Keeps the session's workspace; falls back to the only one when access to it was lost.
      let wid = session.workspaceId ?? null;
      const list = this.enterable(user);
      if (!wid || !list.some((w) => w.id === wid)) {
        wid = list.length === 1 ? list[0]!.id : null;
        await this.unscoped(() => this.db.sessions.update(stored, { workspaceId: wid }));
      }
      this.token = stored;
      return this.sessionFor(user, wid);
    },

    logout: async () => {
      await this.init();
      if (this.token) {
        const token = this.token;
        await this.unscoped(() => this.db.sessions.delete(token));
      }
      await this.db.kv.delete('currentToken');
      this.token = null;
      this.scope.current = { wid: null };
    },

    forgotPassword: async (input) => {
      validate(forgotPasswordSchema, input);
      // 204 always, like the real API (no account enumeration). The demo sends no email.
    },

    resetPassword: async (input) => {
      validate(resetPasswordSchema, input);
      // The demo never issues reset tokens, so any token is invalid here.
      fail('TOKEN_INVALID');
    },

    changePassword: async (input) => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      const data = validate(changePasswordSchema, input);
      if (user.passwordHash !== (await hashPassword(data.currentPassword))) {
        fail('VALIDATION_FAILED', {
          fieldErrors: { currentPassword: [ERRORS.INVALID_CREDENTIALS] },
        });
      }
      const passwordHash = await hashPassword(data.newPassword);
      await this.unscoped(() => this.db.users.update(user.id, { passwordHash, mustChangePassword: false }));
      await this.writeAuditIn(user._wid ?? null, {
        actorId: user.id,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: user.id,
        before: null,
        after: null,
      });
      const raw = (await this.rawUser(user.id))!;
      return this.sessionFor(raw, user._wid ?? null);
    },

    me: async () => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      const raw = (await this.rawUser(user.id))!;
      return this.toUserDto(raw, {
        wid: user._wid ?? null,
        self: true,
        viewerIsOwner: user.accountRole === 'OWNER',
        grants: (user.grants ?? []).filter((g) => g !== 'projects.readGranted'),
      });
    },

    switchWorkspace: async (workspaceId) => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId)) fail('WORKSPACE_FORBIDDEN');
      this.assertEnter(user, workspaceId);
      const old = this.token;
      if (old) await this.unscoped(() => this.db.sessions.delete(old));
      const raw = (await this.rawUser(user.id))!;
      await this.openSession(raw, workspaceId);
      // Audited in the TARGET workspace.
      await this.writeAuditIn(workspaceId, {
        actorId: user.id,
        action: 'auth.workspace_switched',
        entityType: 'workspace',
        entityId: workspaceId,
        before: { workspaceId: user._wid ?? null },
        after: { workspaceId },
      });
      return this.sessionFor(raw, workspaceId);
    },

    workspaces: async () => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      return this.enterable(user);
    },
  };

  system: ApiClient['system'] = {
    info: async () => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      const active = this.activeWorkspaces();
      return {
        workspaceCount: active.length,
        singleWorkspace: active.length <= 1,
        ...(user.accountRole === 'OWNER' ? { workspaces: active.map((w) => ({ id: w.id, name: w.name, code: w.code })) } : {}),
      };
    },
    publicWorkspaces: async () => {
      await this.init();
      await this.reloadIdentity();
      return this.activeWorkspaces().map((w) => ({ id: w.id, name: w.name }));
    },
  };

  me: ApiClient['me'] = {
    update: async (input) => {
      const user = await this.actor(undefined, { optionalWorkspace: true });
      if (!can(user, 'profile.update') && user.accountRole !== 'OWNER' && user._wid) fail('FORBIDDEN');
      const data = validate(updateProfileSchema, input);
      const raw = (await this.rawUser(user.id))!;
      const prefs = data.preferences ?? {};
      const next: DemoUser = {
        ...raw,
        fullName: data.fullName ?? raw.fullName,
        preferences: {
          ...raw.preferences,
          ...Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined)),
          emailNotifications: {
            ...raw.preferences.emailNotifications,
            ...(prefs.emailNotifications ?? {}),
          },
        },
      };
      await this.unscoped(() => this.db.users.put(next));
      return this.toUserDto(next, { wid: user._wid ?? null, self: true, grants: user.grants });
    },
    participations: async () => {
      const user = await this.actor();
      const rows = await this.db.participants.where('userId').equals(user.id).toArray();
      const out = [];
      for (const p of rows) {
        const project = await this.db.projects.get(p.projectId);
        if (!project || project.archivedAt) continue;
        out.push({ projectId: p.projectId, projectName: project.name, title: p.title, level: p.level });
      }
      return out;
    },
  };

  // ------------------------------------------------------------------ owners (A12 round 2)

  private ownerDto(u: DemoUser): OwnerDto {
    return {
      id: u.id,
      username: u.username ?? usernameBase(u.email),
      fullName: u.fullName,
      email: u.email,
      status: u.status,
      hasPhoto: Boolean(u.photoFileId),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  private async findAccount(input: { userId?: string; identifier?: string }): Promise<DemoUser> {
    if (input.userId) return this.getUser(input.userId);
    const id = toWesternDigits(input.identifier ?? '').trim();
    const mobile = id.includes('@') ? null : normalizeSaudiMobile(id);
    const hit =
      (id.includes('@') ? await this.rawUserBy('email', id.toLowerCase()) : undefined) ??
      (mobile ? await this.rawUserBy('mobile', mobile) : undefined) ??
      (/^\d{10}$/.test(id) ? await this.rawUserBy('nationalId', id) : undefined) ??
      (await this.rawUserBy('username', id.toLowerCase()));
    if (!hit) fail('NOT_FOUND');
    return hit;
  }

  owners: ApiClient['owners'] = {
    list: async () => {
      await this.ownerActor();
      const rows = await this.unscoped(() => this.db.users.filter((u) => u.accountRole === 'OWNER').toArray(), 'r');
      return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((u) => this.ownerDto(u));
    },
    add: async (input) => {
      const actor = await this.ownerActor();
      const data = validate(addOwnerSchema, input);
      let target: DemoUser;
      if ('username' in data) {
        await this.assertUnique({ ...data, username: data.username });
        const passwordHash = await hashPassword(data.password);
        target = {
          id: newId(),
          username: data.username,
          accountRole: 'OWNER',
          requestedWorkspaceId: null,
          fullName: data.fullName,
          email: data.email,
          mobile: data.mobile,
          nationalId: data.nationalId,
          role: 'ADMIN',
          requestedRole: null,
          requestedTeamName: null,
          status: 'ACTIVE',
          rejectionReason: null,
          mustChangePassword: data.mustChangePassword ?? true,
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
          preferences: { ...DEFAULT_PREFERENCES, emailNotifications: {} },
          passwordHash,
        };
        await this.unscoped(() => this.db.users.add(target));
      } else {
        target = await this.findAccount(data);
        if (target.status !== 'ACTIVE' || target.accountRole === 'OWNER') fail('INVALID_STATE');
        target = { ...target, accountRole: 'OWNER' };
        const id = target.id;
        await this.unscoped(() => this.db.users.update(id, { accountRole: 'OWNER' }));
      }
      await this.writeAuditIn(null, {
        actorId: actor.id,
        action: 'owner.added',
        entityType: 'user',
        entityId: target.id,
        before: null,
        after: { username: target.username, fullName: target.fullName },
      });
      await this.reloadIdentity();
      return this.ownerDto(target);
    },
    remove: async (userId) => {
      const actor = await this.ownerActor();
      const target = await this.getUser(userId);
      if (target.accountRole !== 'OWNER') fail('NOT_FOUND');
      const others = await this.unscoped(
        () => this.db.users.filter((u) => u.accountRole === 'OWNER' && u.status === 'ACTIVE' && u.id !== userId).count(),
        'r',
      );
      if (others === 0) fail('LAST_OWNER');
      await this.unscoped(async () => {
        await this.db.users.update(userId, { accountRole: 'USER' });
        await this.db.sessions.where('userId').equals(userId).delete();
      });
      await this.writeAuditIn(null, {
        actorId: actor.id,
        action: 'owner.removed',
        entityType: 'user',
        entityId: userId,
        before: { accountRole: 'OWNER' },
        after: { accountRole: 'USER' },
      });
      await this.reloadIdentity();
    },
  };

  // ------------------------------------------------------------------ workspaces (A12 round 2)

  private workspaceDto(w: DemoWorkspace): WorkspaceAdminDto {
    const live = this.workspaceMemberships(w.id);
    return {
      id: w.id,
      name: w.name,
      code: w.code,
      status: w.status,
      createdAt: w.createdAt,
      archivedAt: w.archivedAt,
      adminCount: live.filter((m) => m.role === 'ADMIN' && m.status === 'ACTIVE').length,
      memberCount: new Set(live.map((m) => m.userId)).size,
    };
  }

  private async memberDto(m: DemoWsMembership, viewerIsOwner: boolean): Promise<WorkspaceMemberDto> {
    const u = (await this.rawUser(m.userId))!;
    return {
      id: m.id,
      workspaceId: m.workspaceId,
      role: m.role,
      title: m.title,
      permissions: m.permissions ?? {},
      scope: m.scope ?? {},
      status: m.status,
      createdAt: m.createdAt,
      user: {
        id: u.id,
        username: u.username ?? usernameBase(u.email),
        fullName: u.fullName,
        email: u.email,
        status: u.status,
        accountRole: u.accountRole ?? 'USER',
        hasPhoto: Boolean(u.photoFileId),
      },
      dualRole: this.liveMemberships(u.id).length > 1 || (viewerIsOwner && false),
    };
  }

  private workspaceRow(id: string): DemoWorkspace {
    const w = this.workspaceRows.get(id);
    if (!w) fail('NOT_FOUND');
    return w;
  }

  /** Owners anywhere; admins/assistants only their session's workspace (403 WORKSPACE_FORBIDDEN). */
  private assertWorkspaceReach(actor: Actor, wid: string) {
    this.workspaceRow(wid);
    if (actor.accountRole !== 'OWNER' && actor._wid !== wid) fail('WORKSPACE_FORBIDDEN');
  }

  /** The other live roles of a person (409 DUAL_ROLE_CONFIRM_REQUIRED details). */
  private dualRoleDetails(userId: string, viewerIsOwner: boolean, viewerWid: string | null): UserRoleEntryDto[] {
    return this.liveMemberships(userId).map((m) => {
      const visible = viewerIsOwner || m.workspaceId === viewerWid;
      return {
        workspaceId: visible ? m.workspaceId : null,
        workspaceName: visible ? (this.workspaceRows.get(m.workspaceId)?.name ?? null) : null,
        role: m.role,
        title: visible ? m.title : null,
        status: m.status,
      };
    });
  }

  /** Validates an assistant scope: every id must be a project/team of `wid` (400 otherwise). */
  private async assertScopeIds(wid: string, scope: { projectIds?: string[]; teamIds?: string[] } | undefined) {
    if (!scope) return;
    await this.inWorkspace(
      wid,
      async () => {
        for (const id of scope.projectIds ?? []) {
          if (!(await this.db.projects.get(id))) fail('VALIDATION_FAILED', { fieldErrors: { 'scope.projectIds': [ERRORS.NOT_FOUND] } });
        }
        for (const id of scope.teamIds ?? []) {
          if (!(await this.db.teams.get(id))) fail('VALIDATION_FAILED', { fieldErrors: { 'scope.teamIds': [ERRORS.NOT_FOUND] } });
        }
      },
      'r',
    );
  }

  /** Adds a membership after the dual-role and duplicate checks; returns the new row. */
  private async addMembershipChecked(
    actor: Actor,
    wid: string,
    target: DemoUser,
    input: { role: WorkspaceRole; title?: string | null; permissions?: AssistantPermissions; scope?: { projectIds?: string[]; teamIds?: string[] }; confirmDualRole?: boolean },
  ): Promise<DemoWsMembership> {
    if (target.status !== 'ACTIVE') fail('INVALID_STATE');
    if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
    const live = this.liveMemberships(target.id);
    if (live.some((m) => m.workspaceId === wid && m.role === input.role)) fail('MEMBERSHIP_EXISTS');
    if (live.length && !input.confirmDualRole) {
      fail('DUAL_ROLE_CONFIRM_REQUIRED', { roles: this.dualRoleDetails(target.id, actor.accountRole === 'OWNER', actor._wid ?? null) });
    }
    if (input.role !== 'ASSISTANT' && (input.permissions || input.scope)) {
      fail('VALIDATION_FAILED', { fieldErrors: { permissions: ['الصلاحيات التفصيلية للمساعد فقط'] } });
    }
    await this.assertScopeIds(wid, input.scope);
    const row: DemoWsMembership = {
      id: newId(),
      workspaceId: wid,
      userId: target.id,
      role: input.role,
      title: input.title ?? null,
      permissions: input.role === 'ASSISTANT' ? (input.permissions ?? {}) : {},
      scope: input.role === 'ASSISTANT' ? (input.scope ?? {}) : {},
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      createdBy: actor.id,
      archivedAt: null,
    };
    await this.unscoped(() => this.db.wsMemberships.add(row));
    await this.writeAuditIn(wid, {
      actorId: actor.id,
      action: 'membership.added',
      entityType: 'user',
      entityId: target.id,
      before: null,
      after: { role: row.role, title: row.title, ...(row.role === 'ASSISTANT' ? { permissions: row.permissions, scope: row.scope } : {}) },
    });
    return row;
  }

  /** Archives memberships; ends the person's sessions in that workspace when no role is left there. */
  private async archiveMemberships(actor: Actor, wid: string, rows: DemoWsMembership[], action = 'membership.removed') {
    if (!rows.length) return;
    const userId = rows[0]!.userId;
    const target = await this.getUser(userId);
    if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
    this.guardLastAdmin(wid, rows);
    const at = new Date().toISOString();
    await this.unscoped(async () => {
      for (const m of rows) await this.db.wsMemberships.update(m.id, { archivedAt: at });
      const left = this.liveMemberships(userId).filter((m) => m.workspaceId === wid && !rows.some((r) => r.id === m.id));
      if (!left.length) {
        await this.db.sessions.filter((s) => s.userId === userId && s.workspaceId === wid).delete();
      }
    });
    for (const m of rows) {
      await this.writeAuditIn(wid, {
        actorId: actor.id,
        action,
        entityType: 'user',
        entityId: userId,
        before: { role: m.role, title: m.title },
        after: null,
      });
    }
    await this.reloadIdentity();
  }

  workspaces: ApiClient['workspaces'] = {
    list: async (query = {}) => {
      await this.ownerActor();
      const status = query.status ?? 'ALL';
      return [...this.workspaceRows.values()]
        .filter((w) => status === 'ALL' || w.status === status)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((w) => this.workspaceDto(w));
    },
    create: async (input) => {
      const actor = await this.ownerActor();
      const data = validate(createWorkspaceSchema, input);
      let code = data.code ?? '';
      if (!code) {
        const base = `ws-${this.workspaceRows.size + 1}`;
        code = base;
        for (let n = 2; [...this.workspaceRows.values()].some((w) => w.code === code); n++) code = `${base}-${n}`;
      }
      if ([...this.workspaceRows.values()].some((w) => w.code === code)) fail('WORKSPACE_CODE_TAKEN');
      const row: DemoWorkspace = {
        id: newId(),
        name: data.name,
        code,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        archivedAt: null,
      };
      await this.unscoped(() => this.db.workspaces.add(row));
      // A new workspace is EMPTY: neutral defaults only (settings, palette, calendar, card sizes/templates).
      await seedWorkspaceDefaults(this, row.id);
      await this.writeAuditIn(row.id, {
        actorId: actor.id,
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: row.id,
        before: null,
        after: { name: row.name, code: row.code },
      });
      await this.reloadIdentity();
      return this.workspaceDto(row);
    },
    rename: async (id, input) => {
      const actor = await this.ownerActor();
      const w = this.workspaceRow(id);
      const data = validate(renameWorkspaceSchema, input);
      await this.unscoped(() => this.db.workspaces.update(id, { name: data.name }));
      await this.writeAuditIn(id, {
        actorId: actor.id,
        action: 'workspace.renamed',
        entityType: 'workspace',
        entityId: id,
        before: { name: w.name },
        after: { name: data.name },
      });
      await this.reloadIdentity();
      return this.workspaceDto(this.workspaceRow(id));
    },
    archive: async (id) => {
      const actor = await this.ownerActor();
      const w = this.workspaceRow(id);
      if (w.status === 'ACTIVE' && this.activeWorkspaces().length <= 1) fail('LAST_WORKSPACE');
      if (w.status === 'ACTIVE') {
        const at = new Date().toISOString();
        await this.unscoped(async () => {
          await this.db.workspaces.update(id, { status: 'ARCHIVED', archivedAt: at });
          // Its sessions end (nothing is deleted).
          await this.db.sessions.filter((s) => s.workspaceId === id && s.token !== this.token).delete();
        });
        await this.writeAuditIn(id, {
          actorId: actor.id,
          action: 'workspace.archived',
          entityType: 'workspace',
          entityId: id,
          before: { status: 'ACTIVE' },
          after: { status: 'ARCHIVED' },
        });
        await this.reloadIdentity();
      }
      return this.workspaceDto(this.workspaceRow(id));
    },
    restore: async (id) => {
      const actor = await this.ownerActor();
      const w = this.workspaceRow(id);
      if (w.status === 'ARCHIVED') {
        await this.unscoped(() => this.db.workspaces.update(id, { status: 'ACTIVE', archivedAt: null }));
        await this.writeAuditIn(id, {
          actorId: actor.id,
          action: 'workspace.restored',
          entityType: 'workspace',
          entityId: id,
          before: { status: 'ARCHIVED' },
          after: { status: 'ACTIVE' },
        });
        await this.reloadIdentity();
      }
      return this.workspaceDto(this.workspaceRow(id));
    },
    summary: async (id) => {
      await this.ownerActor();
      const w = this.workspaceRow(id);
      const live = this.workspaceMemberships(id);
      const byRole = { ADMIN: 0, ASSISTANT: 0, SUPERVISOR: 0, MONITOR: 0, MEMBER: 0 } as Record<WorkspaceRole, number>;
      for (const m of live) byRole[m.role] += 1;
      const pendingRegistrations = await this.unscoped(
        () => this.db.users.filter((u) => u.status === 'PENDING' && u.requestedWorkspaceId === id).count(),
        'r',
      );
      // Counts only, read INSIDE that workspace (scoped like any other request).
      const counts = await this.inWorkspace(
        id,
        async () => ({
          projects: await this.db.projects.filter((p) => !p.archivedAt && !p.isTemplate).count(),
          tasks: await this.db.tasks.filter((x) => !x.archivedAt).count(),
          teams: await this.db.teams.filter((x) => x.status !== 'ARCHIVED').count(),
          members: await this.db.members.filter((x) => x.status === 'ACTIVE').count(),
          violations: await this.db.violations.count(),
          pendingMemberRequests: await this.db.memberRequests.filter((x) => x.status === 'PENDING').count(),
        }),
        'r',
      );
      return {
        workspace: { id: w.id, name: w.name, code: w.code, status: w.status },
        users: { total: new Set(live.map((m) => m.userId)).size, byRole, pendingRegistrations },
        ...counts,
      };
    },
    admins: async (id) => {
      await this.ownerActor();
      this.workspaceRow(id);
      const rows = this.workspaceMemberships(id).filter((m) => m.role === 'ADMIN');
      return Promise.all(rows.map((m) => this.memberDto(m, true)));
    },
    addAdmin: async (id, input) => {
      const actor = await this.ownerActor();
      this.workspaceRow(id);
      const data = validate(addWorkspaceAdminSchema, input);
      const target = await this.findAccount(data);
      const row = await this.addMembershipChecked(actor, id, target, { role: 'ADMIN', title: data.title, confirmDualRole: data.confirmDualRole });
      await this.reloadIdentity();
      return this.memberDto(row, true);
    },
    removeAdmin: async (id, userId) => {
      const actor = await this.ownerActor();
      this.workspaceRow(id);
      const rows = this.workspaceMemberships(id).filter((m) => m.userId === userId && m.role === 'ADMIN');
      if (!rows.length) fail('NOT_FOUND');
      await this.archiveMemberships(actor, id, rows);
    },
    members: async (id) => {
      const actor = await this.actor('users.read', { optionalWorkspace: true });
      this.assertWorkspaceReach(actor, id);
      const rows = this.workspaceMemberships(id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.all(rows.map((m) => this.memberDto(m, actor.accountRole === 'OWNER')));
    },
    addMember: async (id, input) => {
      const actor = await this.actor('users.manageRoles', { optionalWorkspace: true });
      this.assertWorkspaceReach(actor, id);
      const data = validate(addWorkspaceMemberSchema, input);
      const target = await this.findAccount(data);
      const row = await this.addMembershipChecked(actor, id, target, data);
      await this.reloadIdentity();
      return this.memberDto(row, actor.accountRole === 'OWNER');
    },
    updateMember: async (id, membershipId, input) => {
      const actor = await this.actor('users.manageRoles', { optionalWorkspace: true });
      this.assertWorkspaceReach(actor, id);
      const data = validate(updateMembershipSchema, input);
      const m = this.workspaceMemberships(id).find((x) => x.id === membershipId);
      if (!m) fail('NOT_FOUND');
      const target = await this.getUser(m.userId);
      if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
      if (m.role !== 'ASSISTANT' && (data.permissions || data.scope)) {
        fail('VALIDATION_FAILED', { fieldErrors: { permissions: ['الصلاحيات التفصيلية للمساعد فقط'] } });
      }
      await this.assertScopeIds(id, data.scope);
      const next: DemoWsMembership = {
        ...m,
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.permissions ? { permissions: data.permissions } : {}),
        ...(data.scope ? { scope: data.scope } : {}),
      };
      await this.unscoped(() => this.db.wsMemberships.put(next));
      await this.writeAuditIn(id, {
        actorId: actor.id,
        action: 'membership.updated',
        entityType: 'user',
        entityId: m.userId,
        before: { title: m.title, permissions: m.permissions, scope: m.scope },
        after: { title: next.title, permissions: next.permissions, scope: next.scope },
      });
      await this.reloadIdentity();
      return this.memberDto(next, actor.accountRole === 'OWNER');
    },
    removeMember: async (id, membershipId) => {
      const actor = await this.actor('users.manageRoles', { optionalWorkspace: true });
      this.assertWorkspaceReach(actor, id);
      const m = this.workspaceMemberships(id).find((x) => x.id === membershipId);
      if (!m) fail('NOT_FOUND');
      await this.archiveMemberships(actor, id, [m]);
    },
  };

  // ------------------------------------------------------------------ users

  /** `GET /users` and `POST /users/search` share the filters; a full national ID matches exactly. */
  private async filterUsers(query: UserListQuery, viewer: Actor) {
    const q = toWesternDigits(query.q ?? '')
      .trim()
      .toLowerCase();
    const qMobile = q ? normalizeSaudiMobile(q) : null;
    const fullId = isFullNationalIdTerm(q) ? q.replace(/[\s-]/g, '') : null;
    const wid = viewer._wid ?? null;
    const all = await this.unscoped(() => this.db.users.toArray(), 'r');
    const rows = all
      .filter((u) => this.inWorkspaceList(u, wid))
      .map((u) => ({ u, dto: this.toUserDto(u, { wid, viewerIsOwner: viewer.accountRole === 'OWNER' }) }))
      .filter(({ dto }) => !query.role || dto.role === query.role)
      .filter(({ dto }) => !query.status || dto.status === query.status)
      .filter(
        ({ u }) =>
          !q ||
          (fullId !== null && u.nationalId === fullId) ||
          u.fullName.toLowerCase().includes(q) ||
          u.email.includes(q) ||
          (u.username ?? '').includes(q) ||
          u.mobile.includes(q) ||
          (qMobile !== null && u.mobile === qMobile),
      )
      .sort((a, b) => byCreatedDesc(a.u, b.u));
    const page = paginate(rows, query.page, query.pageSize);
    return { ...page, items: page.items.map(({ dto }) => dto) };
  }

  /** Owners edit anyone; admins only users of their workspace who belong to no other one, never an owner. */
  private assertMayEditAccount(actor: Actor, target: DemoUser) {
    if (actor.accountRole === 'OWNER') return;
    if (target.accountRole === 'OWNER') fail('FORBIDDEN');
    const live = this.liveMemberships(target.id);
    if (!this.inWorkspaceList(target, actor._wid ?? null)) fail('NOT_FOUND');
    if (live.some((m) => m.workspaceId !== actor._wid)) fail('USER_IN_OTHER_WORKSPACES');
  }

  private auditUserSnapshot(u: DemoUser) {
    return { username: u.username, fullName: u.fullName, email: u.email, mobile: u.mobile, nationalIdMasked: maskNationalId(u.nationalId) };
  }

  users: ApiClient['users'] = {
    list: async (query = {}) => {
      const viewer = await this.actor('users.read');
      rejectFullIdInUrl(query.q, 'POST /users/search');
      return this.filterUsers(query, viewer);
    },

    search: async (input) => {
      const viewer = await this.actor('users.read');
      return this.filterUsers(validate(userSearchSchema, input), viewer);
    },

    all: async (query = {}) => {
      const viewer = await this.ownerActor();
      const data = validate(allUsersQuery, query);
      const q = (data.q ?? '').toLowerCase();
      const rows = (await this.unscoped(() => this.db.users.toArray(), 'r'))
        .filter((u) => !data.status || u.status === data.status)
        .filter((u) => !data.accountRole || (u.accountRole ?? 'USER') === data.accountRole)
        .filter(
          (u) =>
            !q ||
            u.fullName.toLowerCase().includes(q) ||
            u.email.includes(q) ||
            (u.username ?? '').includes(q) ||
            u.mobile.includes(q),
        )
        .sort(byCreatedDesc);
      const page = paginate(rows, data.page, data.pageSize);
      return { ...page, items: page.items.map((u) => this.toUserDto(u, { wid: viewer._wid ?? null, viewerIsOwner: true })) };
    },

    get: async (id) => {
      const actor = await this.actor('users.read', { optionalWorkspace: true });
      if (!actor._wid && actor.accountRole !== 'OWNER') fail('WORKSPACE_REQUIRED');
      const u = await this.workspaceUser(id, actor);
      return this.toUserDto(u, { full: can(actor, 'nationalIds.readFull'), viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    create: async (input) => {
      const actor = await this.actor('users.create', { optionalWorkspace: true });
      const data = validate(createAccountSchema, input);
      const isOwner = actor.accountRole === 'OWNER';
      const wantRoles = data.memberships?.length
        ? data.memberships.map((m) => ({ ...m, workspaceId: m.workspaceId ?? actor._wid ?? undefined }))
        : [{ workspaceId: actor._wid ?? undefined, role: data.role!, title: undefined, permissions: undefined, scope: undefined }];
      for (const m of wantRoles) {
        if (!m.workspaceId) fail('WORKSPACE_REQUIRED');
        if (!this.workspaceRows.has(m.workspaceId)) fail('NOT_FOUND');
        if (!isOwner && m.workspaceId !== actor._wid) fail('WORKSPACE_FORBIDDEN');
        if (m.role !== 'ASSISTANT' && (m.permissions || m.scope)) {
          fail('VALIDATION_FAILED', { fieldErrors: { permissions: ['الصلاحيات التفصيلية للمساعد فقط'] } });
        }
        await this.assertScopeIds(m.workspaceId, m.scope);
      }
      if (wantRoles.length > 1 && !data.confirmDualRole) {
        fail('DUAL_ROLE_CONFIRM_REQUIRED', {
          roles: wantRoles.map((m) => ({
            workspaceId: m.workspaceId ?? null,
            workspaceName: this.workspaceRows.get(m.workspaceId!)?.name ?? null,
            role: m.role,
            title: m.title ?? null,
            status: 'ACTIVE',
          })),
        });
      }
      const username = data.username ?? (await this.uniqueUsername(data.email));
      await this.assertUnique({ ...data, username });
      const passwordHash = await hashPassword(data.password ?? DEMO_PASSWORD);
      const legacy = effectiveRole(wantRoles.map((m) => m.role)) ?? 'MONITOR';
      const created: DemoUser = {
        id: newId(),
        username,
        accountRole: 'USER',
        requestedWorkspaceId: null,
        fullName: data.fullName,
        email: data.email,
        mobile: data.mobile,
        nationalId: data.nationalId,
        role: legacy,
        requestedRole: null,
        requestedTeamName: null,
        status: 'ACTIVE',
        rejectionReason: null,
        // With a first password: must change by default. Without one the real API e-mails a
        // one-time link; the demo uses the shared password and asks for a change.
        mustChangePassword: data.password ? (data.mustChangePassword ?? true) : true,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        preferences: { ...DEFAULT_PREFERENCES, emailNotifications: {} },
        passwordHash,
      };
      await this.unscoped(async () => {
        await this.db.users.add(created);
        for (const m of wantRoles) {
          const row: DemoWsMembership = {
            id: newId(),
            workspaceId: m.workspaceId!,
            userId: created.id,
            role: m.role,
            title: m.title ?? null,
            permissions: m.role === 'ASSISTANT' ? (m.permissions ?? {}) : {},
            scope: m.role === 'ASSISTANT' ? (m.scope ?? {}) : {},
            status: 'ACTIVE',
            createdAt: created.createdAt,
            createdBy: actor.id,
            archivedAt: null,
          };
          await this.db.wsMemberships.add(row);
        }
      });
      for (const wid of new Set(wantRoles.map((m) => m.workspaceId!))) {
        await this.writeAuditIn(wid, {
          actorId: actor.id,
          action: 'user.created',
          entityType: 'user',
          entityId: created.id,
          before: null,
          after: {
            username,
            fullName: created.fullName,
            roles: wantRoles.filter((m) => m.workspaceId === wid).map((m) => m.role),
            status: created.status,
            ...(data.password ? { passwordSet: true, mustChangePassword: created.mustChangePassword } : {}),
          },
        });
      }
      await this.reloadIdentity();
      return this.toUserDto(created, { full: true, viewerIsOwner: isOwner });
    },

    update: async (id, input) => {
      const actor = await this.actor('users.edit', { optionalWorkspace: true });
      const data = validate(updateUserSchema, input);
      const target = await this.getUser(id);
      this.assertMayEditAccount(actor, target);
      await this.assertUnique(
        {
          email: data.email ?? '',
          mobile: data.mobile ?? '',
          nationalId: data.nationalId ?? '',
          username: data.username,
        },
        id,
      );
      const next: DemoUser = {
        ...target,
        ...(data.username ? { username: data.username } : {}),
        ...(data.fullName ? { fullName: data.fullName } : {}),
        ...(data.email ? { email: data.email } : {}),
        ...(data.mobile ? { mobile: data.mobile } : {}),
        ...(data.nationalId ? { nationalId: data.nationalId } : {}),
      };
      await this.unscoped(() => this.db.users.put(next));
      await this.writeAuditIn(actor._wid ?? null, {
        actorId: actor.id,
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        before: this.auditUserSnapshot(target),
        after: this.auditUserSnapshot(next),
      });
      return this.toUserDto(next, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    setUsername: async (id, input) => {
      const actor = await this.actor('users.edit', { optionalWorkspace: true });
      const data = validate(changeUsernameSchema, input);
      const target = await this.getUser(id);
      this.assertMayEditAccount(actor, target);
      const hit = await this.rawUserBy('username', data.username);
      if (hit && hit.id !== id) fail('USERNAME_TAKEN', { fieldErrors: { username: [ERRORS.USERNAME_TAKEN] } });
      await this.unscoped(() => this.db.users.update(id, { username: data.username }));
      await this.writeAuditIn(actor._wid ?? null, {
        actorId: actor.id,
        action: 'user.username_changed',
        entityType: 'user',
        entityId: id,
        before: { username: target.username },
        after: { username: data.username },
      });
      return this.toUserDto({ ...target, username: data.username }, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    setPassword: async (id, input) => {
      const actor = await this.actor('users.edit', { optionalWorkspace: true });
      const data = validate(setUserPasswordSchema, input);
      const target = await this.getUser(id);
      this.assertMayEditAccount(actor, target);
      const passwordHash = await hashPassword(data.password);
      const mustChangePassword = data.mustChangePassword ?? true;
      await this.unscoped(async () => {
        await this.db.users.update(id, { passwordHash, mustChangePassword, failedLogins: 0, lockedUntil: null });
        // Every session of the user ends (never the actor's own when they set their own password).
        await this.db.sessions.filter((s) => s.userId === id && s.token !== this.token).delete();
      });
      // Never the value.
      await this.writeAuditIn(actor._wid ?? null, {
        actorId: actor.id,
        action: 'user.password_set',
        entityType: 'user',
        entityId: id,
        before: null,
        after: { mustChangePassword },
      });
      return this.toUserDto({ ...target, mustChangePassword }, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    changeRole: async (id, input) => {
      const actor = await this.actor('users.manageRoles');
      const data = validate(changeRoleSchema, input);
      const wid = actor._wid!;
      const target = await this.workspaceUser(id, actor);
      if (target.status === 'PENDING') fail('NOT_PENDING');
      if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
      const here = this.workspaceMemberships(wid).filter(
        (m) => m.userId === id && (m.role === 'ADMIN' || m.role === 'SUPERVISOR' || m.role === 'MONITOR'),
      );
      const current = here[0];
      if (current?.role !== data.role) {
        if (current) {
          if (current.role === 'ADMIN') this.guardLastAdmin(wid, [current]);
          await this.unscoped(() => this.db.wsMemberships.update(current.id, { role: data.role }));
        } else {
          await this.grantRole(id, data.role, actor.id, wid);
        }
        await this.writeAuditIn(wid, {
          actorId: actor.id,
          action: 'user.role_changed',
          entityType: 'user',
          entityId: id,
          before: { role: current?.role ?? null },
          after: { role: data.role },
        });
        await this.reloadIdentity();
      }
      return this.toUserDto((await this.rawUser(id))!, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    suspend: async (id, input) => {
      const actor = await this.actor('users.suspend', { optionalWorkspace: true });
      const data = validate(suspendUserSchema, input);
      const scope = data.scope ?? 'workspace';
      const target = await this.getUser(id);
      if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
      if (scope === 'global') {
        if (actor.accountRole !== 'OWNER') fail('FORBIDDEN');
        if (target.status !== 'ACTIVE') return this.toUserDto(target, { full: true, viewerIsOwner: true });
        if (target.accountRole === 'OWNER') {
          const others = await this.unscoped(
            () => this.db.users.filter((u) => u.accountRole === 'OWNER' && u.status === 'ACTIVE' && u.id !== id).count(),
            'r',
          );
          if (!others) fail('LAST_OWNER');
        }
        for (const wid of new Set(this.liveMemberships(id).map((m) => m.workspaceId))) {
          this.guardLastAdmin(wid, this.liveMemberships(id).filter((m) => m.workspaceId === wid));
        }
        await this.unscoped(async () => {
          await this.db.users.update(id, { status: 'SUSPENDED' });
          await this.db.sessions.where('userId').equals(id).delete();
        });
        await this.writeAuditIn(actor._wid ?? null, {
          actorId: actor.id,
          action: 'user.suspended',
          entityType: 'user',
          entityId: id,
          before: { status: 'ACTIVE' },
          after: { status: 'SUSPENDED', scope: 'global', ...(data.reason ? { reason: data.reason } : {}) },
        });
        return this.toUserDto({ ...target, status: 'SUSPENDED' }, { full: true, viewerIsOwner: true });
      }
      const wid = actor._wid;
      if (!wid) fail('WORKSPACE_REQUIRED');
      await this.workspaceUser(id, actor);
      const here = this.workspaceMemberships(wid).filter((m) => m.userId === id && m.status === 'ACTIVE');
      if (here.length) {
        this.guardLastAdmin(wid, here);
        const elsewhere = this.liveMemberships(id).some((m) => m.workspaceId !== wid && m.status === 'ACTIVE');
        await this.unscoped(async () => {
          for (const m of here) await this.db.wsMemberships.update(m.id, { status: 'SUSPENDED' });
          await this.db.sessions.filter((s) => s.userId === id && s.workspaceId === wid).delete();
          // The account itself only when it has no other live role (pre-A12 behaviour in one workspace).
          if (!elsewhere && target.accountRole !== 'OWNER') {
            await this.db.users.update(id, { status: 'SUSPENDED' });
            await this.db.sessions.where('userId').equals(id).delete();
          }
        });
        await this.writeAuditIn(wid, {
          actorId: actor.id,
          action: 'user.suspended',
          entityType: 'user',
          entityId: id,
          before: { status: 'ACTIVE' },
          after: { status: 'SUSPENDED', ...(data.reason ? { reason: data.reason } : {}) },
        });
        await this.reloadIdentity();
      }
      return this.toUserDto((await this.rawUser(id))!, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    reactivate: async (id, input) => {
      const actor = await this.actor('users.suspend', { optionalWorkspace: true });
      const scope = input?.scope ?? 'workspace';
      const target = await this.getUser(id);
      if (scope === 'global' && actor.accountRole !== 'OWNER') fail('FORBIDDEN');
      if (scope === 'workspace') {
        const wid = actor._wid;
        if (!wid) fail('WORKSPACE_REQUIRED');
        await this.workspaceUser(id, actor);
        const here = this.workspaceMemberships(wid).filter((m) => m.userId === id && m.status === 'SUSPENDED');
        await this.unscoped(async () => {
          for (const m of here) await this.db.wsMemberships.update(m.id, { status: 'ACTIVE' });
        });
      }
      if (target.status === 'SUSPENDED') await this.unscoped(() => this.db.users.update(id, { status: 'ACTIVE' }));
      await this.writeAuditIn(actor._wid ?? null, {
        actorId: actor.id,
        action: 'user.reactivated',
        entityType: 'user',
        entityId: id,
        before: { status: 'SUSPENDED' },
        after: { status: 'ACTIVE', ...(scope === 'global' ? { scope } : {}) },
      });
      await this.reloadIdentity();
      return this.toUserDto((await this.rawUser(id))!, { full: true, viewerIsOwner: actor.accountRole === 'OWNER' });
    },

    supervisors: async (q) => {
      const viewer = await this.actor('users.read');
      rejectFullIdInUrl(q, 'POST /users/search');
      const needle = (q ?? '').trim().toLowerCase();
      // The users view of this workspace: role/status are the membership's here.
      const rows = (await this.db.users.toArray()).filter(
        (u) =>
          (u as Actor).roles?.includes('SUPERVISOR') &&
          u.status === 'ACTIVE' &&
          (!needle || u.fullName.toLowerCase().includes(needle)),
      );
      return rows.map((u) => this.toUserDto(u, { viewerIsOwner: viewer.accountRole === 'OWNER' }));
    },
  };

  // ------------------------------------------------------------------ registrations

  registrations: ApiClient['registrations'] = {
    list: async (query = {}) => {
      const viewer = await this.actor();
      if (!can(viewer, 'registrations.review') && !can(viewer, 'registrations.read')) fail('FORBIDDEN');
      const wid = viewer._wid!;
      const rows = (
        await this.unscoped(() => this.db.users.where('status').equals('PENDING').toArray(), 'r')
      )
        .filter((u) => u.requestedWorkspaceId === wid)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const page = paginate(rows, query.page, query.pageSize);
      return { ...page, items: page.items.map((u) => this.toUserDto(u)) };
    },

    approve: async (id, input) => {
      const actor = await this.actor('registrations.review');
      const data = validate(approveRegistrationSchema, input);
      const wid = actor._wid!;
      const target = await this.getUser(id);
      if (target.requestedWorkspaceId !== wid) fail('NOT_FOUND');
      if (target.status !== 'PENDING') fail('NOT_PENDING');
      const role = data.role ?? target.requestedRole ?? target.role;
      await this.unscoped(() => this.db.users.update(id, { status: 'ACTIVE', role }));
      await this.grantRole(id, role, actor.id, wid);
      await this.writeAudit({
        actorId: actor.id,
        action: 'registration.approved',
        entityType: 'user',
        entityId: target.id,
        before: { status: 'PENDING', role: target.requestedRole ?? target.role },
        after: { status: 'ACTIVE', role },
      });
      await this.notify(target.id, 'REGISTRATION_APPROVED', { role });
      await this.reloadIdentity();
      return this.toUserDto({ ...target, status: 'ACTIVE', role }, { full: true });
    },

    reject: async (id, input) => {
      const actor = await this.actor('registrations.review');
      const raw = (input as { reason?: unknown } | undefined)?.reason;
      if (typeof raw !== 'string' || !raw.trim()) fail('REJECTION_REASON_REQUIRED');
      const data = validate(rejectRegistrationSchema, input);
      const target = await this.getUser(id);
      if (target.requestedWorkspaceId !== actor._wid) fail('NOT_FOUND');
      if (target.status !== 'PENDING') fail('NOT_PENDING');
      await this.unscoped(() => this.db.users.update(id, { status: 'REJECTED', rejectionReason: data.reason }));
      await this.writeAudit({
        actorId: actor.id,
        action: 'registration.rejected',
        entityType: 'user',
        entityId: target.id,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', rejectionReason: data.reason },
      });
      await this.notify(target.id, 'REGISTRATION_REJECTED', { reason: data.reason });
      return this.toUserDto({ ...target, status: 'REJECTED', rejectionReason: data.reason }, { full: true });
    },
  };

  // ------------------------------------------------------------------ audit

  audit: ApiClient['audit'] = {
    list: async (query = {}) => {
      await this.actor('audit.read');
      const users = new Map((await this.unscoped(() => this.db.users.toArray(), 'r')).map((u) => [u.id, u]));
      const rows = (await this.db.audit.toArray())
        .filter((a) => !query.action || a.action === query.action)
        .filter((a) => !query.entityType || a.entityType === query.entityType)
        .filter((a) => !query.entityId || a.entityId === query.entityId)
        .filter((a) => !query.actorId || a.actorId === query.actorId)
        .filter((a) => !query.from || riyadhDay(new Date(a.at)) >= query.from)
        .filter((a) => !query.to || riyadhDay(new Date(a.at)) <= query.to)
        .sort((a, b) => b.at.localeCompare(a.at));
      const page = paginate(rows, query.page, query.pageSize);
      return {
        ...page,
        items: page.items.map((a): AuditEntryDto => {
          const actor = a.actorId ? users.get(a.actorId) : undefined;
          return {
            id: a.id,
            actor: actor ? { id: actor.id, fullName: actor.fullName } : null,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            before: a.before,
            after: a.after,
            ip: a.ip,
            at: a.at,
          };
        }),
      };
    },
  };

  // ------------------------------------------------------------------ notifications

  notifications: ApiClient['notifications'] = {
    list: async (query = {}) => {
      const user = await this.actor('notifications.read');
      const rows = (await this.db.notifications.where('userId').equals(user.id).toArray())
        .filter((n) => !query.unread || !n.readAt)
        .sort(byCreatedDesc);
      const page = paginate(rows, query.page, query.pageSize);
      return {
        ...page,
        items: page.items.map((n): NotificationDto => ({
          id: n.id,
          type: n.type,
          payload: n.payload,
          readAt: n.readAt,
          createdAt: n.createdAt,
        })),
      };
    },
    unreadCount: async () => {
      const user = await this.actor('notifications.read');
      const count = await this.db.notifications
        .where('userId')
        .equals(user.id)
        .filter((n) => !n.readAt)
        .count();
      return { count };
    },
    markRead: async (id) => {
      const user = await this.actor('notifications.read');
      const n = await this.db.notifications.get(id);
      if (!n || n.userId !== user.id) fail('NOT_FOUND');
      if (!n.readAt) await this.db.notifications.update(id, { readAt: new Date().toISOString() });
    },
    markAllRead: async () => {
      const user = await this.actor('notifications.read');
      const now = new Date().toISOString();
      await this.db.notifications
        .where('userId')
        .equals(user.id)
        .filter((n) => !n.readAt)
        .modify({ readAt: now });
    },
  };

  // ------------------------------------------------------------------ settings

  /** @internal */
  demoPasswordHash() {
    return hashPassword(DEMO_PASSWORD);
  }

  /** @internal The active workspace's settings (each workspace has its own). */
  async readSettings(): Promise<Settings> {
    const stored = (await this.db.kv.get(this.wsKey('settings')))?.value as Partial<Settings> | undefined;
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  settings: ApiClient['settings'] = {
    get: async () => {
      await this.actor();
      return this.readSettings();
    },
    update: async (input) => {
      const actor = await this.actor('settings.manage');
      const data = validate(updateSettingsSchema, input);
      const before = await this.readSettings();
      const next = { ...before, ...data } as Settings;
      const changed = (Object.keys(data) as (keyof Settings)[]).filter(
        (k) => before[k] !== next[k],
      );
      if (changed.length) {
        await this.db.transaction('rw', [this.db.kv, this.db.audit], async () => {
          await this.db.kv.put({ key: this.wsKey('settings'), value: next });
          await this.writeAudit({
            actorId: actor.id,
            action: 'settings.updated',
            entityType: 'settings',
            entityId: null,
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          });
        });
      }
      return next;
    },
  };
}
