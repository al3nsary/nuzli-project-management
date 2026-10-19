/**
 * A9 — Jira imports: (a) a Jira CSV export ("Export → CSV (all fields)") and (b) Jira Cloud REST
 * (`/rest/api/3/search/jql`, paginated, at most 2,000 issues). Both map the same way:
 * Epic → GROUP, Sub-task under its parent, Parent / Epic Link → hierarchy, Status → status,
 * Assignee → assignee name, Start date (custom) or Created → start, Due date → end, Original
 * Estimate → duration, "blocks" links → FS. The API token is used for one call and never
 * stored or logged; the site URL passes an SSRF guard (https, *.atlassian.net or an allowlist,
 * every resolved address public, DNS pinned for the request).
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../common/app-error';
import {
  MAX_JIRA_ISSUES,
  cleanText,
  emptyDraft,
  headerKey,
  parseDateValue,
  parseStatus,
  warn,
  type DraftTask,
  type ImportDraft,
} from './import-model';
import { decodeText } from './tabular';
import Papa from 'papaparse';
import type { TaskStatus } from '@nuzli/shared';

/** One issue in the shape both sources are reduced to. */
export interface JiraIssue {
  id: string | null;
  key: string;
  summary: string;
  issueType: string;
  status: string | null;
  statusCategory?: string | null;
  assignee: string | null;
  created: string | null;
  startDate: string | null;
  dueDate: string | null;
  /** Seconds. */
  originalEstimate: number | null;
  /** Parent issue id or key (sub-tasks, next-gen children). */
  parent: string | null;
  epicLink: string | null;
  /** Keys this issue blocks / is blocked by. */
  blocks: string[];
  blockedBy: string[];
  description?: string | null;
}

const EPIC = new Set(['epic', 'ملحمة', 'ملحمه', 'ايبك', 'إيبك']);
const SUBTASK = new Set(['sub-task', 'subtask', 'sub task', 'مهمة فرعية', 'مهمه فرعيه']);

/** The status name first (it knows "Blocked"), then its category (REST keys or CSV names). */
function statusOfJira(name: string | null, category?: string | null): TaskStatus | null {
  const byName = parseStatus(name);
  if (byName) return byName;
  const cat = (category ?? '').toLowerCase();
  if (cat === 'done') return 'DONE';
  if (cat === 'indeterminate' || cat === 'in progress') return 'IN_PROGRESS';
  if (cat === 'new' || cat === 'to do') return 'NOT_STARTED';
  return null;
}

/** Issues → draft (shared by CSV and REST). */
export function issuesToDraft(issues: JiraIssue[], opts: { minutesPerDay?: number; projectName?: string | null } = {}): ImportDraft {
  const draft = emptyDraft();
  draft.projectName = opts.projectName ?? null;
  const keyOf = new Map<string, string>();
  issues.forEach((i) => {
    keyOf.set(i.key, `j${i.key}`);
    if (i.id) keyOf.set(i.id, `j${i.key}`);
  });
  const tasks: DraftTask[] = [];
  for (const i of issues) {
    const type = headerKey(i.issueType);
    const isEpic = EPIC.has(type);
    const parentRef = i.parent ?? i.epicLink;
    const parentKey = parentRef ? (keyOf.get(parentRef) ?? null) : null;
    if (parentRef && !parentKey) warn(draft, 'PARENT_MISSING', `الأصل «${parentRef}» للمهمة ${i.key} ليس في الاستيراد، فأصبحت في المستوى الأعلى.`, { sourceId: i.key });
    if (SUBTASK.has(type) && !parentRef) warn(draft, 'PARENT_MISSING', `المهمة الفرعية ${i.key} بلا أصل.`, { sourceId: i.key });
    const status = statusOfJira(i.status, i.statusCategory);
    tasks.push({
      key: `j${i.key}`,
      sourceId: i.key,
      name: `${i.summary}`.slice(0, 300) || i.key,
      parentKey,
      summary: isEpic,
      milestone: false,
      start: i.startDate ?? i.created?.slice(0, 10) ?? null,
      end: i.dueDate,
      durationMinutes: i.originalEstimate && i.originalEstimate > 0 ? Math.round(i.originalEstimate / 60) : null,
      durationDays: null,
      progress: status === 'DONE' ? 100 : 0,
      status,
      assigneeName: i.assignee,
      plannedCost: 0,
      actualCost: 0,
      deadline: i.dueDate ? i.dueDate.slice(0, 10) : null,
      notes: i.description ?? null,
    });
  }
  // A Jira start is a date: never let a creation time decide the unit.
  for (const t of tasks) if (t.start) t.start = t.start.slice(0, 10);
  const pairs = new Set<string>();
  const link = (pred: string, succ: string) => {
    const p = keyOf.get(pred);
    const s = keyOf.get(succ);
    if (!p || !s) return;
    const k = `${p}>${s}`;
    if (pairs.has(k)) return;
    pairs.add(k);
    draft.deps.push({ predKey: p, succKey: s, type: 'FS', lagDays: 0 });
  };
  for (const i of issues) {
    for (const b of i.blocks) link(i.key, b);
    for (const b of i.blockedBy) link(b, i.key);
  }
  draft.tasks = tasks;
  // Estimates are effort in hours; the schedule stays in days unless the admin chooses hours.
  draft.unit = 'DAY';
  return draft;
}

// ─────────────────────────────────────────── (a) CSV export

/** Jira CSV: duplicate headers (several link columns) are kept by reading rows as arrays. */
export function parseJiraCsv(buf: Buffer, dateOrder: 'DMY' | 'MDY' = 'DMY'): ImportDraft {
  const text = decodeText(buf);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t'] });
  const rows = parsed.data;
  if (!rows.length) throw new AppError('IMPORT_NO_TASKS');
  const header = rows[0]!.map((h) => headerKey(h));
  const one = (...names: string[]): number => header.findIndex((h) => names.some((n) => h === headerKey(n)));
  const all = (re: RegExp): number[] => header.flatMap((h, i) => (re.test(h) ? [i] : []));
  const ix = {
    summary: one('Summary', 'الملخص'),
    key: one('Issue key', 'مفتاح المشكلة', 'Key'),
    id: one('Issue id', 'معرف المشكلة'),
    type: one('Issue Type', 'نوع المشكلة'),
    status: one('Status', 'الحالة'),
    statusCategory: one('Status Category'),
    assignee: one('Assignee', 'المسؤول', 'المكلف'),
    created: one('Created', 'تاريخ الانشاء'),
    due: one('Due date', 'Due Date', 'تاريخ الاستحقاق'),
    start: one('Custom field (Start date)', 'Start date', 'Start Date', 'تاريخ البدء'),
    estimate: one('Original Estimate', 'Original estimate', 'التقدير الاصلي'),
    parent: one('Parent', 'Parent id', 'Parent ID', 'الاصل'),
    parentKey: one('Parent key', 'Parent Key'),
    epic: one('Custom field (Epic Link)', 'Epic Link'),
    description: one('Description', 'الوصف'),
  };
  if (ix.summary < 0 || ix.key < 0) throw new AppError('IMPORT_FORMAT_MISMATCH', { expected: 'Jira CSV (Summary, Issue key)' });
  const outward = all(/^outward issue link blocks$/);
  const inward = all(/^inward issue link blocks$/);
  const issues: JiraIssue[] = [];
  const draftWarnings = emptyDraft();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const get = (i: number): string | null => (i >= 0 ? cleanText(row[i], 8000) : null);
    const key = get(ix.key);
    const summary = get(ix.summary);
    if (!key || !summary) {
      if (row.some((c) => c && c.trim())) warn(draftWarnings, 'ROW_SKIPPED', `الصف ${r + 1} بلا مفتاح أو ملخص فتُرك.`, { row: r + 1 });
      continue;
    }
    const est = get(ix.estimate);
    issues.push({
      id: get(ix.id),
      key,
      summary,
      issueType: get(ix.type) ?? 'Task',
      status: get(ix.status),
      statusCategory: get(ix.statusCategory),
      assignee: cleanText(get(ix.assignee), 200),
      created: parseDateValue(get(ix.created), dateOrder),
      startDate: parseDateValue(get(ix.start), dateOrder)?.slice(0, 10) ?? null,
      dueDate: parseDateValue(get(ix.due), dateOrder)?.slice(0, 10) ?? null,
      originalEstimate: est && /^\d+$/.test(est) ? Number(est) : null,
      parent: get(ix.parentKey) ?? get(ix.parent),
      epicLink: get(ix.epic),
      blocks: outward.map((i) => get(i)).filter((v): v is string => !!v),
      blockedBy: inward.map((i) => get(i)).filter((v): v is string => !!v),
      description: get(ix.description),
    });
  }
  const draft = issuesToDraft(issues);
  draft.warnings.unshift(...draftWarnings.warnings);
  return draft;
}

// ─────────────────────────────────────────── (b) REST + SSRF guard

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const g = parseIPv6(ip);
    if (!g) return true;
    // IPv4-mapped (::ffff:a.b.c.d, also written in hex): judge the embedded IPv4 address.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isPrivateAddress(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
    }
    // Security review A9 L5: an allow-list. Only global unicast (2000::/3) can be public; that
    // already excludes ::, ::1, IPv4-compatible ::a.b.c.d, 100::/64, 64:ff9b::/96, fc00::/7,
    // fe80::/10, fec0::/10 and ff00::/8.
    if (g[0]! < 0x2000 || g[0]! > 0x3fff) return true;
    if (g[0] === 0x2002) return true; // 6to4 (may embed a private IPv4)
    if (g[0] === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 IETF special purpose (Teredo, ORCHID, benchmarking…)
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x3fff && g[1]! < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
    return false;
  }
  return true;
}

/** Eight 16-bit groups of an IPv6 address (zone id ignored, embedded IPv4 tail accepted), or null. */
export function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // A dotted IPv4 tail becomes the last two groups.
  const v4 = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${s.slice(0, v4.index)}:${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x === '' ? [] : x.split(':'));
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  if ([...head, ...rest].some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const fill = halves.length === 2 ? new Array<string>(8 - head.length - rest.length).fill('0') : [];
  return [...head, ...fill, ...rest].map((x) => parseInt(x, 16));
}

/**
 * Validates a Jira site URL: https only, no credentials, port 443, host = `<name>.atlassian.net`
 * or a host in `allowedHosts` (exact, lower case), never an IP literal. Returns the origin.
 */
export function assertJiraSite(siteUrl: string, allowedHosts: readonly string[] = []): URL {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    throw new AppError('JIRA_URL_NOT_ALLOWED');
  }
  const host = u.hostname.toLowerCase();
  const allowed = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host) || allowedHosts.map((h) => h.toLowerCase()).includes(host);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || isIP(host) || !allowed) {
    throw new AppError('JIRA_URL_NOT_ALLOWED');
  }
  return new URL(u.origin);
}

type LookupFn = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => void;

/** A DNS lookup that fails when any address of the host is private (pins what the socket uses). */
export function guardedLookup(base: LookupFn = dnsLookup as unknown as LookupFn) {
  return (hostname: string, options: unknown, cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void): void => {
    base(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
        const e = new Error('JIRA_PRIVATE_ADDRESS') as NodeJS.ErrnoException;
        e.code = 'EJIRAPRIVATE';
        return cb(e, '', 4);
      }
      const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface HttpResult {
  status: number;
  body: string;
}

export type HttpGet = (url: URL, headers: Record<string, string>, signal?: AbortSignal) => Promise<HttpResult>;

/** Overall deadline of one Jira import, across every page (security review A9 L5). */
export const JIRA_TOTAL_DEADLINE_MS = 60_000;

/**
 * GET over https with the guarded lookup, no redirects followed, 15 s idle timeout, 5 MB cap.
 * The signal (the overall deadline) destroys the request whatever the server trickles.
 */
export const guardedGet: HttpGet = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers, lookup: guardedLookup() as never, timeout: 15_000, ...(signal ? { signal } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 5 * 1024 * 1024) {
            req.destroy(new Error('JIRA_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('JIRA_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });

export interface JiraRestInput {
  siteUrl: string;
  email: string;
  apiToken: string;
  jql?: string;
  projectKey?: string;
}

/** The custom fields Jira Cloud commonly uses for "Start date" and the classic "Epic Link". */
const START_FIELD = 'customfield_10015';
const EPIC_FIELD = 'customfield_10014';
const FIELDS = ['summary', 'issuetype', 'parent', 'status', 'assignee', 'created', 'duedate', 'timeoriginalestimate', 'issuelinks', 'description', START_FIELD, EPIC_FIELD];

/**
 * Fetches issues with the enhanced search (`/rest/api/3/search/jql`, `nextPageToken`), 100 per
 * page, up to MAX_JIRA_ISSUES. The token goes only into this request's Authorization header and
 * never into errors or logs.
 */
export async function fetchJiraIssues(
  input: JiraRestInput,
  opts: { allowedHosts?: readonly string[]; get?: HttpGet; deadlineMs?: number } = {},
): Promise<{ issues: JiraIssue[]; truncated: boolean; projectName: string | null }> {
  const origin = assertJiraSite(input.siteUrl, opts.allowedHosts ?? []);
  const get = opts.get ?? guardedGet;
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? JIRA_TOTAL_DEADLINE_MS);
  const jql = input.jql ?? `project = "${input.projectKey}" ORDER BY created ASC`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString('base64')}`,
    Accept: 'application/json',
    'User-Agent': 'nuzli-import',
  };
  const issues: JiraIssue[] = [];
  let token: string | null = null;
  let truncated = false;
  for (let page = 0; page < 40; page++) {
    const url = new URL('/rest/api/3/search/jql', origin);
    url.searchParams.set('jql', jql);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('fields', FIELDS.join(','));
    if (token) url.searchParams.set('nextPageToken', token);
    if (deadline.aborted) throw new AppError('JIRA_REQUEST_FAILED', { reason: 'timeout' });
    let res: HttpResult;
    try {
      res = await raceDeadline(get(url, headers, deadline), deadline);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EJIRAPRIVATE') throw new AppError('JIRA_URL_NOT_ALLOWED');
      throw new AppError('JIRA_REQUEST_FAILED', deadline.aborted ? { reason: 'timeout' } : undefined);
    }
    if (res.status === 401 || res.status === 403) throw new AppError('JIRA_AUTH_FAILED');
    if (res.status >= 300 && res.status < 400) throw new AppError('JIRA_URL_NOT_ALLOWED');
    if (res.status === 400) throw new AppError('JIRA_REQUEST_FAILED', { status: 400, reason: 'jql' });
    if (res.status !== 200) throw new AppError('JIRA_REQUEST_FAILED', { status: res.status });
    let body: { issues?: unknown[]; nextPageToken?: string; isLast?: boolean };
    try {
      body = JSON.parse(res.body) as typeof body;
    } catch {
      throw new AppError('JIRA_REQUEST_FAILED', { reason: 'json' });
    }
    for (const raw of body.issues ?? []) {
      if (issues.length >= MAX_JIRA_ISSUES) {
        truncated = true;
        break;
      }
      const i = restIssue(raw);
      if (i) issues.push(i);
    }
    if (truncated || body.isLast || !body.nextPageToken || !(body.issues ?? []).length) {
      if (!truncated && body.nextPageToken && !body.isLast && issues.length >= MAX_JIRA_ISSUES) truncated = true;
      break;
    }
    token = body.nextPageToken;
  }
  return { issues, truncated, projectName: input.projectKey ?? null };
}

/** Rejects as soon as the deadline fires, even if the request ignores the signal. */
function raceDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('JIRA_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('JIRA_TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? (v as J) : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Atlassian Document Format → plain text (paragraph text nodes only). */
function adfText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  const parts: string[] = [];
  const walk = (n: unknown, depth: number) => {
    if (depth > 20 || !n || typeof n !== 'object') return;
    const node = n as J;
    if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c, depth + 1);
      if (node.type === 'paragraph') parts.push('\n');
    }
  };
  walk(v, 0);
  const text = parts.join('').trim();
  return text ? text.slice(0, 8000) : null;
}

export function restIssue(raw: unknown): JiraIssue | null {
  const r = o(raw);
  const f = o(r.fields);
  const key = s(r.key);
  if (!key) return null;
  const links = Array.isArray(f.issuelinks) ? (f.issuelinks as unknown[]).map(o) : [];
  const blocks: string[] = [];
  const blockedBy: string[] = [];
  for (const l of links) {
    const type = o(l.type);
    const name = (s(type.name) ?? '').toLowerCase();
    if (name !== 'blocks') continue;
    const out = s(o(l.outwardIssue).key);
    const inn = s(o(l.inwardIssue).key);
    if (out) blocks.push(out);
    if (inn) blockedBy.push(inn);
  }
  const epic = f[EPIC_FIELD];
  return {
    id: s(r.id),
    key,
    summary: s(f.summary) ?? key,
    issueType: s(o(f.issuetype).name) ?? 'Task',
    status: s(o(f.status).name),
    statusCategory: s(o(o(f.status).statusCategory).key),
    assignee: s(o(f.assignee).displayName),
    created: s(f.created) ? parseDateValue(s(f.created)!.slice(0, 19)) : null,
    startDate: s(f[START_FIELD])?.slice(0, 10) ?? null,
    dueDate: s(f.duedate)?.slice(0, 10) ?? null,
    originalEstimate: typeof f.timeoriginalestimate === 'number' ? f.timeoriginalestimate : null,
    parent: s(o(f.parent).key) ?? s(o(f.parent).id),
    epicLink: typeof epic === 'string' ? epic : null,
    blocks,
    blockedBy,
    description: adfText(f.description),
  };
}
