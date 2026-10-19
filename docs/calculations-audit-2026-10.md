# مراجعة الحسابات والمنطق — أكتوبر 2026

> Read-only audit of every computation the owner listed. No code was changed. Each finding was
> reproduced with a throwaway script, bundled with esbuild from the real sources and run in node.
> Scripts: `%TEMP%\claude\…\scratchpad\audit\{eng,imp,par,stale,bb,night}.ts`.
> Findings marked "to verify" are design questions, not confirmed bugs.

## حالة الاختبارات (2026-10-19)

| Suite | Result |
|---|---|
| packages/shared (vitest) | 5 files, **69 passed** |
| packages/scheduling (vitest) | 5 files, **96 passed** (perf: 2,000 tasks, cold 7.3 ms) |
| packages/ui-print (vitest) | 1 file, **138 passed** |
| apps/api (jest) | 41 suites, **512 passed** |
| apps/web (vitest) | 36 files, **392 passed**. The other agent's in-progress import/wizard files did not break it. |

All suites pass, yet the findings below are real. The tests do not cover these cases.

---

## الملخّص

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| H1 | High | A group's status is never derived. A group at 100 % still shows «لم تبدأ». Status and progress are also decoupled on leaves. | `apps/api/src/projects/task-engine.ts:314`, `apps/web/src/features/projects/engine.ts:251`, `ListView.tsx:416-421` | Fixed (server) · Pending web port |
| H2 | High | A group left with no children keeps its old rolled-up cost, progress and dates. Budget totals and project progress then count money from archived tasks. | `task-engine.ts:376` (API) and `engine.ts:312` (web), `packages/scheduling/src/model.ts:159` | Fixed (server) · Pending web port |
| M1 | Medium | In HOUR projects, project progress and person progress are weighted by touched days, not by minutes. They disagree with the engine (50 % vs 12.5 %). | `task-engine.ts:433-448`, `project-dto.ts:238`, `reports.ts:162` | Fixed (server) · Pending web port |
| M2 | Medium | Demo and API handle HOUR date edits differently: a bare `endDate`, the field priority, and truncation of `durationDays`. | `web/.../projects/engine.ts:156-167` vs `api/.../task-engine.ts:199-207` | Fixed (server: rules shared in `@nuzli/scheduling`) · Pending web port |
| M3 | Medium | Demo `rescheduleProject` in HOUR projects leaves starts in non-working time. The API snaps them. | `web/.../engine.ts:131` via `demo/phase4.ts:514`; API `task-engine.ts:183` via `project-store.ts:406` | Fixed (server: rule shared) · Pending web port |
| M4 | Medium | The workload UI ignores the API's per-day `capacityMinutes` (holidays, short days). Utilisation counts holidays as capacity. The demo does not send the field at all. | `features/workload/WorkloadGrid.tsx:34,104`, `math.ts:129-148`, `features/projects/reports.ts:340,366` | Fixed (server: `totalCapacityMinutes`) · Pending web port |
| M5 | Medium | 27 Arabic count strings have no plural forms, so they produce «أُعيدت جدولة ٥ مهمة», «٥ يوم», «٥ ساعة» and «(١ مهام)». | `i18n/ar.ts` (list below), `Gantt.tsx:1024-1025`, `TaskDrawer.tsx:213`… | Pending web port |
| L1 | Low | The Gantt overdue label uses the wrong plural for 103–110 days and disagrees with the dashboard. | `features/gantt/Gantt.tsx:1617` | Pending web port |
| L2 | Low | `hijriSpan` drops the first year when a range crosses a Hijri year: «ذو الحجة – محرم 1448». | `features/calendar/calendarFormat.ts:51-58` | Pending web port |
| L3 | Low | `formatDate` on an HOUR local string depends on the device time zone (shows the 23rd instead of the 22nd). The list view is not HOUR-aware. | `ListView.tsx:385-405`, `BoardView.tsx:207` | Pending web port |
| L4 | Low | Demo `bbox` with south > north matches nothing. The API normalises it. | `features/violations/stats.ts:40-45` | Pending web port |
| L5 | Low | Offset pagination has no unique tiebreaker, so pages can repeat or skip rows. `topMembers` ties at the LIMIT are not deterministic. | `members.service.ts:86`, `users.service.ts:88`, `notifications.service.ts:196`, `audit.service.ts:243`, `print.service.ts:488`, `violation-stats.ts:76-80` | Fixed (server) |
| L6 | Low | A calendar that ends at 24:00 makes `endDate.slice(0,10)` one day later than the DATE column, so the overdue rules disagree. | `task-engine.ts:469` (+ web `engine.ts:393`, `reports.ts` slices) | Fixed (server) · Pending web port |
| L7 | Low | HOUR→DAY lag rounding is asymmetric: +4 h becomes 1 d but −4 h becomes 0 d. | `packages/scheduling/src/convert.ts:97`, `imports/import-model.ts:578` | Fixed (server + engine) · Pending web port (demo importer) |
| L8 | Low | Import parser edge cases: 24:00 becomes 23:00, `Z` and offsets are dropped, Excel serial ≤ 60 is off by one, "edays" is not parsed, MSPDI elapsed lags are treated as working minutes. | `imports/import-model.ts:214,225,261,291`, `mspdi.ts:273` | Fixed (server) · Pending web port (demo importer) |
| L9 | Low | The 2.25″ × 1.25″ label is 57 × 32 mm instead of 57.15 × 31.75 mm, which can overflow the label stock. | `packages/ui-print/src/sizes.ts:24` | Fixed (ui-print + seed + migration) |
| L10 | Low | Reminders: the cron includes groups (and the API deadline sweep too, while the demo checks leaves only). An HOUR time change on the same day resets reminders and sends them again. | `task-due.service.ts:49-54,96-105`, `project-store.ts:350-353` | Fixed (server) · Pending web port (demo reset rule) |
| L11 | Low | The «حسب الوسم» budget view counts a task once per label, so the bars add up to more than the total. The schema documents this; the UI does not explain it. | `features/reports/BudgetSection.tsx:121` | Fixed (server: `byLabelOverlapping`/`byLabelNote`) · Pending web port (show the note) |
| L12 | Low | Workload "logged" includes archived tasks and projects while "assigned" excludes them. | `project-reports.service.ts:198-201` | Fixed (server) |
| L13 | Low | The edit-window boundary differs: the API is closed at `now >= until`, the demo at `now > until`. | `violations.service.ts:415` vs `demo/phase3.ts:845` | Fixed (server: shared `isEditWindowOpen`) · Pending web port |

---

## High

### H1 — حالة المجموعة لا تُشتقّ: مجموعةٌ 100٪ تظهر «لم تبدأ»

**Where:** `apps/api/src/projects/task-engine.ts:314` (`recompute`) and its port `apps/web/src/features/projects/engine.ts:251`. Display: `apps/web/src/pages/projects/ListView.tsx:416-421`, where a group's status is read-only and shows the stored value.

**What happens:** `rollUp` and `recompute` update a group's dates, duration, progress and costs, but never its `status`. A group keeps the status it was created with (`NOT_STARTED`). Only the import pipeline derives it, once, at `imports/import-model.ts:607`. Status and progress are not coupled on leaves either:
- A board move to «منجزة» sends only `status`, so the card is DONE while progress stays at 30 %.
- A task set to 100 % with status `IN_PROGRESS` is still counted as overdue (`dueFlags` checks `status !== 'DONE'`) and as "not done" in the KPIs.

**Repro (`par.ts`, run against both API and web engines):**
```
group g (status NOT_STARTED), children a,b both progress 100 / DONE
→ API group progress 100 status NOT_STARTED
→ WEB group progress 100 status NOT_STARTED   (expected: DONE)
```

**Fix:** add the same derivation the importer uses, applied to every task that has children in `recompute` (API and web). Run it after `schedule()`, next to `rollUpCosts`:
```ts
// children statuses → group status
all children DONE → 'DONE'; all ON_HOLD → 'ON_HOLD';
any child IN_PROGRESS/DONE or rolled progress > 0 → 'IN_PROGRESS'; else 'NOT_STARTED'
```
Iterate bottom-up, because children may be groups. Add `status` to the group's versioned diff. For leaves, choose one rule and enforce it in `applyScheduleEdit`/the update path, in both the API and the demo. Recommended rule: `progress === 100 ⇒ status DONE` and `status DONE ⇒ progress 100`. A softer alternative is a confirm dialog in the drawer and board.

### H2 — مجموعةٌ بلا أبناء تحتفظ بتكلفتها وتقدّمها القديمين

**Where:** `rollUpCosts` has an early return, `if (!children.has(t.id)) return t;`, at `apps/api/src/projects/task-engine.ts:376` and `apps/web/src/features/projects/engine.ts:312`. The engine's `rollUpModel` has `if (!m.summary[g]) continue;` at `packages/scheduling/src/model.ts:159`.

**What happens:** after the last child is archived (or moved out), `archiveIn` → `recompute` skips the now-childless GROUP. It keeps the sums of tasks that no longer exist. The UI does not allow editing a group's cost or progress (`!isGroup`), so the stale values cannot be corrected. `leavesOf` then treats that group as a leaf.

**Repro (`stale.ts`):**
```
g{a: planned 100 / actual 150 / 100 %, b: planned 200 / 0 %}, c root planned 50
archive a and b →
  g: plannedCost 300, actualCost 150, progress 66.67   (expected 0 / 0 / 0)
  buildBudgetReport → planned 350, actual 150           (expected 50 / 0)
  buildPeople (excludes GROUP) → planned 50              (the two screens disagree)
  projectProgress(roots) → 50                            (expected 0)
```

**Fix:** in `rollUpCosts` (API and web), give a task with `type === 'GROUP'` and no live children `plannedCost = actualCost = 0`. In `recompute`, also reset such a group's `progress` to 0 and keep `start = end` (or demote it to TASK; decide in an ADR). Add a test: archive all children → group totals are 0.

---

## Medium

### M1 — تقدّم المشروع في مشاريع الساعات مرجَّحٌ بالأيام لا بالدقائق

**Where:** `projectProgress` at `apps/api/src/projects/task-engine.ts:433-448` (copy: web `engine.ts:358`). It is used for the project (`project-dto.ts:238`), the person (`reports.ts:162`) and the portfolio. It weights by `durationDays`. In HOUR projects, `durationDays` is the number of *touched working days*, while the engine weights groups by working minutes.

**Repro (`par.ts`):** roots A = 1 h at 100 % and B = 7 h at 0 %, on the same day.
`projectProgress` = **50**. The engine's group of the same two tasks = **12.5** (the correct duration-weighted value).

**Fix:** pass the unit to `projectProgress`, and in HOUR projects use `durationHours` (minutes) as the weight: `w = type==='MILESTONE' ? 0 : (unit==='HOUR' ? durationHours ?? 0 : durationDays)`. `ProjectStats.roots` must then select `durationMinutes` too (`project-store.ts:126-130`). Apply the same change to the people tab and to the demo.

### M2 — العرض التجريبي يخالف الخادم في تعديل تواريخ مشاريع الساعات

**Where:** web `features/projects/engine.ts:156-167` vs API `task-engine.ts:199-207`.

| Edit (task Sun 09:00, 4 h) | API | Demo |
|---|---|---|
| `{endDate:'2026-10-20'}` (bare date) | ends 20th 18:00, **24 h** (bare date = end of that day, `coerceEndLocal`) | ends 19th 18:00, **16 h** (`asLocal` = midnight start of the day) |
| `{endDate:'2026-10-20', durationDays:1}` | `durationDays` wins → 8 h | `endDate` wins → 16 h |
| `{durationDays:1.5}` | `trunc` → 8 h | 12 h |

**Fix:** port the API functions as they are (`coerceEndLocal`, `applyScheduleEditHours`, with `durationHours > durationDays > endDate` and `Math.trunc`) into the web engine. Add a parity test that runs both engines on the same table of inputs.

### M3 — إعادة الجدولة الكاملة في العرض تترك بدايات الساعات في وقتٍ غير عامل

**Where:** `rescheduleProject` calls `normalizeLeaf(t, cal, false, unit)` in both the API (`project-store.ts:406`) and the demo (`demo/phase4.ts:514`). The API's HOUR branch always snaps (`task-engine.ts:183`). The web branch snaps only when `snapStart || date-only` (`web engine.ts:131`).

**Repro:** start `2026-10-23T10:00` (a Friday) with `snapStart=false` → API `2026-10-25T09:00`, demo `2026-10-23T10:00`. For example, after a holiday is added on a task's start day, the demo bar starts on the holiday.

**Fix:** make the web HOUR branch always call `cal.nextWorkingMinute(asLocal(t.startDate))`, like the API.

> Related, to verify: in DAY projects both sides keep a start that falls on a newly added holiday (by design, the "snap only edited tasks" rule). The bar then begins on the holiday.

### M4 — عبء العمل: السعة اليومية الحقيقية مُهمَلة في الواجهة

**Where:** `apps/web/src/features/workload/WorkloadGrid.tsx:34,104` uses a single `data.capacityMinutesPerDay` (480) for every cell. `personTotals` (`math.ts:129-148`) computes capacity as days that are not weekend × 480, so it counts **holidays** as capacity and ignores short days. The API already sends `days[].capacityMinutes` (`reports.ts:335`), which is 0 on holidays and the real minutes on a short day. The demo port (`features/projects/reports.ts:340,366`) omits `capacityMinutes`.

**Repro (by reading the code):** a person with 8 h assigned on a default-calendar holiday shows «ممتلئ» and is not flagged as over capacity. With the API's per-day capacity of 0, `loadLevel` would return `over`. Utilisation over a week that contains a holiday is computed against 5 × 480 instead of 4 × 480.

**Fix:** `const cap = day?.capacityMinutes ?? data.capacityMinutesPerDay` per cell. `personTotals` should sum `d.capacityMinutes` when present. The demo `computeWorkload` should accept a `capacity` calendar like the API and emit `capacityMinutes`.

### M5 — مطابقة العدد والمعدود: «٩ مهمة»

The rule exists (`tCount` with `.few/.many` keys), but these 27 keys have no plural variants and are called with plain `t()`. A count of 3–10 therefore produces the singular (or, for keys written in the plural, «١ مهام»).
`gantt.dragTip`, `gantt.linkAdded`, `task.savedShifted` (TaskDrawer.tsx:213), `task.archived`, `grid.deleted` (ProjectPage.tsx:559), `grid.duplicated` «({count} مهام)», `bulk.done`, `bulk.archiveBody`, `a9c.moreAria` «{n} مهام», `hub.unreadAria`/`hub.commentsAria` «{n} تعليقات», `vlist.lead`, `shell.logoutUnsyncedBody`, `shell.logoutWipe`, `shell.syncPendingAria` «{n} مخالفة», `duration.hours` «{n} ساعة» and `duration.days` «{n} يوم» (Gantt.tsx:1024-1025: «٥ يوم»), `bar.overdueHours`, `teams.createWithMembers`, `import.commit`, `import.committed`, `formation.confirm`, `formation.confirmBody`, `formation.moved`, `formation.dragMany`, `record.roster.updated`, `import.preview.holidays`.

**Fix:** add `.one/.two/.few/.many` variants and call `tCount(key, n)`. Note that several call sites pass `formatNumber(n)`, a string, as `count`, so `Intl.PluralRules` cannot read it. Pass the number and let `interpolate` format it. Extend `scripts/check-i18n.mjs` to fail on `{n|count} <noun>` without variants (the detection regex used here is in the audit notes).

---

## Low

- **L1** `overdueLabel` (`Gantt.tsx:1617`) treats only 3–10 as "few". CLDR, and the dashboard's `pluralKey` (`n % 100 ∈ 3..10`), also treat 103–110 as "few". For 103 the Gantt shows «متأخرة ١٠٣ يومًا» and the dashboard shows «… أيام». **Fix:** reuse `pluralKey`/`tCount`.
- **L2** `hijriSpan` returns «ذو الحجة – محرم 1448 هـ» for 2026-05-20…06-20 (ذو الحجة 1447 → محرم 1448). **Fix:** when the years differ, return `${a} – ${b}`. Keep the short form only when the years are the same.
- **L3** `formatDate('2026-10-22T18:00')` parses the string as *device-local* time. On a device in New York it displays «23 أكتوبر», and in London «22:30» becomes the 23rd. Used at `ListView.tsx:388,405` and `BoardView.tsx:207`; other screens slice to the date first. **Fix:** `formatDate(x.slice(0,10))`, or parse with `+03:00`. The list view is also not HOUR-aware:
  - `type="date"` inputs receive a date-time value, so they show empty.
  - The «المدة» column shows/edits `durationDays`; changing it from 1 to 2 turns a 4 h task into 16 h.

  Use `durationHours` and `datetime-local` in HOUR projects, as the drawer does.
- **L4** Demo `parseBbox` does not order south and north. With bbox `25,46,24,47`, the API matches a point at lat 24.7 and the demo returns nothing (`bb.ts`). **Fix:** use the same `Math.min`/`Math.max` as `violation-scope.ts:57-60`.
- **L5** `parseSort` and fixed sorts on non-unique columns (`fullName`, `createdAt`, `at`, `printedAt`) combined with `skip/take` are unstable on ties. Violations already add `{ id: 'asc' }`. **Fix:** append `{ id: 'asc' }` everywhere, and add `, v.member_id` to the inner `ORDER BY` of `topMembers` (the demo breaks ties by name).
- **L6** With working hours 16:00–24:00, an 8 h task ends `…23T00:00`. The DATE column (`endDayOfLocal`) is the 22nd, but `dueFlags` uses `endDate.slice(0,10)`, which is the 23rd. On the 23rd the cron sends TASK_OVERDUE while the UI/KPI still says "due soon" (`night.ts`). **Fix:** use `endDayOfLocal(start, end)` in `dueFlags`, `buildDashboard`, `plannedByWeek`, `minutesOnDay` and Gantt `overdueDays`.
- **L7** `Math.round(-0.5) === -0` gives `dependenciesToDays(-4h) = 0` but `(+4h) = 1`. The same happens in the import (`import-model.ts:578`). **Fix:** `Math.sign(x) * Math.round(Math.abs(x))`.
- **L8** Imports (`imp.ts`):
  - `'2026-10-19 24:00'` becomes `T23:00`; it should be the next day at `00:00`.
  - ISO text with `Z`/`+hh:mm` is read as Riyadh wall time, so the zone is lost (3 h shift).
  - `fromExcelSerial(1..60)` is one day early (1900 leap bug).
  - `'2 edays'` returns null.
  - MSPDI `LagFormat` 8/10/12 (elapsed) is converted as working minutes, so 1 elapsed day becomes 3 working days.
  - `'1.234,50'` becomes `null`, so the money becomes 0.

  The real files tested parse correctly; these are edge cases.
- **L9** 2.25″ × 1.25″ is 57.15 × 31.75 mm, but the size is defined as 57 × 32. On continuous label stock a page 0.25 mm taller than the label can drift or feed an extra label. **Fix:** use the exact values.
- **L10** The `task-due.service.ts` overdue and due-soon queries do not filter `type` (a TASK promoted to GROUP keeps its `assigneeId`), and the deadline sweep includes groups. The demo restricts the deadline sweep to leaves (`phase4.ts:1800`). An HOUR edit that only moves the end time within the same day resets `dueSoonNotifiedAt`, so the reminder is sent again. **Fix:** add `type: { not: 'GROUP' }`, and reset only when the end *day* changes.
- **L11** `byLabel` counts a task under each of its labels. This is documented at `projects-a9.ts:343`, but the chart has no hint and its bars add up to more than the total. **Fix:** add a footnote «المهمة ذات أكثر من وسم تُحسب تحت كلٍّ منها».
- **L12** `workload` time entries are filtered by user and date only, so they include archived tasks and projects. Assigned minutes exclude them. **Fix:** add `task: { archivedAt: null, project: { archivedAt: null, isTemplate: false } }`.
- **L13** At exactly `editableUntil`, the API refuses the edit and the demo allows it. Use the same comparison in both (`>=`).

## To verify (design questions, not confirmed bugs)

> **Decided by the owner and done on the server (ADR-134, ADR-136).** Week KPI: compare with the same elapsed span of the previous week (`previousWeekToDate`, shared `weekChangePct`). Portfolio progress: weighted by duration (`progressWeightDays`). Per member: `perMemberRate` is null without members. Days overdue: calendar days (shared `calendarDaysOverdue`). The UI parts are pending the web port.

- The week KPI compares a *partial* current week with a *full* previous week. On a Monday this shows about −70 % by construction. Compare with the same weekday range of the previous week, or relabel the KPI.
- Portfolio progress is weighted by `leafCount`, while project progress is weighted by duration. The two scales are different.
- `perMember` returns 0 when a team has no members at the end of the period, although it has violations. The chart shows 0, not "n/a".
- `daysOverdue` counts calendar days (Gantt and dashboard agree; Thursday → Sunday = «٣ أيام»). This is consistent, but state it in the tooltip if working days were expected.

---

## ما تمّ التحقق من صحته (verified correct)

**Scheduling engine** (`eng.ts` plus the 96 existing tests):
- Thu + 1 working day = Sun. A Friday start snaps to Sunday. Sun–Thu = 5 days.
- FS lag 2 d (Thu end → Tue start) and lead −2 d (→ Wed).
- HOUR FS +1 h across the weekend (Thu 18:00 → Sun 10:00), and 4 h across lunch ending at 15:00.
- Overlapping and unsorted working intervals are merged (08–12 + 11–16 → 08–16 = 480 min).
- Special-hours exception: 2 h on a working Friday. A holiday is excluded.
- Nested-group roll-up: 83.33 % with a milestone weighing 0.
- DAY ↔ HOUR conversion round-trip, including a partial first and last day.
- Moving a group forward and backward keeps the gaps in working days. A resize onto Friday snaps back.
- WBS ordering. Cycle and hierarchy errors.

**Money:**
- Cents arithmetic. Groups are the sum of their children with no double counting of nested groups: `rollUpCosts` sums leaves recursively, and the reports use leaves only.
- `variance = planned − actual`. `budgetUsedPct = actual / budget` (2 dp; null without a budget or with budget 0).
- Over-budget flag, `remainingOf`, `usedTone` thresholds (> 90, > 100).
- `formatMoney` (max 2 dp, «ر.س»). Prisma Decimal → `Number` in `toStored` and `projectStats`.
- `plannedByWeek` spreads the cents exactly (the remainder cents go to the first days), with Sunday weeks.

**Progress:** duration-weighted, milestones weigh 0, plain average when all weights are 0 — identical in the engine, the API and the demo for DAY projects.

**Overdue and due soon:** Riyadh today = UTC + 3 with no DST. Overdue = end < today and not DONE. Due soon = end ≤ the second working day after today (from a Friday: Mon). Reminders are claimed with a conditional update (once each) and reset when the end or deadline changes, the same in the API and the demo.

**Violations statistics** (API SQL vs `computeViolationStats`):
- Sunday-start Riyadh weeks. This week and the previous week ignore the date filter.
- `byTeam` uses the snapshot team and members counted at the end of the period (`valid_from ≤ end < valid_to`), the same in the API and the demo.
- The heatmap uses DOW/hour `AT TIME ZONE 'Asia/Riyadh'`. The unassigned KPI is `member_id IS NULL`.
- Antimeridian bbox. Trend zero-fill with the 1100-day cap.
- Clock drift (shared `isClockDriftSuspect`). Register-window age and drift, the same in the API and the demo.
- Retention cut-off and batch skip. Presigned TTL taken from settings everywhere.

**Workload (server):** a DAY task counts its project calendar's minutes on each working day. An HOUR task counts only its minutes inside each day. Milestones and groups count 0. The 92-day cap is the same in the API, the demo and the UI.

**Imports:**
- DMY/MDY with automatic swap when the month is above 12. Arabic-Indic digits and ص/م.
- Durations: weeks = 5 d, months = 20 d, `PT16H30M` = 990 min.
- Predecessors `3FS+2d; 4SS-1 day; 7FF+3h; 1.2.3FS`. MSPDI `LinkLag` in tenths of a minute and Cost in hundredths.
- GanttPRO UTC → Riyadh (`21:30Z` → `00:30` the next day). The hours round-trip (2-dp hours recover whole minutes exactly).

**Validators and cards:**
- National ID Luhn variant; check digit verified against an independent implementation of the rule.
- Saudi mobile in 05/5/9665/009665/+9665 forms with Arabic digits.
- Mask «1•••••••23».
- `resolveCardDimensions` normalises long/short sides before the orientation swap. CR80, 4×2, 3×2 and 4×3 mm values are exact.

**Gantt and calendar:**
- RTL `x = width − logicalX`, so later dates are further left. Drag deltas carry the direction sign. Today = `riyadhToday()`.
- Calendar tab: Sunday-first month grid, 4–6 complete weeks; an HOUR end at 00:00 belongs to the previous day; lane packing; Hijri day labels formatted at UTC noon (device-independent).
- No browser-local `getDay`/`getDate` anywhere in the web source.

**Undo and redo:** the inverse batch uses the write's own `previous` and versions. Re-basing applies only to this user's own version moves, so a foreign edit still answers 409. On the server, a dated change to a group is ignored and the roll-up is recomputed.

**Pagination and badges:** the overdue badge equals `myTasks.filter(overdue)`, the same list the page shows. The unread notification count uses the same `where` as the unread list.

---

## الإصلاح — Fix status (2026-10-19, server side)

The server, `packages/scheduling`, `packages/shared` and `packages/ui-print` are fixed. ADR-133 to ADR-136 record the decisions. Each finding has a test that reproduces the audit's input:
- `packages/scheduling/src/audit-2026-10.test.ts`
- `packages/shared/src/calc-rules.test.ts`
- `apps/api/src/projects/calc-audit.spec.ts`
- `apps/api/src/imports/import-audit.spec.ts`
- additions to the violation stats, violations, task-due and pagination specs.

The migration `20261022000000_calc_audit_fixes` fixes existing rows. It was verified on PGlite.

### What the web demo must adopt (pending web port)

Import these functions from the packages instead of keeping copies.

**`@nuzli/scheduling`**

| Helper | Rule |
|---|---|
| `normalizeStatusProgress(status, progress)` | Leaf invariant: DONE ⇒ 100; ≥ 100 ⇒ DONE; NOT_STARTED with progress > 0 ⇒ IN_PROGRESS. |
| `syncStatusProgress(cur, { status?, progress? })` | Leaf edit; the changed field decides. Progress only: 100 ⇒ DONE; < 100 on DONE ⇒ IN_PROGRESS; > 0 on NOT_STARTED ⇒ IN_PROGRESS. Status only: DONE ⇒ 100; NOT_STARTED ⇒ 0; IN_PROGRESS/ON_HOLD from a task at 100 ⇒ 0. Both: as sent, then the invariant. |
| `deriveGroupStatus(children, rolledProgress)` | All DONE → DONE. Else any IN_PROGRESS/DONE child or progress > 0 → IN_PROGRESS. Else all non-DONE children ON_HOLD → ON_HOLD. Else NOT_STARTED. No children → NOT_STARTED. |
| `rollUpStatus(tasks)` | Run after `schedule`/`rollUp` and the cost roll-up, on every write. Leaves get the invariant. An empty GROUP gets progress 0, costs 0 and NOT_STARTED, with its dates kept. Groups get the derived status, bottom-up. |
| `weightedProgress(items, unit)` / `progressWeight` | Milestones and empty groups (`isEmptyGroup`) weigh 0. HOUR weighs by working minutes (`durationHours × 60`), DAY by `durationDays`. Plain average when every weight is 0. Rounded to 2 dp. Use it for project, person and portfolio progress. |
| `applyScheduleEdit`, `applyScheduleEditHours`, `normalizeLeaf`, `normalizeLeafHours`, `coerceStart`, `coerceEndLocal`, `MIN_TASK_MINUTES` | HOUR rules: the start is always snapped into working time, even with `snapStart = false`. Priority is `durationHours` > `durationDays` > `endDate`. `durationDays` is truncated to whole days × the standard day. A bare `endDate` = the end of that day's working time. The minimum is 15 min. |
| `dueDayOf(t)`, `endDayOfLocal`, `dueFlags(t, today, cal)`, `deadlinePassed` | The due day is the day of the last working minute (an end at 24:00 belongs to the day before). DONE is never overdue, due soon or past its deadline. |
| `roundHalfAway(x)` | Lag rounding in conversions and importers: ±0.5 → ±1, never −0. |
| `elapsedToWorkingMinutes(cal, from, elapsedMinutes)` | Converts elapsed lags and durations (`edays`, MSPDI LagFormat 4/6/8/10/12/36–44) to working time. |

The engine's `rollUp`/`schedule` already give an empty GROUP progress 0 and weight 0. The demo gets this automatically through the package.

**`@nuzli/shared`**

| Helper | Rule |
|---|---|
| `isEditWindowOpen(now, until)` | `now < until` (closed at exactly `editableUntil`). |
| `weekChangePct(thisWeek, previousWeekToDate)` | The week KPI change % (null without a base). |
| `perMemberRate(count, members)` | Null when the team has no members. |
| `calendarDaysOverdue(due, today)` | Calendar days. |
| Error `TASK_GROUP_STATUS_DERIVED` | Answered when someone tries to change a group's status. |

**New DTO fields (all optional and additive)**

| Field | Meaning |
|---|---|
| `BudgetReportDto.byLabelOverlapping`, `byLabelNote` | Show the note under «حسب الوسم». |
| `WorkloadDto.people[].totalCapacityMinutes` | Real capacity. Use `days[].capacityMinutes ?? capacityMinutesPerDay` per cell. |
| `ViolationStats.previousWeekToDate` | The previous week over the same elapsed span. |
| `ViolationStats.byTeam[].perMemberRate` | Null = "n/a". |
| `ProjectReportRow.progressWeightDays` | Portfolio weight. |

**Server behaviour the demo must mirror**
- `PATCH` of a group's status → `TASK_GROUP_STATUS_DERIVED`. Batch and bulk ignore status/progress for groups.
- Reminders skip groups. They are re-armed only when the due day changes.
- Workload "logged" excludes archived tasks and projects.
- Import parsers: `24:00` → next day 00:00. `Z`/offset → Riyadh. Excel serial < 61 gets +1 day. European `1.234,50`. Elapsed units.
- The group status from the file is no longer kept: it is derived.
