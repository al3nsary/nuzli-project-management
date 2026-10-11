# المرحلة 2 — الخادم: الفرق والأعضاء والبيانات المرجعية والكروت

> آخر تحديث: 2026-10-13. يكمّل `docs/phase-1-backend.md`. القرارات في ADR-039 إلى ADR-045.

## ما بُني

| الوحدة | المسار | المحتوى |
|---|---|---|
| الألوان | `src/colors` | `GET /colors/available?excludeTeamId=` (النشطة غير المحجوزة فقط، ولون الفريق المعدَّل يبقى له)، و`GET/POST /colors` و`PATCH /colors/:id` للمدير مع `inUseBy` |
| الفرق | `src/teams` | الإنشاء من المدير (مشرف موجود أو جديد يُنشأ نشطًا مع رابط كلمة المرور) ومن المشرف (لنفسه، معلّق أو نشط حسب `REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS`، مع إشعار المديرين)، واحترام `ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR`، والأعضاء الجدد والحاليين (يُنقلون)، والتعديل، والاعتماد والرفض والأرشفة (تحرّر اللون وتغلق العضويات)، وتغيير المشرف مع السجل، وظهور المخالفات لكل فريق |
| الأعضاء | `src/members` | البحث بالاسم أو الهوية كاملة (فهرس أعمى) أو آخر ٤ أرقام، وتصفية بالفريق أو غير المسندين، والإضافة والتعديل، والسجل، والنقل في معاملة واحدة ولحظة واحدة، والاستيراد بمعاينة ثم حفظ |
| المرجعية | `src/reference` | `/reference/departments` و`/reference/job-titles`: قراءة للجميع، وكتابة للمدير، والحذف يصير إيقافًا إن كان العنصر مستخدمًا |
| الكروت | `src/cards` | المقاسات (المدمجة لا تُحذف)، والقوالب (قالب افتراضي واحد)، والشعارات (ملف جاهز من نوع `logo`)، والمعاينة، ودفعات الطباعة (مفتاح عدم التكرار، ولقطة القالب، والحفظ في السجل)، وPDF عبر خدمة خارجية اختيارية |
| النطاق | `src/teams/team-dto.ts` | المشرف يرى ويدير فرقه فقط (وفريق غيره = 404)، ويرى أعضاء فرقه وغير المسندين. المزخرف الجديد `@RequireAnyPermission()` |
| القاعدة | `prisma/migrations/20261013000000_member_last4_index` | فهرس `team_members(national_id_last4)` للبحث بآخر ٤ أرقام |
| البذرة | `src/seed` | ثلاثة قوالب مدمجة (كلاسيكية أفقية CR80 افتراضية، شارة عمودية CR80، ملصق مدمج 90×40). تأكّدنا: ٢٤ لونًا و٦ مقاسات. و`npm run seed:demo` يحمّل الفرق والأعضاء وسجلّاتهم من `seed/demo/teams.json` و`members.json` (ويربط الألوان والمرجعية والمشرفين عبر `colors.json` و`reference.json` و`users.json`) إن وُجدا، ويتخطّى بهدوء إن غابا |

إضافات إلى `@nuzli/shared` (كلها إضافية): المخططات `rejectTeamSchema` و`updateTeamColorSchema` و`violationVisibilitySchema` و`updateCardTemplateSchema` و`logoInputSchema` و`cardPreviewSchema` و`updateReferenceItemSchema`؛ والأنواع `TeamColorPaletteDto` و`ColorTakenDetails` و`TeamDetailDto` و`SupervisorHistoryDto` و`ImportMembersResultDto` و`CardPreviewDto` و`PrintBatchDetailDto`؛ ورموز الأخطاء `COLOR_EXISTS` و`NOT_PENDING_TEAM` و`TEAM_ARCHIVED` و`NAME_TAKEN` و`BUILTIN_LOCKED` و`IN_USE` و`LOGO_FILE_INVALID` و`PDF_NOT_CONFIGURED` و`PDF_FAILED`؛ وأنواع الإشعار `TEAM_APPROVED` و`TEAM_REJECTED` (مع قوالب بريد عربية).

## إجراءات التدقيق الجديدة (تحتاج تسميات عربية في الواجهة)

`team.created` · `team.updated` · `team.approved` · `team.rejected` · `team.archived` · `team.supervisor_changed` · `team.visibility_changed` · `member.created` · `member.updated` · `members.moved` · `members.imported` · `color.created` · `color.updated` · `reference.created` · `reference.updated` · `reference.deleted` · `card_template.created` · `card_template.updated` · `card_template.archived` · `card_size.created` · `card_size.deleted` · `logo.created` · `logo.deleted` · `logo.default_set` · `cards.printed` · `cards.pdf_exported`

## فروق عن `docs/API.md`

- `GET /teams` دون `status` يعيد النشطة والمعلّقة؛ `status=ARCHIVED` أو `ALL` عند الطلب.
- `409 COLOR_TAKEN` يحمل `details = { fieldErrors.colorId, refresh: 'colors', available }`.
- `MEMBER_ALREADY_IN_TEAM` يرفض الطلب كله (مع `details.memberIds`) ولا يتخطّى. `POST /members/move` و`/members/import` يعيدان 200.
- سجل المشرفين يضيف `id` و`changedBy`. `GET /cards/batches/:id` يعيد الكروت ولقطة القالب. `PrintBatchDto` يضيف `idempotencyKey`. المعاينة تعيد `template` مع `subjects`.
- المرجعية: `PATCH` يقبل `isActive`، و`GET` يعيد `isActive` (والمدير يرى الموقوف)، و`DELETE` يعيد 200 `{ result: 'DELETED' | 'DEACTIVATED', item }`.
- حذف المقاس والقالب والشعار يعيد 204. أول شعار يصبح افتراضيًّا، وحذف شعار يفكّه من القوالب.
- PDF: ‏501 دون `PDF_SERVICE_URL`، و502 `PDF_FAILED` عند تعذّر الخدمة.
- المشرف يرى الأعضاء غير المسندين (لبناء فريق منهم).

## الاختبارات

| الأمر | النتيجة على هذا الجهاز |
|---|---|
| `cd apps/api && npx jest` | ١٢ ملفًّا، ١١٩ اختبارًا ناجحًا (منها ٥١ جديدًا: الألوان المتاحة، وتحويل `COLOR_TAKEN`، وحالة فريق المشرف حسب الإعداد، ونطاق المشرف، والنقل بلحظة واحدة ورفض الفريق غير النشط، وأخطاء صفوف الاستيراد والحفظ، وقواعد إخفاء الهوية في المعاينة، وعدم تكرار الدفعة والحفظ في السجل، و`@RequireAnyPermission`، و501 لـ PDF عبر خط HTTP، وتوثيق Swagger للمسارات الجديدة) |
| `npm run test:int` | `test/int/teams.int-spec.ts`: اللون المستخدم لا يظهر، وطلبان متزامنان باللون نفسه ينجح أحدهما فقط، وفريق المشرف معلّق حتى الاعتماد، والنقل يسجّل صفّين متصلين وقيد الاستبعاد صامد. **تُتخطّى هنا** لعدم وجود Docker |
| `npx tsc --noEmit` و`npx nest build` و`prisma validate` | ناجحة |
| `packages/shared`: ‏`vitest` | ٢٩ ناجحًا |

## ما بقي

- خدمة `pdf` نفسها (Playwright + `packages/ui-print`) وإضافة `PDF_SERVICE_URL` إلى `.env.example`.
- تشغيل اختبارات التكامل على جهاز فيه Docker.
- تسميات عربية لإجراءات التدقيق ولنوعي الإشعار الجديدين في الواجهة.
- رفع صورة العضو وربطها (`photoFileId`) لا مسار له بعد.
- مخططات الاستجابة في Swagger.
