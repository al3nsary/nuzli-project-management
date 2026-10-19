import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfig } from '../../config/app-config';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { ocrImageProblem } from '../../storage/image-dimensions';
import { OCR_ENGINE, OCR_LANGS, type OcrEngine } from './ocr-engine';
import { parseIdCard, type ExtractedCard } from './ocr-parser';

/** What `violation_ocr.extracted_enc` holds once decrypted. */
export interface StoredOcr {
  v: 1;
  fields: ExtractedCard;
  engine: string;
  meanConfidence: number;
}

/** A failure that a retry cannot fix (the photo is gone, the bytes are not an image tesseract reads). */
export class OcrPermanentError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'OcrPermanentError';
  }
}

/** 30 s, 2 min, 8 min, 32 min, then hourly. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 3_600_000);
}

export const OCR_ENGINE_LABEL = `tesseract.js@5 ${OCR_LANGS.join('+')}`;

interface Job {
  violationId: string;
  fileId: string | null;
  attempts: number;
}

/**
 * The ID-card OCR queue (owner request A9, ADR-104). In-process with a concurrency of
 * `OCR_CONCURRENCY` (1–2); the job state is persisted in `violation_ocr`, so nothing is lost on a
 * restart: the start-up sweep puts RUNNING jobs back to PENDING and a one-minute tick picks up
 * jobs whose back-off has elapsed. Claiming is an optimistic `UPDATE … WHERE status = 'PENDING'`,
 * safe even if two API instances ever share the database.
 *
 * Privacy: the image bytes and the OCR text live only in memory during the job. The extracted
 * fields are stored encrypted (CryptoService, AES-256-GCM) with an HMAC blind index of the ID
 * number; logs carry the violation id and an error class only — never OCR text.
 */
@Injectable()
export class OcrQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OcrQueue');
  private running = 0;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly cfg: AppConfig,
    @Inject(OCR_ENGINE) private readonly engine: OcrEngine,
  ) {}

  get enabled(): boolean {
    return this.cfg.OCR_ENABLED !== false;
  }

  private get concurrency(): number {
    return Math.min(Math.max(this.cfg.OCR_CONCURRENCY ?? 1, 1), 2);
  }

  private get maxAttempts(): number {
    return this.cfg.OCR_MAX_ATTEMPTS ?? 3;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sweep().catch((err: unknown) => this.logger.warn(`OCR start-up sweep failed: ${(err as Error).name}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.engine.terminate();
  }

  /** Jobs left RUNNING by a stopped process go back to the queue. */
  async sweep(now = new Date()): Promise<number> {
    const { count } = await this.prisma.violationOcr.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'PENDING', nextAttemptAt: now },
    });
    if (count) this.logger.log(`OCR sweep re-queued ${count} interrupted job(s)`);
    this.kick();
    return count;
  }

  @Interval('violation-ocr-tick', 60_000)
  tick(): void {
    this.kick();
  }

  /**
   * Called after an ID_CARD photo is confirmed. Idempotent: a repeated confirm of the same file
   * leaves a pending/running/done job alone; a new file (or a FAILED job) starts over.
   */
  async enqueue(violationId: string, fileId: string, now = new Date()): Promise<void> {
    const existing = await this.prisma.violationOcr.findUnique({
      where: { violationId },
      select: { fileId: true, status: true },
    });
    if (existing && existing.fileId === fileId && existing.status !== 'FAILED') return;
    const reset = {
      fileId,
      status: 'PENDING' as const,
      attempts: 0,
      error: null,
      nextAttemptAt: now,
      extractedEnc: null,
      idNumberHash: null,
      extractedAt: null,
    };
    await this.prisma.violationOcr.upsert({
      where: { violationId },
      create: { violationId, ...reset },
      update: reset,
    });
    this.kick();
  }

  /** Admin retry of a FAILED (or DONE) job with the current ID-card photo. */
  async retry(violationId: string): Promise<void> {
    const link = await this.prisma.violationFile.findFirst({
      where: { violationId, kind: 'ID_CARD', file: { status: 'READY', deletedAt: null } },
      select: { fileId: true },
    });
    if (!link) return;
    await this.prisma.violationOcr.deleteMany({ where: { violationId } });
    await this.enqueue(violationId, link.fileId);
  }

  /** Decrypted result, or null when there is none (yet). */
  read(row: { extractedEnc: Uint8Array | Buffer | null }): StoredOcr | null {
    if (!row.extractedEnc) return null;
    return JSON.parse(this.crypto.decrypt(row.extractedEnc)) as StoredOcr;
  }

  /** Starts as many jobs as the concurrency allows (fire and forget). */
  kick(): void {
    if (!this.enabled || this.draining) return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.running < this.concurrency) {
        const job = await this.claim();
        if (!job) return;
        this.running++;
        void this.process(job).finally(() => {
          this.running--;
          this.kick();
        });
      }
    } catch (err) {
      this.logger.warn(`OCR queue drain failed: ${(err as Error).name}`);
    }
  }

  /** Processes due jobs one by one until none is left (tests, maintenance scripts). */
  async runPending(now = () => new Date()): Promise<number> {
    let n = 0;
    for (;;) {
      const job = await this.claim(now());
      if (!job) return n;
      await this.process(job, now());
      n++;
    }
  }

  /** Optimistic claim of the oldest due PENDING job. */
  async claim(now = new Date()): Promise<Job | null> {
    for (let i = 0; i < 5; i++) {
      const next = await this.prisma.violationOcr.findFirst({
        where: { status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        select: { violationId: true, fileId: true, attempts: true },
      });
      if (!next) return null;
      const won = await this.prisma.violationOcr.updateMany({
        where: { violationId: next.violationId, status: 'PENDING' },
        data: { status: 'RUNNING', attempts: { increment: 1 } },
      });
      if (won.count === 1) return { ...next, attempts: next.attempts + 1 };
    }
    return null;
  }

  async process(job: Job, now = new Date()): Promise<void> {
    try {
      if (!job.fileId) throw new OcrPermanentError('NO_ID_CARD');
      const file = await this.prisma.file.findUnique({
        where: { id: job.fileId },
        select: { storageKey: true, status: true, deletedAt: true },
      });
      if (!file || file.deletedAt || file.status !== 'READY') throw new OcrPermanentError('FILE_GONE');
      const bytes = Buffer.from(await this.storage.readAll(file.storageKey));
      if (!bytes.length) throw new OcrPermanentError('FILE_EMPTY');
      // Security review A9: a decompression bomb (huge dimensions in a small file) never reaches
      // the engine — the size is read from the header and checked before decoding.
      const imageProblem = ocrImageProblem(bytes);
      if (imageProblem) throw new OcrPermanentError(imageProblem);
      const result = await this.engine.recognize(bytes);
      const fields = parseIdCard({ text: result.text, lines: result.lines });
      const payload: StoredOcr = { v: 1, fields, engine: OCR_ENGINE_LABEL, meanConfidence: Math.round(result.confidence) };
      const done = await this.prisma.violationOcr.updateMany({
        // The ID-card photo may have been replaced meanwhile: then this result is stale.
        where: { violationId: job.violationId, status: 'RUNNING', fileId: job.fileId },
        data: {
          status: 'DONE',
          extractedEnc: this.crypto.encrypt(JSON.stringify(payload)),
          idNumberHash: fields.nationalId ? this.crypto.blindIndex(fields.nationalId.value) : null,
          extractedAt: now,
          error: null,
          nextAttemptAt: null,
        },
      });
      if (!done.count) this.logger.log(`OCR result for violation ${job.violationId} discarded (job changed meanwhile)`);
    } catch (err) {
      const permanent = err instanceof OcrPermanentError;
      const reason = permanent ? (err as Error).message : `ENGINE_${(err as Error)?.name ?? 'Error'}`.slice(0, 80);
      const failed = permanent || job.attempts >= this.maxAttempts;
      await this.prisma.violationOcr
        .updateMany({
          where: { violationId: job.violationId, status: 'RUNNING' },
          data: failed
            ? { status: 'FAILED', error: reason, nextAttemptAt: null }
            : { status: 'PENDING', error: reason, nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)) },
        })
        .catch(() => undefined);
      this.logger.warn(
        `OCR job for violation ${job.violationId} failed (attempt ${job.attempts}/${this.maxAttempts}): ${reason}${failed ? ' — giving up' : ''}`,
      );
    }
  }
}
