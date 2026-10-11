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

- **Let's Encrypt:** أصدر الشهادة بـ certbot (أسلوب webroot على `/.well-known/acme-challenge/`
  الذي يخدمه المنفذ 80، أو أسلوب DNS)، ثم اضبط في `.env`:
  `CERTS_DIR=/etc/letsencrypt/live/<النطاق>` — يحتوي `fullchain.pem` و`privkey.pem` بالأسماء نفسها.
  بعد كل تجديد: `docker compose exec proxy nginx -s reload`.
- **شهادة مقدَّمة من الجهة:** ضع الملفين بالأسماء أعلاه في مجلد خارج المستودع واضبط `CERTS_DIR` عليه.
- يجب أن يقرأ المستخدم `101` (nginx غير الجذري) المفتاح الخاص: `chmod 640` مع مجموعة مناسبة، أو `644` على خادم مخصّص.
