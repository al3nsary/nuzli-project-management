# المرحلة 4 — الخادم: المشاريع والمهام ومخطط جانت

> آخر تحديث: 2026-10-12. يكمّل `docs/phase-3-backend.md`. القرارات في ADR-056 إلى ADR-060.

## ما بُني

| الوحدة | المسار | المحتوى |
|---|---|---|
| المحرّك على الخادم | `src/projects/task-engine.ts` | دوال نقية حول `@nuzli/scheduling`: إعادة حساب النهاية من البداية والمدة بأيام العمل، ونقل البداية الواقعة في عطلة إلى يوم العمل التالي، وتحويل المجموعة تلقائيًّا، و`recompute()` (الجدولة + التجميع + WBS)، والفرق بين المحمَّل والمحسوب، وترتيب كسري بين الإخوة، وإنجاز المشروع من الجذور، و«اليوم» بتوقيت الرياض، وعلامتا التأخر وقرب الاستحقاق |
| مسار الكتابة الوحيد | `src/projects/project-store.ts` | قفل صف المشروع، وتحميل المهام والاعتماديات والتقويم، وفحص كل النسخ قبل أي كتابة (409 بقائمة المعرّفات ونسخها الحالية)، وحفظ ما تغيّر فقط بـ `version + 1` خلف `WHERE id AND version`، وتحديث `wbs_cache` دون رفع النسخة، وتصفير `*_notified_at` عند تغيّر النهاية، وقيد تدقيق لكل مهمة كُتبت |
| المشاريع | `projects.service.ts` | القائمة حسب النطاق، والإنشاء (التقويم الافتراضي)، والتعديل (تغيير التقويم أو تشغيل الجدولة التلقائية يعيد اشتقاق المشروع)، والأرشفة، ومنح المشرفين صلاحية العرض وسحبها، و`/gantt` في طلب واحد، وتصدير Excel |
| المهام | `tasks.service.ts` | الإنشاء بين الإخوة، والتعديل الفردي، ودفعة السحب الواحدة، والأرشفة مع الفروع والاعتماديات، والاعتماديات (ذاتية، مكرّرة، حلقة بمسارها، نوع غير مفعّل)، و«مهامي» |
| التعاون | `task-collab.service.ts` | التعليقات مع الإشارات (`TASK_MENTIONED`)، والنشاط من سجل التدقيق، والمرفقات عبر `files` بـ `entityType: 'task'` (خطّاف رفع: المدير والمسند إليه) |
| التذكيرات | `task-due.service.ts` | مهمة يومية 07:00 بتوقيت الرياض: `TASK_DUE_SOON` و`TASK_OVERDUE` مرة واحدة لكل مهمة بحجز العمود قبل الإشعار |
| التقاويم | `calendars.service.ts` | التقاويم والاستثناءات للمدير؛ أي تغيير في أيام العمل يعيد اشتقاق مشاريع التقويم في المعاملة نفسها؛ لا عطلات مخترعة |
| Excel | `tasks-export.ts` | ورقتا «المهام» و«المشروع» من اليمين لليسار **دون تجميد**، عناوين عربية، ترتيب WBS، تواريخ حقيقية، الإنجاز خلية نسبة، وإزاحة اسم المهمة بمستواها (`alignment.indent`) |
| القاعدة | `prisma/migrations/20261015000000_phase4_tasks` | فهارس جزئية للمهام الحيّة وللتذكيرات و«مهامي» ومرفقات المهام؛ وعمودا `duration_days` و`progress` في `baseline_tasks` للمرحلة 5 (دون مسارات) |
| البريد | `notifications/email-templates.ts` | قوالب عربية لـ `TASK_ASSIGNED` و`TASK_MENTIONED` و`TASK_DUE_SOON` و`TASK_OVERDUE` |

إضافات إلى `@nuzli/shared` (كلها إضافية): `projectListQuerySchema` و`updateCalendarSchema` و`taskAttachmentSchema`؛ والأنواع `ProjectAccessDto` و`GanttDto` و`CreatedTaskDto` و`TaskUpdateResult` و`TaskBatchResult` و`TaskArchiveResult` و`CreatedDependencyDto` و`TaskVersionConflictDetails` و`MyTaskDto` و`TaskAttachmentDto`؛ ورموز الأخطاء `DEPENDENCY_TYPE_DISABLED` و`TASK_PARENT_INVALID` و`PROJECT_ARCHIVED` و`CALENDAR_DATE_EXISTS`.

## المسارات

| المسار | الصلاحية |
|---|---|
| `GET /projects?status=&q=` · `GET /projects/:id` · `GET /projects/:id/gantt` · `GET /projects/:id/export.xlsx` | من يرى المشروع |
| `POST /projects` · `PATCH/DELETE /projects/:id` · `GET/POST /projects/:id/access` · `DELETE /projects/:id/access/:userId` | المدير |
| `POST /projects/:id/tasks` · `POST /projects/:id/tasks/batch` · `DELETE /tasks/:id` · `POST /projects/:id/dependencies` · `DELETE /dependencies/:id` | المدير |
| `GET /tasks/:id` · `GET /tasks/:id/comments|activity|attachments` · `GET /tasks/:id/attachments/:fileId/url` | من يرى المشروع |
| `PATCH /tasks/:id` | المدير؛ والمشرف للإنجاز والحالة في مهامه فقط |
| `POST /tasks/:id/comments` | المدير والمشرف (أي مهمة في مشروع يراه) |
| `POST /tasks/:id/attachments` · `DELETE /tasks/:id/attachments/:fileId` | المدير والمسند إليه (الحذف: المدير أو من رفع) |
| `GET /tasks/mine` | المشرف |
| `GET/POST /calendars` · `GET/PATCH /calendars/:id` · `POST /calendars/:id/exceptions` · `DELETE /calendars/:id/exceptions/:exId` | المدير (`projects.manage`) |

## إجراءات التدقيق الجديدة (تحتاج تسميات عربية في الواجهة)

`project.created` · `project.updated` · `project.archived` · `project.access_granted` · `project.access_revoked` · `project.exported` · `task.created` · `task.updated` · `task.archived` · `task.moved` · `task.comment_added` · `task.attachment_added` · `task.attachment_removed` · `dependency.created` · `dependency.deleted` · `calendar.created` · `calendar.updated` · `calendar_exception.created` · `calendar_exception.deleted`

وأنواع الإشعار `TASK_ASSIGNED` و`TASK_MENTIONED` و`TASK_DUE_SOON` و`TASK_OVERDUE` تحتاج تسميات في مركز الإشعارات.

## فروق عن `docs/API.md` (المرحلة 4)

- `POST /projects/:id/tasks` يعيد `TaskDto` ومعه الحقل `affected`، وكذلك `POST /projects/:id/dependencies` (`DependencyDto` + `affected`).
- `DELETE /tasks/:id` يعيد 200 `{ archivedIds, affected }`، و`DELETE /projects/:id` يعيد 200 بالمشروع المؤرشف.
- `409 CONFLICT_VERSION` يحمل `details = { refresh: 'tasks', conflicts: [{ id, currentVersion }] }` (`null` = مؤرشفة أو ليست في المشروع).
- `DEPENDENCY_SELF` → 400، و`DEPENDENCY_EXISTS` و`DEPENDENCY_CYCLE` → 409، ونوع غير FS → 400 `DEPENDENCY_TYPE_DISABLED`. نقل مهمة تحت نفسها أو فرعها أو تحت معلَم → `TASK_PARENT_INVALID`.
- مسارات إضافية: `GET /tasks/:id` و`GET /tasks/:id/attachments/:fileId/url` و`GET /calendars/:id`. `POST /projects/:id/access` يعيد 201 `ProjectAccessDto` ولا يكرّر المنح.
- `GET /projects` دون `status` يعيد غير المؤرشفة؛ `status=ARCHIVED|ALL` عند الطلب.
- التقاويم تعيد `isDefault` أيضًا؛ إضافة استثناء تعيد التقويم كاملًا (201)، وتاريخ مكرّر → 409 `CALENDAR_DATE_EXISTS`.
- `GET /tasks/mine` يعيد `MyTaskDto` (المهمة + `project` + `overdue` + `dueSoon`).
- المشرف يعلّق على أي مهمة في مشروع يراه (ADR-058).

## الاختبارات

| الأمر | النتيجة على هذا الجهاز |
|---|---|
| `cd apps/api && npx jest` | ٢١ ملفًّا، ٢٠٨ اختبارات ناجحة (منها ٣٣ جديدًا: دفعة بنسخة قديمة لا تكتب شيئًا، وإعادة الجدولة على الخادم تزيح التابعة فوق الجمعة والسبت وعطلة، وعدم الثقة بتواريخ العميل، والحلقة بمسارها والربط الذاتي والمكرّر والربط بالأب، والمسند إليه مشرف نشط وتحويل خطأ الزناد، وحقوق المشرف 403/404، وتحديث WBS دون رفع النسخة، والإدراج الكسري والتحويل إلى مجموعة والمعلَم، والأرشفة، و«مهامي» بتوقيت الرياض، والتذكيرات مرة واحدة وتحت التزامن وبعد تغيير التاريخ، وإعادة الاشتقاق بعد إضافة عطلة، والإشارات، وصلاحية الرفع، وExcel من اليمين دون تجميد بإعادة قراءة الملف، ومسارات Swagger وصلاحيات المصفوفة) |
| `npm run test:int` | `test/int/projects.int-spec.ts`: مشروع + ٣ مهام FS + عطلة → تأخير الأولى بالدفعة يزيح التاليتين متخطيًا الجمعة والسبت والعطلة، ودفعتان متزامنتان بنسخة قديمة → 409 لإحداهما، والزناد يرفض غير المشرف، ومشروع ٢٠٠٠ مهمة: زمن إعادة الجدولة و`GET /gantt` يُطبع في السجل. **تُتخطّى هنا** لعدم وجود Docker |
| `npx prisma generate` و`npx tsc --noEmit` و`npx nest build` و`prisma validate` | ناجحة |
| `packages/shared`: ‏`vitest` | ٢٩ ناجحًا، و`dist` أُعيد بناؤه |
| `apps/web`: ‏`tsc --noEmit` | ٢٣ خطأً كلها مفاتيح ترجمة ناقصة في ملفات المرحلة 3 التي يعمل عليها الوكيل الآخر (`violations/*` و`UpdatePrompt.tsx` و`demo/phase3.ts`)، لا علاقة لها بتغييرات هذه المرحلة |

## ما بقي

- تشغيل اختبارات التكامل على جهاز فيه Docker وتسجيل زمن مشروع الـ ٢٠٠٠ مهمة.
- تسميات عربية لإجراءات التدقيق وأنواع الإشعار في الواجهة، وتحديث `docs/API.md` بالفروق أعلاه.
- `PATCH /tasks/:id` لا يستطيع مسح الوصف (المخطط المشترك يحوّل النص الفارغ إلى «لا تغيير»).
- عطلات تجريبية موسومة في `seed/demo` إن رغب الوكيل المسؤول عنها؛ البذرة الأساسية لا تضيف عطلات.
- الأساسات (Baselines) والمسار الحرج وعبء العمل: المخطط جاهز، والمسارات في المرحلة 5.
