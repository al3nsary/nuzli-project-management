/**
 * Security review A12 M5 (ADR-166) — the mutation gate of the API isolation suite.
 *
 *   npm run test:isolation:mutation                      # every scoped model, 4 at a time
 *   npm run test:isolation:mutation -- --models=Team,Task --concurrency=2
 *   npm run test:isolation:mutation -- --http-only       # measure the HTTP probes alone
 *
 * For each of the 47 workspace-scoped models it runs `test/isolation/mutation.mut-spec.ts` with
 * `MUT_MODEL=<model>`: the application-layer workspace filter of that ONE model is removed (reads,
 * updates, deletes) and the real isolation suite runs with RLS off. The suite MUST fail for every
 * model ("killed"). A control run without a mutation must pass first. Exit code 1 when the control
 * fails or any mutant survives. No model may be listed as an accepted survivor.
 *
 * Runs on Node ≥ 22.6 (TypeScript type stripping; Node 24 needs no flag) from `apps/api`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface Outcome {
  model: string;
  killed: boolean;
  summary: string;
  reasons: string[];
  ms: number;
}

const cwd = process.cwd();
const requireHere = createRequire(join(cwd, 'package.json'));
const jestBin = requireHere.resolve('jest/bin/jest');

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

/** The 47 models, read from the source of truth (src/prisma/scoping.ts → SCOPED_MODELS). */
function scopedModels(): string[] {
  const src = readFileSync(join(cwd, 'src/prisma/scoping.ts'), 'utf8');
  const block = /SCOPED_MODELS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error('SCOPED_MODELS not found in src/prisma/scoping.ts');
  return [...block[1]!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!);
}

function runOnce(model: string | null, httpOnly: boolean): Promise<Outcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUT_HTTP_ONLY: httpOnly ? '1' : '' };
    if (model) env.MUT_MODEL = model;
    else delete env.MUT_MODEL;
    const child = spawn(
      process.execPath,
      [jestBin, '--testRegex', 'mutation\\.mut-spec\\.ts$', '--roots', '<rootDir>/test/isolation', '--runInBand', '--silent', '--ci'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => {
      const summary = /Tests:\s+([^\n]+)/.exec(out)?.[1]?.trim() ?? `exit ${code}`;
      const reasons = [...out.matchAll(/^\s+(?:"|')?((?:LEAK|ACCEPTED|5xx) [^\n"']{0,140})/gm)].map((m) => m[1]!.trim());
      const failedTests = [...out.matchAll(/[✕×] ([^\n(]+)/g)].map((m) => m[1]!.trim());
      const probeLeaks = [...out.matchAll(/"([A-Za-z]+\.(?:findMany|count|findFirst)[^"]{0,80})"/g)].map((m) => m[1]!);
      resolve({
        model: model ?? '(control)',
        killed: code !== 0,
        summary,
        reasons: [...new Set([...reasons, ...probeLeaks, ...failedTests.map((t) => `failed: ${t.slice(0, 110)}`)])].slice(0, 6),
        ms: Date.now() - started,
      });
    });
  });
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const httpOnly = arg('http-only') === 'true';
  const concurrency = Math.max(1, Number(arg('concurrency') ?? 4) || 4);
  const all = scopedModels();
  const only = arg('models')?.split(',').map((x) => x.trim()).filter(Boolean);
  const models = only?.length ? all.filter((m) => only.includes(m)) : all;
  if (!only && all.length !== 47) console.log(`[mutation] note: SCOPED_MODELS has ${all.length} models (47 expected since A12 round 2)`);

  console.log(`[mutation] control run (no mutation)${httpOnly ? ' — HTTP probes only' : ''}…`);
  const control = await runOnce(null, httpOnly);
  if (control.killed) {
    console.error(`[mutation] the CONTROL run fails (${control.summary}); fix the suite first.\n  ${control.reasons.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[mutation] control passes (${control.summary}, ${Math.round(control.ms / 1000)} s). ${models.length} mutants, ${concurrency} at a time…`);

  const results = await pool(models, concurrency, async (m) => {
    const r = await runOnce(m, httpOnly);
    console.log(`  ${r.killed ? 'KILLED  ' : 'SURVIVED'} ${m.padEnd(22)} ${r.summary}${r.reasons[0] ? `  — ${r.reasons[0]}` : ''}`);
    return r;
  });
  const killed = results.filter((r) => r.killed);
  const survived = results.filter((r) => !r.killed);
  const lines = [
    `# API isolation mutation check — ${new Date().toISOString()}${httpOnly ? ' (HTTP probes only)' : ''}`,
    `control: ${control.summary}`,
    `killed: ${killed.length}/${results.length}`,
    ...results.map((r) => `${r.killed ? 'KILLED  ' : 'SURVIVED'} ${r.model.padEnd(22)} ${r.summary} | ${r.reasons.join(' | ')}`),
  ];
  const outFile = arg('out');
  if (outFile && outFile !== 'true') writeFileSync(outFile, `${lines.join('\n')}\n`);
  console.log(`\n[mutation] ${killed.length}/${results.length} mutants killed${httpOnly ? ' by the HTTP probes alone' : ''}.`);
  if (survived.length) {
    console.error(`[mutation] SURVIVED (the suite would not notice these models losing their workspace filter): ${survived.map((r) => r.model).join(', ')}`);
    if (!httpOnly) process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
