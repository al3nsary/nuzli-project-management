#!/usr/bin/env node
/**
 * Generates the PWA icons in apps/web/public from a simple monogram: the Arabic letter «ن»
 * (Readex Pro, self-hosted) on --ink with the vest band on the inline-start edge (the right,
 * as in RTL). No external branding. Renders with headless Chrome over the DevTools protocol.
 *
 * Usage: CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/make-pwa-icons.mjs
 * Output: public/pwa-192.png, pwa-512.png, pwa-maskable-512.png, apple-touch-icon.png (180).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = pathToFileURL(
  join(root, '../../node_modules/@fontsource-variable/readex-pro/files/readex-pro-arabic-wght-normal.woff2'),
).href;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** One icon as HTML. `maskable` = full bleed, content inside the 80 % safe circle. */
function html(size, { maskable = false } = {}) {
  const radius = maskable ? 0 : Math.round(size * 0.22);
  const band = Math.round(size * 0.12);
  return `<!doctype html><html dir="rtl"><head><style>
@font-face { font-family: 'Readex'; src: url('${font}') format('woff2'); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
.icon { position: relative; width: ${size}px; height: ${size}px; background: #14232B; border-radius: ${radius}px; overflow: hidden; }
.band { position: absolute; inset-block: 0; inset-inline-start: 0; width: ${band}px;
  background: linear-gradient(to bottom, transparent 30%, rgb(255 255 255 / .3) 30% 34%, transparent 34% 62%, rgb(255 255 255 / .3) 62% 66%, transparent 66%), #1D5C63; }
.glyph { position: absolute; inset: 0; display: grid; place-items: center; padding-inline-start: ${band}px;
  font-family: 'Readex'; font-weight: 700; font-size: ${Math.round(size * (maskable ? 0.46 : 0.58))}px; line-height: 1; color: #EEF1F1; }
.glyph span { transform: translateY(-${Math.round(size * 0.06)}px); }
</style></head><body><div class="icon"><div class="band"></div><div class="glyph"><span>ن</span></div></div></body></html>`;
}

const ICONS = [
  ['pwa-192.png', 192, {}],
  ['pwa-512.png', 512, {}],
  ['pwa-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
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
for (let i = 0; i < 120 && !targets; i++) {
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
  await sleep(600);
  await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  writeFileSync(join(root, 'public', name), Buffer.from(shot.result.data, 'base64'));
  console.log('wrote public/' + name);
}
ws.close();
chrome.kill();
