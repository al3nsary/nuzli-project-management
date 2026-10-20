/**
 * A12 isolation cases — one entry for EVERY route of the API (the suite fails on a route without
 * one). For each route the runner calls it as users of workspace A (admin, supervisor, monitor,
 * and an owner working in A) while aiming at workspace B:
 *  - path parameters are filled with B's ids (and, for nested routes, A's parent + B's child);
 *  - `body` / `query` reference B's rows wherever the route accepts an id;
 *  - list, search, export, stats, hub, attachments, notifications, audit and report routes run
 *    with B ids in their filters too.
 * A probe passes when the response carries nothing of B (no B id, no B text) and, when it targets
 * B, is refused (4xx). After all probes, every B row must be byte-for-byte unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceFixture } from '../support/workspace-fixture';

export interface Fx {
  /** The workspace whose ids fill the request (B for probes, A for positive controls). */
  t: WorkspaceFixture;
  A: WorkspaceFixture;
  B: WorkspaceFixture;
}

export interface Case {
  /** Not a workspace-data route (public, session, health) — why it needs no B probe. */
  skip?: string;
  body?: (fx: Fx) => unknown;
  query?: (fx: Fx) => Record<string, string | undefined>;
  /** Extra requests (different bodies/queries) for the same route. */
  extra?: Array<{ label: string; body?: (fx: Fx) => unknown; query?: (fx: Fx) => Record<string, string | undefined>; allow2xx?: string }>;
  /**
   * A probe that targets B may still answer 2xx when the API simply finds nothing to do
   * (e.g. "mark as read" = updateMany of the caller's own rows). The reason is required;
   * the "B unchanged" check still covers it.
   */
  allow2xx?: string;
  /** The positive control (admin of A, A's own ids) for a GET route: false when not meaningful. */
  positive?: false | { reason: string };
  /**
   * A12 round 2: owners act on every workspace BY DESIGN (workspaces, owners, every account).
   * Their probes are not run here — test/isolation/a12-round2.pg-spec.ts covers what an owner
   * may do and that it is audited. Every other identity is probed as usual.
   */
  ownerSkip?: string;
  /** A12 round 2: an owner-only route — every non-owner probe must be refused, ids or not. */
  ownerOnly?: boolean;
}

const today = '2026-10-15';
const nidOf = (n: number) => {
  // a valid Saudi national id (Luhn) starting with 1
  const first9 = `1${String(10000000 + n).slice(-8)}`;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(first9[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return first9 + String((10 - (sum % 10)) % 10);
};
let n = 500;
const nid = () => nidOf(++n);

/** Path parameter → the fixture id it stands for, by route prefix. */
export function paramId(route: string, param: string, f: WorkspaceFixture): string {
  const ids = f.ids;
  const u = f.users;
  const by: Array<[RegExp, string, string]> = [
    [/^\/calendars\/:id\/exceptions\/:exId/, 'exId', ids.calendarException!],
    [/^\/calendars/, 'id', ids.calendar!],
    [/^\/cards\/sizes/, 'id', ids.cardSize!],
    [/^\/cards\/templates/, 'id', ids.cardTemplate!],
    [/^\/cards\/batches/, 'id', ids.printBatch!],
    [/^\/colors/, 'id', ids.color!],
    [/^\/custom-fields/, 'id', ids.customField!],
    [/^\/dependencies/, 'id', ids.dependency!],
    [/^\/files/, 'id', ids.taskFile!],
    [/^\/labels/, 'id', ids.label!],
    [/^\/logos/, 'id', ids.logo!],
    [/^\/members/, 'id', ids.member!],
    [/^\/notifications/, 'id', ids.notification!],
    [/^\/org\/positions/, 'id', ids.position!],
    [/^\/org\/units/, 'id', ids.unit!],
    [/^\/portfolios/, 'id', ids.portfolio!],
    [/^\/portfolios/, 'projectId', ids.project!],
    [/^\/projects\/:id\/participants/, 'userId', u.monitor],
    [/^\/projects/, 'id', ids.project!],
    [/^\/projects/, 'userId', u.supervisor],
    [/^\/reference/, 'kind', 'departments'],
    [/^\/reference/, 'id', ids.department!],
    [/^\/registrations/, 'id', u.pending],
    [/^\/member-requests/, 'id', ids.memberRequest!],
    [/^\/owners/, 'userId', u.admin],
    [/^\/workspaces/, 'id', f.workspaceId!],
    [/^\/workspaces/, 'userId', u.admin],
    [/^\/workspaces/, 'membershipId', ids.membership!],
    [/^\/tasks/, 'id', ids.task!],
    [/^\/tasks/, 'fileId', ids.taskFile!],
    [/^\/tasks/, 'itemId', ids.checklistItem!],
    [/^\/tasks/, 'labelId', ids.label!],
    [/^\/tasks/, 'fieldId', ids.customField!],
    [/^\/teams/, 'id', ids.team!],
    [/^\/teams/, 'userId', u.supervisor],
    [/^\/time-entries/, 'id', ids.timeEntry!],
    [/^\/users/, 'id', u.supervisor],
    [/^\/violation-types/, 'id', ids.violationType!],
    [/^\/violations/, 'id', ids.violation!],
    [/^\/violations/, 'fileId', ids.idCardFile!],
  ];
  for (const [re, p, value] of by) if (p === param && re.test(route)) return value;
  throw new Error(`No fixture id for :${param} in ${route} — add it to paramId()`);
}

const SESSION = 'session/account route of the caller only — covered by test/isolation/workspace-session.pg-spec.ts';
const PUBLIC = 'public route without workspace data';
const OWNER_ADMIN = 'owners act on every workspace and every account by design — test/isolation/a12-round2.pg-spec.ts';

export const CASES: Record<string, Case> = {
  // ─────────────────────────────── public, session, health
  'GET /health': { skip: PUBLIC },
  'GET /ready': { skip: PUBLIC },
  'GET /public/workspaces': { skip: 'public list of active workspace NAMES (by design, for registration) — workspace-session suite' },
  'POST /auth/login': { skip: PUBLIC },
  'POST /auth/logout': { skip: PUBLIC },
  'POST /auth/refresh': { skip: SESSION },
  'POST /auth/register': { skip: 'creates a PENDING account addressed to a chosen workspace — workspace-session suite' },
  'POST /auth/forgot-password': { skip: PUBLIC },
  'POST /auth/reset-password': { skip: PUBLIC },
  'POST /auth/change-password': { skip: SESSION },
  'GET /auth/me': { skip: SESSION },
  'PATCH /me': { skip: SESSION },
  'GET /auth/workspaces': { skip: SESSION },
  'POST /auth/switch-workspace': { skip: 'membership check of the target workspace (owners may enter any) — workspace-session suite' },
  'GET /system/info': { skip: SESSION },

  // ─────────────────────────────── A12 round 2 — owners and workspaces (owners act on every workspace by design)
  'GET /owners': { ownerOnly: true, ownerSkip: OWNER_ADMIN, positive: false },
  'POST /owners': { ownerOnly: true, ownerSkip: OWNER_ADMIN, body: (f) => ({ userId: f.t.users.supervisor }) },
  'DELETE /owners/:userId': { ownerOnly: true, ownerSkip: OWNER_ADMIN },
  'GET /workspaces': { ownerOnly: true, ownerSkip: OWNER_ADMIN, positive: false },
  'POST /workspaces': { ownerOnly: true, ownerSkip: OWNER_ADMIN, body: () => ({ name: 'قسم العزل' }) },
  'PATCH /workspaces/:id': { ownerOnly: true, ownerSkip: OWNER_ADMIN, body: () => ({ name: 'اسم جديد' }) },
  'POST /workspaces/:id/archive': { ownerOnly: true, ownerSkip: OWNER_ADMIN },
  'POST /workspaces/:id/restore': { ownerOnly: true, ownerSkip: OWNER_ADMIN },
  'GET /workspaces/:id/summary': { ownerOnly: true, ownerSkip: OWNER_ADMIN, positive: false },
  'GET /workspaces/:id/admins': { ownerOnly: true, ownerSkip: OWNER_ADMIN, positive: false },
  'POST /workspaces/:id/admins': { ownerOnly: true, ownerSkip: OWNER_ADMIN, body: (f) => ({ userId: f.t.users.supervisor, confirmDualRole: true }) },
  'DELETE /workspaces/:id/admins/:userId': { ownerOnly: true, ownerSkip: OWNER_ADMIN },
  'GET /workspaces/:id/members': { ownerSkip: OWNER_ADMIN },
  'POST /workspaces/:id/members': {
    ownerSkip: OWNER_ADMIN,
    body: (f) => ({ userId: f.t.users.monitor, role: 'SUPERVISOR', confirmDualRole: true }),
    extra: [{ label: 'by identifier', body: (f) => ({ identifier: f.t.users.admin, role: 'ASSISTANT', permissions: { projects: 'view' }, confirmDualRole: true }) }],
  },
  'PATCH /workspaces/:id/members/:membershipId': { ownerSkip: OWNER_ADMIN, body: () => ({ title: 'منصب جديد' }) },
  'DELETE /workspaces/:id/members/:membershipId': { ownerSkip: OWNER_ADMIN },

  // ─────────────────────────────── users & registrations
  'GET /users': { query: (f) => ({ q: f.t.tag }) },
  'POST /users/search': { allow2xx: 'a search filter, nothing of B can match', body: (f) => ({ q: f.t.tag, page: 1, pageSize: 50 }) },
  'GET /users/supervisors': {},
  'GET /users/:id': {},
  // A12 round 2 — account administration (owners may edit every account by design)
  'GET /users/all': { ownerOnly: true, ownerSkip: OWNER_ADMIN, query: (f) => ({ q: f.t.tag }) },
  'PATCH /users/:id': { ownerSkip: OWNER_ADMIN, body: () => ({ fullName: 'اسم جديد للعزل' }) },
  'POST /users/:id/username': { ownerSkip: OWNER_ADMIN, body: () => ({ username: `iso${randomUUID().slice(0, 6)}` }) },
  'POST /users/:id/password': { ownerSkip: OWNER_ADMIN, body: () => ({ password: 'Isolation-Pass-9', mustChangePassword: true }) },
  'POST /users': {
    body: () => ({ fullName: 'مستخدم اختبار', email: `iso-${randomUUID().slice(0, 8)}@nuzli.test`, mobile: `05${String(Date.now()).slice(-8)}`, nationalId: nid(), role: 'MONITOR' }),
    allow2xx: 'creates a user in the CALLER’s workspace only (no B id involved)',
  },
  'PATCH /users/:id/role': { body: () => ({ role: 'MONITOR' }) },
  'POST /users/:id/suspend': { body: () => ({ reason: 'اختبار العزل' }) },
  'POST /users/:id/reactivate': {},
  'GET /registrations': {},
  'POST /registrations/:id/approve': { body: () => ({}) },
  'POST /registrations/:id/reject': { body: () => ({ reason: 'اختبار العزل' }) },
  'GET /users/:id/photo-url': { positive: { reason: 'the fixture users have no photo (404 for A too)' } },
  'DELETE /users/:id/photo': {},
  'GET /me/photo-url': { skip: SESSION },
  'DELETE /me/photo': { skip: SESSION },

  // ─────────────────────────────── teams & members
  'GET /teams': { query: (f) => ({ q: f.t.tag }) },
  'GET /teams/:id': {},
  'POST /teams': {
    body: (f) => ({ name: 'فريق العزل', colorId: f.t.ids.color, supervisorId: f.t.users.supervisor }),
    extra: [
      {
        label: 'B supervisor only',
        body: (f) => ({ name: 'فريق العزل ٢', colorId: f.A.ids.color2, supervisorId: f.t.users.supervisor }),
        allow2xx: 'a SUPERVISOR always creates a team led by himself: supervisorId is ignored (the admin probe must be refused)',
      },
    ],
  },
  'PATCH /teams/:id': { body: (f) => ({ name: 'اسم جديد', colorId: f.t.ids.color2 }) },
  'POST /teams/:id/approve': {},
  'POST /teams/:id/reject': { body: () => ({ reason: 'اختبار العزل' }) },
  'POST /teams/:id/archive': { body: () => ({ reason: 'اختبار العزل' }) },
  'POST /teams/:id/supervisor': { body: (f) => ({ supervisorId: f.t.users.supervisor }) },
  'GET /teams/:id/supervisors': {},
  'GET /teams/:id/supervisor-history': {},
  'POST /teams/:id/supervisors': { body: (f) => ({ userId: f.t.users.supervisor }) },
  'DELETE /teams/:id/supervisors/:userId': { body: () => ({ reason: 'اختبار العزل' }) },
  'POST /teams/:id/supervisors/:userId/primary': { body: () => ({}) },
  'POST /teams/:id/foreman': { body: (f) => ({ memberId: f.t.ids.member }) },
  'DELETE /teams/:id/foreman': {},
  'PUT /teams/:id/violation-visibility': { body: () => ({ mode: 'HIDE' }) },
  'POST /teams/:id/members': { body: () => ({ fullName: 'عامل العزل', nationalId: nid() }) },
  'GET /members': { query: (f) => ({ q: f.t.tag, teamId: f.t.ids.team }), extra: [{ label: 'by last 4', query: () => ({ q: '0023' }) }] },
  'POST /members/search': {
    allow2xx: 'a search: a B team id in the filter finds nothing', body: (f) => ({ q: f.t.tag, teamId: f.t.ids.team, page: 1, pageSize: 50 }) },
  'GET /members/:id': {},
  'GET /members/:id/history': {},
  'PATCH /members/:id': { body: (f) => ({ fullName: 'اسم جديد', jobTitleId: f.t.ids.jobTitle, departmentId: f.t.ids.department }) },
  'POST /members/move': { body: (f) => ({ memberIds: [f.t.ids.member], toTeamId: f.t.ids.team }), extra: [{ label: 'B members into A team', body: (f) => ({ memberIds: [f.t.ids.member], toTeamId: f.A.ids.team }) }] },
  'POST /members/import': { body: (f) => ({ teamId: f.t.ids.team, rows: [{ fullName: 'عامل', nationalId: nid() }], commit: true }) },
  'GET /members/:id/photo-url': {},
  // A12 round 2 — removing a worker (admins directly; a supervisor's call becomes a request)
  'POST /members/:id/archive': { body: () => ({ reason: 'اختبار العزل' }) },
  'GET /member-requests': { query: (f) => ({ teamId: f.t.ids.team, status: 'ALL' }) },
  'GET /member-requests/:id': {},
  'POST /member-requests/:id/approve': {},
  'POST /member-requests/:id/reject': { body: () => ({ reason: 'اختبار العزل' }) },
  'DELETE /members/:id/photo': {},
  'GET /colors': {},
  'GET /colors/available': { query: (f) => ({ teamId: f.t.ids.team }) },
  'POST /colors': { body: () => ({ name: 'لون العزل', hex: '#123456' }), allow2xx: 'creates a colour in the CALLER’s workspace (no B id involved)' },
  'PATCH /colors/:id': { body: () => ({ name: 'اسم جديد' }) },
  'GET /reference/:kind': { positive: { reason: 'list route (the kind is not an id)' } },
  'POST /reference/:kind': { body: () => ({ name: `مرجع ${randomUUID().slice(0, 6)}` }), allow2xx: 'the path holds a kind, not an id — creates in the CALLER’s workspace' },
  'PATCH /reference/:kind/:id': { body: () => ({ name: 'اسم جديد' }) },
  'DELETE /reference/:kind/:id': {},
  'GET /org': {},
  'POST /org/units': { body: (f) => ({ parentId: f.t.ids.unit, name: 'وحدة العزل', kind: 'UNIT' }) },
  'PATCH /org/units/:id': { body: () => ({ name: 'اسم جديد' }) },
  'POST /org/units/:id/move': { body: (f) => ({ parentId: f.t.ids.unit }) },
  'DELETE /org/units/:id': {},
  'POST /org/positions': {
    body: (f) => ({ unitId: f.t.ids.unit, title: 'منصب العزل' }),
    extra: [
      { label: 'B holder user in A unit', body: (f) => ({ unitId: f.A.ids.unit, title: 'منصب', holderUserId: f.t.users.admin }) },
      { label: 'B holder member in A unit', body: (f) => ({ unitId: f.A.ids.unit, title: 'منصب', holderMemberId: f.t.ids.member }) },
      { label: 'reports to B position', body: (f) => ({ unitId: f.A.ids.unit, title: 'منصب', reportsToPositionId: f.t.ids.position }) },
    ],
  },
  'PATCH /org/positions/:id': { body: () => ({ title: 'اسم جديد' }) },
  'POST /org/positions/:id/move': { body: (f) => ({ unitId: f.t.ids.unit }) },
  'DELETE /org/positions/:id': {},

  // ─────────────────────────────── projects & tasks
  'GET /projects': { query: (f) => ({ q: f.t.tag }) },
  'POST /projects': {
    body: (f) => ({ name: 'مشروع العزل', startDate: today, calendarId: f.t.ids.calendar }),
    extra: [{ label: 'from a B template', body: (f) => ({ name: 'مشروع العزل', startDate: today, fromTemplateId: f.t.ids.project }) }],
  },
  'GET /projects/:id': {},
  'PATCH /projects/:id': { body: (f) => ({ name: 'اسم جديد', calendarId: f.t.ids.calendar }) },
  'DELETE /projects/:id': {},
  'GET /projects/:id/gantt': {},
  'GET /projects/:id/export': { query: () => ({ format: 'csv' }) },
  'GET /projects/:id/export.xlsx': {},
  'GET /projects/:id/access': {},
  'POST /projects/:id/access': { body: (f) => ({ userId: f.t.users.supervisor }) },
  'DELETE /projects/:id/access/:userId': {},
  'POST /projects/:id/convert': { body: () => ({ durationUnit: 'HOUR' }) },
  'POST /projects/:id/tasks': {
    body: (f) => ({ name: 'مهمة العزل', startDate: today, durationDays: 1, assigneeId: f.t.users.supervisor, parentId: f.t.ids.task }),
  },
  'POST /projects/:id/tasks/batch': { body: (f) => ({ changes: [{ id: f.t.ids.task, version: 0, durationDays: 3 }] }) },
  'POST /projects/:id/dependencies': { body: (f) => ({ predecessorId: f.t.ids.task2, successorId: f.t.ids.task }) },
  'POST /projects/:id/tasks/bulk': { body: (f) => ({ ids: [f.t.ids.task], versions: { [f.t.ids.task!]: 0 }, patch: { status: 'DONE' } }) },
  'POST /projects/:id/tasks/bulk-archive': { body: (f) => ({ ids: [f.t.ids.task2], versions: { [f.t.ids.task2!]: 0 } }) },
  'POST /projects/:id/tasks/restore': { body: (f) => ({ ids: [f.t.ids.task] }) },
  'POST /projects/:id/save-as-template': { body: () => ({ name: 'قالب العزل' }) },
  'GET /projects/:id/labels': {},
  'POST /projects/:id/labels': { body: () => ({ name: 'وسم العزل', color: '#5030E5' }) },
  'GET /projects/:id/custom-fields': {},
  'POST /projects/:id/custom-fields': { body: () => ({ name: 'حقل العزل', type: 'TEXT' }) },
  'GET /projects/:id/budget': {},
  'GET /projects/:id/dashboard': {},
  'GET /projects/:id/people': {},
  'GET /projects/:id/calendar': { query: () => ({ from: '2026-10-01', to: '2026-10-31' }) },
  'GET /project-templates': {},
  // A12 round 2 — participants and the cover image
  'GET /me/participations': {},
  'GET /projects/:id/participants': {},
  // A12 round 3 — the participant picker: B's project → 404; B names in `q` find nothing
  'GET /projects/:id/participant-candidates': { query: (f) => ({ q: `${f.t.tag}` }) },
  'POST /projects/:id/participants': { body: (f) => ({ userId: f.t.users.supervisor, title: 'منصب العزل', level: 'VIEWER' }) },
  'PATCH /projects/:id/participants/:userId': { body: () => ({ level: 'EDITOR' }) },
  'DELETE /projects/:id/participants/:userId': {},
  'GET /projects/:id/cover-url': { positive: { reason: 'the fixture projects have no cover (404 for A too)' } },
  'DELETE /projects/:id/cover': {},
  'GET /tasks/mine': {},
  'GET /tasks/:id': {},
  'PATCH /tasks/:id': { body: (f) => ({ version: 0, name: 'اسم جديد', assigneeId: f.t.users.supervisor, parentId: f.t.ids.task2 }) },
  'DELETE /tasks/:id': {},
  'GET /tasks/:id/activity': {},
  'GET /tasks/:id/comments': {},
  'POST /tasks/:id/comments': { body: (f) => ({ body: 'تعليق العزل', mentions: [f.t.users.admin], replyToId: f.t.ids.comment }) },
  'POST /tasks/:id/comments/read': { allow2xx: 'marks the CALLER’s read state of a task it can see' },
  'GET /tasks/:id/attachments': {},
  'POST /tasks/:id/attachments': { body: (f) => ({ fileId: f.t.ids.taskFile }) },
  'GET /tasks/:id/attachments/:fileId/url': {},
  'DELETE /tasks/:id/attachments/:fileId': {},
  'GET /tasks/:id/checklist': {},
  'POST /tasks/:id/checklist': { body: () => ({ text: 'بند العزل' }) },
  'POST /tasks/:id/checklist/reorder': { body: (f) => ({ ids: [f.t.ids.checklistItem] }) },
  'PATCH /tasks/:id/checklist/:itemId': { body: () => ({ done: true }) },
  'DELETE /tasks/:id/checklist/:itemId': {},
  'POST /tasks/:id/duplicate': { body: () => ({ withSubtasks: true }) },
  'GET /tasks/:id/labels': {},
  'POST /tasks/:id/labels': { body: (f) => ({ labelId: f.t.ids.label }) },
  'DELETE /tasks/:id/labels/:labelId': { allow2xx: 'idempotent unlink: the pair (A task, B label) does not exist in A, nothing is deleted' },
  'GET /tasks/:id/custom-fields': {},
  'PUT /tasks/:id/custom-values/:fieldId': { body: () => ({ value: 'قيمة العزل' }) },
  'GET /tasks/:id/time-entries': {},
  'POST /tasks/:id/time-entries': { body: (f) => ({ date: today, minutes: 30, userId: f.t.users.supervisor }) },
  'PATCH /time-entries/:id': { body: () => ({ minutes: 45 }) },
  'DELETE /time-entries/:id': {},
  'PATCH /labels/:id': { body: () => ({ name: 'اسم جديد' }) },
  'DELETE /labels/:id': {},
  'PATCH /custom-fields/:id': { body: () => ({ name: 'اسم جديد' }) },
  'DELETE /custom-fields/:id': {},
  'DELETE /dependencies/:id': {},
  'GET /calendars': {},
  'GET /calendars/:id': {},
  'POST /calendars': { body: () => ({ name: 'تقويم العزل' }), allow2xx: 'creates a calendar in the CALLER’s workspace (no B id involved)' },
  'PATCH /calendars/:id': { body: () => ({ name: 'اسم جديد' }) },
  'POST /calendars/:id/exceptions': { body: () => ({ date: '2026-12-25', name: 'عطلة العزل' }) },
  'DELETE /calendars/:id/exceptions/:exId': {},
  'GET /portfolios': {},
  'GET /portfolios/:id': {},
  'POST /portfolios': { body: (f) => ({ name: 'محفظة العزل', projectIds: [f.t.ids.project] }) },
  'PATCH /portfolios/:id': { body: (f) => ({ name: 'اسم جديد', projectIds: [f.t.ids.project] }) },
  'DELETE /portfolios/:id': {},
  'POST /portfolios/:id/projects': { body: (f) => ({ projectId: f.t.ids.project }) },
  'DELETE /portfolios/:id/projects/:projectId': { allow2xx: 'idempotent unlink: the pair (A portfolio, B project) does not exist in A, nothing is deleted' },
  'GET /me/view-prefs': { query: (f) => ({ projectId: f.t.ids.project }) },
  'PUT /me/view-prefs': { body: (f) => ({ projectId: f.t.ids.project, key: 'columns', value: { x: 1 } }) },
  'DELETE /me/view-prefs': { query: (f) => ({ projectId: f.t.ids.project, key: 'columns' }), allow2xx: 'deletes the CALLER’s own preference rows only (none for a B project)' },
  'GET /me/time-entries': { query: () => ({ from: '2026-09-01', to: '2026-11-30' }) },
  'GET /reports/projects': { query: (f) => ({ projectIds: f.t.ids.project! }) },
  'GET /workload': { query: (f) => ({ from: '2026-10-01', to: '2026-10-31', userIds: f.t.users.supervisor }) },
  'GET /hub': { query: (f) => ({ projectId: f.t.ids.project!, q: f.t.tag }) },
  'GET /attachments': { query: (f) => ({ projectId: f.t.ids.project!, uploadedBy: f.t.users.admin }) },
  'POST /projects/import': { body: (f) => ({ fileId: f.t.ids.importFile, format: 'csv' }) },
  'POST /projects/import/jira': { skip: 'reads an external Jira site into a preview of the CALLER’s workspace; no workspace id is accepted (needs network)' },
  'POST /projects/import/commit': { body: (f) => ({ previewId: f.t.ids.importPreview }) },

  // ─────────────────────────────── violations
  'POST /violations': {
    body: (f) => ({
      clientUuid: randomUUID(),
      memberId: f.t.ids.member,
      typeId: f.t.ids.violationType,
      description: 'مخالفة العزل',
      latitude: 24.7,
      longitude: 46.7,
      accuracyM: 5,
      capturedAt: new Date().toISOString(),
      expectedEvidencePhotos: 1,
    }),
  },
  'GET /violations': { query: (f) => ({ teamId: f.t.ids.team!, memberId: f.t.ids.member! }) },
  'GET /violations/mine': {},
  'GET /violations/roster': {},
  'GET /violations/stats': { query: (f) => ({ teamId: f.t.ids.team! }) },
  'GET /violations/export.xlsx': { query: (f) => ({ recordedBy: f.t.users.monitor }) },
  'GET /violations/dashboard.pdf': {},
  'GET /violations/:id': {},
  'PATCH /violations/:id': { body: (f) => ({ description: 'وصف جديد', typeId: f.t.ids.violationType }) },
  'POST /violations/:id/status': { body: () => ({ status: 'UNDER_REVIEW' }) },
  'POST /violations/:id/assign': { body: (f) => ({ memberId: f.t.ids.member }) },
  'POST /violations/:id/unassign': { body: () => ({}) },
  'POST /violations/:id/register-member': { body: (f) => ({ fullName: 'عامل العزل', nationalId: nid(), teamId: f.t.ids.team }) },
  'POST /violations/:id/responses': { body: () => ({ body: 'رد العزل' }) },
  'GET /violations/:id/files/:fileId/url': {},
  'GET /violations/:id/ocr': {},
  'POST /violations/:id/ocr/retry': {},
  'GET /violation-types': {},
  'POST /violation-types': { body: () => ({ name: `نوع العزل ${randomUUID().slice(0, 6)}` }), allow2xx: 'creates a type in the CALLER’s workspace (no B id involved)' },
  'PATCH /violation-types/:id': { body: () => ({ name: 'اسم جديد' }) },

  // ─────────────────────────────── cards, logos, files
  'GET /cards/sizes': {},
  'POST /cards/sizes': { body: () => ({ name: `مقاس ${randomUUID().slice(0, 6)}`, widthMm: 80, heightMm: 50 }), allow2xx: 'creates a size in the CALLER’s workspace (no B id involved)' },
  'DELETE /cards/sizes/:id': {},
  'GET /cards/templates': {},
  'POST /cards/templates': {
    body: (f) => ({ name: 'قالب العزل', sizeId: f.t.ids.cardSize, orientation: 'LANDSCAPE', layoutKey: 'CLASSIC_HORIZONTAL', config: {}, logoId: f.t.ids.logo }),
  },
  'PATCH /cards/templates/:id': { body: () => ({ name: 'اسم جديد' }) },
  'DELETE /cards/templates/:id': {},
  'POST /cards/preview': { body: (f) => ({ templateId: f.t.ids.cardTemplate, teamIds: [f.t.ids.team], memberIds: [f.t.ids.member] }) },
  'POST /cards/batches': {
    body: (f) => ({
      idempotencyKey: randomUUID(),
      templateId: f.t.ids.cardTemplate,
      items: [{ memberId: f.t.ids.member, data: { fullName: 'x' } }, { userId: f.t.users.supervisor, data: { fullName: 'y' } }],
    }),
    extra: [
      {
        label: 'A template, B member',
        body: (f) => ({ idempotencyKey: randomUUID(), templateId: f.A.ids.cardTemplate, items: [{ memberId: f.t.ids.member, data: { fullName: 'x' } }] }),
      },
    ],
  },
  'GET /cards/batches': {},
  'GET /cards/batches/:id': {},
  'GET /cards/batches/:id/pdf': {},
  'GET /logos': {},
  'POST /logos': { body: (f) => ({ name: 'شعار العزل', fileId: f.t.ids.logoFile }) },
  'POST /logos/:id/default': {},
  'DELETE /logos/:id': {},
  'POST /files/presign': {
    body: (f) => ({ entityType: 'task', entityId: f.t.ids.task, kind: 'ATTACHMENT', contentType: 'application/pdf', sizeBytes: 100 }),
    extra: [
      { label: 'violation photo', body: (f) => ({ entityType: 'violation', entityId: f.t.ids.violation, kind: 'EVIDENCE', contentType: 'image/jpeg', sizeBytes: 100 }) },
      { label: 'member photo', body: (f) => ({ entityType: 'member_photo', entityId: f.t.ids.member, kind: 'PHOTO', contentType: 'image/png', sizeBytes: 100 }) },
      { label: 'user photo', body: (f) => ({ entityType: 'user_photo', entityId: f.t.users.supervisor, kind: 'PHOTO', contentType: 'image/png', sizeBytes: 100 }) },
      { label: 'project cover', body: (f) => ({ entityType: 'project_cover', entityId: f.t.ids.project, contentType: 'image/png', sizeBytes: 100 }) },
    ],
  },
  'POST /files/:id/confirm': {},
  'GET /files/:id/url': {},

  // ─────────────────────────────── platform
  'GET /notifications': {},
  'GET /notifications/unread-count': {},
  'POST /notifications/:id/read': { allow2xx: 'updateMany of the CALLER’s own notifications: a B id matches nothing' },
  'POST /notifications/read-all': { allow2xx: 'the CALLER’s own notifications only' },
  'GET /audit': { query: (f) => ({ entityId: f.t.ids.team!, actorId: f.t.users.admin }) },
  'GET /settings': {},
  'PATCH /settings': { body: () => ({ VIOLATION_MAX_PHOTOS: 7 }), allow2xx: 'updates the CALLER’s workspace settings (no B id involved)' },
};
