/**
 * Idempotent system seed, run by the container entrypoint after `prisma migrate deploy`.
 *  - default settings, team colour palette, default calendar, built-in card sizes;
 *  - the first admin from BOOTSTRAP_ADMIN_* — only when there is no admin at all, with
 *    mustChangePassword = true (brief §4.4).
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
} from '@nuzli/shared';
import { z } from 'zod';
import { AuditAction } from '../audit/audit.service';
import { isPlaceholder } from '../config/secret-strength';
import { CryptoService } from '../crypto/crypto.service';
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
}

export interface SeedResult {
  settingsCreated: number;
  colorsCreated: number;
  cardSizesCreated: number;
  cardTemplatesCreated: number;
  calendarCreated: boolean;
  adminCreated: boolean;
}

const bootstrapSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  mobile: saudiMobile,
  nationalId: nationalIdSchema,
});

type Log = (message: string) => void;

export async function runSeed(prisma: PrismaClient, env: SeedEnv, log: Log = console.log): Promise<SeedResult> {
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

  const adminCreated = await bootstrapAdmin(prisma, env, log);
  const result: SeedResult = {
    settingsCreated: settings.count,
    colorsCreated: colors.count,
    cardSizesCreated: sizes.count,
    cardTemplatesCreated,
    calendarCreated,
    adminCreated,
  };
  log(`[seed] ${JSON.stringify(result)}`);
  return result;
}

/** Built-in templates by name (idempotent); never steals the default from an admin choice. */
export async function seedCardTemplates(prisma: PrismaClient): Promise<number> {
  let created = 0;
  for (const t of BUILTIN_CARD_TEMPLATES) {
    if (await prisma.cardTemplate.findFirst({ where: { name: t.name }, select: { id: true } })) continue;
    const size = await prisma.cardSize.findUnique({ where: { name: t.sizeName }, select: { id: true } });
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

export async function bootstrapAdmin(prisma: PrismaClient, env: SeedEnv, log: Log): Promise<boolean> {
  const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
  if (admins > 0) return false;

  const parsed = bootstrapSchema.safeParse({
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
    fullName: env.BOOTSTRAP_ADMIN_NAME ?? 'مدير النظام',
    mobile: env.BOOTSTRAP_ADMIN_MOBILE,
    nationalId: env.BOOTSTRAP_ADMIN_NATIONAL_ID,
  });
  if (!parsed.success) {
    // Field names only — never the values (they include a password and a national ID).
    const fields = [...new Set(parsed.error.issues.map((i) => `BOOTSTRAP_ADMIN_${String(i.path[0]).toUpperCase()}`))];
    throw new Error(
      `[seed] No admin exists and the bootstrap admin settings are missing or invalid: ${fields.join(', ')}`,
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

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        mobile: parsed.data.mobile,
        nationalIdEnc: nid.enc,
        nationalIdHash: nid.hash,
        nationalIdFirst: nid.first,
        nationalIdLast2: nid.last2,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        mustChangePassword: true,
        approvedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        action: AuditAction.BOOTSTRAP_ADMIN_CREATED,
        entityType: 'user',
        entityId: user.id,
        after: { id: user.id, email: user.email, role: 'ADMIN', status: 'ACTIVE' },
      },
    });
  });
  log(`[seed] Bootstrap admin created (${parsed.data.email}); a password change is required at first login.`);
  return true;
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
