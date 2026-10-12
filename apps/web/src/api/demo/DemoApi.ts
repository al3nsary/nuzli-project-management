import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  ERRORS,
  approveRegistrationSchema,
  can,
  changePasswordSchema,
  changeRoleSchema,
  createUserSchema,
  forgotPasswordSchema,
  loginSchema,
  maskNationalId,
  normalizeSaudiMobile,
  registerSchema,
  rejectRegistrationSchema,
  resetPasswordSchema,
  suspendUserSchema,
  isFullNationalIdTerm,
  toWesternDigits,
  updateProfileSchema,
  userSearchSchema,
  updateSettingsSchema,
  type AuditEntryDto,
  type AuthSession,
  type NotificationDto,
  type Permission,
  type Role,
  type Settings,
  type UserDto,
} from '@nuzli/shared';
import type { ApiClient, DemoAccount, DemoControls, SessionListener, UserListQuery } from '../client';
import { riyadhDay } from '../../i18n/format';
import { DemoDb, type DemoAudit, type DemoUser } from './db';
import { loadPhase2Seed, loadPhase3Seed, loadSeed } from './seed';
import { createPhase2, type Phase2Api } from './phase2';
import { createPhase3, type Phase3Api } from './phase3';
import { seedViolations } from './seedViolations';
import { fail, hashPassword, newId, paginate, rejectFullIdInUrl, validate } from './util';
import { DEMO_DB_NAME, DEMO_EXPIRES_IN, DEMO_PASSWORD } from './constants';

const LOGIN_FREE_FAILURES = 5;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 5;

const byCreatedDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);

/**
 * In-browser implementation of the API for the GitHub Pages demo (ADR-020).
 * It enforces the same rules as the real API: the shared zod schemas, the `can()` matrix,
 * pending accounts cannot log in, uniqueness of email/mobile/national ID, last-admin
 * protection inside a transaction, audit entries and admin notifications.
 */
export class DemoApi implements ApiClient {
  readonly mode = 'demo' as const;
  readonly db: DemoDb;
  readonly demo: DemoControls;
  private token: string | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<SessionListener>();
  /** ADR-062: per-identifier delays, in memory like the API's LoginThrottleService. */
  private loginBuckets = new Map<string, { failures: number; until: number }>();

  colors!: Phase2Api['colors'];
  teams!: Phase2Api['teams'];
  members!: Phase2Api['members'];
  reference!: Phase2Api['reference'];
  cards!: Phase2Api['cards'];
  logos!: Phase2Api['logos'];
  files!: Phase3Api['files'];
  violationTypes!: Phase3Api['violationTypes'];
  violations!: Phase3Api['violations'];

  /**
   * The demo has no network, so offline is simulated for the "network-shaped" violation
   * endpoints: they fail with NETWORK_ERROR while the browser is offline or `network.offline`
   * is set (tests, docs/offline.md). Everything else keeps working from IndexedDB.
   */
  readonly network = { offline: false };

  constructor(opts: { dbName?: string } = {}) {
    this.db = new DemoDb(opts.dbName ?? DEMO_DB_NAME);
    Object.assign(this, createPhase2(this));
    Object.assign(this, createPhase3(this));
    const seed = loadSeed();
    const first = (role: Role) => seed.users.find((u) => u.role === role && u.status === 'ACTIVE');
    const accounts: DemoAccount[] = (['ADMIN', 'SUPERVISOR', 'MONITOR'] as Role[])
      .map((role) => first(role))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({ role: u.role, identifier: u.email, fullName: u.fullName }));
    this.demo = {
      password: DEMO_PASSWORD,
      accounts,
      pendingExample: seed.users.find((u) => u.status === 'PENDING')?.email ?? '',
      reset: () => this.reset(),
    };
  }

  // ------------------------------------------------------------------ plumbing

  private init(): Promise<void> {
    if (!this.ready) this.ready = this.seedIfEmpty();
    return this.ready;
  }

  private async seedIfEmpty() {
    await this.seedPhase1();
    await this.seedPhase2();
    await this.seedPhase3();
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

  private async seedPhase1() {
    const seeded = await this.db.kv.get('seeded');
    if (seeded) return;
    const seed = loadSeed();
    const hash = await hashPassword(DEMO_PASSWORD);
    await this.db.transaction(
      'rw',
      [this.db.users, this.db.notifications, this.db.audit, this.db.kv],
      async () => {
        await this.db.users.bulkPut(seed.users.map((u) => ({ ...u, passwordHash: hash })));
        await this.db.notifications.bulkPut(seed.notifications);
        await this.db.audit.bulkPut(seed.audit);
        await this.db.kv.put({ key: 'settings', value: { ...DEFAULT_SETTINGS } });
        await this.db.kv.put({ key: 'seeded', value: new Date().toISOString() });
      },
    );
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
    await this.db.transaction('rw', this.db.tables, async () => {
      await Promise.all(this.db.tables.map((table) => table.clear()));
    });
    this.token = null;
    this.ready = null;
    await this.init();
    this.emit(null);
  }

  setAccessToken(token: string | null) {
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

  /** The signed-in, active user; optionally checks a permission like the API guard does. */
  /** @internal The signed-in user (also used by the Phase 2 module). */
  async actor(permission?: Permission): Promise<DemoUser> {
    await this.init();
    if (!this.token) fail('UNAUTHENTICATED');
    const session = await this.db.sessions.get(this.token);
    const user = session ? await this.db.users.get(session.userId) : undefined;
    if (!user || user.status !== 'ACTIVE') fail('UNAUTHENTICATED');
    if (permission) {
      if (user.mustChangePassword) fail('PASSWORD_CHANGE_REQUIRED');
      if (!can(user, permission)) fail('FORBIDDEN');
    }
    return user;
  }

  private toDto(u: DemoUser, opts: { full?: boolean } = {}): UserDto {
    return {
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      mobile: u.mobile,
      nationalIdMasked: maskNationalId(u.nationalId),
      ...(opts.full ? { nationalId: u.nationalId } : {}),
      role: u.role,
      requestedRole: u.requestedRole,
      requestedTeamName: u.requestedTeamName,
      status: u.status,
      rejectionReason: u.rejectionReason,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      preferences: u.preferences,
    };
  }

  private async getUser(id: string): Promise<DemoUser> {
    const u = await this.db.users.get(id);
    if (!u) fail('NOT_FOUND');
    return u;
  }

  private async assertUnique(input: { email: string; mobile: string; nationalId: string }) {
    if (await this.db.users.where('email').equals(input.email).first()) fail('EMAIL_TAKEN');
    if (await this.db.users.where('mobile').equals(input.mobile).first()) fail('MOBILE_TAKEN');
    if (await this.db.users.where('nationalId').equals(input.nationalId).first())
      fail('NATIONAL_ID_TAKEN');
  }

  /** @internal */
  writeAudit(entry: Omit<DemoAudit, 'id' | 'at' | 'ip'>) {
    return this.db.audit.add({ ...entry, id: newId(), at: new Date().toISOString(), ip: null });
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

  /** Throws LAST_ADMIN when the change would leave zero active admins (ADR-009). Call inside a transaction. */
  private async guardLastAdmin(target: DemoUser) {
    if (target.role !== 'ADMIN' || target.status !== 'ACTIVE') return;
    const activeAdmins = await this.db.users
      .where('role')
      .equals('ADMIN')
      .filter((u) => u.status === 'ACTIVE')
      .count();
    if (activeAdmins <= 1) fail('LAST_ADMIN');
  }

  private async session(user: DemoUser): Promise<AuthSession> {
    if (!this.token) fail('UNAUTHENTICATED');
    return { accessToken: this.token, expiresIn: DEMO_EXPIRES_IN, user: this.toDto(user) };
  }

  /** Owners of an e-mail, mobile or national ID already registered (ADR-063). */
  private async duplicateOwners(input: { email: string; mobile: string; nationalId: string }) {
    const hits = await Promise.all([
      this.db.users.where('email').equals(input.email).first(),
      this.db.users.where('mobile').equals(input.mobile).first(),
      this.db.users.where('nationalId').equals(input.nationalId).first(),
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
      await this.db.users.update(user.id, { failedLogins: 0, lockedUntil });
      await this.writeAudit({
        actorId: null,
        action: 'auth.account_locked',
        entityType: 'user',
        entityId: user.id,
        before: null,
        after: { minutes: LOGIN_LOCK_MINUTES },
      });
    } else {
      await this.db.users.update(user.id, { failedLogins });
    }
  }

  // ------------------------------------------------------------------ auth

  auth: ApiClient['auth'] = {
    register: async (input) => {
      await this.init();
      const data = validate(registerSchema, input);
      const passwordHash = await hashPassword(data.password);
      await this.db.transaction(
        'rw',
        [this.db.users, this.db.notifications, this.db.audit],
        async () => {
          // ADR-063: duplicates create nothing and get the same answer; the owner is "e-mailed"
          // and the attempt is audited without personal data.
          const owners = await this.duplicateOwners(data);
          if (owners.length) {
            for (const ownerId of owners) {
              await this.writeAudit({
                actorId: null,
                action: 'registration.duplicate_attempt',
                entityType: 'user',
                entityId: ownerId,
                before: null,
                after: null,
              });
            }
            return;
          }
          const user: DemoUser = {
            id: newId(),
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
          await this.db.users.add(user);
          await this.writeAudit({
            actorId: null,
            action: 'registration.requested',
            entityType: 'user',
            entityId: user.id,
            before: null,
            after: { status: 'PENDING', role: user.role },
          });
          const admins = await this.db.users
            .where('role')
            .equals('ADMIN')
            .filter((u) => u.status === 'ACTIVE')
            .toArray();
          for (const admin of admins) {
            await this.notify(admin.id, 'REGISTRATION_REQUESTED', {
              userId: user.id,
              fullName: user.fullName,
              requestedRole: user.role,
            });
          }
        },
      );
      return { status: 'PENDING' as const };
    },

    login: async (input) => {
      await this.init();
      const data = validate(loginSchema, input);
      const identifier = toWesternDigits(data.identifier).trim();
      const key = identifier.includes('@')
        ? identifier.toLowerCase()
        : (normalizeSaudiMobile(identifier) ?? identifier);
      // ADR-062: while the identifier cools down, answer 429 before checking the password.
      const bucket = this.loginBuckets.get(key);
      const nowMs = Date.now();
      if (bucket && bucket.until > nowMs) {
        fail('RATE_LIMITED', { retryAfterSeconds: Math.ceil((bucket.until - nowMs) / 1000) });
      }
      let user: DemoUser | undefined;
      if (identifier.includes('@')) {
        user = await this.db.users.where('email').equals(identifier.toLowerCase()).first();
      } else {
        const mobile = normalizeSaudiMobile(identifier);
        user = mobile ? await this.db.users.where('mobile').equals(mobile).first() : undefined;
      }
      const passwordOk = Boolean(user) && user!.passwordHash === (await hashPassword(data.password));
      // A locked account answers INVALID_CREDENTIALS even with the right password (no 423).
      const locked = Boolean(user?.lockedUntil && Date.parse(user.lockedUntil) > nowMs);
      if (!user || !passwordOk || locked) {
        await this.recordLoginFailure(key, user && !locked ? user : undefined);
        // Same answer for an unknown account, a wrong password and a locked one (no enumeration).
        fail('INVALID_CREDENTIALS');
      }
      this.loginBuckets.delete(key);
      if (user.failedLogins) await this.db.users.update(user.id, { failedLogins: 0, lockedUntil: null });
      if (user.status === 'PENDING') fail('ACCOUNT_PENDING');
      if (user.status === 'REJECTED') fail('ACCOUNT_REJECTED');
      if (user.status === 'SUSPENDED') fail('ACCOUNT_SUSPENDED');
      const token = `demo.${newId()}`;
      const now = new Date().toISOString();
      await this.db.sessions.add({ token, userId: user.id, createdAt: now });
      await this.db.users.update(user.id, { lastLoginAt: now });
      await this.db.kv.put({ key: 'currentToken', value: token });
      this.token = token;
      return this.session({ ...user, lastLoginAt: now });
    },

    refresh: async () => {
      await this.init();
      const stored = (await this.db.kv.get('currentToken'))?.value;
      if (typeof stored !== 'string') return null;
      const session = await this.db.sessions.get(stored);
      const user = session ? await this.db.users.get(session.userId) : undefined;
      if (!user || user.status !== 'ACTIVE') {
        await this.db.kv.delete('currentToken');
        this.token = null;
        return null;
      }
      this.token = stored;
      return this.session(user);
    },

    logout: async () => {
      await this.init();
      if (this.token) await this.db.sessions.delete(this.token);
      await this.db.kv.delete('currentToken');
      this.token = null;
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
      const user = await this.actor();
      const data = validate(changePasswordSchema, input);
      if (user.passwordHash !== (await hashPassword(data.currentPassword))) {
        fail('VALIDATION_FAILED', {
          fieldErrors: { currentPassword: [ERRORS.INVALID_CREDENTIALS] },
        });
      }
      const passwordHash = await hashPassword(data.newPassword);
      await this.db.users.update(user.id, { passwordHash, mustChangePassword: false });
      await this.writeAudit({
        actorId: user.id,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: user.id,
        before: null,
        after: null,
      });
      return this.session({ ...user, passwordHash, mustChangePassword: false });
    },

    me: async () => this.toDto(await this.actor()),
  };

  me: ApiClient['me'] = {
    update: async (input) => {
      const user = await this.actor('profile.update');
      const data = validate(updateProfileSchema, input);
      const prefs = data.preferences ?? {};
      const next: DemoUser = {
        ...user,
        fullName: data.fullName ?? user.fullName,
        preferences: {
          ...user.preferences,
          ...Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined)),
          emailNotifications: {
            ...user.preferences.emailNotifications,
            ...(prefs.emailNotifications ?? {}),
          },
        },
      };
      await this.db.users.put(next);
      return this.toDto(next);
    },
  };

  /** `GET /users` and `POST /users/search` share the filters; a full national ID matches exactly. */
  private async filterUsers(query: UserListQuery) {
    const q = toWesternDigits(query.q ?? '')
      .trim()
      .toLowerCase();
    const qMobile = q ? normalizeSaudiMobile(q) : null;
    const fullId = isFullNationalIdTerm(q) ? q.replace(/[\s-]/g, '') : null;
    const rows = (await this.db.users.toArray())
      .filter((u) => !query.role || u.role === query.role)
      .filter((u) => !query.status || u.status === query.status)
      .filter(
        (u) =>
          !q ||
          (fullId !== null && u.nationalId === fullId) ||
          u.fullName.toLowerCase().includes(q) ||
          u.email.includes(q) ||
          u.mobile.includes(q) ||
          (qMobile !== null && u.mobile === qMobile),
      )
      .sort(byCreatedDesc);
    const page = paginate(rows, query.page, query.pageSize);
    return { ...page, items: page.items.map((u) => this.toDto(u)) };
  }

  // ------------------------------------------------------------------ users

  users: ApiClient['users'] = {
    list: async (query = {}) => {
      await this.actor('users.read');
      rejectFullIdInUrl(query.q, 'POST /users/search');
      return this.filterUsers(query);
    },

    search: async (input) => {
      await this.actor('users.read');
      return this.filterUsers(validate(userSearchSchema, input));
    },

    get: async (id) => {
      const actor = await this.actor('users.read');
      return this.toDto(await this.getUser(id), { full: actor.role === 'ADMIN' });
    },

    create: async (input) => {
      const actor = await this.actor('users.create');
      const data = validate(createUserSchema, input);
      const passwordHash = await hashPassword(DEMO_PASSWORD);
      let created!: DemoUser;
      await this.db.transaction('rw', [this.db.users, this.db.audit], async () => {
        await this.assertUnique(data);
        created = {
          id: newId(),
          fullName: data.fullName,
          email: data.email,
          mobile: data.mobile,
          nationalId: data.nationalId,
          role: data.role,
          requestedRole: null,
          requestedTeamName: null,
          status: 'ACTIVE',
          rejectionReason: null,
          // The real API emails a one-time set-password link; the demo uses the shared password.
          mustChangePassword: true,
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
          preferences: { ...DEFAULT_PREFERENCES, emailNotifications: {} },
          passwordHash,
        };
        await this.db.users.add(created);
        await this.writeAudit({
          actorId: actor.id,
          action: 'user.created',
          entityType: 'user',
          entityId: created.id,
          before: null,
          after: { fullName: created.fullName, role: created.role, status: created.status },
        });
      });
      return this.toDto(created, { full: true });
    },

    changeRole: async (id, input) => {
      const actor = await this.actor('users.manageRoles');
      const data = validate(changeRoleSchema, input);
      let result!: DemoUser;
      await this.db.transaction('rw', [this.db.users, this.db.audit], async () => {
        const target = await this.getUser(id);
        if (target.status === 'PENDING') fail('NOT_PENDING');
        result = target;
        if (target.role === data.role) return;
        if (data.role !== 'ADMIN') await this.guardLastAdmin(target);
        result = { ...target, role: data.role };
        await this.db.users.put(result);
        await this.writeAudit({
          actorId: actor.id,
          action: 'user.role_changed',
          entityType: 'user',
          entityId: target.id,
          before: { role: target.role },
          after: { role: data.role },
        });
      });
      return this.toDto(result, { full: true });
    },

    suspend: async (id, input) => {
      const actor = await this.actor('users.suspend');
      const data = validate(suspendUserSchema, input);
      let result!: DemoUser;
      await this.db.transaction(
        'rw',
        [this.db.users, this.db.audit, this.db.sessions],
        async () => {
          const target = await this.getUser(id);
          result = target;
          if (target.status !== 'ACTIVE') return;
          await this.guardLastAdmin(target);
          result = { ...target, status: 'SUSPENDED' };
          await this.db.users.put(result);
          // Suspending revokes all sessions immediately (brief §4.2).
          await this.db.sessions.where('userId').equals(target.id).delete();
          await this.writeAudit({
            actorId: actor.id,
            action: 'user.suspended',
            entityType: 'user',
            entityId: target.id,
            before: { status: 'ACTIVE' },
            after: { status: 'SUSPENDED', ...(data.reason ? { reason: data.reason } : {}) },
          });
        },
      );
      return this.toDto(result, { full: true });
    },

    reactivate: async (id) => {
      const actor = await this.actor('users.suspend');
      let result!: DemoUser;
      await this.db.transaction('rw', [this.db.users, this.db.audit], async () => {
        const target = await this.getUser(id);
        result = target;
        if (target.status !== 'SUSPENDED') return;
        result = { ...target, status: 'ACTIVE' };
        await this.db.users.put(result);
        await this.writeAudit({
          actorId: actor.id,
          action: 'user.reactivated',
          entityType: 'user',
          entityId: target.id,
          before: { status: 'SUSPENDED' },
          after: { status: 'ACTIVE' },
        });
      });
      return this.toDto(result, { full: true });
    },

    supervisors: async (q) => {
      await this.actor('users.read');
      rejectFullIdInUrl(q, 'POST /users/search');
      const needle = (q ?? '').trim().toLowerCase();
      const rows = await this.db.users
        .where('role')
        .equals('SUPERVISOR')
        .filter(
          (u) => u.status === 'ACTIVE' && (!needle || u.fullName.toLowerCase().includes(needle)),
        )
        .toArray();
      return rows.map((u) => this.toDto(u));
    },
  };

  // ------------------------------------------------------------------ registrations

  registrations: ApiClient['registrations'] = {
    list: async (query = {}) => {
      await this.actor('registrations.review');
      const rows = (await this.db.users.where('status').equals('PENDING').toArray()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const page = paginate(rows, query.page, query.pageSize);
      return { ...page, items: page.items.map((u) => this.toDto(u)) };
    },

    approve: async (id, input) => {
      const actor = await this.actor('registrations.review');
      const data = validate(approveRegistrationSchema, input);
      let result!: DemoUser;
      await this.db.transaction(
        'rw',
        [this.db.users, this.db.audit, this.db.notifications],
        async () => {
          const target = await this.getUser(id);
          if (target.status !== 'PENDING') fail('NOT_PENDING');
          const role = data.role ?? target.requestedRole ?? target.role;
          result = { ...target, status: 'ACTIVE', role };
          await this.db.users.put(result);
          await this.writeAudit({
            actorId: actor.id,
            action: 'registration.approved',
            entityType: 'user',
            entityId: target.id,
            before: { status: 'PENDING', role: target.requestedRole ?? target.role },
            after: { status: 'ACTIVE', role },
          });
          await this.notify(target.id, 'REGISTRATION_APPROVED', { role });
        },
      );
      return this.toDto(result, { full: true });
    },

    reject: async (id, input) => {
      const actor = await this.actor('registrations.review');
      const raw = (input as { reason?: unknown } | undefined)?.reason;
      if (typeof raw !== 'string' || !raw.trim()) fail('REJECTION_REASON_REQUIRED');
      const data = validate(rejectRegistrationSchema, input);
      let result!: DemoUser;
      await this.db.transaction(
        'rw',
        [this.db.users, this.db.audit, this.db.notifications],
        async () => {
          const target = await this.getUser(id);
          if (target.status !== 'PENDING') fail('NOT_PENDING');
          result = { ...target, status: 'REJECTED', rejectionReason: data.reason };
          await this.db.users.put(result);
          await this.writeAudit({
            actorId: actor.id,
            action: 'registration.rejected',
            entityType: 'user',
            entityId: target.id,
            before: { status: 'PENDING' },
            after: { status: 'REJECTED', rejectionReason: data.reason },
          });
          await this.notify(target.id, 'REGISTRATION_REJECTED', { reason: data.reason });
        },
      );
      return this.toDto(result, { full: true });
    },
  };

  // ------------------------------------------------------------------ audit

  audit: ApiClient['audit'] = {
    list: async (query = {}) => {
      await this.actor('audit.read');
      const users = new Map((await this.db.users.toArray()).map((u) => [u.id, u]));
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

  /** @internal */
  async readSettings(): Promise<Settings> {
    const stored = (await this.db.kv.get('settings'))?.value as Partial<Settings> | undefined;
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
          await this.db.kv.put({ key: 'settings', value: next });
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
