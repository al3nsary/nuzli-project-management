import { randomBytes } from 'node:crypto';
import { CryptoService } from '../../crypto/crypto.service';
import { linesOf, type OcrEngine } from './ocr-engine';
import { backoffMs, OcrQueueService, type StoredOcr } from './ocr-queue.service';

const crypto = new CryptoService({
  encKey: randomBytes(32).toString('base64'),
  hmacKey: randomBytes(32).toString('base64'),
});
const V = 'v0000000-0000-4000-8000-000000000001';
const F = 'f0000000-0000-4000-8000-000000000001';
const RESIDENT = '2345678904';

interface Job {
  violationId: string;
  fileId: string | null;
  status: string;
  attempts: number;
  error: string | null;
  nextAttemptAt: Date | null;
  extractedEnc: Buffer | null;
  idNumberHash: string | null;
  extractedAt: Date | null;
  createdAt: Date;
}

/** In-memory violation_ocr with the subset of Prisma the queue uses. */
function setup(opts: { engine?: Partial<OcrEngine>; enabled?: boolean; file?: Record<string, unknown> | null; maxAttempts?: number } = {}) {
  const jobs = new Map<string, Job>();
  const match = (j: Job, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Array<Record<string, unknown>>).some((w) => match(j, w));
      const val = (j as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !(v instanceof Date) && 'lte' in (v as object)) return val !== null && (val as Date) <= (v as { lte: Date }).lte;
      return val === v;
    });
  const violationOcr = {
    findUnique: jest.fn(async ({ where }: { where: { violationId: string } }) => jobs.get(where.violationId) ?? null),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const due = [...jobs.values()].filter((j) => match(j, where));
      due.sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0));
      return due[0] ? { violationId: due[0].violationId, fileId: due[0].fileId, attempts: due[0].attempts } : null;
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: { violationId: string }; create: Partial<Job>; update: Partial<Job> }) => {
      const cur = jobs.get(where.violationId);
      if (cur) Object.assign(cur, update);
      else jobs.set(where.violationId, { attempts: 0, error: null, extractedEnc: null, idNumberHash: null, extractedAt: null, createdAt: new Date(), ...create } as Job);
      return jobs.get(where.violationId);
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const j of jobs.values()) {
        if (!match(j, where)) continue;
        count++;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) (j as unknown as Record<string, number>)[k]! += (v as { increment: number }).increment;
          else (j as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: { where: { violationId: string } }) => ({ count: Number(jobs.delete(where.violationId)) })),
  };
  const prisma = {
    violationOcr,
    file: {
      findUnique: jest.fn().mockResolvedValue(
        opts.file === undefined ? { storageKey: 'violations/2026/10/f.jpg', status: 'READY', deletedAt: null } : opts.file,
      ),
    },
    violationFile: { findFirst: jest.fn().mockResolvedValue({ fileId: F }) },
  };
  const storage = { readAll: jest.fn().mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])) };
  const engine: OcrEngine = {
    recognize: jest.fn().mockResolvedValue({
      text: `الاسم: راجيش كومار\nرقم الإقامة ${RESIDENT}\nالجنسية: هندي`,
      confidence: 81.4,
      lines: [
        { text: 'الاسم: راجيش كومار', confidence: 88 },
        { text: `رقم الإقامة ${RESIDENT}`, confidence: 92 },
        { text: 'الجنسية: هندي', confidence: 85 },
      ],
    }),
    terminate: jest.fn().mockResolvedValue(undefined),
    ...opts.engine,
  };
  const cfg = { OCR_ENABLED: opts.enabled ?? false, OCR_CONCURRENCY: 1, OCR_MAX_ATTEMPTS: opts.maxAttempts ?? 3 };
  const svc = new OcrQueueService(prisma as never, storage as never, crypto, cfg as never, engine);
  return { svc, jobs, prisma, storage, engine };
}

describe('OCR queue (A9, ADR-104)', () => {
  it('enqueue persists a PENDING job; a repeated confirm of the same file changes nothing', async () => {
    const s = setup();
    await s.svc.enqueue(V, F);
    expect(s.jobs.get(V)).toMatchObject({ status: 'PENDING', fileId: F, attempts: 0 });
    await s.svc.enqueue(V, F);
    expect(s.prisma.violationOcr.upsert).toHaveBeenCalledTimes(1);
  });

  it('a successful job stores the fields encrypted with a blind index of the ID — never the OCR text', async () => {
    const s = setup();
    await s.svc.enqueue(V, F);
    await expect(s.svc.runPending()).resolves.toBe(1);
    const job = s.jobs.get(V)!;
    expect(job).toMatchObject({ status: 'DONE', attempts: 1, error: null, idNumberHash: crypto.blindIndex(RESIDENT) });
    expect(job.extractedEnc).toBeInstanceOf(Buffer);
    // The ciphertext does not contain the number or the name in clear.
    expect(job.extractedEnc!.toString('latin1')).not.toContain(RESIDENT);
    const stored = s.svc.read(job) as StoredOcr;
    expect(stored.fields.nationalId).toMatchObject({ value: RESIDENT });
    expect(stored.fields.name?.value).toBe('راجيش كومار');
    expect(stored.fields.nationality?.value).toBe('هندي');
    expect(stored.meanConfidence).toBe(81);
    expect(JSON.stringify(stored)).not.toContain('رقم الإقامة'); // raw lines are not kept
  });

  it('an engine failure is retried with back-off, then FAILED after OCR_MAX_ATTEMPTS', async () => {
    const recognize = jest.fn().mockRejectedValue(Object.assign(new Error('wasm crashed'), { name: 'RuntimeError' }));
    const s = setup({ engine: { recognize }, maxAttempts: 3 });
    const t0 = new Date('2026-10-19T08:00:00Z');
    await s.svc.enqueue(V, F, t0);
    await s.svc.runPending(() => t0);
    expect(s.jobs.get(V)).toMatchObject({ status: 'PENDING', attempts: 1, error: 'ENGINE_RuntimeError' });
    expect(s.jobs.get(V)!.nextAttemptAt).toEqual(new Date(t0.getTime() + 30_000));
    // Not due yet → nothing runs.
    await expect(s.svc.runPending(() => new Date(t0.getTime() + 10_000))).resolves.toBe(0);
    const t1 = new Date(t0.getTime() + 31_000);
    await s.svc.runPending(() => t1);
    expect(s.jobs.get(V)).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(s.jobs.get(V)!.nextAttemptAt).toEqual(new Date(t1.getTime() + 120_000));
    await s.svc.runPending(() => new Date(t1.getTime() + 121_000));
    expect(s.jobs.get(V)).toMatchObject({ status: 'FAILED', attempts: 3, nextAttemptAt: null });
    expect(recognize).toHaveBeenCalledTimes(3);
  });

  it('a missing or deleted photo fails at once (no retry)', async () => {
    const s = setup({ file: { storageKey: 'k', status: 'READY', deletedAt: new Date() } });
    await s.svc.enqueue(V, F);
    await s.svc.runPending();
    expect(s.jobs.get(V)).toMatchObject({ status: 'FAILED', error: 'FILE_GONE', attempts: 1 });
    expect(s.engine.recognize).not.toHaveBeenCalled();
  });

  it('the start-up sweep re-queues RUNNING jobs; claiming is exclusive', async () => {
    const s = setup();
    await s.svc.enqueue(V, F);
    const claimed = await s.svc.claim();
    expect(claimed).toMatchObject({ violationId: V, attempts: 1 });
    expect(await s.svc.claim()).toBeNull(); // already RUNNING
    expect(s.jobs.get(V)!.status).toBe('RUNNING');
    await expect(s.svc.sweep()).resolves.toBe(1);
    expect(s.jobs.get(V)!.status).toBe('PENDING');
  });

  it('a FAILED job is restarted by a new confirm or an admin retry', async () => {
    const s = setup({ file: null });
    await s.svc.enqueue(V, F);
    await s.svc.runPending();
    expect(s.jobs.get(V)!.status).toBe('FAILED');
    await s.svc.enqueue(V, F);
    expect(s.jobs.get(V)).toMatchObject({ status: 'PENDING', attempts: 0, error: null });
    await s.svc.retry(V);
    expect(s.jobs.get(V)).toMatchObject({ status: 'PENDING', fileId: F });
  });

  it('a result for a replaced ID-card photo is discarded', async () => {
    const s = setup();
    await s.svc.enqueue(V, F);
    const job = (await s.svc.claim())!;
    s.jobs.get(V)!.fileId = 'another-file';
    await s.svc.process(job);
    expect(s.jobs.get(V)!.status).toBe('RUNNING');
    expect(s.jobs.get(V)!.extractedEnc).toBeNull();
  });

  it('with OCR_ENABLED=false jobs are kept PENDING and nothing runs by itself', async () => {
    const s = setup({ enabled: false });
    await s.svc.enqueue(V, F);
    await new Promise((r) => setImmediate(r));
    expect(s.engine.recognize).not.toHaveBeenCalled();
    expect(s.jobs.get(V)!.status).toBe('PENDING');
  });

  it('with OCR_ENABLED the enqueue kicks the in-process worker', async () => {
    const s = setup({ enabled: true });
    await s.svc.enqueue(V, F);
    for (let i = 0; i < 20 && s.jobs.get(V)!.status !== 'DONE'; i++) await new Promise((r) => setImmediate(r));
    expect(s.jobs.get(V)!.status).toBe('DONE');
  });

  it('back-off grows ×4 from 30 s and is capped at one hour', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([30_000, 120_000, 480_000, 1_920_000, 3_600_000, 3_600_000]);
  });

  it('tesseract v5 output is flattened from blocks → paragraphs → lines', () => {
    expect(
      linesOf({ text: 'x', blocks: [{ paragraphs: [{ lines: [{ text: ' أ ', confidence: 90 }, { text: '', confidence: 1 }] }] }] }),
    ).toEqual([{ text: 'أ', confidence: 90 }]);
    expect(linesOf({ lines: [{ text: 'b', confidence: null }] })).toEqual([{ text: 'b', confidence: undefined }]);
  });
});
