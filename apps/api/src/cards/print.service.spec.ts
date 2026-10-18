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
    memberships: [{ teamId: TEAM, team: { id: TEAM, name: 'فريق أ', status: 'ACTIVE', supervisors: [{ userId: SUP_ID }], color: { id: 'c', name: 'أزرق', hex: '#1D4ED8', isActive: true } } }],
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

const urlsFor = (prefix: string) =>
  jest.fn(async (ids: Array<string | null | undefined>) => new Map(ids.filter((v): v is string => !!v).map((id) => [id, `${prefix}${id}`])));

function setup(config: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}, supPhoto: string | null = null) {
  const sp = crypto.protectNationalId(SUP_NID);
  const supRow = { id: SUP_ID, fullName: 'سعد المشرف', nationalIdEnc: sp.enc, nationalIdFirst: sp.first, nationalIdLast2: sp.last2, photoFileId: supPhoto };
  const tx = {
    cardTemplate: { findUnique: jest.fn().mockResolvedValue(template(config)) },
    team: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: TEAM,
          name: 'فريق أ',
          color: { hex: '#1D4ED8' },
          supervisors: [{ user: supRow }],
        },
      ]),
    },
    teamMember: {
      findMany: jest.fn().mockResolvedValue([member()]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([supRow]),
    },
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
    cardPrintItem: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([] as unknown[]),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  const photos = { presignMany: urlsFor('https://bucket/get/'), inlineMany: urlsFor('data:image/jpeg;base64,') };
  const svc = new PrintService(prisma as never, crypto, new AuditService(prisma as never), cfg as never, photos as never);
  return { svc, tx, photos };
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

  it('A9: includeSupervisors gives one card per current supervisor of the team (primary first), each person once', async () => {
    const { svc, tx } = setup();
    const second = { id: 'sup-2', fullName: 'نايف المشرف المساعد', nationalIdEnc: crypto.encrypt(SUP_NID), nationalIdFirst: '1', nationalIdLast2: '00', photoFileId: null };
    const first = (await tx.team.findMany()) as Array<{ supervisors: Array<{ user: unknown }> }>;
    tx.team.findMany.mockResolvedValue([{ ...first[0], supervisors: [...first[0]!.supervisors, { user: second }] }] as never);
    const { subjects } = await svc.preview(previewInput, ADMIN);
    expect(subjects.filter((s) => s.userId).map((s) => s.userId)).toEqual([SUP_ID, 'sup-2']);
    const where = tx.team.findMany.mock.calls.at(-1)![0] as { select: { supervisors: { where: unknown; orderBy: unknown } } };
    expect(where.select.supervisors.where).toEqual({ validTo: null });
  });

  it('includeSupervisors=false leaves the supervisor card out', async () => {
    const { svc } = setup();
    const { subjects } = await svc.preview({ ...previewInput, includeSupervisors: false }, ADMIN);
    expect(subjects.map((s) => s.memberId)).toEqual([MEMBER_ID]);
  });

  it('stored print data is ALWAYS masked, whatever the template printed (review M2)', () => {
    const masked = '1•••••••' + MEMBER_NID.slice(-2);
    expect(storedCardData({ fullName: 'x', nationalId: MEMBER_NID }).nationalId).toBe(masked);
    expect(storedCardData({ fullName: 'x', nationalId: masked }).nationalId).toBe(masked);
    expect(storedCardData({ fullName: 'x' }).nationalId).toBe('');
  });

  it('a preview that decrypts full IDs is audited with count and template only (review M3)', async () => {
    const { svc, tx } = setup({ maskNationalId: false });
    await svc.preview(previewInput, ADMIN, ctx);
    const entries = tx.auditLog.create.mock.calls.map((c) => c[0].data);
    expect(entries).toEqual([
      expect.objectContaining({
        action: 'cards.preview_full_ids',
        entityId: 'tpl-1',
        after: expect.objectContaining({ count: 2, templateId: 'tpl-1' }),
      }),
    ]);
    const json = JSON.stringify(entries);
    expect(json).not.toContain(MEMBER_NID);
    expect(json).not.toContain(SUP_NID);
    expect(json).not.toContain(MEMBER_ID);
  });

  it('a masked preview writes no audit entry', async () => {
    const { svc, tx } = setup();
    await svc.preview(previewInput, ADMIN, ctx);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
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

  it('the server sets nationalId and qrValue from the DB and ignores client values (review L6)', async () => {
    const { svc, tx } = setup();
    const forged = {
      ...body(),
      items: [
        { memberId: MEMBER_ID, data: { fullName: 'x', nationalId: SUP_NID, qrValue: SUP_NID, photoFileId: KEY }, saveBack: false },
        { userId: SUP_ID, data: { fullName: 'y', nationalId: '0000000000', qrValue: 'evil' }, saveBack: false },
      ],
    };
    const res = await svc.createBatch(forged, ADMIN, ctx);
    expect(res.batch.cards.map((c) => c.data.qrValue)).toEqual([MEMBER_ID, SUP_ID]);
    expect(res.batch.cards[0]!.data).toMatchObject({ nationalId: '1•••••••' + MEMBER_NID.slice(-2), photoFileId: null });
    expect(res.batch.cards[1]!.data.nationalId).toBe('2•••••••' + SUP_NID.slice(-2));
    const items = JSON.stringify(tx.cardPrintItem.createMany.mock.calls[0]![0].data);
    expect(items).not.toContain('evil');
    expect(items).not.toContain(SUP_NID);
  });

  it('a full-ID template: rows keep the masked ID + FULL flag; only the answer has full IDs (review M2)', async () => {
    const { svc, tx } = setup({ maskNationalId: false });
    const res = await svc.createBatch(body(), ADMIN, ctx);
    const items = tx.cardPrintItem.createMany.mock.calls[0]![0].data as Array<{ nationalIdPrinted: string }>;
    expect(items.map((i) => i.nationalIdPrinted)).toEqual(['FULL', 'FULL']);
    expect(JSON.stringify(items)).not.toContain(MEMBER_NID);
    expect(JSON.stringify(items)).not.toContain(SUP_NID);
    expect(res.batch.cards.map((c) => c.data.nationalId)).toEqual([MEMBER_NID, SUP_NID]);
    expect(res.batch.cards.every((c) => c.nationalIdPrinted === 'FULL')).toBe(true);
  });

  it('getBatch never returns a full ID, even from a legacy unmasked row', async () => {
    const { svc, tx } = setup();
    tx.cardPrintBatch.findUnique.mockResolvedValue({
      ...(await tx.cardPrintBatch.findUniqueOrThrow()),
      templateSnapshot: {},
      items: [
        { id: 'i1', memberId: MEMBER_ID, userId: null, renderedData: { fullName: 'x', nationalId: MEMBER_NID }, nationalIdPrinted: 'FULL', savedBack: false },
      ],
    } as never);
    const detail = await svc.getBatch('batch-1');
    expect(detail.items[0]).toMatchObject({ nationalIdPrinted: 'FULL', data: { nationalId: '1•••••••' + MEMBER_NID.slice(-2) } });
  });

  const fullRow = () => ({
    memberId: MEMBER_ID,
    userId: null,
    renderedData: { fullName: 'x', nationalId: '1•••••••' + MEMBER_NID.slice(-2) },
    nationalIdPrinted: 'FULL',
  });

  it('an idempotent replay of a FULL batch re-derives the IDs from the DB and audits the re-issue', async () => {
    const { svc, tx } = setup();
    tx.cardPrintBatch.findUnique.mockResolvedValue((await tx.cardPrintBatch.findUniqueOrThrow()) as never);
    tx.cardPrintItem.findMany.mockResolvedValue([fullRow()]);
    const res = await svc.createBatch(body(), ADMIN, ctx);
    expect(res.created).toBe(false);
    expect(res.batch.cards[0]!.data).toMatchObject({ nationalId: MEMBER_NID, qrValue: MEMBER_ID });
    expect(tx.auditLog.create.mock.calls.map((c) => c[0].data.action)).toEqual(['cards.print_data_reissued']);
  });

  it('the PDF service gets the shared-secret header and full IDs re-derived from the DB', async () => {
    const { svc, tx } = setup({}, { PDF_SERVICE_URL: 'http://pdf:4000', PDF_SERVICE_TOKEN: 'tok', PDF_SERVICE_TIMEOUT_MS: 1000 });
    tx.cardPrintBatch.findUnique.mockResolvedValue({
      ...(await tx.cardPrintBatch.findUniqueOrThrow()),
      templateSnapshot: {},
      items: [],
    } as never);
    tx.cardPrintItem.findMany.mockResolvedValue([fullRow()]);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 502 }));
    const err = await svc.streamPdf('batch-1', {} as never, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('PDF_FAILED');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://pdf:4000/render');
    expect((init!.headers as Record<string, string>)['X-Pdf-Service-Token']).toBe('tok');
    expect(JSON.parse(String(init!.body)).cards[0].nationalId).toBe(MEMBER_NID);
    fetchMock.mockRestore();
  });

  it('PDF export answers 501 PDF_NOT_CONFIGURED without PDF_SERVICE_URL', async () => {
    const { svc } = setup();
    const err = await svc.streamPdf('batch-1', {} as never, ctx).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('PDF_NOT_CONFIGURED');
    expect((err as AppError).status).toBe(501);
  });
});

describe('card photos (owner request A8)', () => {
  const MEMBER_PHOTO = '55555555-5555-4555-8555-555555555555';
  const SUP_PHOTO = '66666666-6666-4666-8666-666666666666';

  it('preview returns a short-lived photoUrl for member (member photo) and supervisor (user photo) subjects', async () => {
    const { svc, tx } = setup({}, {}, SUP_PHOTO);
    tx.teamMember.findMany.mockResolvedValue([member({ photoFileId: MEMBER_PHOTO })]);
    const { subjects } = await svc.preview(previewInput, ADMIN);
    expect(subjects[0]).toMatchObject({ userId: SUP_ID, photoUrl: `https://bucket/get/${SUP_PHOTO}`, data: { photoFileId: SUP_PHOTO } });
    expect(subjects[1]).toMatchObject({ memberId: MEMBER_ID, photoUrl: `https://bucket/get/${MEMBER_PHOTO}`, data: { photoFileId: MEMBER_PHOTO } });
  });

  it('without a photo, or with fields.photo=false, photoUrl is null and no file id is carried', async () => {
    const off = setup({ fields: { photo: false } }, {}, SUP_PHOTO);
    off.tx.teamMember.findMany.mockResolvedValue([member({ photoFileId: MEMBER_PHOTO })]);
    const hidden = await off.svc.preview(previewInput, ADMIN);
    expect(hidden.subjects.map((s) => [s.photoUrl, s.data.photoFileId])).toEqual([[null, null], [null, null]]);
    const none = await setup().svc.preview(previewInput, ADMIN);
    expect(none.subjects.every((s) => s.photoUrl === null)).toBe(true);
  });

  it('print batch cards carry photoUrl from the DB photo, never a client-sent file id, and the URL is not stored', async () => {
    const { svc, tx } = setup({}, {}, SUP_PHOTO);
    tx.teamMember.findMany.mockResolvedValue([{ ...member({ photoFileId: MEMBER_PHOTO }) }]);
    const res = await svc.createBatch(
      {
        idempotencyKey: KEY,
        templateId: 'tpl-1',
        items: [
          { memberId: MEMBER_ID, data: { fullName: 'x', photoFileId: KEY }, saveBack: false },
          { userId: SUP_ID, data: { fullName: 'y' }, saveBack: false },
        ],
      },
      ADMIN,
      ctx,
    );
    expect(res.batch.cards.map((c) => c.photoUrl)).toEqual([`https://bucket/get/${MEMBER_PHOTO}`, `https://bucket/get/${SUP_PHOTO}`]);
    const stored = JSON.stringify(tx.cardPrintItem.createMany.mock.calls[0]![0].data);
    expect(stored).not.toContain('https://');
    expect(stored).not.toContain(KEY);
  });

  it('the PDF request inlines each card photo', async () => {
    const { svc, tx, photos } = setup({}, { PDF_SERVICE_URL: 'http://pdf:4000', PDF_SERVICE_TOKEN: 'tok', PDF_SERVICE_TIMEOUT_MS: 1000 });
    tx.cardPrintBatch.findUnique.mockResolvedValue({ ...(await tx.cardPrintBatch.findUniqueOrThrow()), templateSnapshot: {}, items: [] } as never);
    tx.cardPrintItem.findMany.mockResolvedValue([
      { memberId: MEMBER_ID, userId: null, renderedData: { fullName: 'x', photoFileId: MEMBER_PHOTO }, nationalIdPrinted: 'MASKED' },
    ]);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 502 }));
    await svc.streamPdf('batch-1', {} as never, ctx).catch(() => undefined);
    expect(photos.inlineMany).toHaveBeenCalledWith([MEMBER_PHOTO]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).cards[0].photoUrl).toBe(`data:image/jpeg;base64,${MEMBER_PHOTO}`);
    fetchMock.mockRestore();
  });
});
