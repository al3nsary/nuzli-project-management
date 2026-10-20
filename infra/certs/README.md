# شهادات TLS

HTTPS إلزامي حتى في التطوير (الكاميرا والموقع وعامل الخدمة لا تعمل إلا في سياق آمن — §3.1).
يقرأ الوكيل (nginx) ملفّين من هذا المجلد (أو من `CERTS_DIR`):

| الملف | المحتوى |
|---|---|
| `fullchain.pem` | الشهادة مع السلسلة الوسيطة |
| `privkey.pem` | المفتاح الخاص |

ملفات `*.pem` مستثناة من git ومن سياق بناء Docker — لا تُرفع أبدًا.

## التطوير: mkcert (شهادة محلية موثوقة)

1. ثبّت [mkcert](https://github.com/FiloSottile/mkcert):
   - Windows: `choco install mkcert` أو `scoop install mkcert`
   - macOS: `brew install mkcert nss`
   - Linux: من صفحة الإصدارات، ثم `sudo apt install libnss3-tools`
2. من جذر المستودع:
   ```sh
   sh scripts/dev-certs.sh                    # localhost فقط
   sh scripts/dev-certs.sh 192.168.1.20 nuzli.lan   # + عنوان الجهاز على الشبكة لتجربة الجوال
   ```
   يثبّت السكربت جهة الإصدار المحلية (`mkcert -install`) ثم يكتب `fullchain.pem` و`privkey.pem` هنا.
3. **الجوال:** لتجربة التسجيل الميداني من هاتف على الشبكة نفسها، ثبّت ملف `rootCA.pem`
   (مساره: `mkcert -CAROOT`) على الهاتف ووثّق به:
   - iOS: أرسل الملف إلى الهاتف ← ثبّت الملف التعريفي ← الإعدادات ← عام ← حول ← إعدادات الثقة بالشهادات.
   - Android: الإعدادات ← الأمان ← تثبيت شهادة ← شهادة CA.
   ثم اضبط `DEV_PUBLIC_ORIGIN=https://192.168.1.20` في `.env` لتعمل روابط رفع الصور.

## الإنتاج

الخطوات الكاملة القابلة للنسخ في `docs/deployment-oci.md` §6. الخلاصة:

- **Let's Encrypt بـ certbot في الوضع المستقل (standalone)** على المنفذ 80، مع خطّافين يوقفان الوكيل `proxy` ويعيدانه عند
  التجديد، وخطّاف نشر (`/usr/local/bin/nuzli-cert-deploy`) **ينسخ** الملفين إلى مجلد عادي `/opt/nuzli/certs`، ثم
  `CERTS_DIR=/opt/nuzli/certs` في `.env`.
- **لا تضبط `CERTS_DIR` على `/etc/letsencrypt/live/<النطاق>`:** ملفاته روابط رمزية إلى `../../archive/…` لا تُرى داخل
  الحاوية (تُركَّب المجلد وحده)، فيفشل nginx في التشغيل.
- **شهادة مقدَّمة من الجهة:** ضع `fullchain.pem` (الشهادة ثم السلسلة الوسيطة) و`privkey.pem` في `/opt/nuzli/certs`.
- الصلاحيات: يقرأ الملفين المستخدم `101` (nginx غير الجذري): `chown root:101`، و`chmod 644` للشهادة و`640` للمفتاح.
- `scripts/preflight.mjs` يتحقق قبل التشغيل من وجود الملفين وتطابق المفتاح والشهادة وتغطيتها للنطاق ومدة صلاحيتها.
