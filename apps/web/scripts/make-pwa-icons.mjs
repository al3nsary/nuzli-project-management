#!/usr/bin/env node
/**
 * Generates the PWA icons and the favicons in apps/web/public in the Muhsen app's icon style
 * (owner request A7): the Muhsen green gradient, the Muhsen pattern low on the tile, and the real
 * white/gold Muhsen "M" (public/brand/muhsen-mark-white.png) centred — used as a file, never
 * redrawn or recoloured. Maskable icons keep the mark inside the 80 % safe circle.
 * Renders with headless Chrome over the DevTools protocol (no image libraries).
 *
 * Usage: CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/make-pwa-icons.mjs
 * Output: public/pwa-192.png, pwa-512.png, pwa-maskable-512.png, apple-touch-icon.png (180),
 *         favicon-32.png, favicon-64.png.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = (f) => pathToFileURL(join(root, 'public', 'brand', f)).href;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/**
 * One icon as HTML.
 *  - `maskable`: full bleed, the mark at 40 % of the width (inside the 80 % safe circle).
 *  - `rounded`: transparent corners (favicons); otherwise square, the platform masks it.
 *  - `pattern`: the Muhsen pattern band (skipped at favicon sizes, where it would be noise).
 */
function html(size, { maskable = false, rounded = false, pattern = true } = {}) {
  const mark = Math.round(size * (maskable ? 0.4 : size <= 64 ? 0.66 : 0.52));
  const radius = rounded ? Math.round(size * 0.22) : 0;
  return `<!doctype html><html><head><style>
html, body { margin: 0; background: transparent; }
.icon { position: relative; width: ${size}px; height: ${size}px; overflow: hidden; border-radius: ${radius}px;
  background: linear-gradient(150deg, #1a6b4c 0%, #12513a 52%, #0d3e2c 100%); }
.pattern { position: absolute; left: 0; right: 0; bottom: 0; height: 42%;
  background: url('${brand('muhsen-pattern.png')}') repeat-x left top / auto 60%; opacity: .1; }
.mark { position: absolute; inset: 0; display: grid; place-items: center; }
.mark img { width: ${mark}px; height: ${mark}px; object-fit: contain; transform: translateY(-${Math.round(size * 0.02)}px); }
</style></head><body><div class="icon">${pattern ? '<div class="pattern"></div>' : ''}<div class="mark"><img src="${brand('muhsen-mark-white.png')}"></div></div></body></html>`;
}

const ICONS = [
  ['pwa-192.png', 192, {}],
  ['pwa-512.png', 512, {}],
  ['pwa-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-32.png', 32, { rounded: true, pattern: false }],
  ['favicon-64.png', 64, { rounded: true, pattern: false }],
];

const dir = mkdtempSync(join(tmpdir(), 'nuzli-icons-'));
const port = 9341;
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--disable-gpu', '--allow-file-access-from-files', 'about:blank'],
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
  writeFileSync(join(root, 'public', name), Buffer.from(shot.result.data, 'base64'));
  console.log('wrote public/' + name);
}
ws.close();
chrome.kill();
