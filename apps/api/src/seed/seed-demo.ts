/**
 * DEMO DATA ONLY (brief §0 rule 2, CLAUDE.md rule 3) — `npm run seed:demo`.
 * Loads the clearly-marked demo teams and members from `seed/demo/*.json` (the same files the
 * GitHub Pages DemoApi reads) when `teams.json` or `members.json` exist; otherwise does nothing.
 * Idempotent: teams are matched by id (or by name), members by national ID (blind index);
 * history rows are written only for teams/members created in this run.
 *
 * Files and the fields read (extra fields are ignored):
 *   teams.json     { teams: [{ id, name, colorId | colorHex, supervisorId | supervisorEmail, status,
 *                              createdAt?, archivedAt? }], supervisorHistory?: [{ teamId, supervisorId,
 *                              validFrom, validTo, reason, isPrimary? }] }  (A9: rows → team_supervisors)
 *   members.json   { members: [{ id, fullName, nationalId, jobTitleId | jobTitle(Text), departmentId |
 *                                department(Text), status?, teamId? }], memberships?: [{ memberId, teamId,
 *                                validFrom, validTo, reason }] }
 *   colors.json    { colors: [{ id, hex }] }          — demo colour ids → palette colour by hex
 *   reference.json { departments: [{ id, name }], jobTitles: [{ id, name }] } — created by name if missing
 *   users.json     { users: [...] } — a supervisor missing from the database is created from here
 *                  (ACTIVE, no password: use "forgot password").
 *   violation-types.json { types: [{ name, severity? }] } — optional; without it the placeholder
 *                  list below is used. Violation types are loaded even when teams/members are absent.
 */
import { PrismaClient, type Prisma, type TeamStatus } from '@prisma/client';
import { createScopedClient } from '../prisma/prisma.service';
import { runInWorkspace } from '../prisma/workspace-context';
import { supervisorsOf } from '../users/user-dto';
import { allocateUsername } from '../users/usernames';
import { FIRST_WORKSPACE } from './seed';
import { fullName as fullNameSchema, nationalId as nationalIdSchema } from '@nuzli/shared';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CryptoService } from '../crypto/crypto.service';
import type { SeedEnv } from './seed';

/**
 * DEMO PLACEHOLDERS — not business data. The real catalogue is entered by the owner in the
 * admin screens (the system seed creates no violation types). Every name carries «(تجريبي)».
 */
export const DEMO_VIOLATION_TYPES: Array<{ name: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null }> = [
  { name: 'نوع مخالفة تجريبي ١ (تجريبي)', severity: 'LOW' },
  { name: 'نوع مخالفة تجريبي ٢ (تجريبي)', severity: 'MEDIUM' },
  { name: 'نوع مخالفة تجريبي ٣ (تجريبي)', severity: 'HIGH' },
];

const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

type Json = Record<string, unknown>;
type Log = (message: string) => void;

export interface DemoSeedResult {
  skipped: boolean;
  teamsCreated: number;
  membersCreated: number;
  supervisorsCreated: number;
  referenceCreated: number;
  violationTypesCreated: number;
}

export function demoDir(env: NodeJS.ProcessEnv = process.env): string {
  // src/seed and dist/seed are both four levels below the repository root.
  return env.SEED_DEMO_DIR ?? path.resolve(__dirname, '../../../../seed/demo');
}

function readFile(dir: string, name: string): Json | Json[] | null {
  const file = path.join(dir, name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Json | Json[];
}

function list(data: Json | Json[] | null, key: string): Json[] {
  if (!data) return [];
  const raw = Array.isArray(data) ? data : data[key];
  return Array.isArray(raw) ? (raw.filter((x) => x && typeof x === 'object') as Json[]) : [];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const date = (v: unknown): Date | undefined => {
  const s = str(v);
  const d = s ? new Date(s) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

/**
 * A12: the demo data goes into the first workspace «إدارة المشاريع», through the
 * workspace-scoped client (so it works under Row Level Security too).
 */
export async function runDemoSeed(
  raw: PrismaClient,
  env: SeedEnv & NodeJS.ProcessEnv,
  log: Log = console.log,
): Promise<DemoSeedResult> {
  const prisma = (raw as unknown as { $base?: unknown }).$base ? raw : createScopedClient(raw);
  const ws = await prisma.workspace.findUnique({ where: { code: FIRST_WORKSPACE.code }, select: { id: true } });
  if (!ws) throw new Error('[seed:demo] run the system seed first (no «إدارة المشاريع» workspace)');
  return runInWorkspace(ws.id, () => runDemoSeedIn(prisma, ws.id, env, log), 'seed:demo');
}

async function runDemoSeedIn(
  prisma: PrismaClient,
  workspaceId: string,
  env: SeedEnv & NodeJS.ProcessEnv,
  log: Log,
): Promise<DemoSeedResult> {
  const dir = demoDir(env);
  const teamsFile = readFile(dir, 'teams.json');
  const membersFile = readFile(dir, 'members.json');
  const result: DemoSeedResult = {
    skipped: false,
    teamsCreated: 0,
    membersCreated: 0,
    supervisorsCreated: 0,
    referenceCreated: 0,
    violationTypesCreated: 0,
  };
  result.violationTypesCreated = await seedDemoViolationTypes(prisma, dir);
  if (!teamsFile && !membersFile) {
    log(`[seed:demo] No seed/demo/teams.json or members.json in ${dir} — nothing to load.`);
    return { ...result, skipped: true };
  }
  const users = list(readFile(dir, 'users.json'), 'users');
  const demoColors = list(readFile(dir, 'colors.json'), 'colors');
  const referenceFile = readFile(dir, 'reference.json');
  const crypto = new CryptoService({
    encKey: env.NATIONAL_ID_ENC_KEY,
    oldEncKeys: (env.NATIONAL_ID_ENC_KEYS_OLD ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    hmacKey: env.NATIONAL_ID_HMAC_KEY,
  });

  const existingUser = async (id: unknown): Promise<string | null> => {
    const s = str(id);
    if (!s) return null;
    return (await prisma.user.findUnique({ where: { id: s }, select: { id: true } }))?.id ?? null;
  };

  // ── reference lists: demo id → database id (created by name when missing)
  const refIds = { department: new Map<string, string>(), job_title: new Map<string, string>() };
  const refByName = { department: new Map<string, string>(), job_title: new Map<string, string>() };
  for (const [kind, key] of [['department', 'departments'], ['job_title', 'jobTitles']] as const) {
    const delegate = (kind === 'department' ? prisma.department : prisma.jobTitle) as unknown as {
      findFirst(a: object): Promise<{ id: string } | null>;
      create(a: object): Promise<{ id: string }>;
      findMany(a: object): Promise<Array<{ id: string; name: string }>>;
    };
    for (const item of list(referenceFile, key)) {
      const name = str(item.name);
      if (!name) continue;
      let row = await delegate.findFirst({ where: { name }, select: { id: true } });
      if (!row) {
        row = await delegate.create({ data: { name }, select: { id: true } });
        result.referenceCreated++;
      }
      if (str(item.id)) refIds[kind].set(str(item.id)!, row.id);
    }
    for (const r of await delegate.findMany({ where: { isActive: true }, select: { id: true, name: true } })) {
      refByName[kind].set(r.name, r.id);
    }
  }

  // ── supervisors
  const supervisorFor = async (t: Json): Promise<string | null> => {
    const id = str(t.supervisorId);
    const email = str(t.supervisorEmail)?.toLowerCase();
    const found = await prisma.user.findFirst({
      where: { ...supervisorsOf(workspaceId), OR: [...(id ? [{ id }] : []), ...(email ? [{ email }] : [])] },
      select: { id: true },
    });
    if (found) return found.id;
    const demo = users.find((u) => (id && u.id === id) || (email && str(u.email)?.toLowerCase() === email));
    if (!demo || demo.role !== 'SUPERVISOR') return null;
    const nid = nationalIdSchema.safeParse(str(demo.nationalId) ?? '');
    if (!nid.success || !str(demo.email) || !str(demo.mobile) || !str(demo.fullName)) return null;
    const p = crypto.protectNationalId(nid.data);
    const clash = await prisma.user.findFirst({
      where: {
        OR: [{ email: str(demo.email)!.toLowerCase() }, { mobile: str(demo.mobile)! }, { nationalIdHash: p.hash }],
      },
      select: { id: true },
    });
    if (clash) return null;
    const created = await prisma.user.create({
      data: {
        ...(str(demo.id) ? { id: str(demo.id)! } : {}),
        username: await allocateUsername(prisma, str(demo.email)!.toLowerCase()),
        fullName: str(demo.fullName)!,
        email: str(demo.email)!.toLowerCase(),
        mobile: str(demo.mobile)!,
        nationalIdEnc: p.enc,
        nationalIdHash: p.hash,
        nationalIdFirst: p.first,
        nationalIdLast2: p.last2,
        status: demo.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        approvedAt: new Date(),
        memberships: { create: { workspaceId, role: 'SUPERVISOR' } },
      },
      select: { id: true },
    });
    result.supervisorsCreated++;
    return created.id;
  };

  // ── teams
  const palette = await prisma.teamColor.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  const demoHex = new Map(demoColors.map((c) => [str(c.id) ?? '', str(c.hex)?.toUpperCase() ?? '']));
  const history = list(teamsFile, 'supervisorHistory');
  const teamIds = new Map<string, string>(); // demo id or name → database id
  for (const t of list(teamsFile, 'teams')) {
    const name = str(t.name);
    if (!name) continue;
    const jsonId = str(t.id);
    const existing = await prisma.team.findFirst({
      where: jsonId ? { OR: [{ id: jsonId }, { name, status: { not: 'ARCHIVED' } }] } : { name, status: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    if (existing) {
      if (jsonId) teamIds.set(jsonId, existing.id);
      teamIds.set(name, existing.id);
      continue;
    }
    const supervisorId = await supervisorFor(t);
    if (!supervisorId) {
      log(`[seed:demo] Team «${name}» skipped: its supervisor is unknown.`);
      continue;
    }
    const status: TeamStatus =
      t.status === 'PENDING_APPROVAL' ? 'PENDING_APPROVAL' : t.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
    const reserved = new Set(
      (
        await prisma.team.findMany({
          where: { status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
          select: { colorId: true },
        })
      ).map((r) => r.colorId),
    );
    const hex = str(t.colorHex)?.toUpperCase() ?? demoHex.get(str(t.colorId) ?? '');
    const free = (c: { id: string }) => status === 'ARCHIVED' || !reserved.has(c.id);
    const color = palette.find((c) => c.hex.toUpperCase() === hex && free(c)) ?? palette.find(free);
    if (!color) {
      log(`[seed:demo] Team «${name}» skipped: no free colour left in the palette.`);
      continue;
    }
    const createdAt = date(t.createdAt) ?? new Date();
    const archivedAt = status === 'ARCHIVED' ? (date(t.archivedAt) ?? new Date()) : null;
    const rows = history.filter((h) => str(h.teamId) === jsonId);
    const team = await prisma.$transaction(async (tx) => {
      const created = await tx.team.create({
        data: {
          ...(jsonId ? { id: jsonId } : {}),
          name,
          colorId: color.id,
          supervisorId,
          status,
          createdAt,
          archivedAt,
          ...(status !== 'PENDING_APPROVAL' ? { approvedAt: createdAt } : {}),
        },
        select: { id: true },
      });
      // A9 (ADR-100): leadership rows live in team_supervisors; `isPrimary` defaults to true
      // (the old single-supervisor files), an archived team's open rows end at archivedAt.
      const historyRows: Prisma.TeamSupervisorCreateManyInput[] = [];
      for (const h of rows) {
        const sup = (await existingUser(h.supervisorId)) ?? null;
        const from = date(h.validFrom);
        if (!sup || !from) continue;
        historyRows.push({
          teamId: created.id,
          userId: sup,
          isPrimary: h.isPrimary === false ? false : true,
          validFrom: from,
          validTo: date(h.validTo) ?? archivedAt,
          addedById: await existingUser(h.changedById),
          reason: str(h.reason) ?? null,
        });
      }
      if (!historyRows.length) {
        historyRows.push({ teamId: created.id, userId: supervisorId, isPrimary: true, validFrom: createdAt, validTo: archivedAt });
      }
      await tx.teamSupervisor.createMany({ data: historyRows });
      return created;
    });
    if (jsonId) teamIds.set(jsonId, team.id);
    teamIds.set(name, team.id);
    result.teamsCreated++;
  }

  // ── members and their membership history
  const memberships = list(membersFile, 'memberships');
  for (const m of list(membersFile, 'members')) {
    const name = fullNameSchema.safeParse(str(m.fullName) ?? '');
    const nid = nationalIdSchema.safeParse(str(m.nationalId) ?? '');
    if (!name.success || !nid.success) continue;
    const p = crypto.protectNationalId(nid.data);
    if (await prisma.teamMember.findFirst({ where: { nationalIdHash: p.hash }, select: { id: true } })) continue;
    const jsonId = str(m.id);
    const jobId =
      refIds.job_title.get(str(m.jobTitleId) ?? '') ?? refByName.job_title.get(str(m.jobTitle) ?? str(m.jobTitleText) ?? '');
    const depId =
      refIds.department.get(str(m.departmentId) ?? '') ??
      refByName.department.get(str(m.department) ?? str(m.departmentText) ?? '');
    const rows = memberships
      .filter((r) => jsonId && str(r.memberId) === jsonId)
      .map((r) => ({ teamId: teamIds.get(str(r.teamId) ?? ''), from: date(r.validFrom), to: date(r.validTo), r }))
      .filter((r): r is { teamId: string; from: Date; to: Date | undefined; r: Json } => !!r.teamId && !!r.from);
    const simpleTeam = teamIds.get(str(m.teamId) ?? str(m.teamName) ?? '');
    await prisma.$transaction(async (tx) => {
      const created = await tx.teamMember.create({
        data: {
          ...(jsonId ? { id: jsonId } : {}),
          fullName: name.data,
          nationalIdEnc: p.enc,
          nationalIdHash: p.hash,
          nationalIdFirst: p.first,
          nationalIdLast4: p.last4,
          jobTitleId: jobId ?? null,
          jobTitleText: jobId ? null : (str(m.jobTitleText) ?? str(m.jobTitle) ?? null),
          departmentId: depId ?? null,
          departmentText: depId ? null : (str(m.departmentText) ?? str(m.department) ?? null),
          status: m.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
          ...(date(m.createdAt) ? { createdAt: date(m.createdAt)! } : {}),
        },
        select: { id: true },
      });
      const data: Prisma.TeamMembershipCreateManyInput[] = [];
      for (const r of rows) {
        data.push({
          memberId: created.id,
          teamId: r.teamId,
          validFrom: r.from,
          validTo: r.to ?? null,
          movedById: await existingUser(r.r.movedById),
          reason: str(r.r.reason) ?? null,
        });
      }
      if (!data.length && simpleTeam) data.push({ memberId: created.id, teamId: simpleTeam, validFrom: new Date() });
      if (data.length) await tx.teamMembership.createMany({ data });
    });
    result.membersCreated++;
  }
  log(`[seed:demo] ${JSON.stringify(result)}`);
  return result;
}

/** Placeholder violation types, created by name when missing (idempotent). */
export async function seedDemoViolationTypes(prisma: PrismaClient, dir: string): Promise<number> {
  const fromFile = list(readFile(dir, 'violation-types.json'), 'types')
    .map((t) => ({
      name: str(t.name),
      severity: SEVERITIES.has(String(t.severity)) ? (t.severity as (typeof DEMO_VIOLATION_TYPES)[number]['severity']) : null,
    }))
    .filter((t): t is { name: string; severity: (typeof DEMO_VIOLATION_TYPES)[number]['severity'] } => !!t.name);
  let created = 0;
  for (const t of fromFile.length ? fromFile : DEMO_VIOLATION_TYPES) {
    const exists = await prisma.violationType.findFirst({ where: { name: t.name }, select: { id: true } });
    if (exists) continue;
    await prisma.violationType.create({ data: { name: t.name, severity: t.severity } });
    created++;
  }
  return created;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runDemoSeed(prisma, process.env as SeedEnv & NodeJS.ProcessEnv);
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
