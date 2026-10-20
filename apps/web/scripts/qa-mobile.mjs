#!/usr/bin/env node
/**
 * A12 visual QA — «كالسيف» on every size. Drives headless Chrome over the DevTools protocol with
 * device emulation (metrics + touch + mobile user agent), signs in as each demo role, opens every
 * main page and writes a screenshot per device × scheme × role × page, plus a JSON report of
 * automatic checks: horizontal overflow outside scrollers, tap targets under 44px, clipped text.
 *
 *   node scripts/qa-mobile.mjs shoot <baseUrl> <outDir> [--devices=a,b] [--roles=a,b] [--schemes=light,dark]
 *                                  [--pages=home,projects] [--scrolls=1] [--manifest-shots]
 *   node scripts/qa-mobile.mjs sheet <dir> <filter> <out.png> [cols]     contact sheet of screenshots
 *
 * baseUrl: the demo build served by `vite preview --mode demo` (…/nuzli-project-management/).
 * --manifest-shots: also writes public/screenshots/{narrow-home,narrow-projects,wide-project}.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASSWORD = 'NuzliDemo2026';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = (m) => `Mozilla/5.0 (Linux; Android 14; ${m}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36`;

export const DEVICES = {
  se: { name: 'iPhone SE', w: 375, h: 667, dpr: 2, ua: IOS },
  i14: { name: 'iPhone 14', w: 390, h: 844, dpr: 3, ua: IOS },
  promax: { name: 'iPhone 14 Pro Max', w: 430, h: 932, dpr: 3, ua: IOS },
  pixel7: { name: 'Pixel 7', w: 412, h: 915, dpr: 2.625, ua: ANDROID('Pixel 7') },
  s8: { name: 'Galaxy S8', w: 360, h: 740, dpr: 3, ua: ANDROID('SM-G950F') },
  mini: { name: 'iPad Mini portrait', w: 744, h: 1133, dpr: 2, ua: IPAD },
  miniL: { name: 'iPad Mini landscape', w: 1133, h: 744, dpr: 2, ua: IPAD },
  pro: { name: 'iPad Pro 11 portrait', w: 834, h: 1194, dpr: 2, ua: IPAD },
  proL: { name: 'iPad Pro 11 landscape', w: 1194, h: 834, dpr: 2, ua: IPAD },
  w414: { name: '414', w: 414, h: 896, dpr: 2, ua: IOS },
  w428: { name: '428', w: 428, h: 926, dpr: 3, ua: IOS },
  desk: { name: 'Desktop', w: 1440, h: 900, dpr: 1, ua: null },
};

export const ROLES = {
  owner: 'mmansary',
  admin: 'admin1@demo.nuzli.example',
  supervisor: 'supervisor1@demo.nuzli.example',
  monitor: 'monitor1@demo.nuzli.example',
  assistant: 'assistant1',
  participant: 'editor1',
};

/** Pages per role; `@project`, `@task` are resolved from the first link of that kind. */
const PAGES = {
  owner: ['home', 'projects', '@project', '@gantt', 'hub', 'teams', 'users', 'more', 'create'],
  admin: ['home', 'projects', '@project', '@gantt', 'hub', 'teams', 'members', 'users', 'violations', 'registrations', 'notifications', 'settings', 'cards', 'more', 'create'],
  supervisor: ['home', 'mytasks', '@task', 'hub', 'teams', 'members', 'more'],
  monitor: ['home', 'myviolations', 'record', 'pending', 'more'],
  assistant: ['home', 'projects', '@project', 'users', 'more'],
  participant: ['home', 'projects', '@project', 'more'],
};
const PATHS = {
  home: '',
  projects: 'projects',
  hub: 'hub',
  teams: 'teams',
  members: 'members',
  users: 'users',
  violations: 'violations',
  registrations: 'registrations',
  notifications: 'notifications',
  settings: 'settings',
  cards: 'cards',
  more: 'more',
  create: 'projects?create=1',
  mytasks: 'my-tasks',
  myviolations: 'violations/mine',
  record: 'violations/new',
  pending: 'violations/pending',
  install: 'install',
  login: 'login',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port) {
  const dir = mkdtempSync(join(tmpdir(), 'nuzli-qa-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 160 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) for (const l of listeners) l(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { proc, ws, send, listeners };
}

async function newPage(b) {
  const ctx = await b.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await b.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.result.browserContextId });
  const att = await b.send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  const s = (m, p) => b.send(m, p, sid);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Log.enable');
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Console errors and uncaught exceptions of this page (must stay zero).
  const errors = [];
  b.listeners.add((m) => {
    if (m.sessionId !== sid) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) errors.push('console.error ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log ' + m.params.entry.text.slice(0, 300));
  });
  return { s, sid, ctx: ctx.result.browserContextId, errors };
}

async function evaluate(p, expression) {
  const r = await p.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
}

async function settle(p, max = 7000) {
  const t0 = Date.now();
  await sleep(350);
  while (Date.now() - t0 < max) {
    const busy = await evaluate(p, `(() => document.readyState !== 'complete' || document.fonts.status !== 'loaded' || !!document.querySelector('.mantine-Skeleton-root, [data-loading="true"], .mantine-Loader-root:not(.nz-update *)'))()`);
    if (!busy) break;
    await sleep(200);
  }
  await sleep(450);
}

async function device(p, d, scheme) {
  await p.s('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: Boolean(d.ua), screenWidth: d.w, screenHeight: d.h });
  await p.s('Emulation.setTouchEmulationEnabled', { enabled: Boolean(d.ua), maxTouchPoints: d.ua ? 5 : 1 });
  await p.s('Emulation.setUserAgentOverride', { userAgent: d.ua ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
  await p.s('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: scheme },
    ],
  });
}

const FORCE_SCHEME = (scheme) => `(() => {
  const want = ${JSON.stringify(scheme)};
  const apply = () => { if (document.documentElement.getAttribute('data-mantine-color-scheme') !== want) document.documentElement.setAttribute('data-mantine-color-scheme', want); };
  apply();
  if (!window.__nzScheme) { window.__nzScheme = new MutationObserver(apply); window.__nzScheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme'] }); }
})()`;

async function go(p, base, path, scheme) {
  await p.s('Page.navigate', { url: base + path });
  await sleep(200);
  await settle(p);
  await evaluate(p, FORCE_SCHEME(scheme));
  await sleep(120);
}

async function login(p, base, identifier) {
  await go(p, base, 'login', 'light');
  await evaluate(p, `(async () => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    for (let i = 0; i < 50 && !document.querySelector('input[autocomplete="username"]'); i++) await new Promise((r) => setTimeout(r, 100));
    set(document.querySelector('input[autocomplete="username"]'), ${JSON.stringify(identifier)});
    set(document.querySelector('input[autocomplete="current-password"]'), ${JSON.stringify(PASSWORD)});
    document.querySelector('form').requestSubmit();
  })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const path = await evaluate(p, 'location.pathname');
    if (!/\/login$/.test(path)) break;
  }
  await settle(p);
}

/** The automatic checks (run in the page). */
const CHECKS = `(() => {
  const vw = innerWidth;
  const vis = (el) => { if (el.closest('[inert],[aria-hidden="true"],.nz-side:not(.open)')) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const desc = (el) => (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + ' «' + (el.textContent || '').trim().slice(0, 24) + '»');
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1 && p.id !== 'nz-stage') return true; } return false; };
  const overflow = [];
  for (const el of document.querySelectorAll('#root *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || (r.right <= vw + 1 && r.left >= -1)) continue;
    if (!vis(el) || inScroller(el) || getComputedStyle(el).position === 'fixed') continue;
    overflow.push(desc(el) + ' [' + Math.round(r.left) + '…' + Math.round(r.right) + ']');
    if (overflow.length > 8) break;
  }
  const stage = document.getElementById('nz-stage');
  const pageScrollX = document.documentElement.scrollWidth > vw + 1 || (stage ? stage.scrollWidth > stage.clientWidth + 1 : false);
  const small = [];
  for (const el of document.querySelectorAll('#root a[href], #root button, #root [role="tab"], #root input:not([type=hidden]), #root select, #root [role="checkbox"], #root [role="switch"]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    if (el.closest('p, li > span, .nz-crumb, .mantine-Table-td, svg, .nz-gantt, [class*="Gantt"]')) continue;
    if (r.width < 43.5 || r.height < 43.5) small.push(desc(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
  }
  const clipped = [];
  for (const el of document.querySelectorAll('#root h1:not(.sr-only), #root h2:not(.sr-only), #root h3, #root b, #root label, #root .mantine-Button-label, #root .mantine-Badge-label, #root .pill')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && /(hidden|clip)/.test(cs.overflowX)) clipped.push(desc(el));
    if (el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(cs.overflowY) && !/-webkit-box/.test(cs.display) && cs.webkitLineClamp === 'none') clipped.push(desc(el) + ' (v)');
  }
  return { pageScrollX, overflow, small: small.slice(0, 12), smallCount: small.length, clipped: clipped.slice(0, 8) };
})()`;

async function shot(p, file, d) {
  const r = await p.s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: d.w, height: d.h, scale: 1 } });
  if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

async function resolveLink(p, base, kind) {
  if (kind === '@project' || kind === '@gantt') {
    await go(p, base, 'projects', 'light');
    const href = await evaluate(p, `(() => { const a = [...document.querySelectorAll('a[href*="/projects/"]')].map((x) => x.getAttribute('href')).find((h) => /\\/projects\\/[0-9a-f-]{36}$/.test(h)); return a || null; })()`);
    if (!href) return null;
    const rel = href.replace(/^.*?\/projects\//, 'projects/');
    return kind === '@gantt' ? rel + '?view=gantt' : rel;
  }
  if (kind === '@task') {
    await go(p, base, 'my-tasks', 'light');
    const href = await evaluate(p, `(() => { const a = [...document.querySelectorAll('a[href*="/my-tasks/"]')].map((x) => x.getAttribute('href'))[0]; return a || null; })()`);
    return href ? href.replace(/^.*?\/my-tasks\//, 'my-tasks/') : null;
  }
  return PATHS[kind] ?? kind;
}

async function shoot(base, out, opts) {
  mkdirSync(out, { recursive: true });
  const b = await launch(9351);
  const report = [];
  const devices = (opts.devices ?? Object.keys(DEVICES).filter((k) => k !== 'w414' && k !== 'w428' && k !== 'desk')).map((k) => [k, DEVICES[k]]);
  const roles = opts.roles ?? Object.keys(ROLES);
  const schemes = opts.schemes ?? ['light', 'dark'];
  try {
    for (const role of roles) {
      const p = await newPage(b);
      await device(p, devices[0][1], 'light');
      await login(p, base, ROLES[role]);
      const wanted = opts.pages ? PAGES[role].filter((x) => opts.pages.includes(x.replace('@', ''))) : PAGES[role];
      const resolved = [];
      for (const pg of wanted) resolved.push([pg.replace('@', ''), await resolveLink(p, base, pg)]);
      for (const [dk, d] of devices) {
        for (const scheme of schemes) {
          await device(p, d, scheme);
          for (const [name, path] of resolved) {
            if (path === null) continue;
            await go(p, base, path, scheme);
            if (name === 'gantt') await sleep(600);
            const checks = await evaluate(p, CHECKS);
            const stem = `${dk}-${scheme}-${role}-${name}`;
            await shot(p, join(out, `${stem}.png`), d);
            for (let i = 1; i <= (opts.scrolls ?? 1); i++) {
              const moved = await evaluate(p, `(() => { const s = document.getElementById('nz-stage') || document.scrollingElement; const before = s.scrollTop; s.scrollTop = before + innerHeight - 160; return s.scrollTop !== before; })()`);
              if (!moved) break;
              await sleep(250);
              await shot(p, join(out, `${stem}~${i}.png`), d);
            }
            const errors = p.errors.splice(0);
            report.push({ device: dk, scheme, role, page: name, path, ...checks, errors });
            const flag = (checks.pageScrollX ? ' SCROLL-X' : '') + (checks.overflow.length ? ` overflow:${checks.overflow.length}` : '') + (checks.smallCount ? ` small:${checks.smallCount}` : '') + (checks.clipped.length ? ` clipped:${checks.clipped.length}` : '') + (errors.length ? ` ERRORS:${errors.length}` : '');
            console.log(`${stem}${flag}`);
          }
        }
      }
      await b.send('Target.disposeBrowserContext', { browserContextId: p.ctx });
    }
    if (opts.manifestShots) await manifestShots(b, base);
    if (opts.public) {
      const p = await newPage(b);
      for (const [dk, d] of devices) {
        await device(p, d, 'light');
        for (const name of ['login', 'install']) {
          await go(p, base, PATHS[name], 'light');
          const checks = await evaluate(p, CHECKS);
          await shot(p, join(out, `${dk}-light-public-${name}.png`), d);
          report.push({ device: dk, scheme: 'light', role: 'public', page: name, ...checks });
          console.log(`${dk}-light-public-${name}${checks.pageScrollX ? ' SCROLL-X' : ''}${checks.smallCount ? ` small:${checks.smallCount}` : ''}`);
        }
      }
    }
  } finally {
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
    b.ws.close();
    b.proc.kill();
  }
}

async function manifestShots(b, base) {
  const dir = join(root, 'public', 'screenshots');
  mkdirSync(dir, { recursive: true });
  const p = await newPage(b);
  const phone = { w: 390, h: 844, dpr: 2, ua: IOS };
  await device(p, phone, 'light');
  await login(p, base, ROLES.admin);
  await go(p, base, '', 'light');
  await shot(p, join(dir, 'narrow-home.png'), phone);
  await go(p, base, 'projects', 'light');
  await shot(p, join(dir, 'narrow-projects.png'), phone);
  const desk = { w: 1440, h: 900, dpr: 1, ua: null };
  await device(p, desk, 'light');
  const path = await resolveLink(p, base, '@gantt');
  await go(p, base, path, 'light');
  await sleep(800);
  await shot(p, join(dir, 'wide-project.png'), desk);
  console.log('manifest screenshots written to ' + dir);
}

async function sheet(dir, filter, out, cols = 6) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.png') && f.includes(filter)).sort();
  if (!files.length) return console.log('no files');
  const html = `<!doctype html><html dir="rtl"><head><style>
body{margin:0;background:#2b2d33;font:12px system-ui;color:#fff}
.g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px;padding:10px;direction:ltr}
figure{margin:0}img{width:100%;display:block;border-radius:6px;background:#fff}figcaption{padding:3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><div class="g">${files.map((f) => `<figure><img src="${pathToFileURL(join(dir, f)).href}"><figcaption>${f}</figcaption></figure>`).join('')}</div></body></html>`;
  const tmp = join(mkdtempSync(join(tmpdir(), 'nuzli-sheet-')), 'sheet.html');
  writeFileSync(tmp, html);
  const b = await launch(9352);
  try {
    const p = await newPage(b);
    const width = Number(process.env.SHEET_W ?? 1800);
    await p.s('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await p.s('Page.navigate', { url: pathToFileURL(tmp).href });
    await sleep(1200);
    await evaluate(p, 'Promise.all([...document.images].map((i) => i.decode().catch(() => null)))');
    const h = await evaluate(p, 'document.documentElement.scrollHeight');
    await p.s('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const r = await p.s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: h, scale: 1 } });
    writeFileSync(out, Buffer.from(r.result.data, 'base64'));
    console.log(`sheet ${out} (${files.length} shots)`);
  } finally {
    b.ws.close();
    b.proc.kill();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const args = rest.filter((a) => !a.startsWith('--'));
if (cmd === 'shoot') {
  await shoot(args[0], resolve(args[1]), {
    devices: flags.devices ? String(flags.devices).split(',') : undefined,
    roles: flags.roles ? String(flags.roles).split(',') : undefined,
    schemes: flags.schemes ? String(flags.schemes).split(',') : undefined,
    pages: flags.pages ? String(flags.pages).split(',') : undefined,
    scrolls: flags.scrolls !== undefined ? Number(flags.scrolls) : 1,
    manifestShots: Boolean(flags['manifest-shots']),
    public: Boolean(flags.public),
  });
} else if (cmd === 'sheet') {
  await sheet(resolve(args[0]), args[1] ?? '', resolve(args[2]), Number(args[3] ?? 6));
} else {
  console.log('usage: qa-mobile.mjs shoot <baseUrl> <outDir> [flags] | sheet <dir> <filter> <out.png> [cols]');
}
