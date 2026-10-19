#!/usr/bin/env node
/**
 * Generates the PWA icons and the favicons in apps/web/public in the Nozoly identity (owner
 * request A9): the Nozoly logo (recoloured to the identity violet) (public/brand/nozoly.png) — placed as a file,
 * never stretched or redrawn — on white, plus a maskable icon on Nozoly violet
 * (#5030E5) with the logo on a white rounded tile inside the 80 % safe circle.
 * The artwork occupies x 14–415, y 44–141 of the 540×156 file (transparent margins); the mark
 * alone is x 14–169. Favicons (32/64 px) show the mark part of the same file, because the
 * wordmark is illegible at that size.
 * Renders with headless Chrome over the DevTools protocol (no image libraries).
 *
 * Usage: CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/make-pwa-icons.mjs [outDir]
 * Output: pwa-192.png, pwa-512.png, pwa-maskable-512.png, apple-touch-icon.png (180),
 *         favicon-32.png, favicon-64.png (default outDir: public/).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ? resolve(process.argv[2]) : join(root, 'public');
const logo = pathToFileURL(join(root, 'public', 'brand', 'nozoly.png')).href;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const FILE = { w: 540, h: 156 };
const ART = { x: 14, y: 44, w: 402, h: 98 };
const MARK_W = 156;
const INDIGO = '#5030E5';

/** The logo file inside a box that shows only the artwork (or the mark), `width` px wide. */
function logoBox(width, mark = false) {
  const s = width / (mark ? MARK_W : ART.w);
  const h = ART.h * s;
  return `<div style="position:relative;overflow:hidden;width:${width}px;height:${h}px">
    <img src="${logo}" style="position:absolute;max-width:none;width:${FILE.w * s}px;height:${FILE.h * s}px;left:${-ART.x * s}px;top:${-ART.y * s}px"></div>`;
}

/**
 * One icon as HTML.
 *  - default: white square, the full logo at 78 % of the width.
 *  - `maskable`: indigo full bleed, a white rounded tile (56 %, inside the safe circle) with the logo.
 *  - `favicon`: rounded white tile with the mark only.
 */
function html(size, { maskable = false, favicon = false } = {}) {
  let inner;
  let bg = '#ffffff';
  let radius = 0;
  if (maskable) {
    bg = INDIGO;
    const tile = Math.round(size * 0.56);
    inner = `<div style="width:${tile}px;height:${tile}px;border-radius:${Math.round(tile * 0.2)}px;background:#fff;display:grid;place-items:center;box-shadow:0 ${Math.round(size * 0.012)}px ${Math.round(size * 0.04)}px rgba(10,14,60,.35)">${logoBox(Math.round(tile * 0.84))}</div>`;
  } else if (favicon) {
    radius = Math.round(size * 0.22);
    inner = logoBox(Math.round(size * 0.84), true);
  } else {
    inner = logoBox(Math.round(size * 0.78));
  }
  return `<!doctype html><html><head><style>
html, body { margin: 0; background: transparent; }
.icon { width: ${size}px; height: ${size}px; overflow: hidden; border-radius: ${radius}px; background: ${bg};
  display: grid; place-items: center; ${favicon ? 'box-shadow: inset 0 0 0 1px #ebeaf0;' : ''} }
</style></head><body><div class="icon">${inner}</div></body></html>`;
}

const ICONS = [
  ['pwa-192.png', 192, {}],
  ['pwa-512.png', 512, {}],
  ['pwa-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-32.png', 32, { favicon: true }],
  ['favicon-64.png', 64, { favicon: true }],
];

const dir = mkdtempSync(join(tmpdir(), 'nuzli-icons-'));
const port = 9341;
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--disable-gpu', '--allow-file-access-from-files', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 160 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(250);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send('Page.enable');
for (const [name, size, opts] of ICONS) {
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html(size, opts));
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(700);
  await send('Runtime.evaluate', {
    expression: 'Promise.all([...document.images].map((i) => i.decode().catch(() => null)))',
    awaitPromise: true,
  });
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  writeFileSync(join(out, name), Buffer.from(shot.result.data, 'base64'));
  console.log('wrote ' + join(out, name));
}
ws.close();
chrome.kill();
