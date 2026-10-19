/**
 * Self-hosts everything the in-browser ID-card OCR needs (owner request A9, ADR-104): copies the
 * tesseract.js worker script, the LSTM WASM cores and the Arabic + English `4.0.0_best_int`
 * language data from node_modules into `public/ocr/`, so the demo never contacts a CDN and works
 * under any base path (`/` or `/nuzli-project-management/`).
 *
 *   public/ocr/worker.min.js
 *   public/ocr/core/tesseract-core-lstm.wasm.js        (no SIMD)
 *   public/ocr/core/tesseract-core-simd-lstm.wasm.js   (SIMD)
 *   public/ocr/lang/ara.traineddata.gz
 *   public/ocr/lang/eng.traineddata.gz
 *
 * Runs from `npm run dev/build` (pre-scripts) and from the Vite config (so `npx vite build`
 * gets it too). Idempotent: unchanged files (same size) are not copied again.
 * Usage: node scripts/copy-ocr-assets.mjs
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_VARIANT = '4.0.0_best_int';
const LANGS = ['ara', 'eng'];
const CORES = ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'];

export function copyOcrAssets(webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const require = createRequire(join(webRoot, 'package.json'));
  const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
  const out = join(webRoot, 'public', 'ocr');
  const plan = [
    [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
    ...CORES.map((f) => [join(pkgDir('tesseract.js-core'), f), join(out, 'core', f)]),
    ...LANGS.map((l) => [
      join(pkgDir(`@tesseract.js-data/${l}`), DATA_VARIANT, `${l}.traineddata.gz`),
      join(out, 'lang', `${l}.traineddata.gz`),
    ]),
  ];
  let copied = 0;
  for (const [src, dest] of plan) {
    if (!existsSync(src)) throw new Error(`copy-ocr-assets: missing ${src}`);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
    copyFileSync(src, dest);
    copied++;
  }
  return { copied, total: plan.length, out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = copyOcrAssets();
  console.log(`OCR assets: ${r.copied} copied, ${r.total - r.copied} up to date → ${r.out}`);
}
