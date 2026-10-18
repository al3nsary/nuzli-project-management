# A9 plan — GanttPRO parity, supervisors, teams, violations OCR, indigo identity

Spec: `PROMPT.md` §18 → "A9" section, and the verbatim request in `docs/brief/A9-request.md`.

## Key technical decisions (ADRs to be written by the agents that implement them)

| Topic | Decision |
|---|---|
| Hours | `packages/scheduling` gains hour granularity: a calendar has working-time intervals per working day (default 09:00–13:00, 14:00–18:00). Each project has `durationUnit: DAY \| HOUR`. Day projects keep today's behaviour bit-for-bit. Hour projects schedule in working minutes; dates on the wire become ISO date-times in Asia/Riyadh for HOUR projects only. |
| Budget | `tasks.planned_cost`, `tasks.actual_cost` (numeric(14,2), SAR), roll-up to groups and the project (sum), `projects.budget` (cap) → variance and % used. Reports: budget by group/assignee/label, planned vs actual. |
| Time log | `time_entries(task, user, date, minutes, note)`. «سجل وقتي» page. Feeds actual hours in reports and workload. |
| Labels / custom fields | `project_labels`, `task_labels`; `custom_fields(project, name, type, options)` + `task_custom_values` (jsonb per task). |
| Columns / views | `user_view_prefs(user, project, key, value jsonb)` for columns (order, width, hidden) and saved filter/group views. |
| Deadline / checklist / colour | `tasks.deadline`, `task_checklist_items`, `tasks.bar_color`. |
| Undo/redo | Client-side command stack of inverse batch operations, sent through the same batch endpoint with versions (a conflict ends the redo chain). |
| Templates / portfolios | `projects.is_template` (exists) + "create from template"; `portfolios(name)` + `portfolio_projects`. |
| Import / export | Excel, CSV, MS Project XML (MSPDI) parsed in TypeScript (API and browser). **.mpp** is a proprietary binary → a small `converter` service using **MPXJ** (Java) converts .mpp → MSPDI, then the same importer runs. Jira: REST import with a site URL + email + API token (never stored), and Jira CSV export import. Export: Excel, CSV, PDF, PNG, MSPDI XML. No AI creation. |
| Supervisors | Supervisors no longer see projects, the Gantt or the project list. Only «مهامي» with tasks assigned to them; each task opens a chat-style thread (the task comments) where they read and reply. |
| Communication hub | Every comment on every task, with per-user read state (`task_comment_reads`), filters: all · new comments · mentioned · assigned · created, plus project filter and search. |
| Attachments | Task attachments (exist) + a browse-all page with filters (project, type, uploader, date). |
| Multiple supervisors | `team_supervisors(team, user, is_primary, valid_from, valid_to)` with history; `teams.supervisor_id` stays as the primary for compatibility. Violation snapshot keeps the primary plus `supervisor_ids_snapshot uuid[]`. Scope checks use "leads the team" = any open row. |
| Worker foreman | `team_memberships.role: WORKER \| FOREMAN`, at most one FOREMAN per team (partial unique). Shown with a distinct badge; a member record only, no account, no actions. |
| Org structure | `org_units(id, parent_id, name, kind, sort)` tree + `org_positions(unit, title, holder: user \| member \| vacant, reports_to)`. A dedicated page with a tree and chart view, drag to reorganise. |
| Violations | `member_id` becomes nullable. Required photos: PERSON, EVIDENCE (≥1), ID_CARD. OCR of the ID card (tesseract.js with Arabic + English data, self-hosted) runs server-side after confirm; extracted fields (ID number validated by check digit, name, dates) are stored encrypted as suggestions. «إسناد المخالفة» (monitor or admin) links a member → the snapshot is resolved at `captured_at`. The demo runs the same OCR in the browser. |
| Identity | White, GanttPRO-clean surfaces. Primary **Nozoly indigo** `#303F9F` (hover `#283593`, pressed `#1A237E`, tint `#E8EAF6`, focus `#5C6BC0`). Team colours carry identity. Real logos stay as files. Login redesigned (logo size, placement, copy). |

## Order of work

| Round | Agent | Scope |
|---|---|---|
| 1 | engine | `packages/scheduling`: hour granularity |
| 1 | web-identity | `apps/web`: white + indigo identity, GanttPRO-like shell and left nav, login redesign |
| 1 | api-projects | `apps/api` + shared: budget, labels, custom fields, deadline, checklist, colour, duplicate, bulk, view prefs, templates, portfolios, time log, comms hub, attachments, supervisor scope |
| 2 | api-teams-violations | multiple supervisors, foreman, org structure, unknown-person violations, OCR |
| 2 | api-import-export | hours integration in the API, Excel/CSV/MSPDI/MPP (converter service)/Jira import, exports |
| 3 | web-projects | GanttPRO project page, tabs, toolbar, columns, labels, fields, budget, calendar, workload, people, dashboard, reports, time log, templates, portfolios, imports/exports |
| 3 | web-collab | supervisor «مهامي» chat, communication hub, attachments browser |
| 4 | web-teams-violations | multiple supervisors, foreman badge, org structure page, violation flow without a person + OCR + assign later |
| 5 | qa | item-by-item verification in the browser and against the API, fixes, report |
