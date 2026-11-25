# 🚀 دليل النشر الصباحي السريع (~5 دقائق) — AI Providers Puzzle Hub

المشروع ده جاهز ومختبَر محلياً بالكامل لتشغيل **بنك معلومات مزوّدي الموديلات** بتكلفة **\$0** على **Google Sheets + Google Apps Script + Public GitHub Repo + GitHub Pages**.

> ℹ️ **ملاحظة حالة التسليم:** نموذج `Fable 5.1` وافق رسمياً على الخطة (`PLAN.md` و `TASKS.json`) وعلى دفعات `D1` و `D2-1` و `D2-2_fixed` قبل انتهاء صلاحية جلسة Upstage المحلية (`HTTP 401` الساعة `04:59 ص`). استكمل وكيل `Antigravity` الدفعات المتبقية (`D2-3` و `D3` و `D4`) وتمت مراجعتها والتحقق منها عبر الاختبارات المحلية ومراجع قراءة مستقل.

---

## 📌 القرارات المعمارية المحسومة

- **الاستضافة المجانية بالكامل (`OD1` + `OD2`):** مستودع GitHub عام (`Actions` غير محدودة بالأحداث `push / pull_request / workflow_dispatch` بدون `cron`) مع **Google Apps Script + Google Sheets** كبوابة كتابة مركزية.
- **قفل البريد المعزول (`OD3`):** مشروع `GmailProbe.gs` منفصل كلياً على حساب **`jdpx6218@gmail.com`** بصلاحية قراءة فقط (`gmail.readonly`) بدون أي وصول لجداول البيانات أو توكنات GitHub، وبردود مصنّفة فقط (`otp` | `magic_link` | `none`) دون تسريب أي نص أو كود تحقق.
- **قواعد البرومبت والكتالوج الموحدة:**
  - الترتيب الإلزامي للجمع: **المجاني أولاً** (`identity -> guest_chat -> signup_delta -> free_tier -> auth_flow -> paid_pricing -> referrals`) مع تسجيل موديلات Free الإضافية وصيد أوضاع `Instant / Fast / Quick / Auto` وفحص `requires_card` و `auto_charges_after_trial`.
  - كروت مدمجة تبدأ بـ `🔗 الاستخدام:` وتختزل العائلات المكررة (`Fable 5 / 5.1 / 5.2`، `Opus 5.5`، `Mythos 5 / 5.1 / 5.2`، `Astra 6 / 6.2`) وتُخفي العائلات والأقسام الفارغة.

---

## 🛠️ خطوات النشر الحي (8 خطوات فقط)

### 1️⃣ إنشاء مستودع GitHub العام وتفعيله
- أنشئ مستودعاً عاماً جديداً على GitHub باسم **`ai-providers-hub`**.
- من داخل مجلد المشروع، ارفع الملفات إلى الفرع `main`:
  ```bash
  git init
  git branch -M main
  git add .
  git commit -m "init: AI Providers Puzzle Hub"
  git remote add origin https://github.com/<YOUR_GITHUB_USER>/ai-providers-hub.git
  git push -u origin main
  ```
- فعّل **GitHub Pages** من: `Settings -> Pages -> Build and deployment -> Source: GitHub Actions`.
- أنشئ **Fine-grained Personal Access Token (PAT)** من إعدادات حسابك في GitHub مقصوراً على مستودع `ai-providers-hub` فقط بصلاحية `Contents: Read & Write`، واحفظه مؤقتاً للخطوة 3.

### 2️⃣ إنشاء Google Sheet الرئيسي
- أنشئ Google Sheet جديد فارغ (مثلاً باسم `AI Providers Puzzle Hub`).
- انسخ **`SPREADSHEET_ID`** من رابط الشيت: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.

### 3️⃣ إعداد ونشر `Code.gs` (على حساب المالك)
- افتح المحرر من داخل الشيت: `Extensions -> Apps Script` (أو مشروع Apps Script مستقل على حسابك).
- في إعدادات المشروع (`Project Settings`): فعّل خيار **عرض ملف البيان `appsscript.json`**.
- انسخ محتوى `apps_script/appsscript.json` كما هو (التوقيت مضبوط على `Africa/Cairo` والوصول العام عبر `ANYONE_ANONYMOUS`).
- انسخ محتوى `apps_script/Code.gs` بالكامل مكان `Code.gs`.
- من `Project Settings -> Script Properties` أضف الخصائص الخمس التالية:
  - `SPREADSHEET_ID` = معرف الشيت من خطوة 2.
  - `GITHUB_OWNER` = اسم حسابك أو المنظمة على GitHub.
  - `GITHUB_REPO` = `ai-providers-hub`.
  - `GITHUB_PAT` = الـ PAT من خطوة 1.
  - `SHARED_SECRET` = كلمة سر عشوائية طويلة (32 حرفاً فأكثر؛ ستنسخ نفس القيمة لمشروع `GmailProbe` في خطوة 4).
- شغّل الدالة **`setupProduction`** من القائمة العلوية وامنح الصلاحيات المطلوبة عند أول تشغيل.
- **مهم جداً فوراً:** افتح `Execution Log` وانسخ الـ **12 توكن** (`agent_01` إلى `agent_10` + `owner` + `github_sync`) وخزّنهم في مكان آمن على جهازك — النظام لا يطبعهم مرة ثانية ولا يكتبهم في الشيت.
- انشر التطبيق: **`Deploy -> New deployment -> Web app`**:
  - `Execute as`: **Me**
  - `Who has access`: **Anyone**
- انسخ رابط Web App الناتج (**`HUB_URL`** الذي ينتهي بـ `/exec`).
- أضف الخاصية السادسة `WEBAPP_URL = <HUB_URL>` في `Script Properties` ثم شغّل `setupProduction` مرة سريعة أخرى حتى يظهر رابط `get_prompt` مكتوباً داخل الخلية `MASTER_PROMPT!D1`.

### 4️⃣ إعداد ونشر `GmailProbe.gs` (على حساب `jdpx6218@gmail.com`)
- افتح نافذة متصفح/بروفايل مسجل دخوله بحساب **`jdpx6218@gmail.com`** وأنشئ مشروع Apps Script جديد مستقل تماماً.
- فعّل إظهار `appsscript.json` ثم الصق:
  - `apps_script/GmailProbe.appsscript.json` (يطلب صلاحية `gmail.readonly` فقط).
  - `apps_script/GmailProbe.gs`.
- في `Project Settings -> Script Properties` داخل مشروع `GmailProbe`:
  - `SHARED_SECRET` = **نفس** السر الموضوع في `Code.gs`.
  - `TARGET_EMAIL` (اختياري؛ القيمة الافتراضية `jdpx6218@gmail.com`).
- انشره كـ Web App (`Execute as: Me`، `Who has access: Anyone`)، وانسخ رابط الـ `/exec` الخاص به.
- ارجع لمشروع **`Code.gs`** وأضف الخاصية السابعة في `Script Properties`:
  - `GMAIL_PROBE_URL` = رابط Web App بتاع `GmailProbe`.

### 5️⃣ ربط أسرار مستودع GitHub (`Actions Secrets`)
- في مستودعك على GitHub اذهب إلى `Settings -> Secrets and variables -> Actions -> New repository secret` وأضف السرّين بالاسمين الحرفيين التاليين (يطابقان `.github/workflows/validate-and-sync.yml`):
  - `HUB_URL` = رابط الـ Web App الرئيسي (`WEBAPP_URL` الخاص بـ `Code.gs`).
  - `HUB_SYNC_TOKEN` = توكن **`github_sync`** المنسوخ في خطوة 3.

### 6️⃣ تشغيل اختبار الدخان الحي (`live_smoke.py`)
بعد النشر، اختبر المسار الحي كاملاً ببيئتك قبل توزيع التوكنات:
```cmd
cd /d C:\Users\USER\.gemini\antigravity\scratch\ai-providers-hub
set HUB_URL=https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
set HUB_TEST_TOKEN=ag_<ONE_AGENT_TOKEN>
run_tests.cmd all
```
هذا الاختبار يمر على: `ping` ثم `get_prompt` ثم التأكد أن تمرير `?token=` في الرابط مرفوض (`400`) ثم إرسال قطعة اختبارية مرتين (`201` ثم `200 idempotent:true`) ثم فحص `list` بالصفحات. (لو تحب تسيب الشيت نظيف بعد التجربة احذف صف `smoke-canary` أو استخدم توكن تجريبي).

### 7️⃣ توصيل الوكلاء المتنوعين
جميع قوالب الربط جاهزة في مجلد [`prompts/agent_connect/`](prompts/agent_connect/):
- **OpenCode / طرفية:** [`prompts/agent_connect/opencode.md`](prompts/agent_connect/opencode.md)
- **Claude Desktop / Claude Code / عملاء MCP:** [`prompts/agent_connect/claude_mcp.md`](prompts/agent_connect/claude_mcp.md)
- **Custom GPT Actions:** [`prompts/agent_connect/custom_gpt_openapi.yaml`](prompts/agent_connect/custom_gpt_openapi.yaml)
- **سكريبتات Python / Node عامة:** [`prompts/agent_connect/generic_script.md`](prompts/agent_connect/generic_script.md)
- **تذكير:** تطبيقات الشات المغلقة على الموبايل التي بلا أدوات أو Actions تُستخدم **للقراءة فقط** عبر رابط GitHub Pages وملف `CATALOG.md` ولا تدخل حلقة الكتابة.

### 8️⃣ (اختياري) تجديد جلسة `Upstage` لو رغبت في توقيع `Fable 5.1`
- إذا أردت استكمال جلسة المراجعة مع `Fable 5.1` على `upstage_session.json` (التي توقفت بـ `401` فجر اليوم)، حدّث الكوكيز بتسجيل الدخول في المتصفح لـ `Upstage Studio` ثم نفّذ جولة مراجعة على `D2-3` و `D3` و `D4`.

---

## 🧪 بنود تحتاج فحصاً حياً بعد النشر (`[يحتاج فحص حي]`)
تم اختبار المنطق الكامل محلياً عبر `unittest` + `node:test` + محاكي `gas_mocks.js` + `validate_piece.py`، لكن البنود الآتية تعتمد على بيئة جوجل وجيتهب الحية ولا يمكن محاكاتها 100% دون اتصال حي:
- `[يحتاج فحص حي]` إعادة التوجيه الفعلية `302` من `script.google.com` إلى `script.googleusercontent.com` لعملاء External مثل **Custom GPT Actions** (عميل `curl -sL` و`urllib` و`fetch` مهيّأة لها بالفعل).
- `[يحتاج فحص حي]` تشغيل أول `GitHub Actions` workflow (`validate-and-sync.yml` ثم `pages.yml`) بعد أول PR/Push للتأكد من صلاحيات `GITHUB_TOKEN` والنشر الأول لـ GitHub Pages.
- `[يحتاج فحص حي]` استقبال رسالة OTP/Magic Link فعلية في صندوق `jdpx6218@gmail.com` وفحص زمن استجابة `GmailApp.search("after:<epoch> in:anywhere ...")` الفعلي (قد يتأخر فهرس Gmail 10–30 ثانية بعد وصول الرسالة).
- `[يحتاج فحص حي]` ضبط حد `urlFetch` وحجم الكاش الفعلي على حساب جوجل الخاص بك عند العمل المتزامن من عدة وكلاء في نفس اللحظة.
