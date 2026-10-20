# نزلي — إدارة المشاريع والفرق الميدانية

نظامٌ عربيّ (من اليمين لليسار) يجمع شطرين على نموذج مستخدمين وصلاحيات واحد، في **أقسام** معزولة تمامًا:

- **إدارة المشاريع:** مشاريع ومهام هرمية ومخطط Gantt من اليمين لليسار، واعتماديات وجدولة تلقائية على أيام العمل، واستيراد وتصدير GanttPRO وMS Project.
- **عمليات الفرق الميدانية:** فرق بألوانٍ فريدة، ونقل الأعضاء بين الفرق بالسحب والإفلات مع حفظ التاريخ، ومخالفات تُسجَّل في الميدان دون اتصال (موقع GPS وصور)، ولوحة إحصاءات، وطباعة كروت العمل على طابعات Zebra.

ما سُلِّم بالتفصيل: [`docs/RELEASE-NOTES.md`](docs/RELEASE-NOTES.md).

## النشر للإنتاج (Oracle Cloud)

**الدليل الكامل خطوة بخطوة:** [`docs/deployment-oci.md`](docs/deployment-oci.md) — الخادم، والجدار الناري، وDocker، والنطاق
وشهادة HTTPS، ودلو OCI Object Storage، وملفات البيئة وتوليد الأسرار، والفحص، والتشغيل، وأول دخول، والنسخ الاحتياطي،
والتحديثات، وقائمة التحقق قبل الإطلاق. باختصار:

```bash
cp .env.example .env && for f in api db backup converter; do cp env/$f.env.example env/$f.env; done
# عبّئ القيم (الأسرار تُولَّد بأوامر الدليل §9)، ثم:
node scripts/preflight.mjs                                            # يجب أن يطبع «✓ جاهز للنشر»
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose logs api 2>&1 | grep "Temporary password"              # كلمة المالك mmansary المؤقتة (مرة واحدة)
```

النظام **فارغ** عند أول تشغيل: المالك `mmansary` (تغيير كلمة المرور إلزامي) والقسم «إدارة المشاريع» والإعدادات المحايدة فقط.
لا بيانات تجريبية في الإنتاج (ADR-169).

## التشغيل للتطوير (Docker)

```bash
cp .env.example .env                       # إعدادات compose (ليست أسرارًا)
for f in api db backup converter minio; do cp env/$f.env.example env/$f.env; done
# استبدل كل CHANGE_ME في env/*.env — الأوامر المقترحة للتوليد في رأس .env.example
./scripts/dev-certs.sh                     # شهادة HTTPS محلية (mkcert)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

ثم افتح `https://localhost`. البريد في mailpit على `http://127.0.0.1:8025`، وMinIO بديل OCI على `http://127.0.0.1:9001`.

## التطوير دون Docker

التثبيت من `package-lock.json` (مساحات npm، ADR-168):

```bash
npm ci
npm run build -w @nuzli/shared && npm run build -w @nuzli/scheduling && npm run build -w @nuzli/ui-print
npm run dev -w @nuzli/web                  # الواجهة (تمرّر /api إلى 127.0.0.1:3000)
```

## الفحوص

```bash
# الخادم (apps/api) — Node 22.6 أو أحدث لبوابة الطفرات
npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest && npx nest build
npm run test:isolation:mutation            # عزل الأقسام: تفشل المجموعة إن أُزيل مرشّح أي جدول
npm run verify:fresh-install               # تثبيت إنتاج جديد على قاعدة فارغة (PGlite) واختبار دخان كامل
# الواجهة (apps/web)
npx tsc --noEmit && npx vitest run && node scripts/check-i18n.mjs && npx vite build && npx vite build --mode demo
# ملفات النشر (الجذر)
node scripts/check-compose.mjs             # بنية ملفات compose ومطابقة المتغيّرات للأمثلة
node scripts/preflight.mjs --examples      # يفشل عمدًا: الأمثلة فيها CHANGE_ME
```

## نسخة العرض

نسخةٌ للاستعراض على GitHub Pages تعمل كلها داخل المتصفح ببيانات تجريبية موسومة (ADR-020). لا خادم ولا قاعدة بيانات، وكل ما
تُدخله يبقى في متصفحك. البيانات التجريبية في `seed/demo/` فقط، ولا تدخل بناء الإنتاج ولا صورة الخادم.

## الوثائق

| الملف | المحتوى |
|---|---|
| `PROMPT.md` | البرومبت الحيّ وسجلّ تعديلات المالك |
| `docs/STATUS.md` | ما أُنجز، وما لم يُنفَّذ، وما ينتظر الخادم الحقيقي |
| `docs/RELEASE-NOTES.md` | ملخّص ما سُلِّم |
| `docs/deployment-oci.md` | النشر على Oracle Cloud خطوة بخطوة |
| `docs/deployment-rls.md` | دورا قاعدة البيانات وRLS واستعادة المالك |
| `docs/backup-restore.md` | النسخ الاحتياطي والاستعادة وتدوير المفاتيح |
| `docs/ARCHITECTURE.md` | المعمارية ومخططاتها |
| `docs/DATA_MODEL.md` | نموذج البيانات والقيود |
| `docs/DECISIONS.md` | القرارات المعمارية |
| `docs/API.md` | عقد الواجهة البرمجية |
| `docs/printing.md` | ضبط طابعة Zebra |
| `docs/offline.md` | العمل دون اتصال |
| `docs/mobile.md` | الجوال والتابلت والتطبيق المثبّت |
