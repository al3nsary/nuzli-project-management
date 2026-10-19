import { parseIdCard } from '../../features/violations/ocr/parse';
import type { OcrEngine } from '../../features/violations/ocr/engine';
import type { DemoDb, DemoFile, DemoViolationOcr } from './db';

/**
 * The demo's ID-card reading queue (owner request A9, ADR-104 rules, run in the browser): a
 * confirmed ID_CARD photo queues a job; jobs run one at a time on one tesseract.js worker; the
 * result is parsed with the SAME parser as the API (`features/violations/ocr/parse.ts`). Up to
 * three attempts, then FAILED with a short reason code (never OCR text); an admin may retry.
 * A result for a photo that was replaced meanwhile is discarded.
 */
export const OCR_MAX_ATTEMPTS = 3;

export interface OcrRunnerDeps {
  db: DemoDb;
  engine(): Promise<OcrEngine>;
  /** The photo bytes (drawing a seeded placeholder card when needed). */
  imageOf(file: DemoFile): Promise<Blob>;
}

class PermanentOcrError extends Error {}

export function createOcrRunner(deps: OcrRunnerDeps) {
  const { db } = deps;
  const running = new Map<string, Promise<void>>();
  let chain: Promise<unknown> = Promise.resolve();

  async function put(row: DemoViolationOcr) {
    await db.violationOcr.put({ ...row, updatedAt: new Date().toISOString() });
  }

  /** Queues (or re-queues for a new photo) the reading of a violation's ID card. */
  async function enqueue(violationId: string, fileId: string) {
    const cur = await db.violationOcr.get(violationId);
    if (cur && cur.fileId === fileId && cur.status !== 'FAILED') return;
    await put({
      violationId,
      fileId,
      status: 'PENDING',
      attempts: 0,
      error: null,
      extracted: null,
      extractedAt: null,
      updatedAt: '',
    });
    kick(violationId);
  }

  /** Starts a PENDING job (no-op when it is running or not pending). Answers when it ends. */
  function kick(violationId: string): Promise<void> {
    const existing = running.get(violationId);
    if (existing) return existing;
    const job = chain.then(() => run(violationId)).catch(() => undefined);
    chain = job;
    running.set(violationId, job);
    void job.finally(() => running.delete(violationId));
    return job;
  }

  async function run(violationId: string) {
    for (;;) {
      const job = await db.violationOcr.get(violationId);
      if (!job || job.status !== 'PENDING') return;
      const attempt = job.attempts + 1;
      await put({ ...job, status: 'RUNNING', attempts: attempt });
      try {
        const file = await db.files.get(job.fileId);
        if (!file || file.status !== 'READY' || file.deletedAt) throw new PermanentOcrError('FILE_GONE');
        const image = await deps.imageOf(file);
        if (!image.size) throw new PermanentOcrError('FILE_EMPTY');
        const engine = await deps.engine();
        const result = await engine.recognize(image);
        const extracted = parseIdCard({ text: result.text, lines: result.lines });
        const now = await db.violationOcr.get(violationId);
        // The photo was replaced (or the job reset) meanwhile: this result is stale.
        if (!now || now.fileId !== job.fileId || now.status !== 'RUNNING') return;
        await put({ ...now, status: 'DONE', error: null, extracted, extractedAt: new Date().toISOString() });
        return;
      } catch (err) {
        const permanent = err instanceof PermanentOcrError;
        const reason = permanent ? err.message : `ENGINE_${(err as Error)?.name ?? 'Error'}`.slice(0, 80);
        const failed = permanent || attempt >= OCR_MAX_ATTEMPTS;
        const now = await db.violationOcr.get(violationId);
        if (!now || now.status !== 'RUNNING') return;
        await put({ ...now, status: failed ? 'FAILED' : 'PENDING', error: reason });
        if (failed) return;
      }
    }
  }

  /** Admin «إعادة المحاولة»: back to PENDING with fresh attempts. */
  async function retry(violationId: string) {
    const cur = await db.violationOcr.get(violationId);
    if (!cur) return false;
    await put({ ...cur, status: 'PENDING', attempts: 0, error: null, extracted: null, extractedAt: null });
    kick(violationId);
    return true;
  }

  /** Tests: wait until every started job has finished. */
  async function idle() {
    while (running.size) await Promise.all([...running.values()]);
  }

  return { enqueue, kick, retry, idle };
}

export type OcrRunner = ReturnType<typeof createOcrRunner>;
