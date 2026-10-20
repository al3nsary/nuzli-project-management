#!/usr/bin/env node
/**
 * فحص ما قبل النشر — Nuzli pre-deployment check (A12 final step, ADR-170). Node ≥ 18, no packages.
 *
 *   node scripts/preflight.mjs                     # the real files: .env + env/*.env (+ certificates)
 *   node scripts/preflight.mjs --examples          # the committed *.example files (must FAIL)
 *   node scripts/preflight.mjs --root <dir>        # another folder laid out like the repository
 *   node scripts/preflight.mjs --make-sample <dir> # writes a complete, valid sample (tests only)
 *
 * On a server without Node (docs/deployment-oci.md):
 *   docker run --rm -v "$PWD":/w -v /opt/nuzli/certs:/opt/nuzli/certs:ro -w /w node:20-alpine \
 *     node scripts/preflight.mjs
 *
 * Every finding is printed in Arabic and English with the fix. Exit code 1 when anything blocks
 * a production start; warnings (✱) never fail. Secret VALUES are never printed.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ─────────────────────────────────────────────────────────────── output
const findings = { error: [], warn: [], ok: [] };
const err = (where, ar, en, fix) => findings.error.push({ where, ar, en, fix });
const warn = (where, ar, en, fix) => findings.warn.push({ where, ar, en, fix });
const ok = (where, text) => findings.ok.push({ where, text });

// ─────────────────────────────────────────────────────────────── helpers
const PLACEHOLDER = /change[_-]?me/i;
const URL_SAFE = /^[A-Za-z0-9._-]+$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function parseEnvFile(path) {
  const out = new Map();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

function entropyBitsPerChar(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** Same rule as the API (apps/api/src/config/secret-strength.ts): base64 of ≥ minBytes random bytes. */
function weakRandomSecret(value, minBytes = 32) {
  if (!value) return { ar: 'فارغة', en: 'is empty' };
  if (PLACEHOLDER.test(value)) return { ar: 'ما زالت القيمة المثال CHANGE_ME', en: 'is still the CHANGE_ME placeholder' };
  const v = value.trim();
  if (!BASE64.test(v)) return { ar: 'ليست base64', en: 'is not base64' };
  const bytes = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < minBytes) return { ar: `أقصر من ${minBytes} بايت عشوائية`, en: `decodes to fewer than ${minBytes} random bytes` };
  const chars = v.replace(/=+$/, '');
  if (new Set(chars).size < 16 || !/[A-Z]/.test(v) || !/[a-z]/.test(v) || entropyBitsPerChar(chars) < 3.8) {
    return { ar: 'تبدو مكتوبة باليد أو مكرّرة', en: 'looks hand-typed or repetitive' };
  }
  return null;
}

function key32(value) {
  if (!value) return { ar: 'فارغ', en: 'is empty' };
  if (PLACEHOLDER.test(value)) return { ar: 'ما زال CHANGE_ME', en: 'is still CHANGE_ME' };
  const body = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length !== 32) return { ar: 'ليس base64 لـ32 بايت بالضبط', en: 'is not base64 of exactly 32 bytes' };
  if (new Set(bytes).size < 16) return { ar: 'بايتاته ليست عشوائية', en: 'bytes are not random' };
  return null;
}

function strongPassword(value, min) {
  if (!value) return { ar: 'فارغة', en: 'is empty' };
  if (PLACEHOLDER.test(value)) return { ar: 'ما زالت CHANGE_ME', en: 'is still CHANGE_ME' };
  if (value.length < min) return { ar: `أقصر من ${min} حرفًا`, en: `is shorter than ${min} characters` };
  if (new Set(value).size < 8) return { ar: 'متكرّرة الأحرف', en: 'repeats too few characters' };
  return null;
}

function parseDbUrl(raw) {
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      rawPassword: u.password,
      host: u.hostname,
      port: u.port || '5432',
      db: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── sample generator (tests only)
function makeSample(dir) {
  const out = resolve(dir);
  mkdirSync(join(out, 'env'), { recursive: true });
  mkdirSync(join(out, 'certs'), { recursive: true });
  const b64 = (n) => randomBytes(n).toString('base64');
  const urlSafe = (n = 32) => randomBytes(n * 2).toString('base64').replace(/[+/=]/g, '').slice(0, n);
  const dbPw = urlSafe();
  const appPw = urlSafe();
  const converter = b64(48);
  const domain = 'nuzli.example.sa';
  const files = {
    '.env': `NUZLI_VERSION=1.0.0\nHTTP_PORT=80\nHTTPS_PORT=443\nCERTS_DIR=./certs\n`,
    'env/db.env': `POSTGRES_DB=nuzli\nPOSTGRES_USER=nuzli\nPOSTGRES_PASSWORD=${dbPw}\n`,
    'env/api.env': [
      `PUBLIC_WEB_URL=https://${domain}`,
      'CORS_ORIGINS=',
      'LOG_LEVEL=info',
      'SWAGGER_ENABLED=false',
      `DATABASE_URL=postgresql://nuzli:${dbPw}@db:5432/nuzli?schema=public`,
      `APP_DATABASE_URL=postgresql://nuzli_app:${appPw}@db:5432/nuzli?schema=public`,
      'DB_REQUIRE_RLS=true',
      `JWT_ACCESS_SECRET=${b64(48)}`,
      'COOKIE_SECURE=true',
      'BOOTSTRAP_OWNER_USERNAME=mmansary',
      'BOOTSTRAP_OWNER_PASSWORD=',
      `NATIONAL_ID_ENC_KEY=v1:${b64(32)}`,
      `NATIONAL_ID_HMAC_KEY=${b64(32)}`,
      'S3_ENDPOINT=https://axsample1234.compat.objectstorage.me-jeddah-1.oraclecloud.com',
      'S3_REGION=me-jeddah-1',
      'S3_BUCKET=nuzli-files',
      `S3_ACCESS_KEY=${randomBytes(20).toString('hex')}`,
      `S3_SECRET_KEY=${b64(32)}`,
      'S3_FORCE_PATH_STYLE=true',
      'MAIL_TRANSPORT=smtp',
      'SMTP_HOST=smtp.example.sa',
      'SMTP_PORT=587',
      'SMTP_SECURE=false',
      'SMTP_USER=no-reply@example.sa',
      `SMTP_PASS=${urlSafe(24)}`,
      'MAIL_FROM=نزلي <no-reply@example.sa>',
      'CONVERTER_URL=http://converter:8080',
      `CONVERTER_TOKEN=${converter}`,
      '',
    ].join('\n'),
    'env/converter.env': `CONVERTER_TOKEN=${converter}\nCONVERTER_TIMEOUT_SECONDS=50\nCONVERTER_CONCURRENCY=2\nCONVERTER_CHILD_HEAP=256m\n`,
    'env/backup.env': [
      'PGHOST=db',
      'PGPORT=5432',
      'PGDATABASE=nuzli',
      'PGUSER=nuzli',
      `PGPASSWORD=${dbPw}`,
      `BACKUP_ENCRYPTION_PASSPHRASE=${b64(48)}`,
      'BACKUP_TIME=02:00',
      'BACKUP_RETENTION_DAYS=14',
      'BACKUP_ON_START=false',
      'BACKUP_S3_ENABLED=true',
      'BACKUP_S3_ENDPOINT=https://axsample1234.compat.objectstorage.me-jeddah-1.oraclecloud.com',
      'BACKUP_S3_REGION=me-jeddah-1',
      'BACKUP_S3_BUCKET=nuzli-backups',
      'BACKUP_S3_PREFIX=backups/',
      `BACKUP_S3_ACCESS_KEY=${randomBytes(20).toString('hex')}`,
      `BACKUP_S3_SECRET_KEY=${b64(32)}`,
      '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text, { mode: 0o600 });
  // The compose files the checks read.
  for (const f of ['docker-compose.yml', 'docker-compose.prod.yml']) writeFileSync(join(out, f), readFileSync(join(REPO, f)));
  // A certificate for the domain, signed by a throw-away CA (openssl).
  const c = join(out, 'certs');
  const ossl = (...a) => execFileSync('openssl', a, { stdio: 'pipe' });
  ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=Nuzli sample CA', '-keyout', join(c, 'ca.key'), '-out', join(c, 'ca.pem'));
  ossl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${domain}`, '-keyout', join(c, 'privkey.pem'), '-out', join(c, 'leaf.csr'));
  writeFileSync(join(c, 'ext.cnf'), `subjectAltName=DNS:${domain}\n`);
  ossl('x509', '-req', '-in', join(c, 'leaf.csr'), '-CA', join(c, 'ca.pem'), '-CAkey', join(c, 'ca.key'), '-CAcreateserial', '-days', '90', '-extfile', join(c, 'ext.cnf'), '-out', join(c, 'cert.pem'));
  writeFileSync(join(c, 'fullchain.pem'), Buffer.concat([readFileSync(join(c, 'cert.pem')), readFileSync(join(c, 'ca.pem'))]));
  console.log(`sample written to ${out} (random secrets, a throw-away CA certificate for ${domain})`);
}

if (opt('make-sample')) {
  makeSample(opt('make-sample'));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────── load
const ROOT = resolve(opt('root') ?? REPO);
const EXAMPLES = flag('examples');
const suffix = EXAMPLES ? '.example' : '';
const FILES = {
  dotenv: `.env${suffix}`,
  api: `env/api.env${suffix}`,
  db: `env/db.env${suffix}`,
  backup: `env/backup.env${suffix}`,
  converter: `env/converter.env${suffix}`,
};
const env = {};
for (const [k, rel] of Object.entries(FILES)) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    err(rel, 'الملف غير موجود', 'file is missing', `cp ${rel}.example ${rel}   (ثم عبّئ القيم / then fill in the values)`);
    env[k] = new Map();
    continue;
  }
  env[k] = parseEnvFile(p);
  if (!EXAMPLES && process.platform !== 'win32' && k !== 'dotenv') {
    const mode = statSync(p).mode & 0o777;
    if (mode & 0o004) warn(rel, 'الملف مقروء لكل مستخدمي الخادم', 'is world-readable', `chmod 600 ${rel}`);
  }
}
const api = env.api, db = env.db, backup = env.backup, conv = env.converter, dotenv = env.dotenv;
const get = (m, k) => (m.get(k) ?? '').trim();

// Committed real env files would leak every secret.
if (!EXAMPLES) {
  try {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '.env', 'env'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter((f) => f && !f.endsWith('.example') && !f.endsWith('.gitignore'));
    if (tracked.length) err('git', `ملفات أسرار مُتتبَّعة في git: ${tracked.join(', ')}`, `secret files are tracked by git: ${tracked.join(', ')}`, 'git rm --cached <file>');
  } catch {
    /* not a git checkout — nothing to check */
  }
}

// Any CHANGE_ME left anywhere (the secrets checked one by one below report it themselves).
const CHECKED_BELOW = new Set([
  'APP_DATABASE_URL', 'JWT_ACCESS_SECRET', 'NATIONAL_ID_ENC_KEY', 'NATIONAL_ID_HMAC_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY',
  'CONVERTER_TOKEN', 'POSTGRES_PASSWORD', 'BACKUP_ENCRYPTION_PASSPHRASE',
]);
for (const [k, rel] of Object.entries(FILES)) {
  for (const [name, value] of env[k]) {
    if (PLACEHOLDER.test(value) && !CHECKED_BELOW.has(name)) err(rel, `${name} ما زالت CHANGE_ME`, `${name} still contains CHANGE_ME`, 'ضع قيمة حقيقية / set a real value (see the header of the file)');
  }
}

// ─────────────────────────────────────────────────────────────── compose: NODE_ENV and RLS forced in prod
const prodCompose = existsSync(join(ROOT, 'docker-compose.prod.yml')) ? readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8') : '';
const composeForcesProd = /^\s+NODE_ENV:\s*production\s*$/m.test(prodCompose);
const composeForcesRls = /^\s+DB_REQUIRE_RLS:\s*"?true"?\s*$/m.test(prodCompose);
{
  const nodeEnv = get(api, 'NODE_ENV');
  if (nodeEnv && nodeEnv !== 'production') err(FILES.api, `NODE_ENV=${nodeEnv}`, `NODE_ENV must be production (is ${nodeEnv})`, 'احذف السطر أو اجعله production / remove the line or set production');
  if (!composeForcesProd && nodeEnv !== 'production') err('docker-compose.prod.yml', 'لا يفرض NODE_ENV=production', 'does not force NODE_ENV=production', 'NODE_ENV: production under api.environment');
  else ok('NODE_ENV', 'production');
  const rls = get(api, 'DB_REQUIRE_RLS');
  if (composeForcesRls) {
    if (rls && rls !== 'true') warn(FILES.api, 'DB_REQUIRE_RLS=false هنا، لكن ملف الإنتاج يفرض true', 'DB_REQUIRE_RLS=false here is overridden by docker-compose.prod.yml (true)', 'اجعلها DB_REQUIRE_RLS=true للوضوح / set it to true for clarity');
    ok('DB_REQUIRE_RLS', 'true (docker-compose.prod.yml)');
  } else if (rls !== 'true') {
    err(FILES.api, 'DB_REQUIRE_RLS ليست true: قد يعمل الخادم بدور يتجاوز RLS', 'DB_REQUIRE_RLS is not true: the API could run with a role that bypasses RLS', 'DB_REQUIRE_RLS=true');
  }
}

// ─────────────────────────────────────────────────────────────── database
const POSTGRES_USER = get(db, 'POSTGRES_USER');
const POSTGRES_DB = get(db, 'POSTGRES_DB');
const POSTGRES_PASSWORD = get(db, 'POSTGRES_PASSWORD');
{
  if (!POSTGRES_USER || !POSTGRES_DB) err(FILES.db, 'POSTGRES_USER أو POSTGRES_DB فارغ', 'POSTGRES_USER or POSTGRES_DB is empty', 'POSTGRES_DB=nuzli, POSTGRES_USER=nuzli');
  const w = strongPassword(POSTGRES_PASSWORD, 20);
  if (w) err(FILES.db, `POSTGRES_PASSWORD ${w.ar}`, `POSTGRES_PASSWORD ${w.en}`, "openssl rand -base64 32 | tr -d '+/=' | cut -c1-32");
  else if (!URL_SAFE.test(POSTGRES_PASSWORD)) err(FILES.db, 'POSTGRES_PASSWORD فيها رموز لا تصلح داخل رابط', 'POSTGRES_PASSWORD has characters that break the database URL', 'letters, digits, - _ . only');
  else ok('POSTGRES_PASSWORD', 'strong, URL-safe');

  const mig = parseDbUrl(get(api, 'DATABASE_URL'));
  if (!mig || !/^postgres(ql)?:$/.test(mig.protocol)) err(FILES.api, 'DATABASE_URL غير صالح', 'DATABASE_URL is not a postgresql:// URL', 'postgresql://nuzli:<POSTGRES_PASSWORD>@db:5432/nuzli?schema=public');
  else {
    if (mig.user !== POSTGRES_USER) err(FILES.api, `مستخدم DATABASE_URL (${mig.user}) لا يطابق POSTGRES_USER`, `DATABASE_URL user (${mig.user}) differs from POSTGRES_USER`, 'the migrator is POSTGRES_USER of env/db.env');
    if (mig.password !== POSTGRES_PASSWORD) err(FILES.api, 'كلمة مرور DATABASE_URL لا تطابق POSTGRES_PASSWORD', 'DATABASE_URL password differs from POSTGRES_PASSWORD', 'نفس القيمة في الملفين / the same value in both files');
    if (mig.db !== POSTGRES_DB) err(FILES.api, 'قاعدة DATABASE_URL لا تطابق POSTGRES_DB', 'DATABASE_URL database differs from POSTGRES_DB', `…/${POSTGRES_DB}`);
    if (mig.host !== 'db') warn(FILES.api, `مضيف DATABASE_URL هو ${mig.host} لا db`, `DATABASE_URL host is ${mig.host}, not the compose service db`, '@db:5432');
  }
  const app = parseDbUrl(get(api, 'APP_DATABASE_URL'));
  if (!app) err(FILES.api, 'APP_DATABASE_URL غير موجود أو غير صالح: يلزم دور nuzli_app ليعمل RLS', 'APP_DATABASE_URL is missing or invalid: the API must run as nuzli_app for Row Level Security', 'APP_DATABASE_URL=postgresql://nuzli_app:<password>@db:5432/nuzli?schema=public');
  else {
    if (app.user !== 'nuzli_app') err(FILES.api, `دور APP_DATABASE_URL هو ${app.user} وليس nuzli_app`, `APP_DATABASE_URL role is ${app.user}, must be nuzli_app`, 'postgresql://nuzli_app:…');
    const w2 = strongPassword(app.password, 20);
    if (w2) err(FILES.api, `كلمة مرور nuzli_app ${w2.ar}`, `the nuzli_app password ${w2.en}`, "openssl rand -base64 32 | tr -d '+/=' | cut -c1-32");
    else if (!URL_SAFE.test(app.password)) err(FILES.api, 'كلمة مرور nuzli_app فيها رموز لا تصلح داخل رابط', 'the nuzli_app password has URL-unsafe characters', 'letters, digits, - _ . only');
    if (app.password && app.password === POSTGRES_PASSWORD) err(FILES.api, 'كلمة مرور nuzli_app هي نفسها كلمة مرور المُرحِّل', 'nuzli_app uses the same password as the migrator', 'ولّد كلمة مختلفة / generate a different one');
    if (mig && (app.host !== mig.host || app.db !== mig.db)) err(FILES.api, 'APP_DATABASE_URL يشير إلى قاعدة أخرى', 'APP_DATABASE_URL points to another host or database than DATABASE_URL', 'same host and database');
    if (!findings.error.some((f) => f.where === FILES.api && /APP_DATABASE_URL|nuzli_app/.test(f.en))) ok('APP_DATABASE_URL', 'nuzli_app, own strong password');
  }
}

// ─────────────────────────────────────────────────────────────── web origin, CORS, cookies
let domain = '';
{
  const raw = get(api, 'PUBLIC_WEB_URL');
  let u = null;
  try {
    u = new URL(raw);
  } catch {
    /* handled below */
  }
  if (!u) err(FILES.api, 'PUBLIC_WEB_URL غير صالح', 'PUBLIC_WEB_URL is not a URL', 'PUBLIC_WEB_URL=https://<your domain>');
  else {
    domain = u.hostname;
    if (u.protocol !== 'https:') err(FILES.api, 'PUBLIC_WEB_URL ليس https', 'PUBLIC_WEB_URL must be https://', `https://${u.host}`);
    if (/^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname) || /\.(local|lan|example)$/.test(u.hostname)) err(FILES.api, `PUBLIC_WEB_URL يشير إلى ${u.hostname}`, `PUBLIC_WEB_URL points to ${u.hostname}, not the public domain`, 'https://<your domain> (روابط البريد تستعمله / used in e-mail links)');
    else ok('PUBLIC_WEB_URL', u.origin);
  }
  for (const o of get(api, 'CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^https:\/\//.test(o)) err(FILES.api, `CORS_ORIGINS فيه أصل غير آمن: ${o}`, `CORS_ORIGINS has a non-https origin: ${o}`, 'https:// only (empty = same origin through the proxy)');
    if (/localhost|127\.0\.0\.1/.test(o)) err(FILES.api, `CORS_ORIGINS فيه ${o}`, `CORS_ORIGINS contains a development origin ${o}`, 'احذفه في الإنتاج / remove it in production');
  }
  if (get(api, 'COOKIE_SECURE') === 'false') err(FILES.api, 'COOKIE_SECURE=false', 'COOKIE_SECURE=false (forced true in production anyway; never set it)', 'COOKIE_SECURE=true');
  if (['true', '1', 'yes'].includes(get(api, 'SWAGGER_ENABLED'))) warn(FILES.api, 'واجهة Swagger مفتوحة للعامة', 'Swagger UI is public', 'SWAGGER_ENABLED=false');
  if (['debug', 'trace'].includes(get(api, 'LOG_LEVEL'))) warn(FILES.api, `LOG_LEVEL=${get(api, 'LOG_LEVEL')} يملأ السجلات`, 'debug logging in production', 'LOG_LEVEL=info');
}

// ─────────────────────────────────────────────────────────────── secrets of the API
{
  const jwt = weakRandomSecret(get(api, 'JWT_ACCESS_SECRET'));
  if (jwt) err(FILES.api, `JWT_ACCESS_SECRET ${jwt.ar}`, `JWT_ACCESS_SECRET ${jwt.en}`, 'openssl rand -base64 48');
  else ok('JWT_ACCESS_SECRET', 'random, ≥ 32 bytes');
  const enc = key32(get(api, 'NATIONAL_ID_ENC_KEY'));
  if (enc) err(FILES.api, `NATIONAL_ID_ENC_KEY ${enc.ar}`, `NATIONAL_ID_ENC_KEY ${enc.en}`, 'echo "v1:$(openssl rand -base64 32)"');
  const hmac = key32(get(api, 'NATIONAL_ID_HMAC_KEY'));
  if (hmac) err(FILES.api, `NATIONAL_ID_HMAC_KEY ${hmac.ar}`, `NATIONAL_ID_HMAC_KEY ${hmac.en}`, 'openssl rand -base64 32');
  const body = (v) => (v.includes(':') ? v.slice(v.indexOf(':') + 1) : v);
  if (!enc && !hmac && body(get(api, 'NATIONAL_ID_ENC_KEY')) === body(get(api, 'NATIONAL_ID_HMAC_KEY'))) err(FILES.api, 'مفتاحا الهوية متطابقان', 'NATIONAL_ID_HMAC_KEY equals NATIONAL_ID_ENC_KEY', 'two different keys');
  else if (!enc && !hmac) ok('NATIONAL_ID_*', 'two different 32-byte keys');
  if (!enc && !get(api, 'NATIONAL_ID_ENC_KEY').startsWith('v')) warn(FILES.api, 'NATIONAL_ID_ENC_KEY بلا رقم إصدار', 'NATIONAL_ID_ENC_KEY has no version prefix', 'v1:<base64> (key rotation, docs/backup-restore.md)');
  for (const k of ['BACKUP_ENCRYPTION_PASSPHRASE', 'BACKUP_S3_SECRET_KEY']) if (api.has(k)) err(FILES.api, `${k} لا مكان له هنا`, `${k} must not be in the API's file (ADR-068)`, `move it to ${FILES.backup}`);
}

// ─────────────────────────────────────────────────────────────── first owner
{
  const user = get(api, 'BOOTSTRAP_OWNER_USERNAME');
  if (!user) err(FILES.api, 'BOOTSTRAP_OWNER_USERNAME فارغ: لن يُنشأ المالك الأول', 'BOOTSTRAP_OWNER_USERNAME is empty: no first owner will be created', 'BOOTSTRAP_OWNER_USERNAME=mmansary');
  else if (user !== 'mmansary') warn(FILES.api, `اسم المالك الأول ${user} وليس mmansary`, `the first owner is ${user}, not mmansary (brief A12)`, 'BOOTSTRAP_OWNER_USERNAME=mmansary');
  else ok('BOOTSTRAP_OWNER_USERNAME', 'mmansary');
  const pw = get(api, 'BOOTSTRAP_OWNER_PASSWORD') || get(api, 'BOOTSTRAP_ADMIN_PASSWORD');
  if (!pw) ok('BOOTSTRAP_OWNER_PASSWORD', 'empty → a one-time password is printed ONCE: docker compose logs api | grep "Temporary password"');
  else {
    const w = strongPassword(pw, 12);
    if (w || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) err(FILES.api, 'كلمة مرور المالك الأولى ضعيفة', 'BOOTSTRAP_OWNER_PASSWORD is weak (≥ 12 characters, letters and digits)', 'اتركها فارغة لتُولَّد / leave it empty to get a generated one');
    else warn(FILES.api, 'كلمة مرور المالك الأولى مكتوبة في الملف', 'BOOTSTRAP_OWNER_PASSWORD is stored in the file', 'احذفها بعد أول دخول / remove it after the first login');
  }
  const ids = ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_MOBILE', 'BOOTSTRAP_ADMIN_NATIONAL_ID'].filter((k) => get(api, k));
  if (ids.length && ids.length < 3) warn(FILES.api, 'هوية المالك ناقصة (البريد والجوال والهوية معًا أو لا شيء)', 'owner identity is partial (e-mail, mobile and national ID together, or none)', 'set all three or none');
}

// ─────────────────────────────────────────────────────────────── object storage (OCI)
{
  const ep = get(api, 'S3_ENDPOINT');
  const region = get(api, 'S3_REGION');
  const m = /^https:\/\/([a-z0-9-]+)\.compat\.objectstorage\.([a-z0-9-]+)\.oraclecloud\.com\/?$/.exec(ep);
  if (!m) {
    err(FILES.api, `S3_ENDPOINT ليس عنوان OCI (${ep || 'فارغ'})`, `S3_ENDPOINT is not an OCI Object Storage endpoint (${ep || 'empty'})`, 'https://<namespace>.compat.objectstorage.<region>.oraclecloud.com');
  } else {
    if (m[2] !== region) err(FILES.api, `منطقة S3_ENDPOINT (${m[2]}) لا تطابق S3_REGION (${region})`, `the endpoint region (${m[2]}) differs from S3_REGION (${region})`, `S3_REGION=${m[2]}`);
    else ok('S3_ENDPOINT', `OCI ${m[2]}, namespace ${m[1]}`);
  }
  const bucket = get(api, 'S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/i.test(bucket)) err(FILES.api, 'S3_BUCKET غير صالح', 'S3_BUCKET is not a valid bucket name', 'S3_BUCKET=nuzli-files');
  const ak = get(api, 'S3_ACCESS_KEY');
  if (!ak || PLACEHOLDER.test(ak) || ak.length < 16) err(FILES.api, 'S3_ACCESS_KEY غير صالح', 'S3_ACCESS_KEY is missing or not an OCI Customer Secret Key id', 'OCI Console → Profile → Customer secret keys → Access key');
  const sk = strongPassword(get(api, 'S3_SECRET_KEY'), 16);
  if (sk) err(FILES.api, `S3_SECRET_KEY ${sk.ar}`, `S3_SECRET_KEY ${sk.en}`, 'the secret shown ONCE when the Customer Secret Key is created');
  if (get(api, 'S3_FORCE_PATH_STYLE') !== 'true') err(FILES.api, 'S3_FORCE_PATH_STYLE ليست true', 'S3_FORCE_PATH_STYLE must be true for OCI', 'S3_FORCE_PATH_STYLE=true');
  if (get(api, 'S3_PUBLIC_ENDPOINT')) warn(FILES.api, 'S3_PUBLIC_ENDPOINT للتطوير فقط', 'S3_PUBLIC_ENDPOINT is a development setting', 'احذفه / remove it');
}

// ─────────────────────────────────────────────────────────────── e-mail
{
  const host = get(api, 'SMTP_HOST');
  if (get(api, 'MAIL_TRANSPORT') === 'noop') err(FILES.api, 'MAIL_TRANSPORT=noop لا يرسل بريدًا', 'MAIL_TRANSPORT=noop sends nothing (tests only)', 'MAIL_TRANSPORT=smtp');
  if (!host || /^(mailpit|localhost|127\.0\.0\.1)$/.test(host)) warn(FILES.api, `SMTP_HOST=${host || 'فارغ'}: لن تصل رسائل البريد (استعادة كلمة المرور، الاعتمادات)`, `SMTP_HOST=${host || 'empty'} is the development mail catcher: no e-mail reaches anyone (password reset, approvals)`, 'SMTP_HOST/PORT/USER/PASS of your mail provider (OCI Email Delivery or another)');
  else ok('SMTP', `${host}:${get(api, 'SMTP_PORT') || '1025'}`);
  if (/example\.(sa|com)/.test(get(api, 'MAIL_FROM'))) warn(FILES.api, 'MAIL_FROM ما زال عنوان المثال', 'MAIL_FROM is still the example address', 'MAIL_FROM=نزلي <no-reply@<your domain>>');
}

// ─────────────────────────────────────────────────────────────── optional services
{
  const url = get(api, 'CONVERTER_URL');
  if (url) {
    const t = weakRandomSecret(get(api, 'CONVERTER_TOKEN'));
    if (t) err(FILES.api, `CONVERTER_TOKEN ${t.ar}`, `CONVERTER_TOKEN ${t.en}`, 'openssl rand -base64 48 (the same value in env/converter.env)');
    else if (get(api, 'CONVERTER_TOKEN') !== get(conv, 'CONVERTER_TOKEN')) err(FILES.converter, 'CONVERTER_TOKEN لا يطابق env/api.env', 'CONVERTER_TOKEN differs from env/api.env', 'the same value in both files');
    else ok('converter', '.mpp imports on (token matches)');
  } else {
    warn(FILES.api, 'CONVERTER_URL فارغ: استيراد ‎.mpp يردّ 501 ويطلب حفظ الملف XML (اختياري)', 'CONVERTER_URL is empty: .mpp imports answer 501 and ask for MS Project XML (optional feature)', 'CONVERTER_URL=http://converter:8080 + CONVERTER_TOKEN to turn it on');
    const t = weakRandomSecret(get(conv, 'CONVERTER_TOKEN'));
    if (t) err(FILES.converter, `CONVERTER_TOKEN ${t.ar} (الحاوية تعمل حتى إن لم تُستعمل)`, `CONVERTER_TOKEN ${t.en} (the container still starts)`, 'openssl rand -base64 48');
  }
  if (get(api, 'PDF_SERVICE_URL')) {
    warn(FILES.api, 'PDF_SERVICE_URL مضبوط لكن خدمة PDF غير مبنية بعد', 'PDF_SERVICE_URL is set but no PDF service ships with Nuzli yet (ADR-024)', 'احذفه: الطباعة إلى PDF من المتصفح / remove it; print to PDF from the browser');
    const t = weakRandomSecret(get(api, 'PDF_SERVICE_TOKEN'));
    if (t) err(FILES.api, `PDF_SERVICE_TOKEN ${t.ar}`, `PDF_SERVICE_TOKEN ${t.en}`, 'openssl rand -base64 48');
  } else ok('PDF service', 'off (endpoints answer 501; the browser prints to PDF) — optional');
}

// ─────────────────────────────────────────────────────────────── backups
{
  if (get(backup, 'PGHOST') !== 'db') warn(FILES.backup, `PGHOST=${get(backup, 'PGHOST')}`, 'PGHOST is not the compose service db', 'PGHOST=db');
  if (get(backup, 'PGUSER') !== POSTGRES_USER) err(FILES.backup, 'PGUSER لا يطابق POSTGRES_USER', 'PGUSER differs from POSTGRES_USER', POSTGRES_USER || 'nuzli');
  if (get(backup, 'PGPASSWORD') !== POSTGRES_PASSWORD) err(FILES.backup, 'PGPASSWORD لا يطابق POSTGRES_PASSWORD', 'PGPASSWORD differs from POSTGRES_PASSWORD', 'the same value as env/db.env');
  if (get(backup, 'PGDATABASE') !== POSTGRES_DB) err(FILES.backup, 'PGDATABASE لا يطابق POSTGRES_DB', 'PGDATABASE differs from POSTGRES_DB', POSTGRES_DB || 'nuzli');
  const pass = get(backup, 'BACKUP_ENCRYPTION_PASSPHRASE');
  const w = strongPassword(pass, 40);
  if (w) err(FILES.backup, `عبارة تشفير النسخ الاحتياطية ${w.ar} (٤٠ حرفًا على الأقل)`, `BACKUP_ENCRYPTION_PASSPHRASE ${w.en} (≥ 40)`, 'openssl rand -base64 48 — واحفظ نسخة خارج الخادم / keep a copy OFF the server');
  else ok('BACKUP_ENCRYPTION_PASSPHRASE', 'set, ≥ 40 characters (keep a copy off the server)');
  if (pass && [get(api, 'JWT_ACCESS_SECRET'), POSTGRES_PASSWORD].includes(pass)) err(FILES.backup, 'عبارة التشفير مكرّرة من سرّ آخر', 'the backup passphrase reuses another secret', 'a separate random value');
  for (const k of ['NATIONAL_ID_ENC_KEY', 'NATIONAL_ID_HMAC_KEY', 'JWT_ACCESS_SECRET', 'S3_SECRET_KEY']) if (backup.has(k)) err(FILES.backup, `${k} لا مكان له هنا`, `${k} must not be in the backup file (ADR-068)`, 'remove it');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(get(backup, 'BACKUP_TIME') || '02:00')) err(FILES.backup, 'BACKUP_TIME ليس HH:MM', 'BACKUP_TIME is not HH:MM (UTC)', 'BACKUP_TIME=02:00');
  const days = Number(get(backup, 'BACKUP_RETENTION_DAYS') || '14');
  if (!Number.isInteger(days) || days < 1) err(FILES.backup, 'BACKUP_RETENTION_DAYS غير صالح', 'BACKUP_RETENTION_DAYS must be a positive integer', 'BACKUP_RETENTION_DAYS=14');
  if (get(backup, 'BACKUP_S3_ENABLED') === 'true') {
    const missing = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY'].filter((k) => !get(backup, k));
    if (missing.length) err(FILES.backup, `ناقص: ${missing.join(', ')}`, `missing: ${missing.join(', ')}`, 'all BACKUP_S3_* values');
    if (get(backup, 'BACKUP_S3_ENDPOINT') && !/^https:\/\//.test(get(backup, 'BACKUP_S3_ENDPOINT'))) err(FILES.backup, 'BACKUP_S3_ENDPOINT ليس https', 'BACKUP_S3_ENDPOINT must be https://', 'https://<namespace>.compat.objectstorage.<region>.oraclecloud.com');
    if (get(backup, 'BACKUP_S3_BUCKET') && get(backup, 'BACKUP_S3_BUCKET') === get(api, 'S3_BUCKET')) err(FILES.backup, 'دلو النسخ هو دلو التطبيق نفسه', 'the backup bucket is the app bucket', 'a separate bucket (e.g. nuzli-backups)');
    if (get(backup, 'BACKUP_S3_ACCESS_KEY') && get(backup, 'BACKUP_S3_ACCESS_KEY') === get(api, 'S3_ACCESS_KEY')) err(FILES.backup, 'مفاتيح النسخ هي مفاتيح التطبيق نفسها', 'the backup keys are the app keys', 'a separate user / Customer Secret Key');
    if (!missing.length) ok('off-site backups', `on → ${get(backup, 'BACKUP_S3_BUCKET')}`);
  } else {
    warn(FILES.backup, 'النسخ خارج الخادم معطّلة: إن ضاع القرص ضاعت النسخ معه', 'off-site backups are OFF: losing the disk loses the backups too', 'BACKUP_S3_ENABLED=true + BACKUP_S3_* (a separate bucket)');
  }
}

// ─────────────────────────────────────────────────────────────── TLS certificates
{
  const raw = get(dotenv, 'CERTS_DIR') || './infra/certs';
  const dir = isAbsolute(raw) ? raw : join(ROOT, raw);
  const chainPath = join(dir, 'fullchain.pem');
  const keyPath = join(dir, 'privkey.pem');
  if (EXAMPLES) {
    err(FILES.dotenv, `CERTS_DIR=${raw}: مجلد شهادات التطوير`, `CERTS_DIR=${raw} is the development certificate folder`, 'CERTS_DIR=/opt/nuzli/certs (Let’s Encrypt, docs/deployment-oci.md)');
  } else if (!existsSync(chainPath) || !existsSync(keyPath)) {
    err(FILES.dotenv, `لا توجد fullchain.pem و privkey.pem في ${raw}`, `fullchain.pem and privkey.pem not found in ${raw}`, 'certbot (docs/deployment-oci.md §6) or the provided certificate');
  } else {
    try {
      const pem = readFileSync(chainPath, 'utf8');
      const first = pem.slice(0, pem.indexOf('-----END CERTIFICATE-----') + 25);
      const cert = new X509Certificate(first);
      const key = createPrivateKey(readFileSync(keyPath));
      if (!cert.checkPrivateKey(key)) err(FILES.dotenv, 'المفتاح الخاص لا يطابق الشهادة', 'privkey.pem does not match the certificate', 'copy both files from the same issuance');
      const daysLeft = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
      if (daysLeft < 0) err(FILES.dotenv, 'الشهادة منتهية', 'the certificate has expired', 'certbot renew');
      else if (daysLeft < 14) warn(FILES.dotenv, `الشهادة تنتهي خلال ${daysLeft} يومًا`, `the certificate expires in ${daysLeft} days`, 'certbot renew');
      if (domain && !cert.checkHost(domain)) err(FILES.dotenv, `الشهادة لا تغطي ${domain}`, `the certificate does not cover ${domain}`, `certbot certonly -d ${domain}`);
      if (cert.issuer === cert.subject) warn(FILES.dotenv, 'شهادة موقّعة ذاتيًّا: المتصفحات والجوالات سترفضها', 'self-signed certificate: browsers and phones will refuse it', "Let's Encrypt (docs/deployment-oci.md)");
      if (!findings.error.some((f) => f.where === FILES.dotenv)) ok('TLS', `${domain || cert.subject}, ${daysLeft} days left`);
    } catch (e) {
      err(FILES.dotenv, 'تعذّرت قراءة الشهادة أو المفتاح', `cannot read the certificate or key: ${e.message}`, 'PEM files: fullchain.pem + privkey.pem');
    }
  }
  if (!/^\d+$/.test(get(dotenv, 'HTTPS_PORT') || '443')) err(FILES.dotenv, 'HTTPS_PORT غير صالح', 'HTTPS_PORT is not a number', 'HTTPS_PORT=443');
  if ((get(dotenv, 'NUZLI_VERSION') || 'latest') === 'latest') warn(FILES.dotenv, 'NUZLI_VERSION=latest: لا يمكن الرجوع إلى نسخة سابقة بسهولة', 'NUZLI_VERSION=latest makes a rollback harder', 'NUZLI_VERSION=<date or git tag>, e.g. 2026.10.20');
}

// ─────────────────────────────────────────────────────────────── report
const line = '─'.repeat(72);
console.log(`فحص ما قبل النشر — Nuzli preflight   (${EXAMPLES ? 'examples' : 'real files'}: ${ROOT})`);
console.log(line);
for (const o of findings.ok) console.log(`✓ ${o.where}: ${o.text}`);
for (const w of findings.warn) console.log(`✱ [${w.where}] ${w.ar}\n    ${w.en}\n    ← ${w.fix}`);
for (const e of findings.error) console.log(`✗ [${e.where}] ${e.ar}\n    ${e.en}\n    ← ${e.fix}`);
console.log(line);
if (findings.error.length) {
  console.log(`✗ ${findings.error.length} خطأ يمنع النشر، و${findings.warn.length} تنبيه. / ${findings.error.length} blocking error(s), ${findings.warn.length} warning(s).`);
  process.exit(1);
}
console.log(`✓ جاهز للنشر (${findings.warn.length} تنبيه). / Ready to deploy (${findings.warn.length} warning(s)).`);
