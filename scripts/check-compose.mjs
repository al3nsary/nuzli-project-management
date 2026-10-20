#!/usr/bin/env node
/**
 * Compose lint without Docker (A12 final step, ADR-168).
 *
 *   node scripts/check-compose.mjs
 *
 * `docker compose config` is the real check; this script is what can run anywhere (CI, a laptop
 * without Docker). It parses the three compose files strictly (duplicate keys fail), merges the
 * base with the dev and prod overrides the way compose does for the keys used here, and checks:
 *   - every service has an image or a build, every `depends_on` target exists and, for
 *     `service_healthy`, has a healthcheck (compose or the image's Dockerfile HEALTHCHECK);
 *   - networks, volumes and env_file paths exist (env files through their committed `.example`);
 *   - production: no MinIO/mailpit, restart policy + resource limits on every service, no published
 *     port on db/api, NODE_ENV=production and DB_REQUIRE_RLS=true for the API, read-only roots;
 *   - every `${VAR}` used by compose is in .env.example or has a default;
 *   - every variable each container reads is documented in its env/*.env.example (or set by compose
 *     or the Dockerfile): API (src/config/env.schema.ts + process.env), backup (infra/backup/*.sh),
 *     converter (ConverterServer.java), db and minio.
 * Exit 1 on an error; warnings are printed but do not fail.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const YAML = require('yaml');

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function parseCompose(file) {
  const doc = YAML.parseDocument(read(file), { uniqueKeys: true, merge: true, prettyErrors: true });
  for (const e of doc.errors) err(`${file}: ${e.message}`);
  for (const w of doc.warnings) warn(`${file}: ${w.message}`);
  return doc.toJS({ maxAliasCount: 100 }) ?? {};
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Compose merge for the keys used here: maps merge deeply, scalars and sequences are replaced. */
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}

/** KEY=VALUE lines (comments and blanks ignored; `# KEY=` counts as documented-but-commented). */
function envKeys(file) {
  const keys = new Map();
  if (!existsSync(join(ROOT, file))) return keys;
  for (const raw of read(file).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) keys.set(m[2], { commented: !!m[1], value: m[3] });
  }
  return keys;
}
const envListToMap = (env) => (Array.isArray(env) ? Object.fromEntries(env.map((e) => [e.split('=')[0], e.split('=').slice(1).join('=')])) : env ?? {});

const files = { base: 'docker-compose.yml', dev: 'docker-compose.dev.yml', prod: 'docker-compose.prod.yml' };
const base = parseCompose(files.base);
const dev = parseCompose(files.dev);
const prod = parseCompose(files.prod);
const stacks = { prod: merge(base, prod), dev: merge(base, dev) };

/** HEALTHCHECK declared in the image built for a service (Dockerfile of its build). */
function dockerfileOf(svc) {
  const b = svc.build;
  if (!b) return null;
  const ctx = typeof b === 'string' ? b : b.context ?? '.';
  const df = typeof b === 'string' ? 'Dockerfile' : b.dockerfile ?? 'Dockerfile';
  const p = join(ctx, df);
  return existsSync(join(ROOT, p)) ? p : null;
}
const imageHasHealthcheck = (svc) => {
  const df = dockerfileOf(svc);
  return !!df && /^HEALTHCHECK\s+(?!NONE)/m.test(read(df));
};

// ───────────────────────────────────────────── structure of each merged stack
for (const [name, stack] of Object.entries(stacks)) {
  const services = stack.services ?? {};
  const nets = new Set(Object.keys(stack.networks ?? {}));
  const vols = new Set(Object.keys(stack.volumes ?? {}));
  for (const [sname, svc] of Object.entries(services)) {
    const where = `[${name}] ${sname}`;
    if (!svc.image && !svc.build) err(`${where}: neither image nor build`);
    if (svc.build) {
      const df = dockerfileOf(svc);
      if (!df) err(`${where}: Dockerfile not found for build ${JSON.stringify(svc.build)}`);
    }
    for (const n of Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {})) {
      if (!nets.has(n)) err(`${where}: network "${n}" is not defined`);
    }
    for (const v of svc.volumes ?? []) {
      const src = String(typeof v === 'string' ? v.split(':')[0] : v.source ?? '');
      if (src && !src.startsWith('.') && !src.startsWith('/') && !src.startsWith('$') && !vols.has(src)) err(`${where}: volume "${src}" is not defined`);
      if (src.startsWith('./') && !existsSync(join(ROOT, src))) err(`${where}: bind source ${src} does not exist`);
    }
    for (const f of [svc.env_file ?? []].flat()) {
      const path = typeof f === 'string' ? f : f.path;
      if (!existsSync(join(ROOT, `${path}.example`)) && !existsSync(join(ROOT, path))) err(`${where}: env_file ${path} has no ${path}.example`);
    }
    const deps = Array.isArray(svc.depends_on) ? Object.fromEntries(svc.depends_on.map((d) => [d, {}])) : svc.depends_on ?? {};
    for (const [dep, cond] of Object.entries(deps)) {
      const target = services[dep];
      if (!target) {
        err(`${where}: depends_on "${dep}" which is not a service`);
        continue;
      }
      if (cond.condition === 'service_healthy' && !target.healthcheck && !imageHasHealthcheck(target)) {
        err(`${where}: waits for "${dep}" to be healthy but "${dep}" has no healthcheck`);
      }
    }
    const longRunning = !(svc.restart === 'no' || /init$/.test(sname));
    if (longRunning && !svc.healthcheck && !imageHasHealthcheck(svc)) warn(`${where}: no healthcheck`);
    if (svc.healthcheck?.test) {
      const t = [svc.healthcheck.test].flat().join(' ');
      if (/CMD-SHELL/.test(t) && /\/dev\/tcp\//.test(t)) err(`${where}: healthcheck uses bash /dev/tcp through CMD-SHELL (/bin/sh may be dash); use ["CMD", "bash", "-c", …]`);
    }
  }
}

// ───────────────────────────────────────────── production rules
{
  const services = stacks.prod.services ?? {};
  for (const forbidden of ['minio', 'minio-init', 'mailpit']) if (services[forbidden]) err(`[prod] service ${forbidden} must not exist in production`);
  for (const [sname, svc] of Object.entries(services)) {
    if (svc.profiles?.length) continue;
    if (!['unless-stopped', 'always'].includes(svc.restart)) err(`[prod] ${sname}: restart policy missing`);
    if (!svc.deploy?.resources?.limits?.memory) err(`[prod] ${sname}: no memory limit`);
    if (sname !== 'db' && svc.read_only !== true) err(`[prod] ${sname}: root filesystem is not read-only`);
    if (sname !== 'db' && !(svc.cap_drop ?? []).includes('ALL')) err(`[prod] ${sname}: capabilities not dropped`);
    if (['db', 'api', 'converter', 'backup'].includes(sname) && svc.ports?.length) err(`[prod] ${sname}: must not publish a port`);
  }
  const apiEnv = envListToMap(services.api?.environment);
  if (apiEnv.NODE_ENV !== 'production') err('[prod] api: NODE_ENV must be production');
  if (String(apiEnv.DB_REQUIRE_RLS) !== 'true') err('[prod] api: DB_REQUIRE_RLS must be "true"');
  const proxyPorts = (services.proxy?.ports ?? []).map(String);
  if (!proxyPorts.some((p) => /8443$/.test(p))) err('[prod] proxy: HTTPS port not published');
  if (stacks.prod.networks?.converter?.internal !== true) err('[prod] the converter network must be internal');
}

// ───────────────────────────────────────────── ${VAR} interpolation vs .env.example
const dotenv = envKeys('.env.example');
for (const [label, file] of Object.entries(files)) {
  const text = read(file).replace(/^\s*#.*$/gm, '');
  for (const m of text.matchAll(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)(:?[-?][^}]*)?\}/g)) {
    const [, v, def] = m;
    if (!def && !dotenv.has(v)) err(`${file}: \${${v}} has no default and is not in .env.example`);
    else if (!dotenv.has(v) && !['S3_BUCKET'].includes(v)) warn(`${file} (${label}): \${${v}} is not documented in .env.example (default used)`);
  }
}

// ───────────────────────────────────────────── variables each container reads vs its example
function apiReads() {
  const schema = read('apps/api/src/config/env.schema.ts');
  const body = schema.slice(schema.indexOf('z\n  .object({'), schema.indexOf('.superRefine'));
  const out = new Map();
  for (const m of body.matchAll(/^\s{4}([A-Z][A-Z0-9_]*):\s*(.+)$/gm)) {
    const def = m[2];
    const optional = /\.optional\(\)|\.default\(|\bbool\(|\bint\(|\bcsv\b/.test(def);
    out.set(m[1], { required: !optional });
  }
  const walk = (dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [join(dir, e.name)] : [],
    );
  for (const f of walk('apps/api/src')) {
    for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) if (!out.has(m[1])) out.set(m[1], { required: false });
  }
  // Seed (src/seed/seed.ts SeedEnv) and the entrypoint.
  for (const m of read('apps/api/src/seed/seed.ts').matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:\s*string;/gm)) if (!out.has(m[1])) out.set(m[1], { required: false });
  for (const m of read('apps/api/docker-entrypoint.sh').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) if (!out.has(m[1])) out.set(m[1], { required: false });
  return out;
}
function shReads(globDir) {
  const out = new Map();
  for (const f of readdirSync(join(ROOT, globDir)).filter((n) => n.endsWith('.sh'))) {
    const text = read(join(globDir, f));
    const local = new Set([...text.matchAll(/^\s*(?:local\s+)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*)(:?-)?/g)) {
      if (local.has(m[1]) && !m[2]) continue;
      if (!out.has(m[1])) out.set(m[1], { required: false });
    }
  }
  return out;
}
function dockerfileEnv(path) {
  const out = new Set();
  const text = read(path).replace(/\\\r?\n/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*ENV\s/.test(line)) continue;
    for (const m of line.matchAll(/([A-Z][A-Z0-9_]*)=/g)) out.add(m[1]);
  }
  return out;
}
const IGNORE = new Set([
  'NODE_ENV', 'PORT', 'TRUST_PROXY', 'CHECKPOINT_DISABLE', 'PRISMA_HIDE_UPDATE_MESSAGE', 'HOME', 'PATH', 'TZ', 'PGTZ',
  'OCR_SMOKE', 'GNUPGHOME', 'PBKDF2_ITER', 'RETENTION', 'S3_ENDPOINT_ARG', 'BACKUP_DIR', 'NUZLI_TEST_LOG', 'TMPDIR', 'AWS_CONFIG_FILE',
]);
function crossCheck(service, reads, exampleFile, extra = new Set()) {
  const example = envKeys(exampleFile);
  const composeEnv = new Set([
    ...Object.keys(envListToMap(stacks.prod.services?.[service]?.environment)),
    ...Object.keys(envListToMap(stacks.dev.services?.[service]?.environment)),
  ]);
  const missing = [];
  for (const [v, meta] of reads) {
    if (IGNORE.has(v) || composeEnv.has(v) || extra.has(v)) continue;
    if (!example.has(v)) (meta.required ? err : warn)(`${service}: reads ${v}${meta.required ? ' (required)' : ''} — not in ${exampleFile}`), missing.push(v);
  }
  const unused = [...example.keys()].filter((k) => !reads.has(k) && !IGNORE.has(k) && !extra.has(k));
  for (const k of unused) warn(`${service}: ${exampleFile} documents ${k}, which nothing reads`);
  return missing;
}
crossCheck('api', apiReads(), 'env/api.env.example');
// pg_dump / psql read the libpq variables themselves.
const LIBPQ = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
crossCheck('backup', shReads('infra/backup'), 'env/backup.env.example', new Set([...dockerfileEnv('infra/backup/Dockerfile'), ...LIBPQ]));
{
  const java = read('infra/converter/src/ConverterServer.java');
  const reads = new Map([...java.matchAll(/(?:getenv|envLong|envInt)\("([A-Z][A-Z0-9_]*)"/g)].map((m) => [m[1], { required: false }]));
  crossCheck('converter', reads, 'env/converter.env.example', dockerfileEnv('infra/converter/Dockerfile'));
}
crossCheck('db', new Map(['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].map((k) => [k, { required: true }])), 'env/db.env.example');
crossCheck('minio', new Map(['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'S3_BUCKET'].map((k) => [k, { required: true }])), 'env/minio.env.example');

// ───────────────────────────────────────────── report
const services = (s) => Object.keys(s.services ?? {}).join(', ');
console.log(`compose files parsed: ${Object.values(files).join(', ')}`);
console.log(`  prod services: ${services(stacks.prod)}`);
console.log(`  dev services:  ${services(stacks.dev)}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `\n${errors.length} error(s), ${warnings.length} warning(s)` : `\nOK — 0 errors, ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
