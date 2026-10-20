#!/usr/bin/env node
/**
 * Security review A12 M5 (ADR-166) — the mutation gate of the demo isolation suite.
 *
 *   npm run test:isolation:mutation                 # every scoped Dexie table, 4 at a time
 *   npm run test:isolation:mutation -- --tables=notifications,participants
 *
 * For each table of SCOPED_TABLES (src/api/demo/scoping.ts) the demo isolation suite runs with
 * that table's workspace filter removed (`NZ_MUTATE_TABLE`, src/api/demo/isolation.mutation-setup.ts).
 * The suite must FAIL for every table; a control run without a mutation must pass first.
 * Exit code 1 when the control fails or any mutant survives.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = createRequire(join(root, 'package.json')).resolve('vitest/vitest.mjs');

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};

function scopedTables() {
  const src = readFileSync(join(root, 'src/api/demo/scoping.ts'), 'utf8');
  const block = /export const SCOPED_TABLES = \[([\s\S]*?)\] as const/.exec(src);
  if (!block) throw new Error('SCOPED_TABLES not found in src/api/demo/scoping.ts');
  return [...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
}

function runOnce(table) {
  const started = Date.now();
  return new Promise((resolve) => {
    const env = { ...process.env, NZ_MUTATE_TABLE: table ?? '' };
    const child = spawn(process.execPath, [vitestBin, 'run', '--config', 'vitest.isolation-mutation.config.ts', '--reporter=dot'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => {
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
      const summary = /^\s+Tests\s+(.+)$/m.exec(clean)?.[1]?.trim() ?? `exit ${code}`;
      const reason = /(?:Error|AssertionError): ([^\n]{0,160})/.exec(clean)?.[1] ?? '';
      resolve({ table: table ?? '(control)', killed: code !== 0, summary, reason, ms: Date.now() - started });
    });
  });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const all = scopedTables();
const only = arg('tables')?.split(',').map((x) => x.trim()).filter(Boolean);
const tables = only?.length ? all.filter((t) => only.includes(t)) : all;
const concurrency = Math.max(1, Number(arg('concurrency') ?? 4) || 4);

console.log('[demo mutation] control run (no mutation)…');
const control = await runOnce(null);
if (control.killed) {
  console.error(`[demo mutation] the CONTROL run fails (${control.summary}) ${control.reason}`);
  process.exit(1);
}
console.log(`[demo mutation] control passes (${control.summary}, ${Math.round(control.ms / 1000)} s). ${tables.length} mutants, ${concurrency} at a time…`);
const results = await pool(tables, concurrency, async (t) => {
  const r = await runOnce(t);
  console.log(`  ${r.killed ? 'KILLED  ' : 'SURVIVED'} ${t.padEnd(18)} ${r.summary}${r.reason ? `  — ${r.reason.slice(0, 110)}` : ''}`);
  return r;
});
const killed = results.filter((r) => r.killed);
const out = arg('out');
if (out && out !== 'true') {
  writeFileSync(out, [`# demo isolation mutation check — ${new Date().toISOString()}`, `control: ${control.summary}`, `killed: ${killed.length}/${results.length}`, ...results.map((r) => `${r.killed ? 'KILLED  ' : 'SURVIVED'} ${r.table.padEnd(18)} ${r.summary} | ${r.reason}`)].join('\n') + '\n');
}
console.log(`\n[demo mutation] ${killed.length}/${results.length} mutants killed.`);
const survived = results.filter((r) => !r.killed);
if (survived.length) {
  console.error(`[demo mutation] SURVIVED: ${survived.map((r) => r.table).join(', ')}`);
  process.exit(1);
}
