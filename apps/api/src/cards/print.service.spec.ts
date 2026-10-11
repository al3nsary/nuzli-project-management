import { Prisma } from '@prisma/client';
import { cardTemplateConfigSchema, nationalIdCheckDigit } from '@nuzli/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { CryptoService } from '../crypto/crypto.service';
import { storedCardData } from './card-data';
import { PrintService, saveBackPatch } from './print.service';

const ctx: RequestContext = { actorId: 'admin-1', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, status: 'ACTIVE' };
const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});
const MEMBER_NID = '1122334455'.slice(0, 9) + nationalIdCheckDigit('112233445');
const SUP_NID = '2' + '00112233' + nationalIdCheckDigit('200112233');
const TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const SUP_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

function member(overrides: Record<string, unknown> = {}) {
  const p = crypto.protectNationalId(MEMBER_NID);
  return {
    id: MEMBER_ID,
    fullName: 'محمد علي القحطاني',
    nationalIdEnc: p.enc,
    nationalIdHash: p.hash,
    nationalIdFirst: p.first,
    nationalIdLast4: p.last4,
    jobTitleId: 'job-1',
    jobTitleText: null,
    departmentId: null,
    departmentText: 'الصيانة',
    photoFileId: null,
    status: 'ACTIVE',
    jobTitle: { name: 'فني كهرباء' },
    department: null,
    memberships: [{ teamId: TEAM, team: { id: TEAM, name: 'فريق أ', supervisorId: SUP_ID, color: { id: 'c', name: 'أزرق', hex: '#1D4ED8', isActive: true } } }],
    ...overrides,
  };
}

function template(config: Record<string, unknown>) {
  return {
    id: 'tpl-1',
    name: 'كلاسيكية',
    orientation: 'LANDSCAPE',
    layoutKey: 'CLASSIC_HORIZONTAL',
    config: cardTemplateConfigSchema.parse(config),
    isDefault: true,
    logoId: null,
    archivedAt: null,
    size: { id: 's', name: 'CR80', widthMm: new Prisma.Decimal(85.6), heightMm: new Prisma.Decimal(54), isBuiltin: true },
  };
}

function setup(config: Record<string, unknown> = {}) {
  const sp = crypto.protectNationalId(SUP_NID);
  const tx = {
    cardTemplate: { findUnique: jest.fn().mockResolvedValue(template(config)) },
    team: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: TEAM,
          name: 'فريق أ',
          color: { hex: '#1D4ED8' },
          supervisor: { id: SUP_ID, fullName: 'سعد المشرف', nationalIdEnc: sp.enc, nationalIdFirst: sp.first, nationalIdLast2: sp.last2 },
        },
      ]),
    },
    teamMember: {
      findMany: jest.fn().mockResolvedValue([member()]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { count: jest.fn().mockResolvedValue(1) },
    cardPrintBatch: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'batch-1' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'batch-1',
        idempotencyKey: KEY,
        printedAt: new Date('2026-10-12T09:00:00Z'),
        cardCount: 2,
        template: { id: 'tpl-1', name: 'كلاسيكية' },
        printedBy: { id: ADMIN.id, fullName: 'مدير' },
      }),
    },
    cardPrintItem: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = new PrintService(prisma as never, crypto, new AuditService(prisma as never), {} as never);
  return { svc, tx };
}

const previewInput = { templateId: 'tpl-1', teamIds: [TEAM], memberIds: [], includeSupervisors: true };

describe('card preview — national ID rules (brief §8.2, §13)', () => {
  it('masks the ID by default, for members and supervisors; QR carries the internal UUID', async () => {
    const { svc } = setup();
    const { subjects } = await svc.preview(previewInput, ADMIN);
    expect(subjects.map((s) => s.userId ?? s.memberId)).toEqual([SUP_ID, MEMBER_ID]);
    expect(subjects[0]!.data).toMatchObject({ nationalId: '2•••••••' + SUP_NID.slice(-2), qrValue: SUP_ID, roleLabel: 'مشرف الفريق' });
    expect(subjects[1]!.data).toMatchObject({
      fullName: 'محمد علي القحطاني',
      nationalId: '1•••••••' + MEMBER_NID.slice(-2),
      jobTitle: 'فني كهرباء',
      department: 'الصيانة',
      teamName: 'فريق أ',
      teamColor: '#1D4ED8',
      qrValue: MEMBER_ID,
    });
    expect(JSON.stringify(subjects)).not.toContain(MEMBER_NID);
  });

  it('shows the full (decrypted) ID only when the template has maskNationalId = false', async () => {
    const { svc } = setup({ maskNationalId: false });
    const { subjects } = await svc.preview(previewInput, ADMIN);
    expect(subjects[0]!.data.nationalId).toBe(SUP_NID);
    expect(subjects[1]!.data.nationalId).toBe(MEMBER_NID);
  });

  it('a hidden national-ID field carries nothing at all', async () => {
    const { svc } = setup({ maskNationalId: false, fields: { nationalId: false } });
    const { subjects } = await svc.preview(previewInput, ADMIN);
    expect(subjects.every((s) => s.data.nationalId === '')).toBe(true);
  });

  it('includeSupervisors=false leaves the supervisor card out', async () => {
    const { svc } = setup();
    const { subjects } = await svc.preview({ ...previewInput, includeSupervisors: false }, ADMIN);
    expect(subjects.map((s) => s.memberId)).toEqual([MEMBER_ID]);
  });

  it('stored print data is masked unless the template printed the ID in full', () => {
    const masked = cardTemplateConfigSchema.parse({});
    const full = cardTemplateConfigSchema.parse({ maskNationalId: false });
    expect(storedCardData(masked, { fullName: 'x', nationalId: MEMBER_NID }).nationalId).toBe('1•••••••' + MEMBER_NID.slice(-2));
    expect(storedCardData(full, { fullName: 'x', nationalId: MEMBER_NID }).nationalId).toBe(MEMBER_NID);
  });
});

describe('print batches (brief §8.1, §12)', () => {
  const body = (saveBack = false) => ({
    idempotencyKey: KEY,
    templateId: 'tpl-1',
    items: [
      { memberId: MEMBER_ID, data: { fullName: 'محمد علي القحطاني (معدّل)', jobTitle: 'كهربائي أول', department: 'الصيانة', nationalId: MEMBER_NID }, saveBack },
      { userId: SUP_ID, data: { fullName: 'سعد المشرف', nationalId: SUP_NID }, saveBack: false },
    ],
  });

  it('creates the batch with a template snapshot, masked items and a cards.printed audit entry', async () => {
    const { svc, tx } = setup();
    const res = await svc.createBatch(body(), ADMIN, ctx);
    expect(res.created).toBe(true);
    const created = tx.cardPrintBatch.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({ idempotencyKey: KEY, templateId: 'tpl-1', printedById: ADMIN.id, cardCount: 2 });
    expect(created.templateSnapshot).toMatchObject({ name: 'كلاسيكية', size: { widthMm: 85.6, heightMm: 54 } });
    const items = tx.cardPrintItem.createMany.mock.calls[0]![0].data;
    expect(JSON.stringify(items)).not.toContain(MEMBER_NID);
    expect(JSON.stringify(items)).not.toContain(SUP_NID);
    expect(items[1]).toMatchObject({ memberId: null, userId: SUP_ID, savedBack: false });
    expect(tx.teamMember.update).not.toHaveBeenCalled();
    const audit = tx.auditLog.create.mock.calls.map((c) => c[0].data);
    expect(audit).toEqual([expect.objectContaining({ action: 'cards.printed', after: expect.objectContaining({ count: 2, templateId: 'tpl-1' }) })]);
  });

  it('is idempotent: the same key returns the original batch (created=false) and writes nothing', async () => {
    const { svc, tx } = setup();
    tx.cardPrintBatch.findUnique.mockResolvedValue(await tx.cardPrintBatch.findUniqueOrThrow());
    const res = await svc.createBatch(body(true), ADMIN, ctx);
    expect(res).toMatchObject({ created: false, batch: { id: 'batch-1', idempotencyKey: KEY } });
    expect(tx.cardPrintBatch.create).not.toHaveBeenCalled();
    expect(tx.teamMember.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('a concurrent duplicate (unique idempotency_key) returns the winner instead of failing', async () => {
    const { svc, tx } = setup();
    const winner = await tx.cardPrintBatch.findUniqueOrThrow();
    tx.cardPrintBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    tx.cardPrintBatch.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0', meta: { target: ['idempotency_key'] } }),
    );
    const res = await svc.createBatch(body(), ADMIN, ctx);
    expect(res).toMatchObject({ created: false, batch: { id: 'batch-1' } });
  });

  it('saveBack writes the edited name, job title and department to the member and audits it', async () => {
    const { svc, tx } = setup();
    await svc.createBatch(body(true), ADMIN, ctx);
    expect(tx.teamMember.update).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      data: { fullName: 'محمد علي القحطاني (معدّل)', jobTitleText: 'كهربائي أول', jobTitleId: null },
    });
    const actions = tx.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(actions).toEqual(['member.updated', 'cards.printed']);
    expect(tx.cardPrintItem.createMany.mock.calls[0]![0].data[0].savedBack).toBe(true);
  });

  it('saveBack is refused for supervisor cards; a card without a subject is refused', async () => {
    const { svc } = setup();
    const bad = { ...body(), items: [{ userId: SUP_ID, data: { fullName: 'x' }, saveBack: true }, { data: { fullName: 'y' }, saveBack: false }] };
    const err = await svc.createBatch(bad, ADMIN, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('VALIDATION_FAILED');
    expect(Object.keys((err as AppError & { details: { fieldErrors: object } }).details.fieldErrors)).toEqual([
      'items.0.saveBack',
      'items.1.memberId',
    ]);
  });

  it('saveBackPatch leaves unchanged values alone', () => {
    const m = member() as never;
    expect(saveBackPatch(m, { fullName: 'محمد علي القحطاني', jobTitle: 'فني كهرباء', department: 'الصيانة' }).data).toEqual({});
  });

  it('PDF export answers 501 PDF_NOT_CONFIGURED without PDF_SERVICE_URL', async () => {
    const { svc } = setup();
    const err = await svc.streamPdf('batch-1', {} as never, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('PDF_NOT_CONFIGURED');
    expect((err as AppError).status).toBe(501);
  });
});
