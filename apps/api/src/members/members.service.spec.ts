import { nationalIdCheckDigit } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { validateImportRows } from './members-import';
import { MembersService } from './members.service';

const ctx: RequestContext = { actorId: 'admin-1', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const SUP = { id: 'sup-1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };
const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});
const nid = (first9: string) => first9 + nationalIdCheckDigit(first9);

function setup() {
  const tx = {
    team: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', supervisorId: SUP.id }) },
    teamMember: {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([]),
      createManyAndReturn: jest.fn(({ data }: { data: Array<{ nationalIdHash: string }> }) =>
        Promise.resolve(data.map((d, i) => ({ id: `new-${i}`, nationalIdHash: d.nationalIdHash }))),
      ),
    },
    teamMembership: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'ms-1', memberId: 'm1', teamId: TEAM_A },
        { id: 'ms-2', memberId: 'm2', teamId: TEAM_A },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    jobTitle: { findMany: jest.fn().mockResolvedValue([{ id: 'job-1', name: 'فني كهرباء' }]) },
    department: { findMany: jest.fn().mockResolvedValue([{ id: 'dep-1', name: 'الصيانة' }]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = new MembersService(prisma as never, crypto, new AuditService(prisma as never));
  return { svc, tx };
}

describe('MembersService.move (brief §5.3, ADR-013)', () => {
  it('closes every open row and opens the new ones with the SAME timestamp, in one transaction', async () => {
    const { svc, tx } = setup();
    await svc.move({ memberIds: ['m1', 'm2'], toTeamId: TEAM_B, reason: 'إعادة توزيع' }, ADMIN, ctx);
    const close = tx.teamMembership.updateMany.mock.calls[0]![0];
    const open = tx.teamMembership.createMany.mock.calls[0]![0];
    const t = close.data.validTo as Date;
    expect(t).toBeInstanceOf(Date);
    expect(close.where).toMatchObject({ id: { in: ['ms-1', 'ms-2'] }, validTo: null });
    expect(open.data).toHaveLength(2);
    for (const row of open.data) {
      expect(row.validFrom).toBe(t); // the very same instant → contiguous, non-overlapping intervals
      expect(row).toMatchObject({ teamId: TEAM_B, movedById: ADMIN.id, reason: 'إعادة توزيع' });
    }
    const audit = tx.auditLog.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('members.moved');
    expect(audit.after).toMatchObject({ toTeamId: TEAM_B, fromTeamIds: [TEAM_A], memberIds: ['m1', 'm2'] });
  });

  it('refuses a target team that is not ACTIVE (pending or archived)', async () => {
    for (const status of ['PENDING_APPROVAL', 'ARCHIVED']) {
      const { svc, tx } = setup();
      tx.team.findUnique.mockResolvedValue({ status, supervisorId: SUP.id });
      const err = await svc.move({ memberIds: ['m1'], toTeamId: TEAM_B }, ADMIN, ctx).catch((e: AppError) => e);
      expect((err as AppError).code).toBe('TEAM_NOT_ACTIVE');
      expect(tx.teamMembership.updateMany).not.toHaveBeenCalled();
    }
  });

  it('refuses members already in the target team (MEMBER_ALREADY_IN_TEAM)', async () => {
    const { svc, tx } = setup();
    const err = await svc.move({ memberIds: ['m1', 'm2'], toTeamId: TEAM_A }, ADMIN, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('MEMBER_ALREADY_IN_TEAM');
    expect((err as AppError).details).toEqual({ memberIds: ['m1', 'm2'] });
    expect(tx.teamMembership.createMany).not.toHaveBeenCalled();
  });

  it('a concurrent move that already closed a row → CONFLICT_VERSION (no second open row)', async () => {
    const { svc, tx } = setup();
    tx.teamMembership.updateMany.mockResolvedValue({ count: 1 });
    const err = await svc.move({ memberIds: ['m1', 'm2'], toTeamId: TEAM_B }, ADMIN, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('CONFLICT_VERSION');
    expect(tx.teamMembership.createMany).not.toHaveBeenCalled();
  });

  it('supervisors cannot move members (members.move is ADMIN only)', async () => {
    const { svc } = setup();
    const err = await svc.move({ memberIds: ['m1'], toTeamId: TEAM_B }, SUP, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('FORBIDDEN');
  });
});

describe('member import (brief §5.1)', () => {
  const refs = { jobTitles: [{ id: 'job-1', name: 'فني كهرباء' }], departments: [{ id: 'dep-1', name: 'الصيانة' }] };
  const good = nid('112233445');
  const other = nid('212233445');
  const stored = nid('198765432');

  it('reports per-row errors: bad ID, duplicate in the file, duplicate in the DB; masks every ID', () => {
    const hashOf = (id: string) => crypto.blindIndex(id);
    const { results, valid } = validateImportRows(
      [
        { fullName: 'محمد علي القحطاني', nationalId: good, jobTitle: 'فني كهرباء', department: 'قسم جديد' },
        { fullName: 'سا', nationalId: '1234567890' }, // too-short name + bad check digit
        { fullName: 'أحمد سعيد الزهراني', nationalId: good }, // duplicate of row 1
        { fullName: 'خالد ناصر العتيبي', nationalId: stored }, // already stored
        { fullName: 'فهد عبدالله الشهري', nationalId: Number(other) }, // Excel numeric cell
      ],
      refs,
      { hashOf, existingHashes: new Set([hashOf(stored)]) },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, false, false, true]);
    expect(results[1]!.errors).toHaveLength(2);
    expect(results[2]!.errors.join(' ')).toContain('مكرّر في الملف (الصف 1)');
    expect(results[3]!.errors).toContain('رقم الهوية هذا مسجّل مسبقًا.');
    expect(results[0]!.value).toMatchObject({
      jobTitle: 'فني كهرباء',
      jobTitleMatched: true,
      department: 'قسم جديد',
      departmentMatched: false,
    });
    // Never echo full IDs back.
    const json = JSON.stringify(results);
    for (const id of [good, other, stored]) expect(json).not.toContain(id);
    expect(results[0]!.value!.nationalIdMasked).toMatch(/^1•+\d\d$/);
    expect(valid.map((v) => v.row)).toEqual([1, 5]);
    expect(valid[0]!.input).toMatchObject({ jobTitleId: 'job-1', departmentText: 'قسم جديد' });
    expect(valid[0]!.input.jobTitleText).toBeUndefined();
  });

  it('accepts Arabic column headers and Arabic-Indic digits', () => {
    const arabicDigits = good.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    const { valid } = validateImportRows(
      [{ 'الاسم الكامل': 'نورة محمد السبيعي', 'رقم الهوية': arabicDigits, 'الإدارة': 'الصيانة' }],
      refs,
      { hashOf: (id) => id, existingHashes: new Set() },
    );
    expect(valid[0]!.input).toMatchObject({ nationalId: good, departmentId: 'dep-1' });
  });

  it('preview (commit=false) writes nothing', async () => {
    const { svc, tx } = setup();
    const res = await svc.import(
      { teamId: TEAM_A, rows: [{ fullName: 'محمد علي القحطاني', nationalId: good }], commit: false },
      ADMIN,
      ctx,
    );
    expect(res.committed).toBe(0);
    expect(res.results[0]!.ok).toBe(true);
    expect(tx.teamMember.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('commit inserts only the valid rows, in one transaction, with memberships and one audit entry', async () => {
    const { svc, tx } = setup();
    const res = await svc.import(
      {
        teamId: TEAM_A,
        rows: [
          { fullName: 'محمد علي القحطاني', nationalId: good },
          { fullName: 'خطأ', nationalId: '12' },
          { fullName: 'فهد عبدالله الشهري', nationalId: other },
        ],
        commit: true,
      },
      ADMIN,
      ctx,
    );
    expect(res.committed).toBe(2);
    const inserted = tx.teamMember.createManyAndReturn.mock.calls[0]![0].data as unknown as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(2);
    expect(inserted[0]!.nationalIdEnc).toBeInstanceOf(Buffer);
    expect(inserted[0]!.nationalIdLast4).toBe(good.slice(-4));
    expect(JSON.stringify(inserted.map((r) => r.fullName))).not.toContain(good);
    const memberships = tx.teamMembership.createMany.mock.calls[0]![0].data;
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toMatchObject({ teamId: TEAM_A, validFrom: memberships[1].validFrom });
    expect(tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'members.imported',
      after: { committed: 2, rejected: 1, rows: 3 },
    });
  });

  it('refuses to import into an archived team', async () => {
    const { svc, tx } = setup();
    tx.team.findUnique.mockResolvedValue({ status: 'ARCHIVED', supervisorId: SUP.id });
    const err = await svc
      .import({ teamId: TEAM_A, rows: [{ fullName: 'x', nationalId: good }], commit: true }, ADMIN, ctx)
      .catch((e: AppError) => e);
    expect((err as AppError).code).toBe('TEAM_ARCHIVED');
  });
});

describe('member search', () => {
  const { svc } = setup();
  it('a full valid national ID is an exact blind-index match', () => {
    const id = nid('112233445');
    expect(svc.searchWhere(id)).toEqual({ nationalIdHash: crypto.blindIndex(id) });
  });
  it('four digits search the stored last four', () => {
    expect(svc.searchWhere('٤٤٥٧')).toEqual({ nationalIdLast4: '4457' });
  });
  it('anything else is a case-insensitive name search', () => {
    expect(svc.searchWhere('محمد')).toEqual({ fullName: { contains: 'محمد', mode: 'insensitive' } });
  });
});
