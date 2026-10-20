#!/usr/bin/env node
/**
 * A12 — the update path, end to end in headless Chrome («يُثبَّت مرة واحدة»):
 *
 *   1. serve build A (e.g. NUZLI_APP_VERSION=1.0.0) → sign in → the service worker controls the page;
 *   2. put a violation in the device outbox (IndexedDB) as if it had been recorded offline;
 *   3. serve build B (1.0.1) at the same URL → «البحث عن تحديث» in «المزيد» → the new worker
 *      installs and waits → the «تحديث متاح — حدّث الآن» banner;
 *   4. «حدّث الآن» → one reload → «المزيد» shows version B, and the outbox row is still there.
 *
 * Build both first:
 *   NUZLI_APP_VERSION=1.0.0 npx vite build --mode demo --outDir /tmp/a
 *   NUZLI_APP_VERSION=1.0.1 npx vite build --mode demo --outDir /tmp/b
 * Usage: node scripts/qa-update.mjs <dirA> <dirB> <shotsDir>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const [dirA, dirB, shots] = process.argv.slice(2).map((p) => resolve(p));
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = '/nuzli-project-management/';
const PORT = 4190;
mkdirSync(shots, { recursive: true });

let root = dirA;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  p = p.slice(BASE.length) || 'index.html';
  let file = join(root, p);
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));
const url = `http://localhost:${PORT}${BASE}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'nuzli-upd-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9361', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 160 && !targets; i++) {
  try {
    targets = await (await fetch('http://127.0.0.1:9361/json/list')).json();
  } catch {
    await sleep(250);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(250);
  }
  return false;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
};
const log = (ok, msg) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
let failed = 0;
const check = (ok, msg) => {
  log(ok, msg);
  if (!ok) failed++;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: url + 'login' });
  await until(`!!document.querySelector('input[autocomplete="username"]')`);
  await ev(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[autocomplete="username"]'), 'monitor1@demo.nuzli.example'); set(document.querySelector('input[autocomplete="current-password"]'), 'NuzliDemo2026'); document.querySelector('form').requestSubmit(); })()`);
  await until(`!location.pathname.endsWith('/login')`);
  check(await until(`!!navigator.serviceWorker.controller`, 30000), 'build A: the service worker controls the page');

  // A violation recorded "offline", waiting in the outbox (IndexedDB).
  await ev(`new Promise((ok) => { const r = indexedDB.open('nuzli-offline'); r.onsuccess = () => { const tx = r.result.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ id: 'qa-update-keep', userId: 'qa', status: 'failed', createdAt: new Date().toISOString(), lastError: 'QA marker' }); tx.oncomplete = () => ok(true); }; })`);

  await send('Page.navigate', { url: url + 'more' });
  await until(`!!document.querySelector('[data-testid="more-version"]')`);
  const vA = await ev(`document.querySelector('[data-testid="more-version"]').textContent`);
  check(/1\.0\.0/.test(vA), `«المزيد» shows version A: ${vA}`);
  await shot('1-version-a.png');

  root = dirB; // the server now has the new build
  await ev(`document.querySelector('[data-testid="more-check"]').click()`);
  check(await until(`!!document.querySelector('[data-testid="update-banner"]')`, 30000), 'build B detected: «تحديث متاح — حدّث الآن» banner shown');
  await shot('2-banner.png');
  check(await ev(`!!document.querySelector('[data-testid="more-update-now"]')`), '«المزيد» offers «حدّث الآن» too');

  await ev(`[...document.querySelectorAll('[data-testid="update-banner"] button')].find((b) => b.textContent.includes('حدّث'))?.click()`);
  await sleep(1500);
  await until(`document.readyState === 'complete' && !!document.querySelector('[data-testid="more-version"]')`, 30000);
  const vB = await ev(`document.querySelector('[data-testid="more-version"]')?.textContent ?? ''`);
  check(/1\.0\.1/.test(vB), `after one reload «المزيد» shows version B: ${vB}`);
  check(!(await ev(`!!document.querySelector('[data-testid="update-banner"]')`)), 'no banner after updating');
  const kept = await ev(`new Promise((ok) => { const r = indexedDB.open('nuzli-offline'); r.onsuccess = () => { const g = r.result.transaction('outbox').objectStore('outbox').get('qa-update-keep'); g.onsuccess = () => ok(!!g.result); g.onerror = () => ok(false); }; r.onerror = () => ok(false); })`);
  check(kept, 'the unsynced violation in the outbox survived the update');
  await shot('3-version-b.png');
} finally {
  ws.close();
  chrome.kill();
  server.close();
  console.log(failed ? `${failed} check(s) failed` : 'update path verified');
  process.exitCode = failed ? 1 : 0;
}
