#!/usr/bin/env node
/**
 * A12 — the installable app's images, in the Nozoly identity, rendered with headless Chrome over
 * the DevTools protocol (no image libraries), like scripts/make-pwa-icons.mjs:
 *
 *   public/splash/apple-splash-<w>x<h>.png   iPhone launch screens (scripts/ios-splash.mjs):
 *                                            the violet Nozoly logo centred on white
 *   public/shortcuts/{record,tasks,projects}.png   96×96 home-screen shortcut icons: our line
 *                                            icons (Tabler, the app's set) in white on a violet tile
 *   public/pwa-maskable-192.png              the maskable icon at 192 (Android launchers)
 *
 * The install-sheet screenshots (public/screenshots/*.png) come from the real app:
 * scripts/qa-mobile.mjs --manifest-shots.
 *
 * Usage: CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/make-app-images.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IOS_SPLASH, splashFile } from './ios-splash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const logo = pathToFileURL(join(pub, 'brand', 'nozoly.png')).href;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIOLET = '#5030E5';
const FILE = { w: 540, h: 156 };
const ART = { x: 14, y: 44, w: 402, h: 98 };

function logoBox(width) {
  const s = width / ART.w;
  return `<div style="position:relative;overflow:hidden;width:${width}px;height:${ART.h * s}px">
    <img src="${logo}" style="position:absolute;max-width:none;width:${FILE.w * s}px;height:${FILE.h * s}px;left:${-ART.x * s}px;top:${-ART.y * s}px"></div>`;
}

const tabler = (name) =>
  readFileSync(join(root, '..', '..', 'node_modules', '@tabler', 'icons', 'icons', 'outline', `${name}.svg`), 'utf8')
    .replace(/width="24"/, 'width="100%"')
    .replace(/height="24"/, 'height="100%"')
    .replace(/stroke="currentColor"/, 'stroke="#ffffff"')
    .replace(/stroke-width="2"/, 'stroke-width="1.8"');

const page = (w, h, body, bg = 'transparent') => `<!doctype html><html><head><style>
html,body{margin:0;background:${bg}}
.c{width:${w}px;height:${h}px;display:grid;place-items:center;overflow:hidden}
</style></head><body><div class="c">${body}</div></body></html>`;

const JOBS = [];
for (const s of IOS_SPLASH) {
  const W = s.w * s.r;
  const H = s.h * s.r;
  // The logo at 46 % of the width, a little above the middle (where iOS draws app launches).
  JOBS.push({
    out: join(pub, splashFile(s)),
    w: W,
    h: H,
    html: page(W, H, `<div style="transform:translateY(-${Math.round(H * 0.03)}px)">${logoBox(Math.round(W * 0.46))}</div>`, '#ffffff'),
  });
}
for (const [name, icon] of [
  ['record', 'camera'],
  ['tasks', 'checklist'],
  ['projects', 'folders'],
]) {
  JOBS.push({
    out: join(pub, 'shortcuts', `${name}.png`),
    w: 96,
    h: 96,
    html: page(96, 96, `<div style="width:96px;height:96px;border-radius:24px;background:${VIOLET};display:grid;place-items:center"><div style="width:52px;height:52px">${tabler(icon)}</div></div>`),
  });
}
{
  const size = 192;
  const tile = Math.round(size * 0.56);
  JOBS.push({
    out: join(pub, 'pwa-maskable-192.png'),
    w: size,
    h: size,
    html: page(size, size, `<div style="width:${tile}px;height:${tile}px;border-radius:${Math.round(tile * 0.2)}px;background:#fff;display:grid;place-items:center;box-shadow:0 2px 8px rgba(10,14,60,.35)">${logoBox(Math.round(tile * 0.84))}</div>`, VIOLET),
  });
}

mkdirSync(join(pub, 'splash'), { recursive: true });
mkdirSync(join(pub, 'shortcuts'), { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'nuzli-images-'));
const port = 9343;
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'],
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
for (const job of JOBS) {
  const file = join(dir, `job-${JOBS.indexOf(job)}.html`);
  writeFileSync(file, job.html);
  await send('Emulation.setDeviceMetricsOverride', { width: job.w, height: job.h, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(500);
  await send('Runtime.evaluate', { expression: 'Promise.all([...document.images].map((i) => i.decode().catch(() => null)))', awaitPromise: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: job.w, height: job.h, scale: 1 } });
  writeFileSync(job.out, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote ' + job.out);
}
ws.close();
chrome.kill();
