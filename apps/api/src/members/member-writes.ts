import type { Prisma } from '@prisma/client';
import { can, ERRORS, type PermissionSubject } from '@nuzli/shared';
import { AuditAction, type AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { mapPrismaError } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import type { CryptoService } from '../crypto/crypto.service';

/** A member as accepted by `memberInputSchema` (after zod transforms). */
export interface MemberInputData {
  fullName: string;
  nationalId: string;
  jobTitleId?: string;
  jobTitleText?: string;
  departmentId?: string;
  departmentText?: string;
}

type Tx = Prisma.TransactionClient;

/** Unknown reference ids are a validation error on the field, not a 500 from the FK. */
export async function assertReferencesExist(
  tx: Tx,
  rows: ReadonlyArray<{ jobTitleId?: string | null; departmentId?: string | null }>,
  fieldPrefix = '',
): Promise<void> {
  const jobIds = [...new Set(rows.map((r) => r.jobTitleId).filter((v): v is string => !!v))];
  const depIds = [...new Set(rows.map((r) => r.departmentId).filter((v): v is string => !!v))];
  const [jobs, deps] = await Promise.all([
    jobIds.length ? tx.jobTitle.findMany({ where: { id: { in: jobIds } }, select: { id: true } }) : [],
    depIds.length ? tx.department.findMany({ where: { id: { in: depIds } }, select: { id: true } }) : [],
  ]);
  const okJobs = new Set(jobs.map((j) => j.id));
  const okDeps = new Set(deps.map((d) => d.id));
  const fieldErrors: Record<string, string[]> = {};
  rows.forEach((r, i) => {
    const at = fieldPrefix ? `${fieldPrefix}.${i}.` : '';
    if (r.jobTitleId && !okJobs.has(r.jobTitleId)) fieldErrors[`${at}jobTitleId`] = ['المسمّى الوظيفي غير موجود'];
    if (r.departmentId && !okDeps.has(r.departmentId)) fieldErrors[`${at}departmentId`] = ['الإدارة غير موجودة'];
  });
  if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
}

/**
 * Inserts new members and opens their membership in `teamId` at `at`.
 * Duplicate national IDs (inside the batch or already stored) → 409 NATIONAL_ID_TAKEN with
 * the offending field paths; the unique blind index still guards against races.
 */
export async function insertMembers(
  tx: Tx,
  crypto: CryptoService,
  inputs: readonly MemberInputData[],
  opts: { teamId: string; at: Date; actorId: string | null; reason?: string | null; fieldPrefix?: string },
): Promise<string[]> {
  if (!inputs.length) return [];
  const prefix = opts.fieldPrefix ?? 'members';
  const field = (i: number) => (prefix ? `${prefix}.${i}.nationalId` : 'nationalId');
  await assertReferencesExist(tx, inputs, prefix);

  const protectedIds = inputs.map((m) => crypto.protectNationalId(m.nationalId));
  const fieldErrors: Record<string, string[]> = {};
  const seen = new Map<string, number>();
  protectedIds.forEach((p, i) => {
    const first = seen.get(p.hash);
    if (first !== undefined) fieldErrors[field(i)] = [`رقم الهوية مكرّر (السطر ${first + 1})`];
    else seen.set(p.hash, i);
  });
  const existing = await tx.teamMember.findMany({
    where: { nationalIdHash: { in: [...seen.keys()] } },
    select: { nationalIdHash: true },
  });
  for (const e of existing) {
    const i = seen.get(e.nationalIdHash);
    if (i !== undefined) fieldErrors[field(i)] = [ERRORS.NATIONAL_ID_TAKEN];
  }
  if (Object.keys(fieldErrors).length) throw new AppError('NATIONAL_ID_TAKEN', { fieldErrors });

  const created = await tx.teamMember.createManyAndReturn({
    data: inputs.map((m, i) => {
      const p = protectedIds[i]!;
      return {
        fullName: m.fullName,
        nationalIdEnc: p.enc,
        nationalIdHash: p.hash,
        nationalIdFirst: p.first,
        nationalIdLast4: p.last4,
        jobTitleId: m.jobTitleId ?? null,
        jobTitleText: m.jobTitleId ? null : (m.jobTitleText ?? null),
        departmentId: m.departmentId ?? null,
        departmentText: m.departmentId ? null : (m.departmentText ?? null),
        createdById: opts.actorId,
      };
    }),
    select: { id: true, nationalIdHash: true },
  });
  // createManyAndReturn does not promise input order; map back through the blind index.
  const idByHash = new Map(created.map((c) => [c.nationalIdHash, c.id]));
  const ids = protectedIds.map((p) => idByHash.get(p.hash)!);
  await tx.teamMembership.createMany({
    data: ids.map((memberId) => ({
      memberId,
      teamId: opts.teamId,
      validFrom: opts.at,
      movedById: opts.actorId,
      reason: opts.reason ?? null,
    })),
  });
  return ids;
}

/**
 * A12 round 2: the checks `insertMembers` makes (references, duplicates in the batch and in the
 * workspace) without inserting — a supervisor's inline workers become requests after the commit.
 */
export async function assertNewMembersInsertable(tx: Tx, crypto: CryptoService, inputs: readonly MemberInputData[], prefix = 'members'): Promise<void> {
  await assertReferencesExist(tx, inputs, prefix);
  const hashes = inputs.map((m) => crypto.blindIndex(m.nationalId));
  const fieldErrors: Record<string, string[]> = {};
  hashes.forEach((h, i) => {
    if (hashes.indexOf(h) !== i) fieldErrors[`${prefix}.${i}.nationalId`] = [`رقم الهوية مكرّر (السطر ${hashes.indexOf(h) + 1})`];
  });
  const existing = await tx.teamMember.findMany({ where: { nationalIdHash: { in: hashes } }, select: { nationalIdHash: true } });
  for (const e of existing) fieldErrors[`${prefix}.${hashes.indexOf(e.nationalIdHash)}.nationalId`] = [ERRORS.NATIONAL_ID_TAKEN];
  if (Object.keys(fieldErrors).length) throw new AppError('NATIONAL_ID_TAKEN', { fieldErrors });
}

export interface MoveRecord {
  memberId: string;
  fromTeamId: string | null;
  /** A9 (ADR-101): the closed membership was the team's foreman — the flag ends with it. */
  wasForeman?: boolean;
}

/**
 * ADR-013: closes each open membership with `valid_to = at` and opens the new one with
 * `valid_from = at` — the same instant, taken once by the caller — so the intervals are
 * contiguous and never overlap (the exclusion constraint holds).
 */
export async function moveMembersInTx(
  tx: Tx,
  memberIds: readonly string[],
  toTeamId: string,
  opts: { at: Date; actorId: string | null; reason?: string | null; allowAlreadyIn?: boolean },
): Promise<MoveRecord[]> {
  const ids = [...new Set(memberIds)];
  const open = await tx.teamMembership.findMany({
    where: { memberId: { in: ids }, validTo: null },
    select: { id: true, memberId: true, teamId: true, role: true },
  });
  const openByMember = new Map(open.map((o) => [o.memberId, o]));
  const already = ids.filter((id) => openByMember.get(id)?.teamId === toTeamId);
  if (already.length && !opts.allowAlreadyIn) {
    throw new AppError('MEMBER_ALREADY_IN_TEAM', { memberIds: already });
  }
  const moving = ids.filter((id) => openByMember.get(id)?.teamId !== toTeamId);
  if (!moving.length) return [];
  const toClose = moving.map((id) => openByMember.get(id)?.id).filter((v): v is string => !!v);
  if (toClose.length) {
    const closed = await tx.teamMembership.updateMany({
      where: { id: { in: toClose }, validTo: null },
      data: { validTo: opts.at },
    });
    // Another move committed first (READ COMMITTED re-check after the row lock): retry from fresh data.
    if (closed.count !== toClose.length) throw new AppError('CONFLICT_VERSION');
  }
  await tx.teamMembership.createMany({
    data: moving.map((memberId) => ({
      memberId,
      teamId: toTeamId,
      validFrom: opts.at,
      movedById: opts.actorId,
      reason: opts.reason ?? null,
    })),
  });
  // The new membership starts as WORKER (column default): moving the foreman out clears the flag.
  return moving.map((memberId) => {
    const prev = openByMember.get(memberId);
    return { memberId, fromTeamId: prev?.teamId ?? null, ...(prev?.role === 'FOREMAN' ? { wasForeman: true } : {}) };
  });
}

/**
 * Security review L7 (ADR-067): to anyone without `members.manage` (supervisors), a duplicate
 * national ID answers NATIONAL_ID_NOT_ACCEPTED with a generic message, never "already
 * registered", and the attempt is audited so an admin can spot probing. Admins keep
 * NATIONAL_ID_TAKEN with the exact rows. The routes are also rate limited per IP.
 */
export async function hideDuplicateNationalId<T>(
  viewer: PermissionSubject & { id: string },
  audit: AuditService,
  ctx: RequestContext,
  scope: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = err instanceof AppError ? err : mapPrismaError(err);
    if (mapped?.code !== 'NATIONAL_ID_TAKEN' || can(viewer, 'members.manage')) throw mapped ?? err;
    const keys = Object.keys((mapped.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {});
    await audit
      .logCtx(ctx, { action: AuditAction.MEMBER_DUPLICATE_REJECTED, entityType: 'member', after: { ...scope, rows: keys.length || 1 } })
      .catch(() => undefined);
    const fieldErrors = Object.fromEntries((keys.length ? keys : ['nationalId']).map((k) => [k, [ERRORS.NATIONAL_ID_NOT_ACCEPTED]]));
    throw new AppError('NATIONAL_ID_NOT_ACCEPTED', { fieldErrors });
  }
}
