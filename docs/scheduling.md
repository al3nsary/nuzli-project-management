# محرّك الجدولة — `@nuzli/scheduling`

Pure TypeScript, with no runtime dependencies, no DOM and no database. The same code runs in the browser (instant feedback while dragging) and in the API (validation before persisting). It does not import `@nuzli/shared`: its input types (`ScheduleTask`, `ScheduleDependency`, `Calendar`) are minimal and **structurally compatible** with `TaskDto`, `DependencyDto` and `CalendarDto`. Every function is generic, so extra fields such as `name` and `version` pass through untouched.

## التواريخ

- Dates are `YYYY-MM-DD` strings. Internally they become integer **day numbers** (days since 1970-01-01 UTC). The engine never uses `Date` or local time, so timezones and daylight saving cannot shift a date.
- A trailing time part (`2026-10-11T…`) is tolerated, and only the literal date part is used.

## التقويم وأيام العمل

- `new WorkCalendar({ weekendDays, exceptions })`. The default weekend is `[5, 6]` (Friday and Saturday). An exception always beats the weekend rule: `isWorking: false` is a holiday and `isWorking: true` is a working override, for example a working Saturday.
- Exceptions are cached in a `Map`. A prefix table of cumulative working-day counts grows lazily. As a result, `workingDaysBetween` is O(1) and `addWorkingDays` is O(log n) for any distance.

| Function | Rule |
|---|---|
| `isWorkingDay(d)` | The exception first, then the weekend rule |
| `nextWorkingDay(d)` / `prevWorkingDay(d)` | The nearest working day strictly after or before `d` |
| `addWorkingDays(d, n)` | `n > 0` moves forward and `n < 0` moves back. `n = 0` returns `d` if it is a working day, otherwise the next working day. Thursday + 1 = Sunday |
| `workingDaysBetween(s, e)` | Counts working days in `[s, e]`, both ends included. Returns 0 when `e < s` |
| `endFromDuration(s, n)` | `n = 1` returns `s` itself (a non-working `s` first snaps forward). `n = 0` is a milestone and returns `s` |
| `durationFromRange(s, e)` | Same as `workingDaysBetween` |

Each method also has a day-number variant (`addWorkingDaysNum` …) used by the scheduler.

## الجدولة بالساعات (`durationUnit: 'HOUR'`)

لكلّ مشروعٍ وحدةُ جدولة: `DAY` (الافتراضية) أو `HOUR`. مشاريع الأيام لا يتغيّر فيها شيءٌ إطلاقًا: الدوالّ نفسها تُستدعى بالترتيب نفسه، ومخرجاتها مطابقةٌ بتًّا ببتّ لما قبل إضافة الساعات (اختبارات الأيام الستّون كما هي، ومقارنةٌ عشوائيّة بالمحرّك القديم على ١٬٥٠٠ حالة).

### ساعات العمل في التقويم

- `Calendar.workingHours`: فتراتُ يوم العمل العادي بصيغة `HH:MM`، والافتراضي `09:00–13:00` و`14:00–18:00` (ثماني ساعات، بينهما استراحة غداء). تُرتَّب الفترات وتُدمج المتداخلة، ويُقبل `24:00` نهايةً.
- الاستثناء يمكن أن يحمل `workingHours` خاصّةً بتاريخه: يومٌ قصير (رمضان مثلًا `08:00–12:00`) أو سبتُ عملٍ بساعاتٍ خاصّة. العطلة (`isWorking: false`) لا ساعات لها مهما كُتب فيها.
- عطلة نهاية الأسبوع (الجمعة والسبت افتراضيًّا) والعطل لا دقائق عمل فيها.
- `hoursPerDay(date)` و`workingMinutesOfDay(date)` و`workingIntervals(date)` تعطي ساعات أيّ يوم، و`standardMinutesPerDay` طولُ اليوم العادي (480).

### التواريخ والدقائق

- في مشاريع الساعات يكون `startDate` و`endDate` وقتًا محلّيًّا `YYYY-MM-DDTHH:MM` بتوقيت الرياض (UTC+3، بلا توقيتٍ صيفي)، ويُعامَل وقتًا جداريًّا مجرّدًا: يتحوّل داخليًّا إلى **رقم دقيقة** = رقم اليوم × 1440 + دقيقة اليوم (`toMinuteNumber` / `fromMinuteNumber`).
- تُقبل الثواني (وتُهمل) ولاحقة `+03:00` صراحةً. أمّا `Z` وأيّ إزاحةٍ أخرى فتُرفض بـ`RangeError`، حتى لا تُقرأ لحظةٌ بتوقيت غرينتش على أنّها وقتٌ محلّي.
- **البداية** أوّلُ دقيقة عمل، و**النهاية** اللحظةُ التي تلي آخر دقيقة عمل (حصريّة): مهمّةٌ من 09:00 مدّتها أربع ساعات تنتهي 13:00 لا 14:00. المدد كلّها على المجال نصف المفتوح `[بداية، نهاية)`.
- `durationHours` بالساعات العاملة، وتُقبل الكسور (الدقّة دقيقةٌ واحدة، والواجهة تعرض خطوات ربع ساعة). إن غابت استُنتجت من `[startDate, endDate)`. أمّا `durationDays` فتُشتقّ وتُكتب: عددُ أيّام العمل التي تلمسها المهمّة.
- التأخير `lagHours` بالساعات العاملة (سالبُه تقديم). إن غاب استُعمل `lagDays` × طول اليوم العادي.

| الدالّة | القاعدة |
|---|---|
| `isWorkingMinute(t)` | هل الدقيقة التي تبدأ عند `t` دقيقةُ عمل؟ 12:59 نعم، 13:00 لا |
| `nextWorkingMinute(t)` | `t` نفسها إن كانت دقيقة عمل، وإلّا بداية فترة العمل التالية (13:00 ← 14:00، الخميس 18:00 ← الأحد 09:00) |
| `addWorkingMinutes(t, n)` | `n > 0`: أقرب لحظةٍ بعدها `n` دقيقة عمل بالضبط (11:00 + 120 = 13:00). `n < 0`: أبعد لحظةٍ قبلها `|n|` دقيقة عمل (14:00 − 60 = 12:00). `n = 0`: تقريبٌ إلى الأمام |
| `workingMinutesBetween(a, b)` | دقائق العمل في `[a, b)`، وصفرٌ إن كانت `b ≤ a` |
| `endFromDurationMinutes(s, n)` | تُقرَّب `s` إلى الأمام إلى وقت العمل، ثم النهاية عند نهاية آخر دقيقة عمل. `n = 0` معلمٌ عند `s` نفسها |
| `prevWorkingEnd(t)` | تقريب نهايةٍ إلى الخلف: 13:30 ← 13:00 |

مثالٌ محسوب: مهمّةٌ من ست ساعات تبدأ الأحد 11:00 تأخذ 11:00–13:00 (ساعتان) ثم 14:00–18:00 (أربع)، فتنتهي **الأحد 18:00**. ولو كانت سبع ساعات لانتهت الإثنين 10:00، ولو بدأت الخميس لانتهت الأحد 10:00 متخطّيةً الجمعة والسبت.

### الجدولة والتجميع والتحريك

- `schedule({ …, durationUnit: 'HOUR' })` بالقواعد نفسها: `P —FS(lag)→ S` تعني أنّ S لا تبدأ قبل نهاية P زائد `lag` دقيقةَ عمل، ثم أقرب دقيقة عمل. سابقةٌ تنتهي 13:00 تبدأ لاحقتها 14:00، وتنتهي 18:00 فتبدأ لاحقتها صباح يوم العمل التالي. التحريك إلى الأمام فقط، والمعلم مدّته صفر ونهايته بدايته، والمجموعة اللاحقة تُزاح أوراقها بالعدد نفسه من دقائق العمل.
- `rollUp(tasks, calendar, 'HOUR')`: بداية المجموعة ونهايتها من أبنائها، و`durationHours` دقائق العمل بينهما، والإنجاز **موزونٌ بدقائق العمل** (مهمّة 8 ساعات منجزةٌ ومهمّة ساعتين لم تبدأ ← 80٪، بينما في الأيام ← 50٪).
- `moveTask` تقرّب البداية الجديدة إلى أقرب دقيقة عمل (13:30 ← 14:00) وتحفظ المدّة بالدقائق، وتحريك المجموعة بفرقٍ موقَّعٍ من دقائق العمل. `resizeTask` تقرّب النهاية إلى الخلف (13:30 ← 13:00) ولا تقلّ المدّة عن ربع ساعة.
- لحظتان متساويتان بصيغتين (`…T09:00:00` و`…T09:00`) لا تُعدّان تغييرًا.

### التحويل بين مشروع أيّام ومشروع ساعات

- `tasksToHours(tasks, calendar)`: البداية أوّل دقيقة عمل في يوم البداية، والنهاية نهاية آخر دقيقة عمل في يوم النهاية، و`durationHours` مجموع ساعات تلك الأيّام (اليوم القصير يُحسب بساعاته). المعلم عند أوّل دقيقة عمل في يومه.
- `tasksToDays(tasks, calendar)`: يوم أوّل دقيقة عمل ويوم آخر دقيقة عمل، واليوم الجزئي يُحسب يومًا كاملًا. التحويل ذهابًا وإيابًا يعيد مهامّ الأيّام كما كانت.
- `dependenciesToHours` / `dependenciesToDays`: التأخير × طول اليوم العادي، وبالعكس مع التقريب إلى أقرب يوم.
- مشروع أيّامٍ بلا معالم يُجدوَل بعد تحويله إلى ساعات على الأيّام نفسها تمامًا (مُختبَر). المعلم يختلف عمدًا: في الأيّام يشغل يومه فتبدأ لاحقته في اليوم التالي، وفي الساعات هو لحظةٌ فتبدأ لاحقته عندها.

### الأداء

جدول دقائق العمل التراكمي لكلّ يوم يُبنى كسولًا (لا يُبنى أصلًا في مشاريع الأيّام)، فيكون `workingMinutesBetween` O(1) و`addWorkingMinutes` O(log n) ببحثٍ ثنائي. اختبار الأداء بالساعات: ٢٬٠٠٠ مهمّة بمدد ربع ساعة إلى ست ساعات وتأخيرات بالساعات وعطلٍ وأيّامٍ بساعاتٍ خاصّة؛ على جهاز التطوير الجدولة الأولى نحو 8 ms ووسيط `moveTask` نحو 8 ms، والحدّ 50 ms.

## الهيكل والترقيم (WBS)

- `computeWbs(tasks)` returns `Map<id, '1.2.3'>`, built from `parentId`. Siblings are ordered by `sortOrder`, then by `id` when two are equal. A task whose parent is not in the list is treated as a root. A loop in `parentId` throws `HierarchyError`.
- All tree traversals are iterative, with no recursion, so depth 60 is tested, and so is depth 5,000.

## التجميع (Roll-up)

`rollUp(tasks, calendar)` applies to any task that has children, bottom-up:
- start = the earliest child start, and end = the latest child end;
- `durationDays` = the working days between them, both ends included;
- progress = the average weighted by duration in working days. Milestones weigh 0. If every weight is 0, it uses the plain average. The result is rounded to 2 decimals to match `Decimal(5,2)`.

## الاعتماديات والجدولة التلقائية

`schedule({ tasks, dependencies, calendar, autoSchedule, changed? })` returns `{ tasks, changedIds }`:

1. Roll up the groups.
2. If `autoSchedule` is on (the default), run a forward pass in topological order (Kahn's algorithm) over the FS dependencies and the hierarchy:
   - `P —FS(lag)→ S` means S starts **no earlier than** `addWorkingDays(P.end, 1 + lag)`. That is the working day after P ends, moved `lag` working days. A negative lag is a lead: `-1` lets S start on P's last day.
   - **Forward only:** a task moves only when the constraint is broken, and it is never pulled earlier. It keeps its duration in working days, and its end is recomputed. A milestone stays at duration 0 with end = start.
   - **A group as predecessor:** uses the group's end after roll-up, once its children are scheduled.
   - **A group as successor:** all of its leaf tasks move by the same number of working days, just enough for the group's start to meet the constraint. A leaf's own dependency can push it further.
   - `SS`, `FF` and `SF` are stored in the model but ignored for now. A dependency that references an unknown task is ignored.
   - `changed` (optional): only tasks downstream of the edited ones may move, so unrelated old violations are left as they are.
3. Roll up again. The result is the full list. Unchanged objects keep their identity, and `changedIds` lists the changed tasks in input order.

If `autoSchedule = false`, only the roll-up runs.

`moveTask(state, id, newStart)` and `resizeTask(state, id, newEnd)` apply the edit, call `schedule`, and return `changes`: the batch of changed tasks that the UI sends in one request (ADR-017).
- Moving onto a weekend snaps forward to the next working day. Moving a group moves its leaves by a signed working-day delta. A move earlier than the predecessors allow is pushed back by the constraint.
- Resizing to a weekend snaps the end back to the last working day, and the duration is never less than 1. A group or a milestone cannot be resized (`TaskEditError`).

## الدورات

- `detectCycle(deps, newDep?)` returns `null` or a closed path `['a','b','c','a']`. A self-dependency gives `['a','a']`. All four types count.
- `wouldCreateCycle(deps, pred, succ)` is used by the API to reject a dependency before saving it.
- `schedule` throws `CycleError` (with `code = 'DEPENDENCY_CYCLE'` and `path`) when there is a cycle among the FS dependencies. A dependency between a task and one of its ancestors is also a cycle. The engine's message is technical, and the API or UI turns `code` into an Arabic message.

## ملاحظة الاتجاه (RTL)

The engine is **direction-agnostic**: it deals only in dates and working days, never in pixels or sides. Right-to-left drawing is the Gantt component's job (ADR-016: `x = width − logicalX`). A "forward" move in the engine means later in time, whatever the direction the bar moves on screen.

## الأداء

The test `performance.test.ts` covers 2,000 tasks (200 groups and 1,800 leaves) with 1,799 FS dependencies and holidays. Delaying the first task pushes every task in the project. The local target is under 50 ms. With `CI=1` the limit is 150 ms, and `SCHEDULING_PERF_BUDGET_MS` can override it. Measured on the development machine: the first pass took about 7 ms and the median `moveTask` about 3 ms.
