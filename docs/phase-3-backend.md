# المرحلة 3 — الخادم: المخالفات

> آخر تحديث: 2026-10-12. يكمّل `docs/phase-2-backend.md`. القرارات في ADR-046 إلى ADR-050.

## ما بُني

| الوحدة | المسار | المحتوى |
|---|---|---|
| أنواع المخالفات | `src/violations/violation-types.service.ts` | `GET /violation-types?active=true` (غير المدير يرى النشطة دائمًا)، و`POST` و`PATCH /violation-types/:id` للمدير مع التدقيق. لا حذف: الإيقاف بـ `isActive=false`. البذرة الأساسية لا تنشئ أي نوع؛ `npm run seed:demo` يضيف ثلاثة أنواع موسومة «(تجريبي)» أو يقرأ `seed/demo/violation-types.json` إن وُجد |
| قائمة الأعضاء للجهاز | `GET /violations/roster` | للمراقب والمدير: الأعضاء النشطون ذوو فريق حالي، بالهوية مقنّعة وآخر ٤ أرقام واسم الفريق ولونه، مع `generatedAt` و`Cache-Control: no-store` |
| التسجيل | `POST /violations` | عدم تكرار بـ `clientUuid` (201 للجديد، 200 للمكرر، ومعالجة السباق P2002)، ولقطة الفريق والمشرف عند `capturedAt` باستعلام SQL بفترات نصف مفتوحة، و`receivedAt` من الخادم، وعلامة فرق الساعة، وتنقية معلومات الجهاز، وعدد الصور المتوقع |
| الصور | `src/violations/violation-files.service.ts` | خطّاف على `FilesService`: صورة هوية واحدة و`VIOLATION_MAX_PHOTOS` صورة مخالفة (`TOO_MANY_PHOTOS`)، والصور فقط، والمسجِّل أو المدير فقط، والربط بـ `violation_files` عند التأكيد دون تكرار وبقفل صف المخالفة. المفاتيح `violations/{yyyy}/{mm}/{uuid}.{ext}` |
| القراءة | `GET /violations` و`/mine` و`/:id` | المرشّحات (التاريخ بأيام الرياض، والفريق من اللقطة، والعضو، والمراقب، والنوع، والحالة، والخطورة، ومستطيل الخريطة، وبحث الاسم `q`)، والنطاق داخل الاستعلام: المدير الكل، والمراقب ما سجّله، والمشرف فرقه الحالية غير المؤرشفة عند الظهور فقط (صفحة فارغة أو 404 عند الإخفاء) |
| روابط الصور | `GET /violations/:id/files/:fileId/url` | بعد فحص النطاق؛ صورة الهوية تتطلب `violations.viewIdPhoto` (لا يملكها المشرف) ويُسجَّل عرضها `violation.id_photo_viewed` |
| التعديل والحالة والرد | `PATCH /:id` و`POST /:id/status` و`POST /:id/responses` | المسجِّل خلال المهلة ثم المدير فقط (`EDIT_WINDOW_CLOSED` بـ 403)، والإلغاء بسبب، ورد المشرف يُشعر المديرين `VIOLATION_OBJECTION` (بريد عربي) |
| الإحصاءات | `src/violations/violation-stats.ts` | `GET /violations/stats` (المدير): استعلام SQL لكل رسم بالشرط نفسه، والتجميع `AT TIME ZONE 'Asia/Riyadh'`، والأسبوع يبدأ الأحد، والخريطة حتى 5000 نقطة مع `pointsTruncated` |
| Excel | `src/violations/violations-export.ts` | `GET /violations/export.xlsx`: ورقتان من اليمين لليسار **دون تجميد**، وعناوين عربية، وتواريخ حقيقية بتوقيت الرياض، وهوية مقنّعة، وعرض أعمدة ملائم، وحد 50 ألف صف، ويُسجَّل `violations.exported` |
| PDF اللوحة | `GET /violations/dashboard.pdf` | نمط الكروت نفسه: 501 دون `PDF_SERVICE_URL`، و502 عند تعذّر الخدمة، ويُسجَّل `violations.dashboard_exported` |
| الاحتفاظ | `purgeExpiredPhotos()` | مهمة يومية 03:15 بتوقيت الرياض؛ لا تفعل شيئًا والقيمة 0 (الافتراضي)، وإلا تحذف الصور الأقدم وتعلّم الملفات محذوفة وتكتب قيد تدقيق واحدًا بفاعل النظام |
| القاعدة | `prisma/migrations/20261014000000_violation_constraints` | فهرس فريد جزئي لصورة هوية واحدة لكل مخالفة، وفهرس ملفات المخالفات، و`violations(member_id, captured_at)` |

إضافات إلى `@nuzli/shared` (كلها إضافية): `updateViolationTypeSchema`، و`RosterResponse`، وحقول اختيارية في `ViolationDto` (`expectedPhotos` و`clientSentAt` و`deviceInfo` للمدير) وفي `ViolationStats` (`pointsTruncated` و`generatedAt`).

## إجراءات التدقيق الجديدة (تحتاج تسميات عربية في الواجهة)

`violation_type.created` · `violation_type.updated` · `violation.updated` · `violation.status_changed` · `violation.response_added` · `violation.id_photo_viewed` · `violations.exported` · `violations.dashboard_exported` · `violations.photos_purged`

ونوع الإشعار `VIOLATION_OBJECTION` يحتاج تسمية في مركز الإشعارات.

## فروق عن `docs/API.md` (المرحلة 3)

- `POST /violations` بـ `clientUuid` سجّله مستخدم آخر → `409 CONFLICT_VERSION`. العضو أو النوع غير النشط → `400 VALIDATION_FAILED` مع `fieldErrors.memberId/typeId`.
- `TOO_MANY_PHOTOS` → 409، و`EDIT_WINDOW_CLOSED` → 403. رفع صورة لمخالفة ليست لك → 404، وملف PDF للمخالفة → 415.
- `GET /violation-types` دون `active` يعيد الكل للمدير والنشطة لغيره.
- `GET /violations/mine` يقبل المرشّحات نفسها، و`GET /violations` يقبل `q` (اسم العضو) و`sort=capturedAt|receivedAt|status:asc|desc`.
- `ViolationFileDto.id` هو معرّف الملف (`fileId`) المستخدم في مسار الرابط.
- `thisWeek`/`previousWeek` تتجاهل مدى التاريخ وتطبّق بقية المرشّحات؛ `byTeam` يستبعد المخالفات دون فريق؛ `topMembers` لمن تكرّرت مخالفاته (أكثر من واحدة).
- عرض صور المخالفة (غير الهوية) لا يُسجَّل في التدقيق (ADR-050).
- مسار PDF يرسل إلى `POST {PDF_SERVICE_URL}/render/violations-dashboard`.

## الاختبارات

| الأمر | النتيجة على هذا الجهاز |
|---|---|
| `cd apps/api && npx jest` | ١٧ ملفًّا، ١٧٥ اختبارًا ناجحًا (منها ٥٦ جديدًا: عدم التكرار وسباق P2002، واللقطة عند `capturedAt` ونقل العضو بعد المخالفة، وعلامة فرق الساعة، وحدود الصور والربط المتكرر، ونطاق المشرف ظاهرًا ومخفيًّا وموروثًا والمراقب والمدير، ومهلة التعديل، وسبب الإلغاء، وبنّاء SQL للإحصاءات، وأيام الرياض وأسبوع الأحد، وExcel من اليمين دون تجميد بإعادة قراءة الملف، والاحتفاظ، و403/501 عبر خط HTTP) |
| `npm run test:int` | `test/int/violations.int-spec.ts`: عدم التكرار (مرتين وبالتزامن)، ونقل العضو يُبقي المخالفات القديمة على فريقها، وظهور المخالفات للمشرف تشغيلًا وإيقافًا، ومسار القبول (٣ مخالفات بصور عبر presign + PUT + confirm، والإعادة دون تكرار، واللقطة والموقع صحيحان)، ومهلة التعديل والإلغاء وExcel. **تُتخطّى هنا** لعدم وجود Docker |
| `npx tsc --noEmit` و`npx nest build` و`prisma validate` | ناجحة |
| `packages/shared`: ‏`vitest` | ٢٩ ناجحًا |
| `apps/web`: ‏`tsc --noEmit` | ناجح |

## ما بقي

- تشغيل اختبارات التكامل على جهاز فيه Docker.
- خدمة `pdf` نفسها (قالب لوحة المخالفات) وإضافة `PDF_SERVICE_URL` إلى `.env.example`.
- تسميات عربية لإجراءات التدقيق ونوع الإشعار في الواجهة، وتحديث `docs/API.md` بالفروق أعلاه.
