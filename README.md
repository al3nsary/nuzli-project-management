# نزلي — إدارة المشاريع والفرق الميدانية

نظامٌ عربيّ (من اليمين لليسار) يجمع شطرين على نموذج مستخدمين وصلاحيات واحد:

- **إدارة المشاريع:** مشاريع ومهام هرمية ومخطط Gantt من اليمين لليسار، واعتماديات وجدولة تلقائية على أيام العمل. المهام تُسند إلى المشرفين فقط.
- **عمليات الفرق الميدانية:** فرق بألوانٍ فريدة، ونقل الأعضاء بين الفرق بالسحب والإفلات مع حفظ التاريخ، ومخالفات تُسجَّل في الميدان دون اتصال (موقع GPS وصور)، ولوحة إحصاءات، وطباعة كروت العمل على طابعات Zebra.

## التشغيل بأمر واحد

```bash
cp .env.example .env                       # إعدادات compose (ليست أسرارًا)
for f in api db backup minio; do cp env/$f.env.example env/$f.env; done
# استبدل كل CHANGE_ME في env/*.env — الأوامر المقترحة للتوليد في رأس .env.example
./scripts/dev-certs.sh        # شهادة HTTPS محلية (mkcert)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

ثم افتح `https://localhost`. يُنشأ أول مدير نظام من `BOOTSTRAP_ADMIN_EMAIL` و`BOOTSTRAP_ADMIN_PASSWORD`، ويُطلب منه تغيير كلمة المرور عند أول دخول.

للإنتاج: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` (التخزين على OCI Object Storage، انظر `docs/deployment-oci.md`).

## نسخة العرض

نسخةٌ للاستعراض على GitHub Pages تعمل كلها داخل المتصفح ببيانات تجريبية (ADR-020). لا خادم ولا قاعدة بيانات، وكل ما تُدخله يبقى في متصفحك.

## التطوير دون Docker

```bash
npm install                   # أو pnpm install
npm run build -w @nuzli/shared
npm run dev -w @nuzli/web     # الواجهة
npm run test -w @nuzli/shared
```

## الوثائق

| الملف | المحتوى |
|---|---|
| `PROMPT.md` | البرومبت الحيّ وسجلّ تعديلات المالك |
| `docs/STATUS.md` | ما أُنجز وما لم يُنفَّذ |
| `docs/ARCHITECTURE.md` | المعمارية ومخططاتها |
| `docs/DATA_MODEL.md` | نموذج البيانات والقيود |
| `docs/DECISIONS.md` | القرارات المعمارية |
| `docs/API.md` | عقد الواجهة البرمجية |
| `docs/printing.md` | ضبط طابعة Zebra |
| `docs/offline.md` | العمل دون اتصال |
| `docs/deployment-oci.md` | النشر على Oracle Cloud |
| `docs/backup-restore.md` | النسخ الاحتياطي والاستعادة |
