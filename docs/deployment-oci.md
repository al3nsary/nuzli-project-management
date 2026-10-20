# نشر نُزلي على Oracle Cloud (OCI) — دليل المالك خطوة بخطوة

> هذا الدليل يأخذك من حساب OCI فارغ إلى نظام يعمل على نطاقك بـ HTTPS، ثم أول دخول باسم **`mmansary`**.
> كل أمر في صندوق يُنسخ ويُلصق كما هو. ما بين `<…>` تستبدله بقيمتك.
> المتطلبات كما في البرومبت (§2 و§3 و§13): Docker وdocker compose، وPostgreSQL 16، وتخزين OCI Object Storage عبر
> واجهة S3، وHTTPS إلزامي، ونسخ احتياطية مشفّرة، وكل الإعدادات من ملفات البيئة، والأوقات تُخزَّن بتوقيت UTC.

**ما الذي سيعمل على الخادم** (`docker-compose.yml` + `docker-compose.prod.yml`):

| الخدمة | العمل | منفذ على الإنترنت |
|---|---|---|
| `proxy` | nginx: شهادة HTTPS، وتطبيق الويب، وتمرير `/api` إلى الخادم | 80 (تحويل إلى HTTPS فقط) و443 |
| `api` | خادم NestJS. عند كل تشغيل: الترحيلات ← البذرة ← الخادم بدور `nuzli_app` مع RLS | لا |
| `db` | PostgreSQL 16 على قرص دائم (`db-data`) | لا |
| `converter` | تحويل ملفات MS Project ‎.mpp (اختياري) على شبكة داخلية بلا إنترنت | لا |
| `backup` | نسخة احتياطية يومية مشفّرة، ونسخة خارج الخادم في دلو OCI منفصل | لا |

**النظام فارغ عند أول تشغيل.** لا يُنشأ إلا: المالك `mmansary` (كلمة مرور مؤقتة تُطبع مرة واحدة، ويُفرض تغييرها)، والقسم
«إدارة المشاريع»، والإعدادات المحايدة (١٠ إعدادات، ولوحة ٢٤ لونًا للفرق، والتقويم الافتراضي بعطلة الجمعة والسبت، و٦ مقاسات
كروت و٣ قوالب). لا مستخدمين ولا فرق ولا مشاريع ولا مخالفات ولا أنواع مخالفات ولا إدارات ولا مسمّيات ولا إجازات ولا شعارات
ولا ملفات. البيانات التجريبية لا تدخل الإنتاج: صورة الخادم لا تحتويها، وأمر `seed:demo` يرفض العمل في الإنتاج (ADR-169).

---

## المحتويات

1. [ما تحتاجه قبل البدء](#1)
2. [إنشاء الخادم (Compute)](#2)
3. [الجدار الناري: 80 و443 فقط](#3)
4. [تثبيت Docker](#4)
5. [النطاق (DNS)](#5)
6. [شهادة HTTPS](#6)
7. [دلو الملفات على OCI Object Storage](#7)
8. [دلو النسخ الاحتياطية](#8)
9. [تنزيل النظام وملفات البيئة](#9)
10. [فحص ما قبل النشر](#10)
11. [التشغيل](#11)
12. [أول دخول للمالك](#12)
13. [المديرون والمستخدمون والأقسام](#13)
14. [النسخ الاحتياطي والاستعادة](#14)
15. [التحديثات](#15)
16. [المراقبة](#16)
17. [استكشاف الأخطاء](#17)
18. [قائمة التحقق قبل الإطلاق](#18)

---

<a id="1"></a>
## ١. ما تحتاجه قبل البدء

- حساب Oracle Cloud بصلاحية إنشاء الخوادم والدلاء والمستخدمين (Administrator للمستأجر أو للحجيرة Compartment).
- **نطاق** تملكه (مثلًا `nuzli.example.sa`) وتستطيع إضافة سجلّ DNS له.
- **خادم بريد SMTP** (مثل OCI Email Delivery أو بريد جهتك) لرسائل استعادة كلمة المرور والاعتمادات. يعمل النظام بدونه،
  لكن لن تصل أي رسالة.
- جهازك مع طرفية SSH (ويندوز: PowerShell أو Windows Terminal، وفيه `ssh` جاهز).
- مكان آمن خارج الخادم (مدير كلمات مرور) لحفظ **عبارة تشفير النسخ الاحتياطية** ومفاتيح الهوية. بدونها لا تُستعاد أي نسخة.

المنطقة (Region) المقترحة: **جدة `me-jeddah-1`** أو **الرياض `me-riyadh-1`** (البيانات داخل المملكة — نظام حماية البيانات الشخصية).
اختر منطقة واحدة للخادم والدلاء.

<a id="2"></a>
## ٢. إنشاء الخادم (Compute)

OCI Console ← **Compute ← Instances ← Create instance**:

| الحقل | القيمة |
|---|---|
| Name | `nuzli-prod` |
| Image | **Canonical Ubuntu 24.04** (أو 22.04) |
| Shape | انظر الجدول أدناه |
| Networking | VCN جديدة أو موجودة مع **Public subnet** و**Assign a public IPv4 address** |
| SSH keys | ارفع مفتاحك العام أو نزّل المفتاح الذي يولّده OCI واحفظه |
| Boot volume | **100 GB** على الأقل |

| الحجم | المعالج والذاكرة | يناسب |
|---|---|---|
| الحد الأدنى | 2 OCPU و**8 GB** (`VM.Standard.E5.Flex` أو `VM.Standard.A1.Flex` — Ampere ARM) | قسم واحد وحتى نحو ٥٠ مستخدمًا |
| المقترح | 4 OCPU و**16 GB** | عدة أقسام ومئات المستخدمين واستيراد ملفات ‎.mpp |

حدود الذاكرة في `docker-compose.prod.yml` مجموعها نحو ٤٫٨ GB (قاعدة البيانات 2G، والخادم 1G، والمحوّل 1G، والنسخ 512M،
والوكيل 256M)، فـ 8 GB تترك هامشًا للنظام. معالجات ARM (A1) مدعومة: كل الصور تُبنى على المعمارية نفسها.

بعد الإنشاء: **Networking ← IP management ← Reserved public IPs** واحجز العنوان العام للخادم كي لا يتغيّر عند إعادة التشغيل
(أو حوّل العنوان المؤقت إلى محجوز من صفحة الخادم ← Attached VNICs ← IPv4 Addresses).

ادخل إلى الخادم من جهازك:

```bash
ssh -i <path-to-private-key> ubuntu@<server-public-ip>
```

<a id="3"></a>
## ٣. الجدار الناري: 80 و443 فقط

**أ) قائمة أمان الشبكة في OCI** — Networking ← Virtual cloud networks ← VCN الخادم ← Subnet ← Security List ← **Add Ingress Rules**:

| Source CIDR | Protocol | Destination port | الغرض |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `80` | شهادة Let's Encrypt والتحويل إلى HTTPS |
| `0.0.0.0/0` | TCP | `443` | النظام |
| `<your-ip>/32` | TCP | `22` | SSH من جهازك فقط (عدّل القاعدة الافتراضية `0.0.0.0/0` إلى عنوانك) |

لا تفتح أي منفذ آخر (لا 5432 ولا 3000): قاعدة البيانات والخادم لا يُنشران خارج Docker أصلًا.

**ب) الجدار الناري داخل Ubuntu** — صور Ubuntu في OCI تأتي بقواعد `iptables` ترفض كل شيء عدا SSH:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

<a id="4"></a>
## ٤. تثبيت Docker

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y git ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
exit
```

ادخل من جديد (`ssh …`) ليسري الانضمام إلى مجموعة docker، ثم تحقّق:

```bash
docker --version && docker compose version
```

يجب أن يكون compose بالإصدار 2.20 أو أحدث.

<a id="5"></a>
## ٥. النطاق (DNS)

عند مزوّد النطاق أضف سجلّ **A**: الاسم `nuzli` (أو الجذر) ← القيمة **العنوان العام المحجوز** للخادم. انتظر حتى يظهر:

```bash
getent hosts <your-domain>     # يجب أن يطبع عنوان الخادم
```

<a id="6"></a>
## ٦. شهادة HTTPS (Let's Encrypt)

الطريقة الموثّقة: **certbot بالوضع المستقل (standalone)** على المنفذ 80، قبل تشغيل النظام أول مرة. عند التجديد كل ~٦٠ يومًا
يتوقف الوكيل `proxy` نحو ٢٠ ثانية ثم يعود تلقائيًّا. تُنسخ الشهادة إلى مجلد عادي `/opt/nuzli/certs` لأن ملفات
`/etc/letsencrypt/live/` روابط رمزية لا تعمل داخل الحاوية، ويقرؤها nginx غير الجذري (المستخدم 101).

```bash
sudo apt-get install -y certbot
sudo mkdir -p /opt/nuzli/certs /opt/nuzli/app
sudo chown "$USER":"$USER" /opt/nuzli/app

# يُشغَّل بعد كل إصدار أو تجديد: ينسخ الشهادة ويعيد تحميل nginx.
sudo tee /usr/local/bin/nuzli-cert-deploy >/dev/null <<'EOF'
#!/bin/sh
set -e
install -m 0644 -o root -g 101 "$RENEWED_LINEAGE/fullchain.pem" /opt/nuzli/certs/fullchain.pem
install -m 0640 -o root -g 101 "$RENEWED_LINEAGE/privkey.pem"   /opt/nuzli/certs/privkey.pem
EOF
sudo chmod 0755 /usr/local/bin/nuzli-cert-deploy

sudo certbot certonly --standalone -d <your-domain> \
  -m <your-email> --agree-tos --no-eff-email \
  --deploy-hook /usr/local/bin/nuzli-cert-deploy \
  --pre-hook  "sh -c 'cd /opt/nuzli/app && docker compose stop proxy || true'" \
  --post-hook "sh -c 'cd /opt/nuzli/app && docker compose start proxy || true'"

ls -l /opt/nuzli/certs        # fullchain.pem و privkey.pem
sudo certbot renew --dry-run  # تجربة التجديد (بعد التشغيل في §11 يوقف الوكيل ويعيده)
```

التجديد تلقائي (مؤقّت `certbot.timer`). الأوامر في الخطافات تُحفظ مع الشهادة فلا تكتبها مرة أخرى.

**إن كانت عندك شهادة من جهتك:** ضع الملفين باسمي `fullchain.pem` (الشهادة ثم السلسلة الوسيطة) و`privkey.pem` في
`/opt/nuzli/certs` بالصلاحيات نفسها (`chown root:101`، و`chmod 644` للشهادة و`640` للمفتاح).

<a id="7"></a>
## ٧. دلو الملفات على OCI Object Storage

الصور والمرفقات والشعارات تُرفع من المتصفح مباشرة إلى الدلو بروابط موقّعة قصيرة العمر، والدلو **خاص** دائمًا.

**أ) الدلو** — Storage ← Object Storage ← Buckets ← **Create Bucket**:
- Name: `nuzli-files` — Default Storage Tier: **Standard** — Encryption: Oracle-managed keys.
- **Object Versioning: Enabled** (حماية من الحذف الخطأ؛ النسخة الاحتياطية لقاعدة البيانات لا تشمل الملفات).
- اترك **Visibility: Private** (الافتراضي). لا تنشئ «Pre-Authenticated Requests» للدلو أبدًا.

**ب) Namespace والمنطقة** — Profile (أعلى اليمين) ← **Tenancy: <name>** ← «Object storage namespace» (مثل `axabc123xyz`).
عنوان واجهة S3:

```
https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
مثال: https://axabc123xyz.compat.objectstorage.me-jeddah-1.oraclecloud.com
```

**ج) الحجيرة المعتمدة لواجهة S3** — في صفحة Tenancy نفسها: **Object Storage Settings ← Amazon S3 Compatibility API
Designated Compartment** واجعلها الحجيرة التي فيها الدلو (أو أنشئ الدلو في الحجيرة المعتمدة أصلًا).

**د) مستخدم خاص بالتطبيق وصلاحياته** — Identity & Security ← Domains ← Default:
1. **Groups ← Create group**: `nuzli-app`.
2. **Users ← Create user**: `nuzli-app` (دون كلمة مرور للوحة التحكم)، وأضفه إلى المجموعة.
3. Identity ← **Policies ← Create Policy** في الحجيرة نفسها:
   ```
   Allow group nuzli-app to read buckets in compartment <compartment> where target.bucket.name = 'nuzli-files'
   Allow group nuzli-app to manage objects in compartment <compartment> where target.bucket.name = 'nuzli-files'
   ```
4. افتح المستخدم `nuzli-app` ← **Customer secret keys ← Generate secret key** (الاسم `nuzli-app-s3`):
   - **انسخ «Secret key» فورًا: يظهر مرة واحدة فقط** ← هذا `S3_SECRET_KEY`.
   - «Access key» يظهر في القائمة بعد الإغلاق ← هذا `S3_ACCESS_KEY`.

**هـ) تنظيف الرفع غير المكتمل (موصى به، ADR-065)** — الدلو ← **Lifecycle Policy Rules ← Create Rule**: Lifecycle Action
**Delete**، بعد **1 day**، Object Name Filters ← Prefix **`pending/`**. تحتاج القاعدة سياسة للخدمة نفسها (مرة واحدة):
```
Allow service objectstorage-<region> to manage object-family in compartment <compartment>
```

**و) CORS (رفع المتصفح مباشرة إلى الدلو):** خدمة OCI Object Storage لا تعرض قواعد CORS لكل دلو كما في AWS، وتردّ على
طلبات المتصفح بترويسات CORS تسمح بالأصول. وسياسة أمان الصفحة (CSP في `infra/nginx/nginx.conf`) تسمح أصلًا بـ
`https://*.oraclecloud.com`. **تحقّق من ذلك على خادمك بعد التشغيل** (الأمر في §11، الخطوة ٥)؛ وإن لم تظهر
`access-control-allow-origin` فانظر §17.

<a id="8"></a>
## ٨. دلو النسخ الاحتياطية (منفصل)

دلو ومفاتيح **مختلفة** عن دلو التطبيق، حتى لا يستطيع من يسرق مفاتيح التطبيق حذف النسخ:

1. Buckets ← Create Bucket: `nuzli-backups`، Private، Standard.
2. الدلو ← **Retention Rules ← Create Rule**: مدة ٣٠ يومًا (أو ما تقرّره) — لا يُحذف أي ملف ولا يُعدَّل قبلها، حتى من المدير.
3. مجموعة `nuzli-backup` ومستخدم `nuzli-backup` كما في §7-د، بسياسة كتابة وقراءة **بلا حذف**:
   ```
   Allow group nuzli-backup to read buckets in compartment <compartment> where target.bucket.name = 'nuzli-backups'
   Allow group nuzli-backup to manage objects in compartment <compartment> where all {target.bucket.name = 'nuzli-backups', any {request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_INSPECT', request.permission = 'OBJECT_READ'}}
   ```
4. Customer secret key للمستخدم `nuzli-backup` ← `BACKUP_S3_ACCESS_KEY` و`BACKUP_S3_SECRET_KEY`.

<a id="9"></a>
## ٩. تنزيل النظام وملفات البيئة

```bash
cd /opt/nuzli/app
git clone https://github.com/al3nsary/nuzli-project-management.git .
```

**أ) نسخ الأمثلة وتوليد كل الأسرار تلقائيًّا** — انسخ الصندوق كاملًا والصقه مرة واحدة:

```bash
cd /opt/nuzli/app
cp .env.example .env
for f in api db backup converter; do cp env/$f.env.example env/$f.env; done
DB_PW=$(openssl rand -base64 48 | tr -d '+/=' | cut -c1-32)
APP_PW=$(openssl rand -base64 48 | tr -d '+/=' | cut -c1-32)
CONV_TOKEN=$(openssl rand -base64 48)
sed -i "s|CHANGE_ME_db_password|$DB_PW|" env/db.env env/api.env env/backup.env
sed -i "s|CHANGE_ME_app_password|$APP_PW|" env/api.env
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" env/api.env
sed -i "s|^NATIONAL_ID_ENC_KEY=.*|NATIONAL_ID_ENC_KEY=v1:$(openssl rand -base64 32)|" env/api.env
sed -i "s|^NATIONAL_ID_HMAC_KEY=.*|NATIONAL_ID_HMAC_KEY=$(openssl rand -base64 32)|" env/api.env
sed -i "s|^CONVERTER_TOKEN=.*|CONVERTER_TOKEN=$CONV_TOKEN|" env/api.env env/converter.env
sed -i "s|^DB_REQUIRE_RLS=.*|DB_REQUIRE_RLS=true|" env/api.env
sed -i "s|^BACKUP_ENCRYPTION_PASSPHRASE=.*|BACKUP_ENCRYPTION_PASSPHRASE=$(openssl rand -base64 48)|" env/backup.env
sed -i "s|^# COMPOSE_FILE=|COMPOSE_FILE=|; s|^CERTS_DIR=.*|CERTS_DIR=/opt/nuzli/certs|; s|^NUZLI_VERSION=.*|NUZLI_VERSION=$(date +%Y.%m.%d)|" .env
chmod 600 .env env/*.env
unset DB_PW APP_PW CONV_TOKEN
```

`COMPOSE_FILE` في `.env` يجعل كل أمر `docker compose …` بعد الآن يستعمل ملف الإنتاج تلقائيًّا.

**ب) ما تكتبه بيدك** — افتح `nano env/api.env` وعدّل:

| المتغيّر | القيمة |
|---|---|
| `PUBLIC_WEB_URL` | `https://<your-domain>` |
| `S3_ENDPOINT` | `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` |
| `S3_REGION` | المنطقة نفسها، مثل `me-jeddah-1` |
| `S3_BUCKET` | `nuzli-files` |
| `S3_ACCESS_KEY` و`S3_SECRET_KEY` | مفتاح المستخدم `nuzli-app` من §7-د |
| `SMTP_HOST` و`SMTP_PORT` و`SMTP_SECURE` و`SMTP_USER` و`SMTP_PASS` | بيانات خادم البريد |
| `MAIL_FROM` | `نزلي <no-reply@<your-domain>>` |
| `BOOTSTRAP_OWNER_USERNAME` | `mmansary` (موجود) |
| `BOOTSTRAP_OWNER_PASSWORD` | **اتركه فارغًا**: تُولَّد كلمة مرور مؤقتة وتُطبع مرة واحدة (§12) |

وفي `nano env/backup.env`: `BACKUP_S3_ENABLED=true` و`BACKUP_S3_ENDPOINT` (العنوان نفسه) و`BACKUP_S3_REGION`
و`BACKUP_S3_BUCKET=nuzli-backups` و`BACKUP_S3_ACCESS_KEY` و`BACKUP_S3_SECRET_KEY` من §8.

**ج) احفظ نسخة من الأسرار خارج الخادم الآن** (مدير كلمات مرور):

```bash
grep -E '^(BACKUP_ENCRYPTION_PASSPHRASE)=' env/backup.env
grep -E '^(NATIONAL_ID_ENC_KEY|NATIONAL_ID_HMAC_KEY)=' env/api.env
```

بدون العبارة لا تُفكّ أي نسخة احتياطية، وبدون مفتاحي الهوية لا تُقرأ أرقام الهوية المشفّرة بعد أي استعادة.

**اختياري:** إن لم تحتج استيراد ملفات ‎.mpp فاجعل `CONVERTER_URL=` فارغًا في `env/api.env` (يردّ الاستيراد برسالة واضحة
ويطلب حفظ الملف XML من MS Project). خدمة PDF على الخادم غير مبنية بعد: اترك `PDF_SERVICE_URL` معلّقًا، والطباعة إلى PDF تتم
من نافذة الطباعة في المتصفح (`docs/printing.md`).

<a id="10"></a>
## ١٠. فحص ما قبل النشر

سكربت لا يحتاج أي حزمة: يفحص الملفات كلها (القيم الناقصة، وبقايا `CHANGE_ME`، وقوة الأسرار، وتطابق كلمات المرور بين
الملفات، وعنوان OCI ومنطقته، ودور `nuzli_app`، و`https` للأصل وCORS، والشهادة: صلاحيتها وتطابق مفتاحها ونطاقها، والنسخ
الاحتياطي)، ويطبع كل ملاحظة بالعربية والإنجليزية مع طريقة إصلاحها. لا يطبع أي سرّ.

```bash
cd /opt/nuzli/app
docker run --rm -v "$PWD":/w -v /opt/nuzli/certs:/opt/nuzli/certs:ro -w /w node:20-alpine \
  node scripts/preflight.mjs
```

لا تنتقل إلى §11 حتى يطبع **«✓ جاهز للنشر»**. علامة ✱ تنبيه لا يمنع النشر (اقرأه)، وعلامة ✗ تمنعه.

<a id="11"></a>
## ١١. التشغيل

```bash
cd /opt/nuzli/app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

(بعد ضبط `COMPOSE_FILE` في §9 يكفي `docker compose up -d --build`.) البناء الأول يأخذ ٥–١٥ دقيقة. البناء يثبّت الحزم
من `package-lock.json` حرفيًّا (`npm ci`) فلا تتغيّر النسخ من بناء لآخر (ADR-168).

1. الحالة — كل الخدمات `healthy` (الخادم يحتاج حتى دقيقتين أول مرة):
   ```bash
   docker compose ps
   ```
2. سجل الخادم: الترحيلات ثم البذرة ثم التشغيل بدور `nuzli_app`:
   ```bash
   docker compose logs api | grep -E "entrypoint|seed"
   #   [entrypoint] prisma migrate deploy
   #   [seed] Bootstrap owner "mmansary" created. Temporary password (shown once — change it at first login): …
   #   [seed] nuzli_app can log in (password from APP_DATABASE_URL); the API connects with it.
   #   [entrypoint] the API connects as the application role (APP_DATABASE_URL)
   ```
3. الصحة من الخارج:
   ```bash
   curl -fsS https://<your-domain>/api/v1/health    # {"status":"ok",...}
   curl -fsS https://<your-domain>/api/v1/ready     # {"status":"ready","checks":{"db":true,"storage":true}}
   ```
   `storage: false` يعني أن مفاتيح OCI أو العنوان أو الصلاحيات خاطئة (§17).
4. RLS فعّال:
   ```bash
   docker compose exec db psql -U nuzli -d nuzli -c "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nuzli_app'"
   #   nuzli_app | t | f | f
   ```
5. CORS للرفع المباشر إلى OCI (يحاكي ما يفعله المتصفح):
   ```bash
   curl -sS -o /dev/null -D - -X OPTIONS \
     -H "Origin: https://<your-domain>" -H "Access-Control-Request-Method: PUT" \
     -H "Access-Control-Request-Headers: content-type" \
     "https://<namespace>.compat.objectstorage.<region>.oraclecloud.com/nuzli-files/pending/check" | grep -i access-control
   ```
   يجب أن تظهر `access-control-allow-origin` و`access-control-allow-methods` تشمل `PUT`.

<a id="12"></a>
## ١٢. أول دخول للمالك

1. كلمة المرور المؤقتة (تُطبع **مرة واحدة** في أول تشغيل، ولا يُخزَّن إلا تجزئتها):
   ```bash
   docker compose logs api 2>&1 | grep "Temporary password"
   ```
2. افتح `https://<your-domain>` وادخل باسم المستخدم **`mmansary`** وهذه الكلمة.
3. يطلب النظام **تغيير كلمة المرور فورًا** (لا تُفتح أي صفحة قبل ذلك). اختر كلمة قوية (١٠ أحرف على الأقل بحروف وأرقام).
4. للمالك بريد وجوال ورقم هوية **مؤقتة محايدة** (بريد ينتهي بـ `.invalid`): من **إدارة المستخدمين** (أو **إدارة النظام ← كل
   الحسابات**) افتح حسابك ← «تعديل» وضع بياناتك الحقيقية (يلزم البريد الحقيقي لاستعادة كلمة المرور). «ملفي الشخصي» للاسم
   والصورة والتفضيلات.
5. إن ضاعت السجلات قبل أن تقرأ الكلمة (أو نُسيت): من الخادم
   ```bash
   docker compose exec api npm run owner:recover -- --username mmansary --reset-password
   ```
   يطبع كلمة مؤقتة جديدة مرة واحدة (يُسجَّل في سجل الحسابات).

الحالة الآن: قسم واحد «إدارة المشاريع» فيظهر النظام دون أي اختيار للأقسام، واسم القسم تحت شعار نُزلي.

<a id="13"></a>
## ١٣. المديرون والمستخدمون والأقسام

- **البيانات المرجعية أولًا** (القائمة ← الإعدادات): الإدارات والمسمّيات، وأنواع المخالفات، والإجازات في التقويم، والشعارات
  للكروت. النظام لا يخترع أيًّا منها.
- **المستخدمون** (القائمة ← **إدارة المستخدمين** `/users`): «إنشاء مستخدم» باسم مستخدم وكلمة مرور أولى يُطلب تغييرها عند أول
  دخول، وصفته في القسم (مدير نظام، مساعد، مشرف، مشرف مراقبة) ومنصبه. لا تُعرض كلمة مرور أحد أبدًا؛ «تعيين كلمة مرور جديدة» ينهي
  جلساته. كل تغيير مسجّل في سجل التدقيق.
- **مدير النظام لقسم**: أنشئ المستخدم بصفة «مدير النظام»، أو من **إدارة النظام ← الأقسام** ← القسم ← «المديرون».
- **ملّاك آخرون**: **إدارة النظام ← الملّاك** (لا يبقى النظام بلا مالك).
- **قسم جديد**: **إدارة النظام ← الأقسام ← إنشاء** — قسم فارغ تمامًا بإعداداته المحايدة ومعزول عن غيره. عندها يظهر منتقي
  الأقسام والتبديل من قائمة الاسم. حذف القسم = **أرشفة** (لا يُحذف شيء، ويمكن الاستعادة).
- **التسجيل الذاتي**: من صفحة الدخول ← «قدّم طلب تسجيل»؛ الطلبات تصل إلى مديري القسم والملّاك في «الطلبات».
- **الجوال**: افتح الرابط في Safari أو Chrome ← «تثبيت التطبيق» (أندرويد) أو «أضف إلى الشاشة الرئيسية» (آيفون، الدليل داخل
  النظام في «المزيد»).

<a id="14"></a>
## ١٤. النسخ الاحتياطي والاستعادة

- **تلقائي يوميًّا** في `BACKUP_TIME` (الافتراضي 02:00 UTC = 05:00 الرياض): `pg_dump` ← تشفير gpg AES-256 ← فحص قراءة النسخة
  ← حفظ في القرص (`backups`) لمدة `BACKUP_RETENTION_DAYS` (١٤ يومًا) ← رفع إلى `nuzli-backups`.
- **الملفات (الصور والمرفقات)** في دلو `nuzli-files` وليست في النسخة: يحميها تفعيل Versioning (§7-أ).
- **نسخة يدوية الآن والتحقق منها** (افعلها بعد أول دخول، وقبل كل تحديث كبير):
  ```bash
  docker compose exec backup backup.sh
  docker compose exec backup ls -l /backups
  docker compose exec backup restore.sh /backups/<newest>.dump.gpg --verify    # يجب أن يطبع verify OK
  ```
- **تمرين استعادة شهري** (ومعه اختبار ملف تالف) واستعادة فعلية خطوة بخطوة: `docs/backup-restore.md` §2 و§3.
  الاستعادة تكتب في قاعدة جديدة ولا تمسّ القاعدة الحيّة إلا في التبديل الأخير.
- **تدوير مفتاح الهوية** (سنويًّا أو عند الشك): `docs/backup-restore.md` §4.

<a id="15"></a>
## ١٥. التحديثات

```bash
cd /opt/nuzli/app
docker compose exec backup backup.sh                     # نسخة قبل التحديث
git pull --ff-only
sed -i "s|^NUZLI_VERSION=.*|NUZLI_VERSION=$(date +%Y.%m.%d)|" .env
docker run --rm -v "$PWD":/w -v /opt/nuzli/certs:/opt/nuzli/certs:ro -w /w node:20-alpine node scripts/preflight.mjs
docker compose up -d --build
docker compose ps && docker compose logs --tail=50 api
```

- **الترحيلات تلقائية**: الخادم يشغّل `prisma migrate deploy` ثم البذرة (لا تغيّر البذرة شيئًا موجودًا) عند كل تشغيل؛ والترحيل
  يعمل في معاملة واحدة ويتراجع كاملًا عند أي خطأ.
- **الأجهزة**: التطبيق المثبّت يفحص التحديث عند الفتح وكل نصف ساعة، ويُظهر شريط **«تحديث متاح — حدّث الآن»**؛ ومن «المزيد» ←
  «البحث عن تحديث». المخالفات غير المرسلة تبقى على الجهاز عبر التحديث.
- **الرجوع إلى إصدار سابق** (إن لم يكن فيه ترحيل جديد): `git checkout <previous-commit>` ثم `NUZLI_VERSION=<previous>` في `.env`
  ثم `docker compose up -d --build`. إن كان فيه ترحيل: استعد النسخة التي أخذتها قبل التحديث (`docs/backup-restore.md` §2).
- تنظيف الصور القديمة أحيانًا: `docker image prune -f`.

<a id="16"></a>
## ١٦. المراقبة

| ماذا | الأمر أو المكان |
|---|---|
| حالة الخدمات | `docker compose ps` (كلها `healthy`) |
| الحياة والجاهزية | `https://<domain>/api/v1/health` و`/api/v1/ready` (قاعدة البيانات + التخزين) و`/healthz` (الوكيل) |
| مراقبة خارجية | OCI **Monitoring ← Health Checks** (HTTP، كل دقيقة) على `https://<domain>/api/v1/ready` مع تنبيه بالبريد |
| السجلات | `docker compose logs -f api` (JSON مع رقم الطلب؛ لا أرقام هوية ولا كلمات مرور) — تُدوَّر تلقائيًّا ٥×٢٠ MB لكل خدمة |
| النسخ الاحتياطية | `docker compose logs backup \| tail` وملفات اليوم في الدلو `nuzli-backups` |
| القرص | `df -h /` و`docker system df` |
| الشهادة | `sudo certbot certificates` (تاريخ الانتهاء) — التجديد تلقائي |
| الموارد | `docker stats --no-stream` |

<a id="17"></a>
## ١٧. استكشاف الأخطاء

| العَرَض | السبب الأرجح والإصلاح |
|---|---|
| الصفحة لا تفتح من الخارج | قائمة الأمان في OCI أو `iptables` (§3)؛ `docker compose ps` للوكيل؛ `sudo ss -ltnp \| grep -E ':80\|:443'` |
| الوكيل يعيد التشغيل باستمرار | الشهادة مفقودة أو غير مقروءة: `ls -l /opt/nuzli/certs` و`docker compose logs proxy` (`cannot load certificate`)؛ صلاحيات §6 |
| الخادم `unhealthy` أو يتوقف فورًا | `docker compose logs api`: «Invalid environment configuration» = متغيّر ناقص أو ضعيف (شغّل §10)؛ «bypasses Row Level Security» = `APP_DATABASE_URL` ليس `nuzli_app`؛ «password authentication failed» = كلمة مرور قاعدة البيانات مختلفة بين `env/db.env` و`env/api.env` |
| غيّرت `POSTGRES_PASSWORD` بعد أول تشغيل | Postgres يقرؤها مرة واحدة عند إنشاء القرص. غيّرها داخل القاعدة: `docker compose exec db psql -U nuzli -d nuzli -c "ALTER ROLE nuzli PASSWORD '<new>'"` ثم حدّث الملفات الثلاثة |
| لا توجد كلمة المرور المؤقتة في السجل | السجل دُوِّر أو أُنشئ المالك سابقًا: `owner:recover --reset-password` (§12-5) |
| `/ready` يعطي `storage: false` | `S3_ENDPOINT`/`S3_REGION` غير متطابقين، أو المفتاح خاطئ، أو السياسة لا تشمل الدلو، أو الحجيرة المعتمدة لواجهة S3 (§7-ج) |
| رفع الصور يفشل في المتصفح (CORS أو 403) | أمر CORS في §11-5؛ ساعة الخادم (`timedatectl` يجب أن يكون متزامنًا)؛ الرابط الموقّع ينتهي بعد ٥ دقائق |
| لا تصل رسائل البريد | `SMTP_*` في `env/api.env`، ومنفذ 587/465 مسموح للخروج، و`docker compose logs api \| grep -i mail` |
| استيراد ‎.mpp يردّ 501 | `CONVERTER_URL` فارغ (اختياري) أو حاوية المحوّل متوقفة: `docker compose ps converter` |
| فشل النسخة الاحتياطية | `docker compose logs backup`: عبارة التشفير قصيرة، أو مفاتيح `BACKUP_S3_*`، أو سياسة الدلو (§8) |
| امتلاء القرص | `docker system df`، و`docker image prune -f`، وخفّض `BACKUP_RETENTION_DAYS` |

<a id="18"></a>
## ١٨. قائمة التحقق قبل الإطلاق

- [ ] الخادم بحجمه المقترح، والعنوان العام **محجوز**، وSSH من عنوانك فقط.
- [ ] المنافذ المفتوحة 80 و443 فقط (قائمة الأمان و`iptables`).
- [ ] سجلّ DNS يشير إلى الخادم، و`https://<domain>` بقفل صحيح، و`certbot renew --dry-run` ناجح.
- [ ] دلو `nuzli-files` **خاص** ومعه Versioning وقاعدة حذف `pending/` بعد يوم؛ مفتاح التطبيق مقصور على هذا الدلو.
- [ ] دلو `nuzli-backups` منفصل بقاعدة احتفاظ، ومفتاحه بلا حذف، و`BACKUP_S3_ENABLED=true`.
- [ ] `scripts/preflight.mjs` يطبع «✓ جاهز للنشر».
- [ ] عبارة تشفير النسخ ومفتاحا الهوية محفوظة **خارج الخادم**.
- [ ] `docker compose ps`: كل الخدمات `healthy`؛ و`/api/v1/ready` يعطي `db: true` و`storage: true`.
- [ ] `nuzli_app | t | f | f` (RLS فعّال، §11-4).
- [ ] اختبار CORS للدلو ناجح (§11-5)، ورفع صورة فعلي من جوال (تسجيل مخالفة بصورة).
- [ ] أول دخول بـ `mmansary` وتغيير كلمة المرور، وتحديث بريد المالك وجواله الحقيقيين.
- [ ] `BOOTSTRAP_OWNER_PASSWORD` فارغ في `env/api.env` (أو حُذف بعد أول دخول).
- [ ] نسخة احتياطية يدوية و`restore.sh … --verify` = `verify OK`، وظهور الملف في `nuzli-backups`.
- [ ] رسالة بريد تجريبية وصلت (مثل «نسيت كلمة المرور» لمستخدم تجريبي ثم حذفه).
- [ ] البيانات المرجعية الحقيقية أُدخلت (الإدارات، المسمّيات، أنواع المخالفات، الإجازات، الشعارات).
- [ ] مراقبة خارجية على `/api/v1/ready` بتنبيه بريدي.
- [ ] طباعة كرت فعلية على طابعة Zebra بمقاسَي CR80 و٩٠×٤٠ (`docs/printing.md`).

---

مراجع: `docs/deployment-rls.md` (الدوران وRLS واستعادة المالك)، و`docs/backup-restore.md` (النسخ والاستعادة وتدوير المفاتيح)،
و`infra/certs/README.md` (الشهادات في التطوير)، و`docs/STATUS.md` (ما جُرِّب وما ينتظر الخادم الحقيقي).
