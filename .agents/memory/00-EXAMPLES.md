# 📚 Reference Implementations — `ai-providers-hub`

## 1. Google Apps Script Web App (`POST` -> `302` Redirect -> JSON Envelope)
- Apps Script ينفّذ `doPost(e)` أولاً ثم يرد بتحويل `302` إلى رابط لمرة واحدة على `script.googleusercontent.com` لا يقبل إلا `GET`.
- **القاعدة القياسية في `curl`:** استخدم `curl -sL -H "Content-Type: application/json" -d @body.json "$HUB_URL"` — **ممنوع `-X POST` أو `--post302`** مع `-L`.
- **القاعدة القياسية في الكود:** تحقق دائماً من `(res.get("ok") is True and res.get("code") in (200, 201))` وليس HTTP status الخارجي فقط (Apps Script يرجع HTTP `200` دائماً حتى في أخطاء `400/401/403/426/429`).
- **أمان التوكن (`CWE-598`):** التوكن يُرسل داخل JSON `body.token` فقط في `POST`، ويُرفض فوراً بأي استعلام URL (`hasTokenInQuery_` + `probeHasQueryAuth_`).

## 2. Gmail Search Window (`after:<epoch>` بدلاً من `newer_than:20m`)
- في لغة بحث Gmail، اللاحقة `m` داخل `newer_than:20m` تعني **months (أشهر)** وليست دقائق! الوحدات المدعومة فقط هي `d` و`m` و`y`.
- لنوافذ الدقائق المحدودة (مثل 20 دقيقة) استخدم دائماً:
  ```javascript
  var afterEpochSec = Math.floor((Date.now() - WINDOW_MINUTES * 60000) / 1000);
  var query = 'after:' + afterEpochSec + ' in:anywhere to:' + targetEmail;
  ```
  مع الإبقاء على فلتر الميلي ثانية الدقيق في JS أثناء فحص الرسائل (`in:anywhere` ضروري للوصول لرسائل `Spam` الشائعة في OTP وMagic Links).

## 3. Atomic Quota Reservation Outside `LockService` Before `UrlFetchApp`
- استدعاء `UrlFetchApp.fetch` داخل قفل `LockService` يحجز خيوط التنفيذ ويسبب تعطل السباق، لكن تأجيل زيادة العداد إلى ما بعد `UrlFetchApp` يفتح ثغرة سباق TOCTOU تتجاوز الحد المسموح (`PROBE_MAX`).
- **النمط المعتمد في `Code.gs` (`act_probe_email_`):**
  1. تحقق من صلاحية المضيف (`normalizeHost_` + `isBlockedHost_`).
  2. داخل قفل قصير (`MICRO_LOCK_MS`) + `try ... finally { lock.releaseLock(); }`: تحقق من النية والملكية والحد الأقصى، ثم تأكد من وجود الإعدادات (`GMAIL_PROBE_URL`, `SHARED_SECRET`) دون كشفها لغير المصرح لهم، ثم احجز العداد فوراً (`setCells_`).
  3. **بعد** تحرير القفل بالكامل، وقّع الطلب بـ HMAC (`host|agent_id|ts_utc|nonce`) ونفّذ `UrlFetchApp.fetch`.
  4. بعد عودة النتيجة، حدّث نتيجة التحقق فقط عبر `microUpdate_`.
