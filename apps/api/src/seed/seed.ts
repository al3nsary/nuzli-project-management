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
import {
  cardTemplateConfigSchema,
  DEFAULT_SETTINGS,
  email as emailSchema,
  fullName as fullNameSchema,
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
 */
export async function bootstrapAdmin(prisma: PrismaClient, env: SeedEnv, log: Log, workspaceId?: string): Promise<boolean> {
  const owners = await prisma.user.count({ where: { accountRole: 'OWNER' } });
  const admins = owners ? 0 : await prisma.workspaceMembership.count({ where: { role: 'ADMIN', archivedAt: null } });
  if (owners > 0 || admins > 0) return false;

  const parsed = bootstrapSchema.safeParse({
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
    fullName: env.BOOTSTRAP_ADMIN_NAME ?? 'مدير النظام',
    mobile: env.BOOTSTRAP_ADMIN_MOBILE,
    nationalId: env.BOOTSTRAP_ADMIN_NATIONAL_ID,
    username: env.BOOTSTRAP_OWNER_USERNAME || undefined,
  });
  if (!parsed.success) {
    // Field names only — never the values (they include a password and a national ID).
    const fields = [...new Set(parsed.error.issues.map((i) => (i.path[0] === 'username' ? 'BOOTSTRAP_OWNER_USERNAME' : `BOOTSTRAP_ADMIN_${String(i.path[0]).toUpperCase()}`)))];
    throw new Error(
      `[seed] No owner exists and the bootstrap owner settings are missing or invalid: ${fields.join(', ')}`,
    );
  }
  // Security review H1: the example value is public, so whoever logs in first would own the
  // admin (mustChangePassword lets them pick the new password). Refused in every environment.
  if (isPlaceholder(parsed.data.password)) {
    throw new Error(
      '[seed] BOOTSTRAP_ADMIN_PASSWORD is still the CHANGE_ME placeholder from .env.example; set a real one-time password.',
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

  await prisma.$transaction(async (tx) => {
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
        after: { id: user.id, email: user.email, username: user.username, accountRole: 'OWNER', role: 'ADMIN', status: 'ACTIVE' },
      },
    });
  });
  log(`[seed] Bootstrap owner created (${parsed.data.email}); a password change is required at first login.`);
  return true;
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
