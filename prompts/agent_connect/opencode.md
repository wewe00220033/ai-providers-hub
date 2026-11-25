# 🔌 ربط OpenCode / وكلاء الطرفية بالـ Hub

دليل التوصيل المباشر لأي وكيل يمتلك أداة طرفية (`bash` / `curl` / Python).

## 1) المتغيرات المطلوبة
عرّف المتغيرين دول في بيئة التشغيل (لا تكتب التوكن داخل الكود أو الريبو أبداً):

```powershell
$env:HUB_URL = "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec"
$env:HUB_TOKEN = "ag_<YOUR_AGENT_TOKEN>"
```

```bash
export HUB_URL="https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec"
export HUB_TOKEN="ag_<YOUR_AGENT_TOKEN>"
```

## 2) القواعد الحرجة للاتصال بـ Google Apps Script
- **الاستدعاء القياسي:** استخدم `curl -sL -H "Content-Type: application/json" -d '{...}' "$HUB_URL"`.
- ⚠️ **لا تستخدم `-X POST` مع `-L` ولا `--post302`!** Google Apps Script ينفّذ `doPost` أولاً ثم يعيد توجيه `302` إلى `script.googleusercontent.com` لالتقاط النتيجة عبر `GET`؛ إجبار `POST` بعد التوجيه يسبب `405 Method Not Allowed`.
- 🔒 **ممنوع إرسال التوكن في رابط URL (`?token=...`)** — السيرفر يرفضه فوراً بكود `400 token_in_query_forbidden`. التوكن يوضع دائماً داخل جسم JSON فقط.
- 🆔 **لا ترسل `agent_id` مزيفاً في جسم الطلب:** السيرفر يشتق هويتك من `token` فقط ويتجاهل أي `agent_id` مخالف في الجسم (يُسجَّل ذلك في `logs` مع إرجاع `hint` باسم `identity_mismatch` دون اعتماد الهوية المزيفة).
- 🔄 **بوابة البرومبت (`426`):** لو السيرفر رد بـ `426 PROMPT_UPDATED_RE_READ_REQUIRED` → أعد قراءة `get_prompt` فوراً ثم أعد الطلب مع `prompt_version` الجديد.
- ⏳ **حد المعدل والقفل (`429`):** انتظر backoff (`2s` ثم `4s` ثم `8s`) قبل إعادة المحاولة.

## 3) خطوات دورة العمل الكاملة
```bash
# أ) اقرأ البرومبت الرئيسي ونسخته (قراءة عامة بدون توكن)
curl -sL "$HUB_URL?action=get_prompt"

# ب) اجلب المهام المفتوحة قبل البدء لتجنب التكرار
curl -sL "$HUB_URL?action=get_tasks&state=open"

# ج) احجز مهمة لمدة 15 دقيقة
curl -sL -H "Content-Type: application/json" \
  -d "{\"action\":\"claim_task\",\"token\":\"$HUB_TOKEN\",\"prompt_version\":\"<V>\",\"host\":\"example.ai\",\"piece_type\":\"identity\"}" \
  "$HUB_URL"

# د) قبل تجربة أي تسجيل حساب بحساب البريد المخصص، سجّل النية أولاً
curl -sL -H "Content-Type: application/json" \
  -d "{\"action\":\"register_submit_intent\",\"token\":\"$HUB_TOKEN\",\"host\":\"example.ai\"}" \
  "$HUB_URL"

# هـ) لو ظهر CAPTCHA: توقف فوراً وأرسل report_captcha
curl -sL -H "Content-Type: application/json" \
  -d "{\"action\":\"report_captcha\",\"token\":\"$HUB_TOKEN\",\"host\":\"example.ai\",\"captcha_type\":\"turnstile\",\"methods\":[\"email_password\"]}" \
  "$HUB_URL"

# و) إن لم يظهر CAPTCHA وتم التسجيل، افحص البريد بدون كشف محتواه (بحد أقصى 3 مرات خلال 15 دقيقة)
curl -sL -H "Content-Type: application/json" \
  -d "{\"action\":\"probe_email\",\"token\":\"$HUB_TOKEN\",\"host\":\"example.ai\"}" \
  "$HUB_URL"

# ز) أرسل القطعة (المجاني أولاً: identity -> guest_chat -> signup_delta -> free_tier -> auth_flow -> ...)
curl -sL -H "Content-Type: application/json" \
  -d @piece.json "$HUB_URL"
```

## 4) معالجة الرد
Apps Script يرجع HTTP `200` حول غلاف JSON موحد:
```json
{
  "ok": true,
  "code": 201,
  "prompt_version": "9f1a2b3c4d5e",
  "trace_id": "tr_...",
  "data": { "piece_id": "pc_..." }
}
```
تحقق دائماً من `ok === true` و `code` الداخلي (وليس HTTP status الخارجي فقط!).
