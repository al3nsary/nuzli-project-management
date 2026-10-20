/**
 * Idempotent system seed, run by the container entrypoint after `prisma migrate deploy`.
 *  - A12: the first workspace «إدارة المشاريع» (code `projects`) when none exists;
 *  - per ACTIVE workspace: default settings, team colour palette, default calendar, built-in card
 *    sizes and templates (every workspace has its own reference data);
 *  - the first OWNER from BOOTSTRAP_ADMIN_* (+ BOOTSTRAP_OWNER_USERNAME) — only when no owner and
 *    no admin exist at all — with mustChangePassword = true (brief §4.4) and an ADMIN membership
 *    of «إدارة المشاريع»;
 *  - A12: accounts named in BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_USERNAME (comma-separated)
 *    are promoted to OWNER (audited).
 * Demo/business data never comes from here (see seed/demo).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes, randomInt } from 'node:crypto';
import {
  cardTemplateConfigSchema,
  DEFAULT_SETTINGS,
  email as emailSchema,
  fullName as fullNameSchema,
  nationalIdCheckDigit,
  nationalId as nationalIdSchema,
  password as passwordSchema,
  saudiMobile,
  usernameSchema,
} from '@nuzli/shared';
import { z } from 'zod';
import { AuditAction } from '../audit/audit.service';
import { isPlaceholder } from '../config/secret-strength';
import { CryptoService } from '../crypto/crypto.service';
import { createScopedClient } from '../prisma/prisma.service';
import { runInWorkspace, runWithoutWorkspace } from '../prisma/workspace-context';
import { allocateUsername } from '../users/usernames';
import { BUILTIN_CARD_SIZES, BUILTIN_CARD_TEMPLATES, DEFAULT_CALENDAR, TEAM_PALETTE } from './seed-data';

export interface SeedEnv {
  NATIONAL_ID_ENC_KEY: string;
  NATIONAL_ID_ENC_KEYS_OLD?: string;
  NATIONAL_ID_HMAC_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
  BOOTSTRAP_ADMIN_NAME?: string;
  BOOTSTRAP_ADMIN_MOBILE?: string;
  BOOTSTRAP_ADMIN_NATIONAL_ID?: string;
  /** A12: the first owner's username (e.g. mmansary); generated from the e-mail when absent. */
  BOOTSTRAP_OWNER_USERNAME?: string;
  /** A12 round 2: the first owner's one-time password (else BOOTSTRAP_ADMIN_PASSWORD, else generated and logged once). */
  BOOTSTRAP_OWNER_PASSWORD?: string;
  /** A12 round 2 (deployment): the URL the API uses as nuzli_app; its password is applied to the role. */
  APP_DATABASE_URL?: string;
  /** A12: existing accounts (e-mails, comma-separated) to promote to OWNER. */
  BOOTSTRAP_OWNER_EMAIL?: string;
}

export interface SeedResult {
  settingsCreated: number;
  colorsCreated: number;
  cardSizesCreated: number;
  cardTemplatesCreated: number;
  calendarCreated: boolean;
  adminCreated: boolean;
}

/** A12: the first workspace (all pre-A12 data was migrated into it). */
export const FIRST_WORKSPACE = { code: 'projects', name: 'إدارة المشاريع' } as const;

const bootstrapSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  mobile: saudiMobile,
  nationalId: nationalIdSchema,
  username: usernameSchema.optional(),
});

type Log = (message: string) => void;

/** The seed always works through the workspace-scoped client (RLS-safe as nuzli_app or as owner). */
function scoped(prisma: PrismaClient): PrismaClient {
  return (prisma as unknown as { $base?: unknown }).$base ? prisma : createScopedClient(prisma);
}

export async function runSeed(raw: PrismaClient, env: SeedEnv, log: Log = console.log): Promise<SeedResult> {
  const prisma = scoped(raw);
  const first = await prisma.workspace.upsert({
    where: { code: FIRST_WORKSPACE.code },
    create: { code: FIRST_WORKSPACE.code, name: FIRST_WORKSPACE.name },
    update: {},
    select: { id: true },
  });
  const workspaces = await prisma.workspace.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const total: SeedResult = {
    settingsCreated: 0,
    colorsCreated: 0,
    cardSizesCreated: 0,
    cardTemplatesCreated: 0,
    calendarCreated: false,
    adminCreated: false,
  };
  for (const ws of workspaces) {
    const r = await runInWorkspace(ws.id, () => seedWorkspaceDefaults(prisma), 'seed');
    total.settingsCreated += r.settingsCreated;
    total.colorsCreated += r.colorsCreated;
    total.cardSizesCreated += r.cardSizesCreated;
    total.cardTemplatesCreated += r.cardTemplatesCreated;
    total.calendarCreated = total.calendarCreated || r.calendarCreated;
  }
  total.adminCreated = await runWithoutWorkspace(() => bootstrapAdmin(prisma, env, log, first.id), 'seed');
  await runWithoutWorkspace(() => promoteOwnersFromEnv(prisma, env, log), 'seed');
  await ensureAppRoleGrants(prisma, log);
  await ensureAppRoleLogin(prisma, env.APP_DATABASE_URL, log);
  log(`[seed] ${JSON.stringify(total)}`);
  return total;
}

/** Default reference data of the ACTIVE workspace (idempotent; also used when a workspace is created). */
export async function seedWorkspaceDefaults(prisma: PrismaClient): Promise<Omit<SeedResult, 'adminCreated'>> {
  const settings = await prisma.setting.createMany({
    data: Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
      key,
      value: value as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  const colors = await prisma.teamColor.createMany({
    data: TEAM_PALETTE.map((c, i) => ({ name: c.name, hex: c.hex, sortOrder: i + 1 })),
    skipDuplicates: true,
  });

  const sizes = await prisma.cardSize.createMany({
    data: BUILTIN_CARD_SIZES.map((s) => ({ ...s, isBuiltin: true })),
    skipDuplicates: true,
  });

  const cardTemplatesCreated = await seedCardTemplates(prisma);

  let calendarCreated = false;
  if (!(await prisma.calendar.findFirst({ where: { isDefault: true } }))) {
    await prisma.calendar.create({ data: { ...DEFAULT_CALENDAR, isDefault: true } });
    calendarCreated = true;
  }
  return {
    settingsCreated: settings.count,
    colorsCreated: colors.count,
    cardSizesCreated: sizes.count,
    cardTemplatesCreated,
    calendarCreated,
  };
}

/** Built-in templates by name (idempotent); never steals the default from an admin choice. */
export async function seedCardTemplates(prisma: PrismaClient): Promise<number> {
  let created = 0;
  for (const t of BUILTIN_CARD_TEMPLATES) {
    if (await prisma.cardTemplate.findFirst({ where: { name: t.name }, select: { id: true } })) continue;
    const size = await prisma.cardSize.findFirst({ where: { name: t.sizeName }, select: { id: true } });
    if (!size) continue;
    const hasDefault = !!(await prisma.cardTemplate.findFirst({
      where: { isDefault: true, archivedAt: null },
      select: { id: true },
    }));
    await prisma.cardTemplate.create({
      data: {
        name: t.name,
        sizeId: size.id,
        orientation: t.orientation,
        layoutKey: t.layoutKey,
        config: cardTemplateConfigSchema.parse(t.config) as Prisma.InputJsonValue,
        isDefault: t.isDefault && !hasDefault,
      },
    });
    created++;
  }
  return created;
}

/**
 * The first account of a fresh system: an OWNER (A12) who is also ADMIN of the first workspace.
 * Created only when there is no owner and no admin membership at all.
 *
 * A12 round 2: `BOOTSTRAP_OWNER_USERNAME` (e.g. mmansary) is enough. The password is
 * `BOOTSTRAP_OWNER_PASSWORD` (or the older `BOOTSTRAP_ADMIN_PASSWORD`); when neither is set a
 * random temporary password is generated and printed ONCE to the server log on this first boot —
 * only its argon2id hash is stored. E-mail, mobile and national ID come from `BOOTSTRAP_ADMIN_*`
 * when given, else neutral placeholders the owner replaces in user management. The owner must
 * change the password at first login.
 */
export async function bootstrapAdmin(prisma: PrismaClient, env: SeedEnv, log: Log, workspaceId?: string): Promise<boolean> {
  const owners = await prisma.user.count({ where: { accountRole: 'OWNER' } });
  const admins = owners ? 0 : await prisma.workspaceMembership.count({ where: { role: 'ADMIN', archivedAt: null } });
  if (owners > 0 || admins > 0) return false;

  const username = (env.BOOTSTRAP_OWNER_USERNAME ?? '').split(',')[0]?.trim().toLowerCase() || undefined;
  const given = env.BOOTSTRAP_OWNER_PASSWORD || env.BOOTSTRAP_ADMIN_PASSWORD || undefined;
  const generated = given ? null : temporaryPassword();
  // Each identity field falls back to a neutral placeholder when absent (username-only bootstrap).
  const ph = username ? placeholderIdentity(username) : null;
  const placeholder = ph && (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_MOBILE || !env.BOOTSTRAP_ADMIN_NATIONAL_ID) ? ph : null;
  const parsed = bootstrapSchema.safeParse({
    email: env.BOOTSTRAP_ADMIN_EMAIL || ph?.email,
    password: given ?? generated,
    fullName: env.BOOTSTRAP_ADMIN_NAME || 'المالك',
    mobile: env.BOOTSTRAP_ADMIN_MOBILE || ph?.mobile,
    nationalId: env.BOOTSTRAP_ADMIN_NATIONAL_ID || ph?.nationalId,
    username,
  });
  if (!parsed.success) {
    // Field names only — never the values (they include a password and a national ID).
    const fields = [...new Set(parsed.error.issues.map((i) => (i.path[0] === 'username' ? 'BOOTSTRAP_OWNER_USERNAME' : i.path[0] === 'password' ? 'BOOTSTRAP_OWNER_PASSWORD' : `BOOTSTRAP_ADMIN_${String(i.path[0]).toUpperCase()}`)))];
    throw new Error(
      `[seed] No owner exists and the bootstrap owner settings are missing or invalid: ${fields.join(', ')} (set BOOTSTRAP_OWNER_USERNAME at least)`,
    );
  }
  // Security review H1: the example value is public, so whoever logs in first would own the
  // admin (mustChangePassword lets them pick the new password). Refused in every environment.
  if (isPlaceholder(parsed.data.password)) {
    throw new Error(
      '[seed] BOOTSTRAP_OWNER_PASSWORD / BOOTSTRAP_ADMIN_PASSWORD is still the CHANGE_ME placeholder from the example env; set a real one-time password or leave it empty to get a generated one.',
    );
  }
  const crypto = new CryptoService({
    encKey: env.NATIONAL_ID_ENC_KEY,
    oldEncKeys: (env.NATIONAL_ID_ENC_KEYS_OLD ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    hmacKey: env.NATIONAL_ID_HMAC_KEY,
  });
  const nid = crypto.protectNationalId(parsed.data.nationalId);
  const passwordHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
  const ws =
    workspaceId ??
    (await prisma.workspace.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id;

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: await allocateUsername(tx, parsed.data.email, parsed.data.username),
        accountRole: 'OWNER',
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        mobile: parsed.data.mobile,
        nationalIdEnc: nid.enc,
        nationalIdHash: nid.hash,
        nationalIdFirst: nid.first,
        nationalIdLast2: nid.last2,
        passwordHash,
        status: 'ACTIVE',
        mustChangePassword: true,
        approvedAt: new Date(),
        ...(ws ? { memberships: { create: { workspaceId: ws, role: 'ADMIN' } } } : {}),
      },
    });
    // Account-level entry (workspace NULL): visible to owners only.
    await tx.auditLog.create({
      data: {
        action: AuditAction.BOOTSTRAP_ADMIN_CREATED,
        entityType: 'user',
        entityId: user.id,
        after: {
          id: user.id,
          email: user.email,
          username: user.username,
          accountRole: 'OWNER',
          role: 'ADMIN',
          status: 'ACTIVE',
          generatedPassword: !!generated,
          placeholderIdentity: !!placeholder,
        },
      },
    });
    return user;
  });
  if (generated) {
    // Shown ONCE (this run created the owner; later starts find it and skip). Never stored in clear.
    log(`[seed] Bootstrap owner "${created.username}" created. Temporary password (shown once — change it at first login): ${generated}`);
  } else {
    log(`[seed] Bootstrap owner "${created.username}" created; a password change is required at first login.`);
  }
  if (placeholder) log('[seed] The owner has placeholder e-mail / mobile / national ID: set the real ones in user management.');
  return true;
}

/** A random temporary password that satisfies the password rule (letters + digits, ≥ 10). */
export function temporaryPassword(): string {
  const raw = randomBytes(18).toString('base64url').replace(/[-_]/g, '');
  return `Nz${raw.slice(0, 14)}${randomInt(10, 99)}`;
}

/**
 * Neutral identity placeholders for a username-only bootstrap: an e-mail on the reserved
 * `.invalid` domain, a random Saudi-format mobile, and a valid-format national ID that starts
 * with 2 and is random — all replaceable later; none of it is personal data.
 */
export function placeholderIdentity(username: string): { email: string; mobile: string; nationalId: string } {
  const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join('');
  const first9 = `2${digits(8)}`;
  return {
    email: `${username}@owner.nuzli.invalid`,
    mobile: `+9665${digits(8)}`,
    nationalId: first9 + nationalIdCheckDigit(first9),
  };
}

/** A12: promotes the accounts named in BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_USERNAME to OWNER. */
export async function promoteOwnersFromEnv(prisma: PrismaClient, env: SeedEnv, log: Log): Promise<number> {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const emails = list(env.BOOTSTRAP_OWNER_EMAIL);
  const usernames = list(env.BOOTSTRAP_OWNER_USERNAME);
  if (!emails.length && !usernames.length) return 0;
  const users = await prisma.user.findMany({
    where: { accountRole: 'USER', status: 'ACTIVE', OR: [{ email: { in: emails } }, { username: { in: usernames } }] },
    select: { id: true, email: true, username: true },
  });
  for (const u of users) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { accountRole: 'OWNER' } });
      await tx.auditLog.create({
        data: {
          action: AuditAction.OWNER_PROMOTED,
          entityType: 'user',
          entityId: u.id,
          before: { accountRole: 'USER' },
          after: { accountRole: 'OWNER', source: 'BOOTSTRAP_OWNER_*' },
        },
      });
    });
    log(`[seed] ${u.username} promoted to owner.`);
  }
  return users.length;
}

/**
 * A12 round 2 (deployment, ADR-152): gives the role `nuzli_app` LOGIN and the password of
 * APP_DATABASE_URL, at every start (idempotent; a changed password applies at the next start).
 * Runs as the migrator, which may alter roles (the postgres image's POSTGRES_USER is a superuser).
 * The password crosses as a bound parameter into set_config and is quoted by format(%L) — it is
 * never interpolated into SQL text and never logged.
 */
export async function ensureAppRoleLogin(prisma: PrismaClient, appUrl: string | undefined, log: Log): Promise<boolean> {
  if (!appUrl) return false;
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    log('[seed] APP_DATABASE_URL is not a valid URL; nuzli_app was not configured.');
    return false;
  }
  if (decodeURIComponent(url.username) !== 'nuzli_app' || !url.password) {
    log('[seed] APP_DATABASE_URL must name the role nuzli_app with a password; nuzli_app was not configured.');
    return false;
  }
  if (isPlaceholder(url.password)) throw new Error('[seed] APP_DATABASE_URL still has the CHANGE_ME placeholder password.');
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SELECT set_config('nuzli.app_role_password', ${decodeURIComponent(url.password)}, true)`,
      prisma.$executeRawUnsafe(
        `DO $do$ BEGIN EXECUTE format('ALTER ROLE nuzli_app LOGIN PASSWORD %L', current_setting('nuzli.app_role_password')); END $do$`,
      ),
    ]);
    log('[seed] nuzli_app can log in (password from APP_DATABASE_URL); the API connects with it.');
    return true;
  } catch (err) {
    log(`[seed] could not configure nuzli_app: ${(err as Error).message.split(String.fromCharCode(10))[0]}`);
    return false;
  }
}

/**
 * A12 (ADR-143): the API role `nuzli_app` needs DML on every table. The migration grants it once;
 * backups are dumped with --no-privileges, so after a restore the grants are gone. The seed runs at
 * every start (as the migrator) and re-grants idempotently. Skipped when the role does not exist or
 * the migrator may not grant.
 */
export async function ensureAppRoleGrants(prisma: PrismaClient, log: Log): Promise<void> {
  try {
    const role = await prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT true AS ok FROM pg_roles WHERE rolname = 'nuzli_app'`;
    if (!role.length) return;
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO nuzli_app');
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nuzli_app');
    await prisma.$executeRawUnsafe('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nuzli_app');
    const migrations = await prisma.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('public._prisma_migrations')::text AS t`;
    if (migrations[0]?.t) await prisma.$executeRawUnsafe('REVOKE ALL ON TABLE _prisma_migrations FROM nuzli_app');
  } catch (err) {
    log(`[seed] could not (re)grant nuzli_app: ${(err as Error).message.split('\n')[0]}`);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, process.env as unknown as SeedEnv);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
