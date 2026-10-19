import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  cardDataSchema,
  type CardData,
  type CardPreviewDto,
  type CardPreviewSubjectDto,
  type NationalIdPrinted,
  type Paginated,
  type PrintBatchCreatedDto,
  type PrintBatchDetailDto,
  type PrintBatchDto,
  type PrintRunCardDto,
} from '@nuzli/shared';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { paginate } from '../common/pagination';
import { pdfServiceHeaders } from '../common/pdf-service';
import { mapPrismaError, targetText } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { CryptoService } from '../crypto/crypto.service';
import { PhotosService } from '../photos/photos.service';
import { PrismaService } from '../prisma/prisma.service';
import { MEMBER_SELECT, memberDepartment, memberJobTitle, type MemberRow, type Viewer } from '../teams/team-dto';
import {
  cardNationalId,
  FOREMAN_ROLE_LABEL,
  foremanFields,
  memberCard,
  nationalIdPrintedFor,
  parseConfig,
  storedCardData,
  supervisorCard,
  templateSnapshot,
  TEMPLATE_SELECT,
  toTemplateDto,
  type CardTeam,
  type SupervisorRow,
} from './card-data';

export const MAX_PREVIEW_SUBJECTS = 1000;

/** The DB facts a printed card is derived from (never taken from the client, review L6). */
interface CardSubject {
  id: string;
  enc: Uint8Array;
  first: string;
  last: string;
  photoFileId: string | null;
  /** A10: a member who is the worker foreman of their current team (undefined for supervisors). */
  isForeman?: boolean;
}

type StoredItem = {
  memberId: string | null;
  userId: string | null;
  renderedData: Prisma.JsonValue;
  nationalIdPrinted: string;
};

const subjectKey = (item: { memberId?: string | null; userId?: string | null }) =>
  item.memberId ? `m:${item.memberId}` : `u:${item.userId}`;

export interface PrintBatchData {
  idempotencyKey: string;
  templateId: string;
  items: Array<{ memberId?: string | null; userId?: string | null; data: CardData; saveBack: boolean }>;
}

const SUPERVISOR_SELECT = {
  id: true,
  fullName: true,
  nationalIdEnc: true,
  nationalIdFirst: true,
  nationalIdLast2: true,
  photoFileId: true,
} satisfies Prisma.UserSelect;

const BATCH_SELECT = {
  id: true,
  idempotencyKey: true,
  printedAt: true,
  cardCount: true,
  template: { select: { id: true, name: true } },
  printedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.CardPrintBatchSelect;

type BatchRow = Prisma.CardPrintBatchGetPayload<{ select: typeof BATCH_SELECT }>;

function toBatchDto(b: BatchRow): PrintBatchDto {
  return {
    id: b.id,
    idempotencyKey: b.idempotencyKey,
    template: b.template,
    printedBy: b.printedBy,
    printedAt: b.printedAt.toISOString(),
    cardCount: b.cardCount,
  };
}

/** Card preview, print log and server PDF (brief §8.1, §8.5, ADR-018/024). */
@Injectable()
export class PrintService {
  private readonly logger = new Logger(PrintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly cfg: AppConfig,
    private readonly photos: PhotosService,
  ) {}

  /**
   * Owner request A8: a short-lived presigned GET per card photo (member photo for members, the
   * user photo for supervisors). Only in the answer — never stored with the batch.
   */
  private async withPhotoUrls<T extends { data: CardData }>(cards: T[]): Promise<Array<T & { photoUrl: string | null }>> {
    const urls = await this.photos.presignMany(cards.map((c) => c.data.photoFileId));
    return cards.map((c) => ({ ...c, photoUrl: (c.data.photoFileId && urls.get(c.data.photoFileId)) || null }));
  }

  private async template(id: string) {
    const row = await this.prisma.cardTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
    if (!row || row.archivedAt) throw new AppError('NOT_FOUND', { field: 'templateId' });
    return row;
  }

  // ─────────────────────────────────────────── preview

  /**
   * One card per subject: for every team its supervisors (when asked; A9: all of them, the
   * primary first) then its current members,
   * then the individually chosen members. Each person appears once.
   */
  async preview(
    input: { templateId: string; teamIds: string[]; memberIds: string[]; includeSupervisors: boolean },
    viewer: Viewer,
    ctx?: RequestContext,
  ): Promise<CardPreviewDto> {
    void viewer; // cards.print is checked by the guard; it is not data-scoped today
    const template = await this.template(input.templateId);
    const config = parseConfig(template.config);
    const subjects: CardPreviewSubjectDto[] = [];
    const seenMembers = new Set<string>();
    const seenUsers = new Set<string>();

    const teamIds = [...new Set(input.teamIds)];
    const teams = teamIds.length
      ? await this.prisma.team.findMany({
          where: { id: { in: teamIds }, status: { not: 'ARCHIVED' } },
          select: {
            id: true,
            name: true,
            color: { select: { hex: true } },
            // A9 (ADR-100): every current supervisor, the primary first.
            supervisors: {
              where: { validTo: null },
              orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
              select: { user: { select: SUPERVISOR_SELECT } },
            },
          },
        })
      : [];
    if (teams.length !== teamIds.length) throw new AppError('NOT_FOUND', { field: 'teamIds' });
    const order = new Map(teamIds.map((id, i) => [id, i]));
    teams.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    for (const team of teams) {
      const cardTeam: CardTeam = { name: team.name, hex: team.color.hex };
      if (input.includeSupervisors) {
        for (const { user } of team.supervisors) {
          if (seenUsers.has(user.id)) continue;
          seenUsers.add(user.id);
          subjects.push({ userId: user.id, data: supervisorCard(user, cardTeam, config, this.crypto) });
        }
      }
      const members = await this.prisma.teamMember.findMany({
        where: { archivedAt: null, status: 'ACTIVE', memberships: { some: { teamId: team.id, validTo: null } } },
        select: MEMBER_SELECT,
        orderBy: { fullName: 'asc' },
      });
      for (const m of members) {
        if (seenMembers.has(m.id)) continue;
        seenMembers.add(m.id);
        subjects.push({ memberId: m.id, data: memberCard(m, cardTeam, config, this.crypto) });
      }
    }

    const extra = [...new Set(input.memberIds)].filter((id) => !seenMembers.has(id));
    if (extra.length) {
      const rows = await this.prisma.teamMember.findMany({
        where: { id: { in: extra }, archivedAt: null },
        select: MEMBER_SELECT,
      });
      if (rows.length !== extra.length) throw new AppError('NOT_FOUND', { field: 'memberIds' });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of extra) {
        const m = byId.get(id)!;
        const team = m.memberships[0]?.team;
        subjects.push({
          memberId: m.id,
          data: memberCard(m, team ? { name: team.name, hex: team.color.hex } : null, config, this.crypto),
        });
      }
    }
    if (subjects.length > MAX_PREVIEW_SUBJECTS) {
      throw new AppError('VALIDATION_FAILED', {
        fieldErrors: { teamIds: [`الحد الأعلى ${MAX_PREVIEW_SUBJECTS} بطاقة في المعاينة الواحدة`] },
      });
    }
    // Security review M3: decrypting full IDs for a preview is a bulk read of national IDs.
    // Audit it (count and template only — never the IDs or the people); the route is rate limited.
    if (ctx && subjects.length && nationalIdPrintedFor(config) === 'FULL') {
      await this.audit.logCtx(ctx, {
        action: AuditAction.CARDS_PREVIEW_FULL_IDS,
        entityType: 'card_template',
        entityId: template.id,
        after: {
          count: subjects.length,
          templateId: template.id,
          templateName: template.name,
          teamCount: teamIds.length,
          memberCount: extra.length,
        },
      });
    }
    return { template: toTemplateDto(template), subjects: await this.withPhotoUrls(subjects) };
  }

  // ─────────────────────────────────────────── print batches

  /**
   * Idempotent by `idempotencyKey` (brief §12): a repeated request returns the original batch
   * with `created = false` (HTTP 200 instead of 201) and changes nothing.
   */
  /**
   * Security review M2/L6: the server derives `nationalId` (from the DB, per template) and
   * `qrValue` (the internal UUID) for every card and ignores what the client sent for them.
   * `rendered_data` stores the ID masked plus `national_id_printed`; the full IDs for this
   * print run are only in this answer (`cards`), never in list/get.
   */
  async createBatch(
    input: PrintBatchData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ created: boolean; batch: PrintBatchCreatedDto }> {
    const existing = await this.prisma.cardPrintBatch.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: BATCH_SELECT,
    });
    if (existing) return { created: false, batch: await this.replay(existing, ctx) };

    const template = await this.template(input.templateId);
    const config = parseConfig(template.config);
    const mode = nationalIdPrintedFor(config);
    this.assertSubjects(input.items);
    let cards: PrintRunCardDto[] = [];

    try {
      const batch = await this.prisma.$transaction(
        async (tx) => {
          const subjects = await this.loadSubjects(tx, input.items);
          cards = input.items.map((item) => ({
            memberId: item.memberId ?? null,
            userId: item.memberId ? null : (item.userId ?? null),
            data: this.serverCard(config, item.data, subjects.get(subjectKey(item))!),
            nationalIdPrinted: mode,
          }));
          const saved = await this.saveBack(tx, input.items, ctx);
          const created = await tx.cardPrintBatch.create({
            data: {
              idempotencyKey: input.idempotencyKey,
              templateId: template.id,
              printedById: viewer.id,
              cardCount: input.items.length,
              templateSnapshot: templateSnapshot(template) as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          await tx.cardPrintItem.createMany({
            data: cards.map((card) => ({
              batchId: created.id,
              memberId: card.memberId,
              userId: card.userId,
              renderedData: storedCardData(card.data) as Prisma.InputJsonValue,
              nationalIdPrinted: mode,
              savedBack: !!card.memberId && saved.has(card.memberId),
            })),
          });
          await this.audit.logCtx(
            ctx,
            {
              action: AuditAction.CARDS_PRINTED,
              entityType: 'card_print_batch',
              entityId: created.id,
              after: {
                count: input.items.length,
                templateId: template.id,
                templateName: template.name,
                memberIds: input.items.map((i) => i.memberId).filter(Boolean),
                userIds: input.items.filter((i) => !i.memberId).map((i) => i.userId),
                savedBack: saved.size,
                nationalIdFull: mode === 'FULL',
              },
            },
            tx,
          );
          return tx.cardPrintBatch.findUniqueOrThrow({ where: { id: created.id }, select: BATCH_SELECT });
        },
        { timeout: 60_000 },
      );
      return { created: true, batch: { ...toBatchDto(batch), cards: await this.withPhotoUrls(cards) } };
    } catch (err) {
      // Two identical requests raced: the loser returns the winner's batch.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        /idempotency/.test(targetText(err))
      ) {
        const winner = await this.prisma.cardPrintBatch.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: BATCH_SELECT,
        });
        if (winner) return { created: false, batch: await this.replay(winner, ctx) };
      }
      throw (err instanceof AppError ? err : mapPrismaError(err)) ?? err;
    }
  }

  private assertSubjects(items: PrintBatchData['items']): void {
    const fieldErrors: Record<string, string[]> = {};
    items.forEach((item, i) => {
      if (!item.memberId && !item.userId) fieldErrors[`items.${i}.memberId`] = ['حدّد العضو أو المشرف لهذه البطاقة'];
      if (item.saveBack && !item.memberId) fieldErrors[`items.${i}.saveBack`] = ['الحفظ في السجل متاح لبطاقات الأعضاء فقط'];
    });
    if (Object.keys(fieldErrors).length) throw new AppError('VALIDATION_FAILED', { fieldErrors });
  }

  /** Members and supervisors named by the items, keyed `m:<id>` / `u:<id>`; any missing → 404. */
  private async loadSubjects(
    db: Prisma.TransactionClient | PrismaService,
    items: ReadonlyArray<{ memberId?: string | null; userId?: string | null }>,
  ): Promise<Map<string, CardSubject>> {
    const memberIds = [...new Set(items.map((i) => i.memberId).filter((v): v is string => !!v))];
    const userIds = [...new Set(items.filter((i) => !i.memberId).map((i) => i.userId).filter((v): v is string => !!v))];
    const [members, users] = await Promise.all([
      memberIds.length
        ? db.teamMember.findMany({
            where: { id: { in: memberIds } },
            select: {
              id: true,
              nationalIdEnc: true,
              nationalIdFirst: true,
              nationalIdLast4: true,
              photoFileId: true,
              memberships: { where: { validTo: null }, take: 1, select: { role: true } },
            },
          })
        : [],
      userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: SUPERVISOR_SELECT }) : [],
    ]);
    if (members.length !== memberIds.length || users.length !== userIds.length) {
      throw new AppError('NOT_FOUND', { field: 'items' });
    }
    const out = new Map<string, CardSubject>();
    for (const m of members) {
      out.set(`m:${m.id}`, {
        id: m.id,
        enc: m.nationalIdEnc,
        first: m.nationalIdFirst,
        last: m.nationalIdLast4,
        photoFileId: m.photoFileId,
        isForeman: m.memberships[0]?.role === 'FOREMAN',
      });
    }
    for (const u of users) {
      out.set(`u:${u.id}`, { id: u.id, enc: u.nationalIdEnc, first: u.nationalIdFirst, last: u.nationalIdLast2, photoFileId: u.photoFileId });
    }
    return out;
  }

  /**
   * Client text fields (name, job, department, team label) + server-derived ID, QR and photo
   * (the member photo, or the supervisor's user photo — owner request A8).
   */
  private serverCard(config: ReturnType<typeof parseConfig>, data: CardData, subject: CardSubject): CardData {
    const parsed = cardDataSchema.parse(data);
    // A10: the foreman mark comes from the membership, never from the client.
    const { isForeman: _sent, ...rest } = parsed;
    void _sent;
    const role =
      subject.isForeman === undefined
        ? {}
        : subject.isForeman
          ? foremanFields(true)
          : { isForeman: false, roleLabel: rest.roleLabel === FOREMAN_ROLE_LABEL ? undefined : rest.roleLabel };
    return {
      ...rest,
      ...role,
      nationalId: cardNationalId(config, { first: subject.first, last: subject.last }, () => this.crypto.decrypt(subject.enc)),
      qrValue: subject.id, // internal UUID — never a national ID (brief §8.2)
      photoFileId: config.fields.photo ? subject.photoFileId : null,
    };
  }

  /**
   * Cards of a recorded batch for a print run: stored (masked) data, with the full national ID
   * decrypted from the DB for items printed in FULL. Used by the PDF and by an idempotent replay.
   */
  private async printRun(items: StoredItem[]): Promise<PrintRunCardDto[]> {
    const full = items.filter((i) => i.nationalIdPrinted === 'FULL');
    const subjects = full.length ? await this.loadSubjects(this.prisma, full) : new Map<string, CardSubject>();
    return items.map((i) => {
      const data = { ...(i.renderedData as unknown as CardData), qrValue: i.memberId ?? i.userId ?? undefined };
      const subject = i.nationalIdPrinted === 'FULL' ? subjects.get(subjectKey(i)) : undefined;
      if (subject) data.nationalId = this.crypto.decrypt(subject.enc);
      return { memberId: i.memberId, userId: i.userId, data, nationalIdPrinted: toPrinted(i.nationalIdPrinted) };
    });
  }

  /** Idempotent replay of POST /cards/batches: the original batch and its print-run cards. */
  private async replay(batch: BatchRow, ctx: RequestContext): Promise<PrintBatchCreatedDto> {
    const items = await this.prisma.cardPrintItem.findMany({
      where: { batchId: batch.id },
      select: { memberId: true, userId: true, renderedData: true, nationalIdPrinted: true },
    });
    const cards = await this.withPhotoUrls(await this.printRun(items));
    const fullCount = items.filter((i) => i.nationalIdPrinted === 'FULL').length;
    if (fullCount) {
      await this.audit.logCtx(ctx, {
        action: AuditAction.CARDS_PRINT_DATA_REISSUED,
        entityType: 'card_print_batch',
        entityId: batch.id,
        after: { count: items.length, fullNationalIds: fullCount },
      });
    }
    return { ...toBatchDto(batch), cards };
  }

  /**
   * "Save edits to the member record" (brief §8.1): name, job title and department text.
   * Only changed values are written; each member update is audited.
   */
  async saveBack(
    tx: Prisma.TransactionClient,
    items: PrintBatchData['items'],
    ctx: RequestContext,
  ): Promise<Set<string>> {
    const wanted = items.filter((i) => i.saveBack && i.memberId);
    const saved = new Set<string>();
    if (!wanted.length) return saved;
    const rows = await tx.teamMember.findMany({
      where: { id: { in: wanted.map((i) => i.memberId!) }, archivedAt: null },
      select: MEMBER_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const item of wanted) {
      const m = byId.get(item.memberId!);
      if (!m) continue;
      const { data, before, after } = saveBackPatch(m, item.data);
      if (!Object.keys(data).length) continue;
      await tx.teamMember.update({ where: { id: m.id }, data });
      await this.audit.logCtx(
        ctx,
        {
          action: AuditAction.MEMBER_UPDATED,
          entityType: 'member',
          entityId: m.id,
          before,
          after: { ...after, source: 'cards.saveBack' },
        },
        tx,
      );
      saved.add(m.id);
    }
    return saved;
  }

  async listBatches(q: { page: number; pageSize: number }): Promise<Paginated<PrintBatchDto>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cardPrintBatch.findMany({
        select: BATCH_SELECT,
        orderBy: [{ printedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.cardPrintBatch.count(),
    ]);
    return paginate(rows.map(toBatchDto), total, q.page, q.pageSize);
  }

  async getBatch(id: string): Promise<PrintBatchDetailDto> {
    const row = await this.prisma.cardPrintBatch.findUnique({
      where: { id },
      select: {
        ...BATCH_SELECT,
        templateSnapshot: true,
        items: {
          select: { id: true, memberId: true, userId: true, renderedData: true, nationalIdPrinted: true, savedBack: true },
        },
      },
    });
    if (!row) throw new AppError('NOT_FOUND');
    return {
      ...toBatchDto(row),
      templateSnapshot: (row.templateSnapshot ?? {}) as Record<string, unknown>,
      items: row.items.map((i) => ({
        id: i.id,
        memberId: i.memberId,
        userId: i.userId,
        // Stored masked since migration 20261016; maskStored also covers anything older.
        data: maskStored(i.renderedData),
        nationalIdPrinted: toPrinted(i.nationalIdPrinted),
        savedBack: i.savedBack,
      })),
    };
  }

  // ─────────────────────────────────────────── server PDF (ADR-024, ADR-043)

  /**
   * Streams a PDF rendered by the separate pdf service. Without `PDF_SERVICE_URL` → 501.
   * The service receives the batch snapshot and items and answers `application/pdf`.
   */
  async streamPdf(id: string, res: Response, ctx: RequestContext): Promise<void> {
    const base = this.cfg.PDF_SERVICE_URL;
    if (!base) throw new AppError('PDF_NOT_CONFIGURED');
    const batch = await this.getBatch(id);
    const stored = await this.prisma.cardPrintItem.findMany({
      where: { batchId: id },
      select: { memberId: true, userId: true, renderedData: true, nationalIdPrinted: true },
    });
    const cards = await this.printRun(stored);
    // Owner request A8: photos travel inline (data: URLs) — the service may not reach the bucket.
    const photos = await this.photos.inlineMany(cards.map((c) => c.data.photoFileId));
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${base.replace(/\/$/, '')}/render`, {
        method: 'POST',
        headers: pdfServiceHeaders(this.cfg.PDF_SERVICE_TOKEN),
        body: JSON.stringify({
          batchId: batch.id,
          template: batch.templateSnapshot,
          cards: cards.map((c) => ({
            ...c.data,
            photoUrl: (c.data.photoFileId && photos.get(c.data.photoFileId)) || null,
          })),
        }),
        signal: AbortSignal.timeout(this.cfg.PDF_SERVICE_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`PDF service unreachable: ${(err as Error).message}`);
      throw new AppError('PDF_FAILED');
    }
    if (!upstream.ok || !upstream.body) {
      this.logger.warn(`PDF service answered ${upstream.status}`);
      throw new AppError('PDF_FAILED');
    }
    await this.audit.logCtx(ctx, {
      action: AuditAction.CARDS_PDF_EXPORTED,
      entityType: 'card_print_batch',
      entityId: id,
      after: { count: batch.cardCount, fullNationalIds: cards.filter((c) => c.nationalIdPrinted === 'FULL').length },
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cards-${id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  }
}

function toPrinted(value: string): NationalIdPrinted {
  return value === 'FULL' ? 'FULL' : 'MASKED';
}

/** Rendered data as returned by list/get: the national ID is masked whatever was stored. */
function maskStored(value: Prisma.JsonValue): CardData {
  return storedCardData(value as unknown as CardData);
}

/** Fields written back to the member from an edited card: only those that differ. */
export function saveBackPatch(m: MemberRow, data: CardData) {
  const out: Prisma.TeamMemberUncheckedUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const name = data.fullName?.trim();
  if (name && name !== m.fullName) {
    out.fullName = name;
    before.fullName = m.fullName;
    after.fullName = name;
  }
  const job = data.jobTitle?.trim() ?? '';
  if (job && job !== (memberJobTitle(m) ?? '')) {
    out.jobTitleText = job;
    out.jobTitleId = null;
    before.jobTitle = memberJobTitle(m);
    after.jobTitleText = job;
  }
  const dep = data.department?.trim() ?? '';
  if (dep && dep !== (memberDepartment(m) ?? '')) {
    out.departmentText = dep;
    out.departmentId = null;
    before.department = memberDepartment(m);
    after.departmentText = dep;
  }
  return { data: out, before, after };
}
