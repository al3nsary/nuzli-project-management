import { Logger } from '@nestjs/common';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OcrLine } from './ocr-parser';

/** Raw OCR output kept only in memory for the parser — never logged or stored (ADR-104). */
export interface OcrResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
}

export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
  terminate(): Promise<void>;
}

export const OCR_ENGINE = Symbol('OCR_ENGINE');

/** Self-hosted language data (never a CDN): the `@tesseract.js-data/*` packages. */
export const OCR_LANGS = ['ara', 'eng'] as const;
const DATA_VARIANT = '4.0.0_best_int';

/**
 * tesseract.js reads every language from one `langPath`, but each language ships in its own
 * package. The two `.traineddata.gz` files are copied once into a private temp folder (same
 * bytes, no download) and that folder is the langPath. Throws when a package is missing.
 */
export function prepareLangPath(target = join(tmpdir(), 'nuzli-tessdata', DATA_VARIANT)): string {
  mkdirSync(target, { recursive: true });
  for (const lang of OCR_LANGS) {
    const pkg = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    const src = join(pkg, DATA_VARIANT, `${lang}.traineddata.gz`);
    const dest = join(target, `${lang}.traineddata.gz`);
    if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) copyFileSync(src, dest);
  }
  return target;
}

interface TessLine {
  text?: string | null;
  confidence?: number | null;
}

interface TessPage {
  text?: string;
  confidence?: number;
  lines?: TessLine[] | null;
  blocks?: Array<{ paragraphs?: Array<{ lines?: TessLine[] }> }> | null;
}

/** Flattens tesseract.js v5 output (lines are nested under blocks → paragraphs). */
export function linesOf(page: TessPage): OcrLine[] {
  const flat: TessLine[] = page.lines?.length
    ? page.lines
    : (page.blocks ?? []).flatMap((b) => (b.paragraphs ?? []).flatMap((p) => p.lines ?? []));
  return flat
    .map((l) => ({ text: String(l.text ?? '').trim(), confidence: typeof l.confidence === 'number' ? l.confidence : undefined }))
    .filter((l) => l.text.length > 0);
}

/**
 * tesseract.js (WASM, in-process worker thread) with Arabic + English LSTM models. One worker is
 * created lazily and reused; jobs are serialised by the queue (concurrency 1–2 → 1–2 engines).
 * Preprocessing: none beyond tesseract's own binarisation plus `rotateAuto` (deskew) — sharp/jimp
 * are not dependencies (ADR-104).
 */
export class TesseractEngine implements OcrEngine {
  private readonly logger = new Logger('OcrEngine');
  private worker: Promise<import('tesseract.js').Worker> | null = null;

  private async getWorker(): Promise<import('tesseract.js').Worker> {
    if (!this.worker) {
      this.worker = (async () => {
        const { createWorker, OEM } = await import('tesseract.js');
        const langPath = prepareLangPath();
        return createWorker([...OCR_LANGS], OEM.LSTM_ONLY, {
          langPath,
          gzip: true,
          // Never write a cache next to the process (default cachePath is '.').
          cacheMethod: 'none',
          errorHandler: (err: unknown) => this.logger.warn(`OCR worker error: ${(err as Error)?.name ?? 'Error'}`),
        });
      })().catch((err: unknown) => {
        this.worker = null;
        throw err;
      });
    }
    return this.worker;
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true });
    const page = data as unknown as TessPage;
    return { text: page.text ?? '', confidence: page.confidence ?? 0, lines: linesOf(page) };
  }

  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => undefined);
  }
}
