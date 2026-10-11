import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CardData,
  CardPreviewDto,
  CardPreviewSubjectDto,
  Paginated,
  PrintBatchDetailDto,
  PrintBatchDto,
} from '@nuzli/shared';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { paginate } from '../common/pagination';
import { mapPrismaError, targetText } from '../common/prisma-errors';
import type { RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { MEMBER_SELECT, memberDepartment, memberJobTitle, type MemberRow, type Viewer } from '../teams/team-dto';
import {
  memberCard,
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
  ) {}

  private async template(id: string) {
    const row = await this.prisma.cardTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
    if (!row || row.archivedAt) throw new AppError('NOT_FOUND', { field: 'templateId' });
    return row;
  }

  // ─────────────────────────────────────────── preview

  /**
   * One card per subject: for every team its supervisor (when asked) then its current members,
   * then the individually chosen members. Each person appears once.
   */
  async preview(
    input: { templateId: string; teamIds: string[]; memberIds: string[]; includeSupervisors: boolean },
    viewer: Viewer,
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
          select: { id: true, name: true, color: { select: { hex: true } }, supervisor: { select: SUPERVISOR_SELECT } },
        })
      : [];
    if (teams.length !== teamIds.length) throw new AppError('NOT_FOUND', { field: 'teamIds' });
    const order = new Map(teamIds.map((id, i) => [id, i]));
    teams.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    for (const team of teams) {
      const cardTeam: CardTeam = { name: team.name, hex: team.color.hex };
      if (input.includeSupervisors && !seenUsers.has(team.supervisor.id)) {
        seenUsers.add(team.supervisor.id);
        subjects.push({ userId: team.supervisor.id, data: supervisorCard(team.supervisor, cardTeam, config, this.crypto) });
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
    return { template: toTemplateDto(template), subjects };
  }

  // ─────────────────────────────────────────── print batches

  /**
   * Idempotent by `idempotencyKey` (brief §12): a repeated request returns the original batch
   * with `created = false` (HTTP 200 instead of 201) and changes nothing.
   */
  async createBatch(
    input: PrintBatchData,
    viewer: Viewer,
    ctx: RequestContext,
  ): Promise<{ created: boolean; batch: PrintBatchDto }> {
    const existing = await this.prisma.cardPrintBatch.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: BATCH_SELECT,
    });
    if (existing) return { created: false, batch: toBatchDto(existing) };

    const template = await this.template(input.templateId);
    const config = parseConfig(template.config);
    this.assertSubjects(input.items);

    try {
      const batch = await this.prisma.$transaction(
        async (tx) => {
          await this.assertSubjectsExist(tx, input.items);
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
            data: input.items.map((item) => ({
              batchId: created.id,
              memberId: item.memberId ?? null,
              userId: item.memberId ? null : (item.userId ?? null),
              renderedData: storedCardData(config, item.data) as Prisma.InputJsonValue,
              savedBack: !!item.memberId && saved.has(item.memberId),
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
                nationalIdFull: !config.maskNationalId && config.fields.nationalId,
              },
            },
            tx,
          );
          return tx.cardPrintBatch.findUniqueOrThrow({ where: { id: created.id }, select: BATCH_SELECT });
        },
        { timeout: 60_000 },
      );
      return { created: true, batch: toBatchDto(batch) };
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
        if (winner) return { created: false, batch: toBatchDto(winner) };
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

  private async assertSubjectsExist(tx: Prisma.TransactionClient, items: PrintBatchData['items']): Promise<void> {
    const memberIds = [...new Set(items.map((i) => i.memberId).filter((v): v is string => !!v))];
    const userIds = [...new Set(items.filter((i) => !i.memberId).map((i) => i.userId).filter((v): v is string => !!v))];
    const [members, users] = await Promise.all([
      memberIds.length ? tx.teamMember.count({ where: { id: { in: memberIds } } }) : 0,
      userIds.length ? tx.user.count({ where: { id: { in: userIds } } }) : 0,
    ]);
    if (members !== memberIds.length || users !== userIds.length) throw new AppError('NOT_FOUND', { field: 'items' });
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
        orderBy: { printedAt: 'desc' },
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
        items: { select: { id: true, memberId: true, userId: true, renderedData: true, savedBack: true } },
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
        data: i.renderedData as unknown as CardData,
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
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${base.replace(/\/$/, '')}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
        body: JSON.stringify({
          batchId: batch.id,
          template: batch.templateSnapshot,
          cards: batch.items.map((i) => i.data),
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
      after: { count: batch.cardCount },
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cards-${id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  }
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
