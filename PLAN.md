# 📐 PLAN.md — AI Providers Puzzle Hub (خطة الهندسة 360° — Lock360 v3.0)

> **الحالة:** `LOCKED_FOR_EXECUTION` (الجولة 3 — مُقفلة بعد تدقيق `Antigravity` وحسم `OD1/OD2/OD3` بتفويض المالك). التنفيذ يبدأ من `D1.T1`.
> **المرجع الحاكم:** `SPEC_AND_MEMORY.md` (التحديثات 1 → 6). أي تعارض بين هذا الملف والـ SPEC يُحسم لصالح الـ SPEC ويُسجَّل في `DUET_LOG.md`.
> **قاعدة RTL-Safe:** لا جداول `| col |` في هذا الملف؛ كل الهياكل كقوائم رأسية.
> **سجل الإصدار:** v1 مسودة (02:05) → v2 مُقفلة بثماني إقفالات هندسية (§15).

---

## 0. بوابة الفهم (Q-Contract) — ما الذي نبنيه بالضبط؟

- **المنتج:** مركز سحابي مجاني `100%` (Google Sheets + Apps Script كواجهة أمامية، GitHub Public Repo كمصدر حقيقة) يستقبل من وكلاء موزعين «قطع بازل» موثقة بأدلة عن مزودي 9 موديلات، بدون تكرار مزود، بدون هلوسة، بدون أي عمل يدوي من المالك أثناء الجمع.
- **من يكتب:** فقط الوكلاء أصحاب أداة HTTP POST (OpenCode، سكريبتات، MCP، Custom GPT Actions، موصّلات) عبر بوابة واحدة. الشاتات المقفولة بلا أدوات = **قراءة فقط** (قرار المالك — تحديث 4).
- **من يملك المفاتيح:** لا وكيل يرى GitHub PAT ولا Service Account. الـ PAT يعيش في `PropertiesService` للحارس وفي GitHub Secrets فقط.
- **ما ليس في النطاق الآن:** التحديث الدوري التلقائي للأسعار، الواتساب، إضافات المتصفح، Cloudflare، أي تخطي لكابتشا، تطبيقات الموبايل كمزودين.
- **معيار النجاح النهائي للنسخة:** وكيلان مختلفان على الأقل يقدران يصبّان قطعاً لنفس المزود في نفس الثانية فتظهر قطعتان تحت مزود واحد في الشيت وفي `pieces/<host>/` على GitHub وفي `CATALOG.md` خلال ≤ 10 دقائق، وأي تعديل للمالك على الصف الأول (البرومبت) يُجبر الوكلاء على إعادة القراءة (`426`) فوراً، وأي خطأ يكتشفه المالك يُحوَّل لمهمة `blind_reverify` ويُخصم من `agent_scores` **وينعكس على GitHub عبر `reviews/`** في نفس اللحظة.

---

## 1. حقائق مُثبتة حياً تحكم التصميم (من `v0.1` + التحديث 5/6)

1. Apps Script Web App **لا يمرر هيدرز مخصصة** إلى `doPost/doGet` → التوكن يُرسل في جسم JSON (`token`) حصراً. **ممنوع نهائياً في Query String** (إقفال `CWE-598` — §3.1).
2. Apps Script **يرجع HTTP 200 دائماً** بعد `302` إلى `script.googleusercontent.com` → كل الأكواد المنطقية في حقل JSON `code`. أي عميل (وكيل أو `sync_to_sheet.py`) **لا يعتبر الطلب ناجحاً من HTTP 200** بل من `ok === true && code ∈ {200, 201}`.
3. `LockService.getScriptLock().waitLock(25000)` + فحص المزود داخل القفل = سباق متزامن أنشأ مزوداً واحداً و4 قطع مستقلة (مُثبت 10/10). **القفل يُمسك فقط لعمليات الشيت/الكاش ولا يُمسك أبداً أثناء أي مكالمة شبكية** (§3.9).
4. حدود مؤكدة: Apps Script `30` تنفيذ متزامن، `20,000 UrlFetchApp/يوم`، `90 دقيقة/يوم` مؤقتات، `6 دقائق/تنفيذ`، `CacheService 100KB/مفتاح`. GitHub: `5,000/ساعة` PAT، `1,000/ساعة` `GITHUB_TOKEN`، إنشاء محتوى ثانوي `80/دقيقة` و`500/ساعة`.
5. المستودع **Public** → دقائق Actions غير محدودة + GitHub Pages مجاناً، لكن Workflows تعمل عند الحدث فقط (`push / pull_request / workflow_dispatch`).

---

## 2. المعمارية النهائية (مخطط تدفق نصي)

- **الوكيل (أي قناة فيها HTTP POST)** ← `POST <WEB_APP_URL>` بجسم `{token, action, prompt_version, ...}`.
- **الحارس `apps_script/Code.gs` (حساب Google نظيف منفصل — تحديث 4):**
  - يصادق التوكن ← يشتق الهوية سيرفرياً ← يتحقق من `prompt_version` (`426`) ← **قفل قصير**: يطبّع الدومين، يمنع تكرار المزود، يُلحق القطعة بحالة `github_state=queued`، يحدّث أعمدة ملخص `providers`، يحرر القفل ← **خارج القفل**: يدفع للـ GitHub Contents API (`origin: "sheet"`) ← نجاح: تحديث ميكروي لـ `github_state=pushed` بقفل ≤ 2500ms ← فشل: صف في `github_outbox`.
- **GitHub Public Repo (مصدر الحقيقة):** `pieces/<canonical_host>/<agent_id>_<piece_id>.json` ملف لكل قطعة + **`reviews/<review_id>.json`** ملف لكل حدث مراجعة مالك (flag/resolve). كلاهما Add-Only لا يُعدَّل ولا يُحذف أبداً.
- **GitHub Actions `validate-and-sync.yml`:** عند `pull_request` يفحص `pieces/**` و`reviews/**` فقط بكود من فرع الأساس (عزل fork) ← عند `push(main)` يبني `CATALOG.md` + `docs/index.html` (تركيب `reviews/` فوق `pieces/`) ← للقطع ذات `origin: "github"` غير المسجلة يستدعي `POST action=sync_from_github` (توكن دور `sync`).
- **`apps_script/GmailProbe.gs` (حساب `jdpx6218@gmail.com` معزول):** Web App داخلي يقبل طلبات موقّعة HMAC من الحارس فقط ويرد `otp | magic_link | none`.
- **GitHub Pages (`docs/`):** كتالوج قراءة عام للمالك ولأي شات مقفول (قراءة فقط).

---

## 3. عقد الـ API الموحد — `apps_script/Code.gs` (D2)

### 3.1 غلاف الطلب والرد + سياسة GET/POST (إقفال `CWE-598`)
- **الطلب (POST لكل ما يحتاج توكن — كتابةً أو قراءةً):** `{ "token": "ag_...", "action": "<name>", "prompt_version": "<12-hex>", "client_ref": "<اختياري>", ...payload }`.
- **الرد الموحد:** `{ "ok": bool, "code": int, "action": "...", "agent": { "agent_id", "display_name", "role", "source_kind" }, "server_time_utc": ISO, "server_time_cairo": "yyyy-MM-dd hh:mm ص|م", "prompt_version": "...", "data": {...} | "error": "snake_case", "hint": "نص للوكيل" }`.
- **GET = قراءة عامة فقط بلا توكن:** `?action=ping` · `?action=get_prompt` · `?action=get_tasks&state=open` (بدون `excluded_agent_id` ولا `claimed_by`) · `?action=catalog_summary` (عدّادات فقط) · `?action=get_provider&host=...` (القطع النشطة بدون `tok_tail` وبدون `owner_correction` وبدون `payload_json` الخام الأطول من 2KB — ملخص فقط).
- **أي طلب GET أو POST يحمل `token` في Query String يُرفض فوراً بكود `400 token_in_query_forbidden`** ويُسجَّل في `logs` (قبل أي مصادقة؛ التوكن لا يُقرأ من Query إطلاقاً).
- **القراءة الموثقة عبر POST:** `list` (مُرقّم)، `get_tasks` الكامل، `get_provider` الكامل (مع `payload_json` و`tok_tail`)، `my_score`.

### 3.2 أكواد `code` المنطقية (في JSON)
- `200` نجاح/قراءة/idempotent · `201` إنشاء جديد · `400` جسم فاسد أو action مجهول أو `token_in_query_forbidden` · `401` توكن مفقود/باطل/ملغي · `403` الدور لا يملك الصلاحية أو `excluded_from_blind_task` أو `no_active_submit_intent` · `409` تعارض (`task_claimed` / `host_already_submitted`) · `422` فشل تحقق حتمي (مع `error` دقيق) · `426 PROMPT_UPDATED_RE_READ_REQUIRED` (مع `data.prompt` كامل + `data.prompt_version` الجديد) · `429` `lock_timeout_retry` / `agent_rate_limited` / `probe_limit_reached` (العميل يعيد بـ backoff 2s/4s/8s) · `500` خطأ داخلي مع `trace_id`.

### 3.3 الأدوار (مشتقة من التوكن فقط)
- `agent` (الافتراضي): `submit_piece`, `claim_task`, `release_task`, `complete_task`, `register_submit_intent`, `report_captcha`, `probe_email`, `heartbeat`, `list`, `get_tasks`, `get_provider`, `my_score`.
- `owner`: كل ما سبق + `flag_piece`, `resolve_review`, `set_prompt`, `issue_token`, `rotate_token`, `set_agent_label`, `revoke_token`.
- `sync` (توكن GitHub Actions فقط): `sync_from_github`, `heartbeat`, `list`.
- أي action خارج دور التوكن ← `403 role_not_allowed` + صف في `logs`.

### 3.4 الأكشنات (POST)
1. **`submit_piece`:** `{url|domain, display_name?, piece_type, model_tag?, channels[], summary, payload{}, evidence_url, evidence_excerpt (≤ 600 حرف اقتباس حرفي), confidence: "observed"|"inferred"}`.
   - **خارج القفل:** تطبيع + Validator (§6) + حساب `idempotency_key = sha256(agent_id|host|piece_type|canonicalJson_(payload))`.
   - **داخل القفل (`waitLock(25000)`, هدف ≤ 800ms):** مزود موجود؟ يعيد `provider_id` (لا صف جديد) → `idempotency_key` موجود؟ يحرر القفل ويرجع `200 idempotent:true` → وإلا يُلحق صف القطعة بـ `github_state=queued` + يولّد `piece_id` (ULID) + يحدّث أعمدة ملخص `providers` (§4) + يحدّث الكاش → **`lock.releaseLock()`**.
   - **خارج القفل:** دفع GitHub (§3.9) → الرد `201` مع `piece_id`, `github_path`, `github_state: pushed|queued`.
   - **قاعدة `canonicalJson_` الموحدة (Code.gs ≡ validate_piece.py ≡ tests):** ترتيب مفاتيح الكائنات أبجدياً (ترتيب نقاط الكود Unicode) **عودياً**، المصفوفات تحافظ على ترتيبها، بلا مسافات (`separators=(',', ':')`), `ensure_ascii=False` (UTF-8 خام)، الأرقام كما هي بدون `.0` زائدة، `null/true/false` حرفياً. الـ `sha256` يُحسب على بايتات UTF-8 للناتج. اختبار تطابق Node/GAS ↔ Python على أمثلة عربية ومتداخلة في `D4`.
2. **`claim_task`:** `{task_id | (host, piece_type)}` → داخل القفل: المهمة `open` أو `claimed` بعقد منتهٍ (`lease_until < now`) → تُمنح 15 دقيقة لـ `agent_id` → `201` مع `lease_until`. `excluded_agent_id == agent_id` ← `403 excluded_from_blind_task`. مُطالَب بها من غيرك ← `409 task_claimed` مع `lease_until`.
3. **`release_task` / `complete_task`:** `open` أو `done` (مع `piece_id`) أو `blocked` (`block_reason` من: `captcha | paywall | geo_block | site_down | not_found`).
4. **`register_submit_intent`:** `{host}` → `submit_log` موجود بأي حالة ← `409 host_already_submitted` مع النتيجة المسجلة → وإلا يسجل `{host, agent_id, intent_at, window_until=+15m, state: intent}` → `201`. **إلزامي قبل أي ملء نموذج.**
5. **`report_captcha`:** `{host, captcha_type}` → `submit_log.state = captcha_blocked` + قطعة `auth_flow` تلقائية بـ `captcha_detected:true` → `201`.
6. **`probe_email`:** `{host}` → يتطلب `intent` ساري لنفس الوكيل وإلا `403 no_active_submit_intent` → يوقّع HMAC ويستدعي `GmailProbe` **خارج القفل** → يخزن النتيجة في `submit_log` → `200`. الحد 3 استدعاءات لكل intent ثم `429 probe_limit_reached`.
7. **`flag_piece` (owner):** `{piece_id, owner_correction (خاص), blind_hint (عام محايد), severity: minor|major}` → داخل القفل: `owner_reviews` صف جديد → `pieces.status = needs_reverify` + `providers.status = needs_reverify` + تحديث `providers.owner_review_note` → `search_tasks` صف `blind_reverify` بـ `excluded_agent_id = piece.agent_id` + `blind_hint` → خصم `agent_scores` (§8) → حرر القفل → **خارج القفل: دفع `reviews/<review_id>.json` إلى GitHub** (§3.10) → `201`.
8. **`resolve_review` (owner):** `{review_id, resolved_by_piece_id}` → `owner_reviews.state=resolved`، القطعة القديمة `superseded`، لو طابقت `owner_correction` ← `+3` للوكيل المُصلِح → **دفع حدث `reviews/` بـ `action: resolve`** → `201`.
9. **`sync_from_github` (sync):** `{piece_id, path, piece{...}, origin: "github"}` → موجود؟ `200 idempotent` → وإلا يُلحق بـ `origin=github` و`github_state=pushed` (لا دفع عكسي) → `201`.
10. **`issue_token` (owner):** `{owner_label, display_name, role: agent|sync, source_kind}` → يولّد `ag_<uuid>` ويضيفه لـ `AGENT_TOKENS_JSON` → يرجع التوكن **مرة واحدة فقط في الرد** (لا يُكتب في أي تبويب) → `201`.
11. **`rotate_token` / `revoke_token` (owner):** `{agent_id}` → القديم `revoked:true` (يحتفظ بسجله للتدقيق) + جديد يُرجع مرة واحدة / أو إلغاء فقط → `201`.
12. **`set_agent_label` (owner):** `{agent_id, display_name?, owner_label?}` → تحديث السجل في `AGENT_TOKENS_JSON` + `agent_scores` → `200`.
13. **`set_prompt` (owner):** يكتب `MASTER_PROMPT!A1` ويشغّل نفس منطق `onEdit` (§3.5) → `200` مع `prompt_version` الجديد.
14. **`heartbeat` / `my_score`:** تسجيل نشاط / قراءة صف الوكيل من `agent_scores`.

### 3.5 بوابة `prompt_version` (`426`) + `onEdit(e)`
- المصدر: تبويب `MASTER_PROMPT` (**التبويب رقم 1 دائماً** — `setupProduction` ينقله للمقدمة) الخلية `A1` البرومبت الحي؛ `B1` = `prompt_version`؛ `C1` = آخر تحديث (Cairo `ص/م`)؛ `D1` رابط `GET ?action=get_prompt`.
- `prompt_version = sha256(trim(A1)).slice(0,12)`، كاش `CacheService` 60 ثانية (مفتاح `prompt:v`).
- **`onEdit(e)` (Simple Trigger):** لو `e.range` في تبويب `MASTER_PROMPT` وتشمل `A1` ← يعيد الحساب فوراً، يكتب `B1`/`C1`، ويمسح `prompt:v` من الكاش (تأخير 0 ثانية). `set_prompt` يستدعي نفس الدالة `refreshPromptVersion_()`.
- كل `submit_piece` و`claim_task` و`complete_task` يلزمها `prompt_version` مطابقة؛ عدم التطابق ← `426` + `data.prompt` كاملاً. `ping/get_prompt/list/heartbeat/my_score` معفاة.
- `dashboard_view` يعرض `B1` و`C1` مرجعياً بصيغة `=MASTER_PROMPT!B1`.

### 3.6 الهوية المشتقة من التوكن
- `AGENT_TOKENS_JSON` في `PropertiesService`: `{ "<token>": { "agent_id", "display_name", "owner_label", "role", "source_kind", "created_at", "revoked": false } }`.
- أي `agent_id` أو `display_name` يرسله الوكيل **يُتجاهل**؛ عند الاختلاف صف `logs` بـ `identity_mismatch` + `hint` في الرد.
- التوكنات لا تُطبع في الشيت أبداً؛ يُعرض `agent_id` + `display_name` + `tok_tail` (آخر 4) في القراءة الموثقة فقط (POST)، **ولا يظهر `tok_tail` في أي GET عام**.

### 3.7 التوقيت
- كل صف يحفظ `*_utc` (ISO) + `*_cairo`: `Utilities.formatDate(d, "Africa/Cairo", "yyyy-MM-dd hh:mm a")` ثم `AM→ص`، `PM→م`.

### 3.8 `CacheService` فوق 100KB (Chunking + Pagination)
- فهارس: `idx:providers` (host→provider_id)، `idx:aliases`، `idx:idem` (idempotency_key→piece_id)، `prompt:v`.
- التخزين: `idx:<name>:meta = {chunks: n, updated_utc}` + `idx:<name>:<i>` كل قطعة ≤ 90,000 بايت. القراءة تجمع القطع؛ فشل/غياب ← إعادة بناء من الشيت داخل القفل. الشيت أولاً ثم الكاش.
- `list`: `cursor` = رقم الصف، `limit ≤ 200`، يرجع `next_cursor` أو `null`.

### 3.9 الدفع إلى GitHub بدون إمساك القفل + `github_outbox` (إقفال السباق والكمون)
- **المبدأ الحاكم:** **ممنوع أي `UrlFetchApp` داخل `LockService`.** كل مكالمة شبكية (GitHub / GmailProbe) تجري بعد `releaseLock()`.
- التسلسل في `submit_piece`: (أ) صف القطعة يُكتب داخل القفل بـ `github_state=queued`؛ (ب) حرر القفل؛ (ج) `PUT https://api.github.com/repos/<owner>/<repo>/contents/pieces/<host>/<agent_id>_<piece_id>.json` بهيدر `Authorization: Bearer <PAT>` ورسالة `[hub-sync] piece <piece_id> <host> <piece_type>` مع `muteHttpExceptions:true` و`timeout` ضمني؛ (د) `201` أو `422 already exists` ← **تحديث ميكروي**: `waitLock(2500)` → ابحث عن صف `piece_id` (عبر الكاش `idx:idem` أو مسح عمود) → اكتب `github_state=pushed` + `github_sha` → حرر؛ (هـ) فشل GitHub (`403/429/5xx/timeout`) **أو** فشل الحصول على القفل الميكروي ← صف `github_outbox` `{piece_id, kind: piece|review, path, attempts:0, next_retry_utc, last_error}` (الإلحاق لا يحتاج قفلاً لأنه `appendRow` ذري على تبويب مستقل).
- `flushOutbox_()` مؤقت كل 10 دقائق: يعالج ≤ 25 صف بـ backoff أسي حتى 6 محاولات ثم `state=dead` + تنبيه في `dashboard_view`؛ لكل صف: PUT خارج القفل ثم تحديث ميكروي كما في (د). ميزانية ≤ 60 ثانية/تشغيل.
- منع الـ loop: `origin=github` لا يدخل الـ outbox أبداً؛ الـ Action يتجاهل الالتزامات `[hub-sync]`؛ `piece_id` فريد في الاتجاهين.

### 3.10 طبقة `reviews/` على GitHub (انعكاس مراجعات المالك — Add-Only Overlay)
- عند `flag_piece` و`resolve_review` يُدفع (خارج القفل، وعبر outbox عند الفشل بـ `kind: review`) ملف **`reviews/<review_id>.json`** بالشكل: `{ schema_version: 1, review_id, piece_id, provider_id, canonical_host, action: "flag"|"resolve", status: "needs_reverify"|"resolved", severity, blind_hint, resolved_by_piece_id|null, flagged_agent_id, created_at_utc, created_at_cairo }`.
- **ممنوع بنيوياً وجود `owner_correction` في أي ملف `reviews/`** — الحارس يبني الكائن من قائمة بيضاء من الحقول (لا ينسخ الصف)، واختبار في `D2` يثبت الغياب، و`validate_piece.py` يرفض أي ملف `reviews/` يحوي المفتاح.
- `build_catalog.py` يقرأ `reviews/*.json` ويطبّق آخر حدث لكل `piece_id` (بالترتيب الزمني `created_at_utc` ثم ULID) فوق `pieces/**` → حالة الكتالوج تطابق الشيت لحظياً.

---

## 4. هيكل تبويبات Google Sheet (12 تبويباً) + التنسيق الاحترافي

- **`MASTER_PROMPT` (التبويب رقم 1):** `A1` البرومبت · `B1` `prompt_version` · `C1` آخر تحديث Cairo · `D1` رابط `get_prompt`. تجميد الصف، خلفية صفراء فاتحة، لف نص، ارتفاع كبير، محمي للمالك.
- **`providers`:** `provider_id, canonical_host, display_name, status (new|in_progress|verified|needs_reverify|not_found), channels, usage_url, agents_contributed (مثال: خالد(2) · عباس(1)), models_found_compact (مثال: Fable 5/5.1 · Astra 6), free_summary, auth_summary, owner_review_note, first_seen_by, first_seen_at_utc, first_seen_at_cairo, pieces_count, last_piece_at_cairo, github_dir`.
  - الأعمدة الملخصة (`usage_url` → `models_found_compact` → `free_summary` → `auth_summary` → `owner_review_note` → `agents_contributed` → `pieces_count`) تُحدَّث داخل القفل عند `submit_piece` / `flag_piece` / `resolve_review` بدالة `recomputeProviderSummary_(provider_id)` تقرأ القطع النشطة لذلك المزود فقط. `free_summary` تُبنى من `guest_chat` + `free_tier` (مثال: `Guest: Auto/Fast بلا تسجيل · Free: Fable 5 (10 رسائل/يوم) · بطاقة: لا`). `auth_summary` من `auth_flow` (مثال: `Sign up: Email OTP · Google · GitHub | CAPTCHA: Turnstile | Probe: otp`). التعارض بين وكيلين يظهر كـ `⚠️ تعارض: <agent_a> vs <agent_b>` في `owner_review_note`.
- **`provider_aliases`:** `alias_host, provider_id, kind (redirect|mirror|subdomain), added_by, added_at_cairo`.
- **`pieces`:** `piece_id, provider_id, canonical_host, agent_id, display_name, tok_tail, piece_type, model_tag, channels, summary, payload_json, evidence_url, evidence_excerpt, confidence, status (active|needs_reverify|superseded), supersedes_piece_id, conflict_with, origin (sheet|github), idempotency_key, github_path, github_state (queued|pushed|dead), github_sha, created_at_utc, created_at_cairo`.
- **`claim_leases`:** `task_id, agent_id, lease_until_utc, lease_until_cairo, state (active|released|expired)`.
- **`search_tasks`:** `task_id, type (discover|fill_piece|blind_reverify), canonical_host, piece_type, state (open|claimed|done|blocked), blind_hint, excluded_agent_id, claimed_by, lease_until_utc, result_piece_id, block_reason, created_at_cairo, updated_at_cairo`.
- **`submit_log`:** `canonical_host, agent_id, state (intent|submitted|captcha_blocked|probed), captcha_type, probe_result (otp|magic_link|none|''), intent_at_utc, window_until_utc, probe_calls, updated_at_cairo`. **صف واحد لكل دومين للأبد.**
- **`owner_reviews`:** `review_id, piece_id, provider_id, flagged_agent_id, severity, owner_correction (عمود محمي ومخفي), blind_hint, state (open|resolved), reverify_task_id, resolved_by_piece_id, github_path, github_state, created_at_cairo, resolved_at_cairo`.
- **`agent_scores`:** `agent_id, display_name, owner_label, role, source_kind, pieces_submitted, verified_count, flagged_minor, flagged_major, blind_fixes, accuracy_pct, score, last_active_cairo, last_flag_cairo`.
- **`dashboard_view`:** صيغ فقط: `prompt_version` + آخر تحديث (مرجع `MASTER_PROMPT!B1/C1`)، عدد المزودين حسب الحالة، أعلى/أدنى وكلاء، outbox pending/dead، آخر 20 قطعة، عمر أقدم مهمة مفتوحة، أعلى 3 أنماط خطأ من `owner_reviews`.
- **`logs`:** `ts_utc, ts_cairo, agent_id, action, code, trace_id, detail`.
- **`github_outbox`:** `piece_id, kind (piece|review), path, attempts, next_retry_utc, last_error, state (pending|dead|done), updated_at_cairo`.
- **التنسيق في `setupProduction()`:** `MASTER_PROMPT` يُنقل للموضع 1؛ تجميد الصف الأول في كل تبويب، رؤوس داكنة بنص أبيض عريض، لف النصوص، عرض أعمدة مناسب، تنسيق شرطي (`verified` أخضر، `needs_reverify` أحمر، `claimed` أصفر، `dead` أحمر داكن، `queued` رمادي)، حماية `MASTER_PROMPT` و`owner_reviews` للمالك، إخفاء عمود `owner_correction`، إنشاء مؤقت `flushOutbox_` إن لم يوجد. idempotent.

---

## 5. عقد ملفات GitHub + `schemas/` (D1)

- **القطع:** `pieces/<canonical_host>/<agent_id>_<piece_id>.json` (ULID 26 حرفاً Crockford base32، سيرفري).
- **المراجعات:** `reviews/<review_id>.json` (§3.10) — `schemas/review_event.schema.json` بقائمة حقول بيضاء و`additionalProperties: false` (فيرفض `owner_correction` تلقائياً).
- **الشكل القياسي للقطعة (`schemas/piece.base.schema.json`):** `{ schema_version: 1, piece_id, provider: {provider_id, canonical_host, display_name}, agent: {agent_id, display_name, source_kind}, piece_type, model_tag: <enum 9 | null>, channels: [<enum 6>], summary, payload: {...}, evidence: {url, excerpt, captured_at_utc}, confidence: observed|inferred, origin: sheet|github, created_at_utc, created_at_cairo }`.
- **مخططات الأنواع (`schemas/types/*.schema.json`):** `identity`, `guest_chat`, `signup_delta`, `free_tier`, `auth_flow`, `paid_pricing`, `referrals`, `not_found` + `_generic`.
  - **`guest_chat`:** `works_without_signup: bool`, `mode: instant|fast|quick|auto|model_select|unknown`, `models_named: [string]`, `free_credits_or_quota: string`, `requires_card: bool`, `auto_charges_after_trial: bool|null`, `none_found: bool`, `limits_notes`.
  - **`free_tier`:** `exists: bool`, `includes_target_models: bool`, `models_named: [string]`, `free_models_other: [string]`, `free_credits_or_quota: string`, `requires_card: bool`, `auto_charges_after_trial: bool|null`, `how_to_use: string`, `none_found: bool`.
  - **`signup_delta`:** `credits_increase: bool|null`, `unlocked_models: [string]`, `notes`.
  - **`auth_flow`:** `flow: signup|login`, `methods: [enum]`, `oauth_providers: [enum]`, `captcha: {detected, type}`, `probe_result` (سيرفري فقط).
- **ثوابت (`schemas/enums.json`):** الموديلات الـ 9 بالأسماء الكاملة + خريطة العرض المضغوط حسب العائلة (`Claude Fable` → `Fable 5 / 5.1 / 5.2`, `Claude Opus` → `Opus 5.5`, `Claude Mythos` → `Mythos 5 / 5.1 / 5.2`, `GPT Astra` → `Astra 6 / 6.2`)، القنوات الست، أنواع الكابتشا، طرق التسجيل، `block_reason`.
- **`prompts/master_prompt.md`:** نفس `MASTER_PROMPT!A1`؛ قاعدة «اقتباس حرفي أو `not_found`»؛ ترتيب الكارت (§5.1).

### 5.1 أسلوب الكروت المعتمد (من `messages.html` `[message172019]` + `[message172037]`)
- السطر الأول بعد عنوان المزود: **`🔗 الاستخدام: <usage_url>`**.
- ثم كتلة **المجاني أولاً**: `🆓 بدون تسجيل:` (`guest_chat` — الوضع `Instant/Fast/Quick/Auto` أو اختيار موديل + الموديلات بالاسم + الرصيد) ← `🎁 الباقة المجانية:` (`free_tier` — الموديلات المستهدفة الموجودة + `free_models_other` بالاسم + الرصيد/الحصة + `بطاقة: نعم/لا` + `سحب تلقائي بعد التجربة: نعم/لا/غير معروف` + كيفية الاستفادة) ← `📈 بعد التسجيل:` (`signup_delta`).
- ثم `🔐 التسجيل والدخول:` (`Sign up` vs `Login` + الطرق + أزرار OAuth + `CAPTCHA: <type>` + `Probe: otp|magic_link|none`).
- ثم `💳 المدفوع:` ثم `🤝 الإحالات:`.
- تجميع الموديلات مضغوطاً بلا تكرار العائلة؛ أي عائلة/مجموعة فارغة **تُخفى تماماً** (لا «غير متوفر»)؛ لا حشو؛ القنوات من الست فقط؛ `⚠️ تعارض` و`🔁 يحتاج إعادة فحص` كعلامات حالة من `reviews/`.

---

## 6. الـ Validator الحتمي (0 توكنات) — نفس القواعد في `Code.gs` و`scripts/validate_piece.py`

1. **تطبيع الدومين:** lowercase، إزالة scheme/port/path/`www.`، رفض بلا نقطة، رفض IP وlocalhost، رفض قائمة موانع (مختصرات الروابط، صفحات نتائج بحث، `t.me`, `x.com/`…).
2. **تكرار المزود:** `canonical_host` أو alias موجود ← `provider_id` الحالي (لا صف جديد أبداً).
3. **الدليل:** `evidence_url` يبدأ بـ `https://`، مضيفه = `canonical_host` أو alias أو نطاق فرعي له؛ وإلا `422 evidence_host_mismatch`. `evidence_excerpt` إلزامي (20–600 حرفاً) لأي `confidence: observed`.
4. **فخ المسارات الزائفة (`-2` route):** رفض أي رابط يحوي مقطع `/-\d+` أو `//` داخل المسار أو تكرار مقطع > مرتين؛ تنظيف `utm_*`/`ref=` سيرفرياً.
5. **ادعاءات المجاني:** `free_tier`/`guest_chat` تحوي `models_named: [≥1]` أو `none_found: true` صراحة؛ `includes_target_models: true` يلزمه `model_tag` من الـ 9 + مقتطف يذكر الاسم حرفياً.
6. **`auth_flow`:** `methods[]` من القائمة المغلقة؛ `captcha`؛ `probe_result` سيرفري فقط.
7. **`not_found`:** `checked_pages[]` (≥ 1 من نفس الدومين) + `checked_at_utc`.
8. **التناقض:** قطعة تناقض `active` لنفس (host, piece_type) من وكيل آخر تُعلَّم `conflict_with` ويُفتح `fill_piece`؛ لا مسح ولا إخفاء.
9. **على GitHub (PR):** add-only تحت `pieces/**` **و`reviews/**`**؛ أي تعديل/حذف ← فشل؛ المسار يطابق المحتوى؛ `piece_id`/`review_id` فريد في المستودع؛ أي ملف `reviews/` يحوي `owner_correction` ← فشل؛ أي ملف خارج `pieces/**`/`reviews/**` في PR من fork ← فشل (`out_of_scope_path`).
10. **`canonicalJson_`:** كما في §3.4 — نفس الدالة بالاسم في الطرفين مع fixtures مشتركة.

---

## 7. بروتوكول المزامنة الثنائية بدون Loop + عزل الـ fork

- **الاتجاه A (Sheet → GitHub):** فوري عند `submit_piece`/`flag_piece`/`resolve_review` خارج القفل (أو عبر outbox). الالتزام يحمل `[hub-sync]` و`origin=sheet`.
- **الاتجاه B (GitHub → Sheet):** وكلاء GitHub يرسلون **PR فقط** (fork بلا مفاتيح). **`OD1` محسوم: فحص تلقائي + دمج يدوي من المالك.**
  - في `validate-and-sync.yml` على `pull_request`: checkout لـ `scripts/` و`schemas/` من **`github.event.pull_request.base.sha`** (كود موثوق)، ثم جلب ملفات **`pieces/**` و`reviews/**` فقط** من `head.sha` كبيانات (`git show head:path` أو `actions/checkout` بمسار منفصل ثم نسخ المجلدين فقط)؛ لا تنفيذ لأي كود من الـ PR؛ لا secrets في job الـ PR.
  - على `push(main)` بعد الدمج اليدوي: build + `sync_to_sheet.py` للقطع ذات `origin=github` غير المؤكدة.
- **`scripts/sync_to_sheet.py` (مصيدة HTTP 200):** يتبع `302` (`allow_redirects`)؛ النجاح = `resp.ok === true && resp.code ∈ {200, 201}` فقط؛ `429` ← backoff 2/4/8/16s ثم فشل الخطوة؛ أي كود آخر ← فشل الخطوة مع طباعة الرد؛ `piece_id` يُسجَّل في `docs/.synced_ids.json` **بعد تأكيد الحارس فقط**، والالتزام بـ `[hub-sync] synced ids`.
- **قواطع الـ loop (3 طبقات):** `origin` ثابت؛ `piece_id` فريد + `idempotency_key`؛ الـ Action يتخطى sync لو `github.actor == 'github-actions[bot]'` أو رسالة HEAD تبدأ بـ `[hub-sync]`.
- **ميزانية الحصص:** `submit_piece` = 1 طلب GitHub؛ الفائض فوق 80/دقيقة يُمتص بالـ outbox تلقائياً.

---

## 8. خوارزمية `blind_reverify` + `agent_scores`

- **الخصم/الإضافة:** `major -3`، `minor -1`، قطعة مُثبَّتة بوكيلين مختلفين `+2` لكل منهما، إصلاح `blind_reverify` مطابق للتصحيح `+3`؛ `accuracy_pct = verified / (verified + flagged_major + flagged_minor)`.
- **العمى:** `owner_correction` لا يُرجع في أي GET/POST للوكلاء، ولا يُدفع لـ GitHub (`reviews/` قائمة بيضاء)؛ `blind_hint` فقط؛ `excluded_agent_id` يمنع المخطئ.
- **الإغلاق:** `resolve_review` يعلّم القديمة `superseded` ويدفع حدث `resolve` إلى `reviews/` فيُحدَّث الكتالوج.
- **التعلّم:** `dashboard_view` يعرض أعلى 3 أنماط خطأ ليحدّث المالك `A1` فيسري على الجميع عبر `onEdit` + `426`.

---

## 9. فحص البريد التجريبي الآمن — `apps_script/GmailProbe.gs` (D3)

- Web App على `jdpx6218@gmail.com` (`Execute as: Me`, `Access: Anyone`) يقبل فقط `{host, agent_id, ts_utc, nonce, sig = HMAC-SHA256(SHARED_SECRET, host|agent_id|ts|nonce)}`؛ يرفض `ts` أقدم من 5 دقائق أو nonce مكرر (كاش 10 دقائق) أو توقيعاً خاطئاً ← `401`.
- البحث: `newer_than:20m in:anywhere to:jdpx6218@gmail.com`، تصفية المرسل بـ `host`/aliases. التصنيف: رمز `\b\d{4,8}\b` قرب (`code|verification|OTP|رمز`) ← `otp`؛ رابط يحوي `token|verify|magic|confirm` ← `magic_link`؛ وإلا `none`.
- الرد: `{ok, result, matched_sender_domain, received_at_utc}` بدون نص/رابط/رمز.
- الحماية: صف واحد لكل دومين للأبد؛ الكابتشا توقف المسار قبل الإرسال؛ `SHARED_SECRET` في `PropertiesService` للحسابين فقط؛ الاستدعاء من الحارس **خارج القفل**.
- `[يحتاج فحص حي]`: تأخر الرسائل (3 محاولات)؛ تصنيف spam.

---

## 10. هيكل المستودع النهائي

- `apps_script/Code.gs` · `apps_script/GmailProbe.gs` · `apps_script/appsscript.json` · `apps_script/GmailProbe.appsscript.json`
- `schemas/piece.base.schema.json` · `schemas/review_event.schema.json` · `schemas/enums.json` · `schemas/types/*.schema.json`
- `scripts/validate_piece.py` · `scripts/build_catalog.py` · `scripts/sync_to_sheet.py` · `scripts/hub_common.py` (يحوي `canonical_json` + `normalize_host` المشتركين)
- `prompts/master_prompt.md` · `prompts/agent_connect/{opencode.md, claude_mcp.md, custom_gpt_openapi.yaml, generic_script.md}`
- `.github/workflows/validate-and-sync.yml` · `.github/workflows/pages.yml`
- `pieces/.gitkeep` · `reviews/.gitkeep` · `docs/index.html` (مولَّد) · `docs/.synced_ids.json` · `CATALOG.md` (مولَّد)
- `tests/node/*.test.js` (`node:vm` بمحاكيات `SpreadsheetApp/LockService/PropertiesService/CacheService/UrlFetchApp/GmailApp/Utilities`) · `tests/python/test_*.py` · `tests/fixtures/` · `tests/smoke/live_smoke.py`
- `run_tests.cmd` (الجذر — غلاف التحقق الوحيد للمخطط): بلا وسيط = `unit`؛ `unit` = Node + Python؛ `all` = unit + smoke حي اختياري (`HUB_URL` + `HUB_TEST_TOKEN`) وإلا `SKIPPED` بوضوح.
- `README_DEPLOY.md` · `SPEC_AND_MEMORY.md` · `PLAN.md` · `TASKS.json` · `DUET_LOG.md` · `duet_resume.json`

---

## 11. استراتيجية الاختبار

- **Node vm:** سباق 20 `submit_piece` متزامناً ← مزود واحد؛ **القفل لا يُمسك أثناء `UrlFetchApp`** (المحاكي يرمي لو استُدعي `UrlFetchApp` والقفل ممسوك)؛ فشل GitHub ← outbox وتبقى القطعة `queued`؛ نجاح GitHub ← `pushed` + `sha`؛ فشل القفل الميكروي ← outbox؛ `426` فور `onEdit(A1)`؛ `token` في Query ← `400`؛ `agent_id` مزيف يُتجاهل؛ `403` excluded؛ outbox retry→dead؛ `sync_from_github` لا يدخل outbox؛ chunk >100KB؛ intent مرتين ← `409`؛ captcha يقفل؛ Cairo `ص/م`؛ `flag_piece` يدفع `reviews/` بلا `owner_correction`؛ `recomputeProviderSummary_` يبني الأعمدة الملخصة؛ `issue_token` لا يكتب التوكن في أي تبويب.
- **Python:** `validate_piece.py` fixtures لكل قاعدة §6 (بما فيها `reviews/` و`out_of_scope_path`)؛ `build_catalog.py` حتمي ويطبّق `reviews/` ويخفي الفارغ؛ **تطابق `canonical_json` + sha256 مع Node على fixtures عربية/متداخلة**؛ `sync_to_sheet.py` ضد خادم وهمي يرجع HTTP 200 مع `code: 429/422/201`.
- **Smoke حي اختياري:** `ping → get_prompt → submit_piece ×2 (idempotent) → list (POST) → GET بـ token في Query ← 400`.

---

## 12. المناطق الحمراء ومعايير القبول لكل دفعة

- **D1:** منطقة حمراء جزئياً (`.github/workflows`). `T1` نبض أولاً. القبول: `run_tests.cmd unit` أخضر، كل fixture فاسد يُرفض بالكود الصحيح (بما فيها `reviews/`)، `sync_to_sheet.py` لا يعتبر HTTP 200 نجاحاً، workflows بعزل fork (base.sha للكود، head.sha للبيانات).
- **D2 (`Code.gs`):** مفردة. القبول: اختبارات vm لكل أكشن §3.4 (14 أكشن)، لا `UrlFetchApp` داخل القفل، `onEdit`، `400 token_in_query_forbidden`، `reviews/` بلا `owner_correction`، أعمدة ملخص `providers`، 10+1+1 توكنات، `issue_token`.
- **D3 (`GmailProbe.gs`):** مفردة. القبول: رفض توقيع/زمن/nonce، التصنيف الثلاثي، لا تسريب.
- **D4:** عادية. القبول: `run_tests.cmd all` أخضر، `README_DEPLOY.md` ~5 دقائق، قوالب التوصيل الأربعة (بدون أي توكن في URL).

---

## 13. التحليل الهجومي + كشف النجاح الزائف + الخطة البديلة

- **توكن مُسرَّب:** إلحاق فقط؛ `revoke_token`/`rotate_token`؛ `tok_tail` يكشف المشاركة؛ لا يظهر في URL أو سجلات وسيطة (إقفال `CWE-598`).
- **إغراق:** `60 submit/ساعة/وكيل` ← `429`؛ payload ≤ 20KB.
- **بطء GitHub:** لا يؤثر على الوكلاء الآخرين (القفل محرر)؛ أسوأ حالة = قطعة `queued` تُدفع خلال ≤ 10 دقائق.
- **PR خبيث من fork:** لا كود يُنفَّذ من الـ PR؛ لا secrets؛ مسارات خارج `pieces/**`/`reviews/**` ترسب؛ الدمج يدوي.
- **التسمم بالثقة الزائفة:** مقتطف حرفي من نفس الدومين؛ `verified` بوكيلين؛ `blind_reverify` + خصم + انعكاس فوري على الكتالوج.
- **نجاح زائف:** vm خضراء لكن الحي مختلف → `run_tests.cmd all` + smoke في `README_DEPLOY` قبل الاكتمال؛ `[يحتاج فحص حي]`: حصة المؤقتات، spam Gmail، زمن PUT خارج القفل تحت 30 تنفيذاً.
- **بديل:** تعثر `GmailProbe` ← `probe_result=unknown`؛ حظر `jdpx6218` ← النواة سليمة؛ تعثر Actions ← الحارس يبقى المسار الأساسي والكتالوج يُبنى من الشيت لاحقاً.

---

## 14. القرارات المحسومة (كانت مفتوحة — أُقفلت بتفويض المالك)

1. **`OD1` ← محسوم:** فحص PR تلقائي + **دمج يدوي من المالك**؛ عزل fork (base.sha للكود، head.sha لبيانات `pieces/**` و`reviews/**` فقط).
2. **`OD2` ← محسوم:** `setupProduction()` يولّد **10 `agent` + 1 `owner` + 1 `sync`** إن لم توجد؛ `issue_token` / `rotate_token` / `revoke_token` / `set_agent_label` للمالك لاحقاً.
3. **`OD3` ← محسوم:** **ممنوع التوكن في Query نهائياً** (`400 token_in_query_forbidden`)؛ القراءة الموثقة عبر POST؛ GET عام بلا توكن وبلا `tok_tail`/`owner_correction`.

---

## 15. سجل الإقفالات الثمانية (الجولة 3 — v2)

1. فك `LockService` قبل أي `UrlFetchApp` + كتابة `queued` أولاً + تحديث ميكروي ≤ 2500ms + outbox عند أي فشل (§3.9).
2. حسم `OD1/OD2/OD3` (§14) + أكشنات `issue_token`/`rotate_token`/`revoke_token`/`set_agent_label` (§3.4).
3. طبقة `reviews/<review_id>.json` Add-Only بقائمة بيضاء بلا `owner_correction` + تركيبها في `build_catalog.py` (§3.10, §5, §6.9).
4. `onEdit(e)` لتصفير كاش `prompt:v` فورياً + `MASTER_PROMPT` التبويب رقم 1 + عرض `B1/C1` في `dashboard_view` (§3.5, §4).
5. أعمدة ملخص مقروءة في `providers` (`usage_url`, `agents_contributed`, `models_found_compact`, `free_summary`, `auth_summary`, `owner_review_note`) بدالة `recomputeProviderSummary_` (§4).
6. قاعدة `canonicalJson_` الموحدة (مفاتيح مرتبة عودياً، بلا مسافات، UTF-8 خام) + اختبار تطابق sha256 بين Node/GAS وPython (§3.4, §6.10, §11).
7. `sync_to_sheet.py` يتحقق من `ok && code ∈ {200,201}` لا من HTTP 200، backoff على `429`، تسجيل `synced_ids` بعد التأكيد فقط (§7).
8. أسلوب الكروت من `messages.html` + حقول `requires_card` / `auto_charges_after_trial` / `free_credits_or_quota` / `free_models_other` في `guest_chat` و`free_tier` (§5, §5.1).
