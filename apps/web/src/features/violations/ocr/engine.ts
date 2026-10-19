import type { OcrLine } from './parse';

/**
 * ID-card OCR in the browser for the demo build (owner request A9, ADR-104 + this round's ADR):
 * tesseract.js 5 with the Arabic + English LSTM models. Everything is self-hosted under
 * `<base>/ocr/` (copied by `scripts/copy-ocr-assets.mjs`): the worker script, the WASM core and
 * the `4.0.0_best_int` language data — no CDN is ever contacted. The library is imported lazily,
 * so the main bundle does not grow; one worker is created on first use and reused.
 * Raw OCR text stays in memory for the parser and is never stored or logged.
 */

export interface OcrResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
}

export interface OcrEngine {
  recognize(image: Blob): Promise<OcrResult>;
  terminate(): Promise<void>;
}

export const OCR_LANGS = ['ara', 'eng'] as const;

/** Absolute URLs (the worker resolves relative paths against its own script URL). */
export function ocrAssetUrls(base: string = import.meta.env.BASE_URL ?? '/', origin: string = location.href) {
  const root = new URL(`${base.replace(/\/?$/, '/')}ocr/`, origin).href;
  return {
    workerPath: `${root}worker.min.js`,
    corePath: `${root}core/`,
    langPath: `${root}lang`,
  };
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

/** Flattens tesseract.js v5 output (lines are nested under blocks → paragraphs). Same as the API. */
export function linesOf(page: TessPage): OcrLine[] {
  const flat: TessLine[] = page.lines?.length
    ? page.lines
    : (page.blocks ?? []).flatMap((b) => (b.paragraphs ?? []).flatMap((p) => p.lines ?? []));
  return flat
    .map((l) => ({ text: String(l.text ?? '').trim(), confidence: typeof l.confidence === 'number' ? l.confidence : undefined }))
    .filter((l) => l.text.length > 0);
}

let shared: Promise<OcrEngine> | null = null;

/** The browser engine (lazy, one worker). A failed start is retried on the next call. */
export function browserOcrEngine(): Promise<OcrEngine> {
  if (!shared) {
    shared = (async (): Promise<OcrEngine> => {
      // No Web Worker (tests, very old browsers): fail fast; the job ends FAILED and can be retried.
      if (typeof Worker === 'undefined') throw new Error('NoWorker');
      const { createWorker, OEM } = await import('tesseract.js');
      const urls = ocrAssetUrls();
      const worker = await createWorker([...OCR_LANGS], OEM.LSTM_ONLY, {
        workerPath: urls.workerPath,
        corePath: urls.corePath,
        langPath: urls.langPath,
        gzip: true,
        // A same-origin worker script, not a blob wrapper (CSP-friendly, no importScripts of a CDN).
        workerBlobURL: false,
        // The language data (not personal data) is cached in IndexedDB for the next reading.
        cachePath: 'nuzli-ocr',
      });
      return {
        async recognize(image: Blob) {
          const { data } = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true });
          const page = data as unknown as TessPage;
          return { text: page.text ?? '', confidence: page.confidence ?? 0, lines: linesOf(page) };
        },
        async terminate() {
          shared = null;
          await worker.terminate().catch(() => undefined);
        },
      };
    })().catch((err: unknown) => {
      shared = null;
      throw err;
    });
  }
  return shared;
}
