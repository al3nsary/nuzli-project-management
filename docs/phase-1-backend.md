# المرحلة 1 — الخادم (NestJS) والبنية

> آخر تحديث: 2026-10-12. يكمّل `docs/phase-1-frontend.md`.

## ما بُني

| الوحدة | المسار | المحتوى |
|---|---|---|
| الإقلاع | `apps/api/src/main.ts` | helmet مع CSP، وCORS صارم من `CORS_ORIGINS`، وcookie-parser، والبادئة `api/v1`، وSwagger على `/api/docs` |
| الإعدادات | `src/config` | التحقق من متغيرات البيئة بـ zod؛ يرفض الخادم الإقلاع عند أي نقص |
| السجلات | `src/app.module.ts` | pino مع `requestId` في كل سطر (يُعاد في `X-Request-Id`)، وحجب الترويسات والكلمات السرية وأرقام الهوية، والرابط دون الاستعلام |
| الأخطاء | `src/common` | شكل واحد `{ code, message_ar, details }` من `ERRORS`، و`VALIDATION_FAILED` مع `details.fieldErrors`، وتحويل تكرار البريد/الجوال/الهوية إلى `EMAIL_TAKEN`/`MOBILE_TAKEN`/`NATIONAL_ID_TAKEN` |
| الصحة | `src/health` | `/api/v1/health` (الحياة) و`/api/v1/ready` (القاعدة + التخزين، وإلا 503) |
| الدخول | `src/auth` | argon2id، ورمز وصول 15 دقيقة (HS256)، ورمز تجديد دوّار في الكعكة `nz_rt` مخزّن بـ SHA-256 مع كشف إعادة الاستخدام لكل سلسلة، وCSRF بالإرسال المزدوج (`nz_csrf` + `X-CSRF-Token`)، والدخول بالبريد أو الجوال، والقفل بعد 5 محاولات لمدة 15 دقيقة، ونسيت كلمة المرور/إعادة التعيين/الإنشاء برابط لمرة واحدة، وتغيير كلمة المرور الإجباري، و`issueSession()` مدخلًا وحيدًا لبدء الجلسة (جاهز لـ SSO) |
| الصلاحيات | `src/auth/guards.ts` | حارس JWT عام مع `@Public()`، و`@RequirePermission()` يقرأ `can()` من `@nuzli/shared` — لا فحص أدوار في المتحكمات |
| المستخدمون والتسجيل | `src/users` | التسجيل المعلّق، والقوائم والتصفية، والإنشاء المباشر مع رابط كلمة المرور، والاعتماد (مع تغيير الصفة)، والرفض بسبب يُرسل بالبريد، وتغيير الصفة، والإيقاف (ينهي الجلسات فورًا)، وإعادة التفعيل، وقائمة المشرفين، وحماية آخر مدير بقفل الصفوف داخل معاملة |
| الهوية الوطنية | `src/crypto` | AES-256-GCM بإصدار مفتاح (`v1:`)، وفهرس أعمى HMAC، والرقم كاملًا للمدير فقط |
| التدقيق | `src/audit` | `AuditService.log()` لكل اعتماد ورفض وتغيير صفة وإيقاف وإعادة تفعيل وإنشاء مستخدم وتعديل إعدادات وإصدار رابط صورة هوية؛ `GET /audit` للمدير بالمرشّحات؛ أسماء الإجراءات وفق ADR-028 |
| الإشعارات | `src/notifications` | إشعار داخل التطبيق + بريد (SMTP؛ mailpit في التطوير) مع احترام تفضيلات المستخدم، وقوالب عربية RTL |
| الإعدادات | `src/settings` | `GET/PATCH /settings` على جدول `settings` مع `SETTINGS_SCHEMA` والقيم الافتراضية |
| التخزين | `src/storage` | رابط رفع موقّع (المدة من الإعدادات، والنوع والحجم مثبّتان)، وتأكيد بالحجم وبصمة الملف (JPEG/PNG/WebP/PDF فقط؛ يُحذف غيرها)، ورابط تنزيل بعد فحص الصلاحية، ومفاتيح `{entity}/{yyyy}/{mm}/{uuid}.{ext}`، وحذف الرفع غير المؤكد بعد 24 ساعة (مهمة كل ساعة) |
| البذرة | `src/seed/seed.ts` | متكررة بأمان: الإعدادات، ولوحة 24 لونًا بأسماء عربية، والتقويم الافتراضي (عطلة الجمعة والسبت)، ومقاسات الكروت الستة، وأول مدير من `BOOTSTRAP_ADMIN_*` فقط إن لم يوجد مدير |
| قاعدة البيانات | `prisma/migrations/20261012000000_files_kind` | عمود `files.kind` لتدقيق صور الهوية (ADR-035) |
| البنية | الجذر و`infra/` | `docker-compose.yml` و`.dev.yml` و`.prod.yml`، وDockerfile للخادم وللواجهة+nginx، و`infra/nginx/nginx.conf`، والشهادات (`infra/certs/README.md` + `scripts/dev-certs.sh`)، والنسخ الاحتياطي المشفّر (`infra/backup/`)، و`.env.example` |

إضافات إلى `@nuzli/shared`: الصلاحية `nationalIds.readFull`، والدالة `maskNationalIdParts()`، ورمزا الخطأ `CSRF_INVALID` و`INVALID_STATE`.

## التشغيل

```sh
cp .env.example .env            # املأ كل CHANGE_ME (المفاتيح: openssl rand -base64 32)
sh scripts/dev-certs.sh         # شهادة محلية بـ mkcert
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

- التطبيق: `https://localhost` — توثيق الـ API: `https://localhost/api/docs`
- البريد (mailpit): `http://localhost:8025` — وحدة MinIO: `http://localhost:9001`
- عند أول دخول يطلب النظام من المدير المؤسِّس تغيير كلمة المرور.
- الإنتاج: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` مع إعدادات OCI في `.env` و`CERTS_DIR`.
- النسخ الاحتياطي: `docker compose exec backup restore.sh /backups/<ملف> --verify` يجرّب الاستعادة في قاعدة مؤقتة.

دون Docker (للتطوير المحلي): `cd apps/api && npx prisma generate && npx nest build && npm run start` مع `DATABASE_URL` وبقية المتغيرات.

## متغيرات البيئة

القائمة الكاملة مع الشرح في `.env.example`. الإلزامية للخادم: `DATABASE_URL` (أو `POSTGRES_*` في compose)، و`JWT_ACCESS_SECRET` (32 حرفًا فأكثر)، و`NATIONAL_ID_ENC_KEY` و`NATIONAL_ID_HMAC_KEY` (32 بايت base64)، و`S3_BUCKET` و`S3_ACCESS_KEY` و`S3_SECRET_KEY` (و`S3_ENDPOINT` لـ OCI/MinIO)، و`BOOTSTRAP_ADMIN_*` عند أول تشغيل، و`BACKUP_ENCRYPTION_PASSPHRASE` لحاوية النسخ.

## الاختبارات

| الأمر | النتيجة على هذا الجهاز |
|---|---|
| `cd apps/api && npx jest` | 8 ملفات، 68 اختبارًا ناجحًا: التشفير، وحماية آخر مدير (معاملة مقلّدة)، وتدوير رموز التجديد وكشف إعادة الاستخدام، وبصمة الملفات وسياسة القراءة، وشكل الأخطاء ومحوّل zod، والحراس (الصلاحيات وJWT وCSRF)، وتنقية التدقيق، وخط HTTP كاملًا على AppModule مع Prisma مقلّد |
| `npm run test:int` | Testcontainers (Postgres 16 + MinIO): التسجيل ← منع الدخول ← الاعتماد ← الدخول؛ المدير ينشئ مديرًا؛ آخر مدير لا يُخفَّض (وبطلبين متزامنين)؛ الرفع الموقّع والتأكيد ورفض SVG. **تُتخطّى هنا** لعدم وجود Docker، برسالة واضحة |
| `npx tsc --noEmit` و`npx nest build` و`prisma validate` | ناجحة |

## ما بقي

- تشغيل اختبارات التكامل وبناء الصور فعليًّا على جهاز فيه Docker (لم يُختبر `docker compose` هنا).
- `pnpm-lock.yaml` لم يُولَّد بعد (ADR-022)؛ الـ Dockerfile يثبّت دون قفل حتى يُضاف.
- مخططات الاستجابة في Swagger (الطلبات موثّقة من zod، والاستجابات لا).
- إعداد CORS على حاوية OCI للرفع المباشر من المتصفح، وتجديد شهادة Let's Encrypt آليًّا.
- سكربت تدوير مفاتيح الهوية (الخطوات موصوفة في ADR-011/032).
- `docs/API.md`: تحديثه بالفروق المذكورة في تقرير المرحلة (423 للقفل، ورموز الأخطاء الجديدة، وقبول `from/to` تاريخًا).
- المراحل 2–4: الفرق والكروت والمخالفات والمشاريع، وقواعد الوصول المقيّدة بالبيانات للملفات.
