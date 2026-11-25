# 📓 DUET_LOG.md — سجل الحوكمة (Planner ⇄ Executor ⇄ Critic)

> صيغة السطر القياسي: `## [YYYY-MM-DD HH:MM] mode=internal stage=<id> action=PLAN|ASSIGN|VERIFY|ACCEPT|REJECT|ESCALATE status=<value>`
> التوقيت: `Africa/Cairo`. الملف Append-Only.

---

## [2026-11-25 02:05] mode=internal stage=R3-PLAN action=PLAN status=draft_awaiting_audit

### ما تم في هذه الخطوة
- قراءة `SPEC_AND_MEMORY.md` كاملاً (التحديثات 1 → 6) وقراءة `prototype_apps_script/Code.gs` (`v0.1`) لاستخراج العقد المُثبت حياً.
- كتابة `PLAN.md` (خطة 360° بـ 14 قسماً) و`TASKS.json` (4 دفعات ذرّية `D1 → D4`).
- **لم يُستدعَ `executor` ولا `critic` ولا `question`** التزاماً بتعليمات الجولة 3.

### قرارات هندسية مُقفلة في الجولة 3 (مستمدة من SPEC + v0.1)
1. **الأكواد المنطقية في JSON لا في HTTP:** Apps Script يرجع 200 دائماً بعد 302 → `code` داخل الجسم (`201/401/403/409/422/426/429`). التوكن في جسم POST فقط (الهيدرز لا تصل).
2. **GitHub = مصدر الحقيقة، Sheet = واجهة أمامية + مرآة:** ملف لكل قطعة `pieces/<host>/<agent_id>_<ulid>.json` لا يُعدَّل أبداً → استحالة merge conflict. المزامنة ثنائية لكن بـ `origin` ثابت + `piece_id` فريد + تجاهل التزامات `[hub-sync]` و`github-actions[bot]` (3 قواطع loop).
3. **الهوية مشتقة من التوكن حصراً** (`AGENT_TOKENS_JSON` بسجل كامل)؛ أي اسم يرسله الوكيل يُتجاهل ويُسجَّل كـ `identity_mismatch`. التوكنات لا تُكتب في أي تبويب؛ `tok_tail` فقط.
4. **بوابة `prompt_version` (`426`):** `sha256(trim(MASTER_PROMPT!A1)).slice(0,12)` مع كاش 60 ثانية؛ الرد يحمل البرومبت كاملاً لإجبار إعادة القراءة.
5. **إيميل الاختبار:** `register_submit_intent` إلزامي قبل أي نموذج → صف واحد لكل دومين للأبد → `report_captcha` يوقف المسار → `probe_email` بحد 3 محاولات وبشرط intent نشط لنفس الوكيل. `GmailProbe.gs` معزول على `jdpx6218` ويقبل HMAC فقط ويرد تصنيفاً بدون نص/رابط/رمز.
6. **`blind_reverify` + `agent_scores`:** `owner_correction` خاص لا يُرجع أبداً ولا يُدفع لـ GitHub؛ `blind_hint` فقط؛ `excluded_agent_id` يمنع الوكيل المخطئ؛ خصم `-3/-1` وإضافة `+2/+3`.
7. **`CacheService` > 100KB:** chunking بـ `meta + chunks ≤ 90KB` وإعادة بناء من الشيت عند الفشل؛ `list` مُرقّم بصفحات ≤ 200.
8. **`github_outbox`:** الدفع فوري، والفشل المؤقت يدخل طابوراً بمؤقت كل 10 دقائق (≤ 25 صف/تشغيل، 6 محاولات ثم `dead`) — ميزانية المؤقتات ≪ 90 دقيقة/يوم.
9. **`run_tests.cmd` في D1.T1 كاختبار نبض** لأنه الغلاف الوحيد المسموح للمخطط بالتحقق المستقل.
10. **PRs من GitHub = فحص فقط بدون دمج تلقائي افتراضياً** (قرار مالك مفتوح `OD1`).

### انحرافات مقصودة عن الصياغة الحرفية في رسالة الجولة 3 (للشفافية)
- عدد التبويبات في PLAN = **12** (الـ 10 المذكورة + `logs` + `github_outbox`) كما أشارت الرسالة بـ `plus logs / outbox`.
- `GET ?action=list` يقبل التوكن في Query للقراءة فقط (لا أثر كتابي)؛ إلغاء Drop-URL كان عن الكتابة. مُعلَّم كقرار مالك مفتوح `OD3` لو أراد منعه بالكامل.

### مخاطر متبقية معلّمة `[يحتاج فحص حي]`
- دمج PRs تلقائياً من fork (`pull_request_target`) وأمانه — الافتراضي: دمج يدوي.
- الاستهلاك الفعلي لحصة المؤقتات بتشغيل `flushOutbox_` كل 10 دقائق.
- تصنيف Gmail لرسائل بعض المزودين كـ spam (نستخدم `in:anywhere`).
- زمن `UrlFetchApp PUT` إلى GitHub داخل القفل ضمن نافذة 6 دقائق تحت 30 تنفيذاً متزامناً.

### قرارات مفتوحة للمالك (بدون تخمين)
- `OD1` دمج PR تلقائي أم يدوي (الافتراضي يدوي).
- `OD2` عدد التوكنات الأولي (الافتراضي 6 agent + 1 owner + 1 sync).
- `OD3` هل `GET list` عام أم بتوكن (الافتراضي بتوكن).

### الخطوة التالية
- `Antigravity` يدقق `PLAN.md` + `TASKS.json` عبر `lock360.py audit` → موافقة المالك → `ASSIGN D1.T1` للـ `executor` (اختبار نبض) مع إنشاء `duet_resume.json` عند أول تكليف.

**[PLAN_DRAFT]**

---

## [2026-11-25 02:40] mode=internal stage=R3-LOCK action=PLAN status=LOCKED_FOR_EXECUTION

### ما تم في هذه الخطوة
- استلام تدقيق `Antigravity` (8 نقاط إقفال هندسية) ودمجها كاملة في `PLAN.md` (v2) و`TASKS.json` (معايير قبول محدّثة لكل دفعة).
- تحويل `PLAN.md` إلى حالة `LOCKED_FOR_EXECUTION` بتفويض المالك («لا ترجعلي في قرارات»).
- **لم يُستدعَ `executor` ولا `critic` ولا `question`** التزاماً بالتعليمات.

### الإقفالات الثمانية المُثبتة (PLAN §15)
1. **فك القفل قبل الشبكة:** ممنوع أي `UrlFetchApp` داخل `LockService`؛ القطعة تُكتب `queued` داخل القفل ثم يُحرر، ثم PUT إلى GitHub، ثم تحديث ميكروي `pushed` بقفل ≤ 2500ms، وأي فشل (شبكة أو قفل ميكروي) → `github_outbox`. المحاكي في الاختبارات يرمي استثناءً لو استُدعي `UrlFetchApp` والقفل ممسوك.
2. **حسم `OD1/OD2/OD3`:** فحص PR تلقائي + دمج يدوي مع عزل fork (base.sha للكود، head.sha لبيانات `pieces/**` و`reviews/**` فقط) · 10 agent + 1 owner + 1 sync + أكشنات `issue_token`/`rotate_token`/`revoke_token`/`set_agent_label` · **التوكن في Query ممنوع نهائياً** (`400 token_in_query_forbidden`)، القراءة الموثقة عبر POST، GET عام بلا `tok_tail`/`owner_correction`.
3. **طبقة `reviews/<review_id>_<ulid>.json` Add-Only** بقائمة بيضاء (`review_event.schema.json` بـ `additionalProperties: false`) تُدفع عند `flag_piece`/`resolve_review` خارج القفل، و`build_catalog.py` يركّبها فوق `pieces/**`؛ `validate_piece.py` يرفض `owner_correction` فيها.
4. **`onEdit(e)`** يصفّر كاش `prompt:v` فورياً ويحدّث `B1/C1`؛ `MASTER_PROMPT` التبويب رقم 1؛ `dashboard_view` يعرض `B1/C1`.
5. **أعمدة ملخص `providers`** (`usage_url`, `agents_contributed`, `models_found_compact`, `free_summary`, `auth_summary`, `owner_review_note`) بدالة `recomputeProviderSummary_` داخل القفل.
6. **`canonicalJson_` موحدة** (مفاتيح مرتبة عودياً بنقاط كود Unicode، بلا مسافات، UTF-8 خام) في `hub_common.py` وتُثبَّت 3 قيم sha256 في `D1.T1` يجب أن يعيد إنتاجها Node/GAS بايتاً ببايت في `D2`/`D4`.
7. **`sync_to_sheet.py`** النجاح = `ok && code ∈ {200,201}` لا HTTP 200؛ backoff على `429`؛ `synced_ids` بعد التأكيد فقط؛ اختبار ضد خادم وهمي.
8. **أسلوب الكروت من `messages.html`** + حقول `requires_card` / `auto_charges_after_trial` / `free_credits_or_quota` / `free_models_other` في `guest_chat` و`free_tier`.

### تغييرات تبعية على `TASKS.json`
- `D1.T1` توسّع ليشمل `schemas/review_event.schema.json` + `scripts/hub_common.py` + `tests/python/test_hub_common.py` (تثبيت sha256 المرجعية مبكراً حتى يبني عليها D2).
- `D1.T5` يشمل اختبار `sync_to_sheet.py` ضد خادم وهمي بـ HTTP 200 وأكواد منطقية مختلفة.
- `D2.T1` معايير القبول أصبحت 19 بنداً تغطي القفل/الشبكة، `CWE-598`، `reviews/`، `onEdit`، الأعمدة الملخصة، و14 أكشن.
- `D4.T1` يضيف `test_canonical_parity.py`.
- `needs_live_check` حُدّثت: أُزيل بند الدمج التلقائي (محسوم يدوياً) وأُضيف اعتمادية `onEdit` عند اللصق vs الكتابة.

### مخاطر متبقية `[يحتاج فحص حي]`
- حصة المؤقتات الفعلية لـ `flushOutbox_` كل 10 دقائق.
- تصنيف Gmail لرسائل المزودين كـ spam.
- زمن PUT خارج القفل تحت 30 تنفيذاً متزامناً ومعدل تنافس القفل الميكروي.
- اعتمادية `onEdit` (Simple Trigger) عند لصق البرومبت vs كتابته.

### الخطوة التالية
- `ASSIGN D1.T1` للـ `executor` (اختبار نبض: schemas + `hub_common.py` + `run_tests.cmd`) مع إنشاء `duet_resume.json` عند أول تكليف، ثم تحقق مستقل عبر `run_tests.cmd unit`.

**[PLAN_LOCKED_READY_FOR_D1]**

---

## [2026-11-25 02:50] mode=internal stage=D1 action=ASSIGN status=D1.T1_in_progress

- قيود البيئة (تحديث 7): `Python 3.15.2` stdlib فقط + `Node v26.13.1` `node:test` فقط؛ ممنوع `pip install`/`npm install`؛ `run_tests.cmd` أنشأه `Antigravity` و`executor` ممنوع من لمسه.
- `run_tests.cmd` يشغّل `python -m unittest discover -s tests/python -p "test_*.py"` من جذر المشروع → الاختبارات تضيف الجذر لـ `sys.path` وتستورد `scripts.hub_common`.
- تكليف `executor` بـ `D1.T1` فقط (نبض): `schemas/` كاملة + `scripts/hub_common.py` + `tests/python/test_schemas_load.py` + `tests/python/test_hub_common.py`. حجم الدفعة = 1.
- `duet_resume.json` أُنشئ؛ `executor_session_id` يُحفظ فور عودة المنفذ.

## [2026-11-25 03:05] mode=internal stage=D1 action=ASSIGN status=D1.T1_resumed_after_timeout

- انقطاع مهلة 600 ثانية في الجلسة `ses_deff63c2cffe80BFvz14OcPH2P` (انقطاع رقم 1 للدفعة).
- فحص القرص: 9 ملفات مكتملة (`enums.json`, `piece.base`, `review_event`, 5 مخططات أنواع، `hub_common.py` كامل بـ 13 دالة stdlib وينتهي بـ `__all__` سليم).
- متبقٍ: `paid_pricing`/`referrals`/`not_found`/`_generic` + `__init__.py` ×3 + `test_schemas_load.py` + `test_hub_common.py`.
- إعادة تكليف نفس الجلسة بالمتبقي فقط دون إعادة كتابة ما اكتمل.

## [2026-11-25 03:20] mode=internal stage=D1 action=ACCEPT status=D1.T1_done

- عاد `executor` بتقرير `[STAGE D1.T1 DONE]` (35/35). **تحقق مستقل من المخطط:** `.\run_tests.cmd unit` → `Ran 35 tests in 0.013s` / `OK` / `[PASS] Unit tests passed cleanly.` (ملاحظة بيئية: PowerShell يتطلب `.\` قبل اسم الملف؛ المحاولة الأولى بدونه فشلت بـ CommandNotFound وليس بفشل اختبار).
- فحص يدوي: الاختباران يستوردان stdlib فقط (`json/sys/unittest/pathlib/datetime/unittest.mock`) + `scripts.hub_common`؛ قيم sha256 الثلاث مثبّتة كثوابت في `test_hub_common.py` سطور 34–36؛ `review_event.schema.json` بـ `additionalProperties: false` ورفض `owner_correction` مُختبر؛ `_generic` بـ `additionalProperties: true`.
- القيم المرجعية الحاكمة لـ `Code.gs` (D2): `ARABIC=dc0bafb4abcd51166f56ad4f1bb452d1a127409837b95884a90e73da5e32f83d` · `NESTED=579c2706f0ebbbbcb9fd366700e4dba5c4a9b8efb115bd8b74690d74235dcb45` · `ARRAY=ca9292b3baefb3363b0a6960d7fddfecfca98319a456a86682482a6ff685cdf9`.
- انحرافان مقبولان: `required: [name, price]` لعناصر `plans` في `paid_pricing` (تشديد معقول)، و`additionalProperties: false` على `paid_pricing/referrals/not_found` (اتساق مع `piece.base`).
- `rejections[D1] = 0`. الدفعة التالية المقترحة: `D1.T2 + D1.T3` (الفاحص + مولّد الكتالوج، بينهما اعتماد على `hub_common` فقط) ثم `D1.T4 + D1.T5`. بانتظار اعتماد `Antigravity`.

**[STAGE_APPROVED D1.T1]**

## [2026-11-25 03:30] mode=internal stage=D1 action=ASSIGN status=D1.T2+D1.T3_in_progress

- اعتماد `Antigravity` لنتيجة النبض (تحقق مستقل منه أيضاً: 35/35).
- تكليف `executor` (نفس الجلسة `ses_deff63c2cffe80BFvz14OcPH2P`) بـ `D1.T2` (الفاحص الحتمي + fixtures + اختبار) و`D1.T3` (مولّد الكتالوج + `docs/index.html` + اختبار). حجم الدفعة = 2 (لا تبعية بينهما؛ كلاهما على `hub_common` فقط).
- قيود مؤكدة في التكليف: stdlib فقط، لا تكرار لدوال `hub_common`، حتمية بايت-ببايت، لا جداول Markdown، لا CDN، XSS-safe عبر `textContent`.

## [2026-11-25 03:55] mode=internal stage=D1 action=ACCEPT status=D1.T2+D1.T3_done

- عاد `executor` بـ `[STAGE D1.T2+D1.T3 DONE]` (73/73). **تحقق مستقل من المخطط:** `.\run_tests.cmd unit` → `Ran 73 tests in 0.187s` / `OK` / `[PASS] Unit tests passed cleanly.` (35 قديمة + 24 validate + 14 catalog).
- فحص يدوي بـ grep على `validate_piece.py` و`build_catalog.py`: كل الاستيرادات stdlib + `from scripts.hub_common import ...` فقط؛ لا تعريف مكرر لـ `canonical_json/normalize_host/to_cairo_time/validate_schema_dict`؛ `datetime.now` و`innerHTML` يظهران في الـ docstring فقط كمنع موثق.
- 27 كود خطأ منفذاً ولكل منها fixture (`test_each_error_code_has_a_fixture`).
- **توحيد قاعدة المسار (قرار مخطط):** `pieces/<host>/<agent_id>_<piece_id>.json` (بالبادئة `pc_`) و`reviews/<review_id>.json` (بالبادئة `rv_`). حُدّث `PLAN.md` (8 مواضع) و`TASKS.json` D1.T2 ليطابقا الفاحص؛ `Code.gs` في D2 يلتزم بنفس القاعدة.
- انحرافات مقبولة: كودان إضافيان (`probe_result_invalid`, `invalid_json`)، 8 fixtures صالحة بدل 6، تهريب `<!--` بـ `<\u0021--` (JSON صالح)، أولوية `🚫 دليل سلبي` بعد `needs_reverify`.
- `rejections[D1] = 0`. الدفعة التالية: `D1.T4 + D1.T5` (البرومبت + workflows/sync — منطقة حمراء جزئية) بانتظار اعتماد `Antigravity`.

**[STAGE_APPROVED D1.T2+D1.T3]**

## [2026-11-25 04:05] mode=internal stage=D1 action=ASSIGN status=D1.T4+D1.T5_in_progress

- اعتماد `Antigravity` لـ D1.T2+T3 (تحقق مستقل منه: 73/73 في 0.176s) ولتوحيد قاعدة المسار.
- تكليف `executor` (نفس الجلسة `ses_deff63c2cffe80BFvz14OcPH2P`) بـ `D1.T4` (البرومبت الحي) و`D1.T5` (workflows بعزل fork + `sync_to_sheet.py` بمصيدة HTTP 200 + اختبار بخادم محلي حقيقي مع 302). حجم الدفعة = 2.
- بعد العودة: تحقق مستقل + قراءة الـ YAML والبرومبت والمزامن + بوابة `critic` بـ `LENS: scope-guard` على D1 كاملة (استدعاء 1 من 2).

## [2026-11-25 04:40] mode=internal stage=D1 action=VERIFY status=D1.T4+D1.T5_verified_then_timeout

- عاد `executor` بـ 91/91؛ تحقق مستقل من المخطط: `Ran 91 tests in 5.955s OK [PASS]`؛ قراءة يدوية للـ YAML (عزل fork + قواطع loop) و`sync_to_sheet.py` (`redact`) والبرومبت (426 + معيار النجاح).
- أُطلق `critic` (`ses_defc82b73ffesWpskNM83evs1y`, LENS scope-guard) لكن المهلة 1200 ثانية انقطعت قبل عودته (انقطاع رقم 2؛ النتيجة لم تُستلم — يُعاد الاستدعاء بعد التصحيحات بدون احتساب الأول ضد الميزانية لأنه لم يُنتج حكماً).
- مراجعة `Antigravity` المباشرة رصدت 3 إصلاحات إلزامية قبل إغلاق D1: (1) `master_prompt.md:41` يخطئ بنصح `--post302/--post303` — بعد 302 يذهب الطلب إلى `/macros/echo` الذي يقبل GET فقط (405 لو POST)؛ الصحيح `curl -sL -H Content-Type -d` بلا `-X POST` وبلا `--post302`. (2) `pages.yml` لا يُشغَّل من push بـ `GITHUB_TOKEN` → إضافة `workflow_run` على `validate-and-sync`. (3) `validate-and-sync.yml`: `concurrency sync-main` + `head_commit.message || ''` للـ dispatch؛ + `symlink_forbidden` في `validate_piece.py`.
- `ASSIGN` التصحيحات الثلاثة + اختبار symlink للـ `executor` (نفس الجلسة).

## [2026-11-25 05:15] mode=internal stage=D1 action=VERIFY status=D1_fixes_verified_critic_returned

- عاد `executor` بالتصحيحات الأربعة؛ تحقق مستقل من المخطط: `Ran 92 tests in 5.792s OK (skipped=1)` `[PASS]` (الـ skipped = symlink على ويندوز بلا صلاحيات؛ يُنفَّذ على Linux في Actions). grep أكّد: لا `post302`؛ `workflow_run` + `ref: main`؛ `concurrency sync-main` + `head_commit.message || ''`؛ `symlink_forbidden` قبل القراءة.
- **`critic` (`ses_defbc4d0cffesm33tRiu1ECwQv`, LENS scope-guard, استدعاء 1/2 المحتسب):** `VERDICT: PASS_WITH_MAJORS`.
  - `[Major] validate-and-sync.yml:110,128` — `git push` مباشر بلا `pull --rebase`/retry → non-fast-forward عند دفعة بشرية متزامنة → فشل job → `pages.yml` لا ينشر. **مقبول (مدعوم بـ file:line)** → `ASSIGN` إصلاح الحلقة `pull --rebase --autostash` + 3 محاولات للـ `executor`.
  - `[Nitpick] pages.yml:9-12` فلتر `branches` في `workflow_run` قد يطلق نشراً زائداً من fork فرعه `main` — مُتجاهَل: غير ضار (checkout يثبّت `ref: main` للمستودع الأصلي).
  - `[Nitpick] validate-and-sync.yml:72` شرطا bot/`[hub-sync]` زائدان عملياً — مُتجاهَل: دفاع في العمق بلا تكلفة، ويحمي لو استُبدل `GITHUB_TOKEN` بـ PAT مستقبلاً.
  - ملاحظة نطاق من critic: لم يفحص السطور 1-49 (job الـ PR) — غطّاها المخطط يدوياً (`pull_request` لا `pull_request_target`، `persist-credentials: false`، لا secrets).

## [2026-11-25 05:30] mode=internal stage=D1 action=ACCEPT status=D1_done

- عاد `executor` بإصلاح الـ Major: الخطوتان `Commit catalog` و`Commit synced ids` تستخدمان حلقة `git pull --rebase --autostash origin main && git push origin HEAD:main` بـ 3 محاولات وخروج 1 بعدها (سطور 110–116 و134–139). قرأ المخطط الكتلة بعينه: المسافات متسقة داخل `run: |`، والحلقة صحيحة تحت `set -e`.
- تحقق مستقل نهائي: `.\run_tests.cmd unit` → `Ran 92 tests in 5.890s OK (skipped=1)` `[PASS]`.
- لم يُستدعَ `critic` ثانٍ: الإصلاح محصور في سطرين ومحدد حرفياً من حكمه. ميزانية critic لـ D1 = 1/2 محتسب.
- `TASKS.json`: `D1.T4`, `D1.T5`, و`batch D1 → done`. `rejections[D1] = 0`.
- D1 اكتملت: 8 مكونات (schemas, hub_common, validate_piece, build_catalog, master_prompt, sync_to_sheet, workflows ×2) + 92 اختباراً stdlib.
- الدفعة التالية: `D2.T1` (`apps_script/Code.gs` الإنتاجي — منطقة حمراء، مفردة) بانتظار اعتماد `Antigravity`.

**[STAGE_APPROVED D1]**

## [2026-11-25 05:45] mode=internal stage=D2 action=ASSIGN status=D2.T1_in_progress

- اعتماد `Antigravity` الرسمي لـ D1 (تحقق مستقل منه: 92 OK skipped=1).
- تكليف `executor` بـ `D2.T1` (`apps_script/Code.gs` الإنتاجي + `appsscript.json` + `gas_mocks.js` + `code_gs.test.js`) في **جلسة جديدة نظيفة** (جلسة D1 امتلأ سياقها). منطقة حمراء → حجم الدفعة = 1.
- فخاخ مُثبتة في التكليف: بايتات موقّعة من `computeDigest` (`& 0xff`)، `base64Encode` بـ UTF-8، المحاكي يرمي لو `UrlFetchApp` داخل قفل، `400 token_in_query_forbidden` قبل المصادقة، `onEdit` + `refreshPromptVersion_`، قيم sha256 الثلاث المرجعية، قاعدة المسار الموحدة.
- `critic` مؤجل لخطوة منفصلة تالية (قرار Antigravity لتفادي انتهاء المهلة).

## [2026-11-25 06:20] mode=internal stage=D2 action=ESCALATE status=D2.T1_timeout_context_bloat_resplit

- انقطاع رقم 3 (مهلة 1500 ثانية): جلسة `ses_defb1322fffeHN1uQvwOyCkFkZ` لم تكتب أي ملف — قضت 19 دورة تقرأ المستودع حتى 73,913 توكن (تشخيص `Antigravity` من `bridge.log`). القرص: لا `apps_script/` ولا `tests/node/`.
- السبب الجذري: حجم التكليف + إحالته لقراءة ملفات كثيرة. القرار: تقسيم `D2.T1` إلى 3 مراحل صغيرة (`D2-1` mocks + appsscript.json + smoke؛ `D2-2` Code.gs؛ `D2-3` code_gs.test.js) كل منها بجلسة `executor` جديدة والعقد مضمّن حرفياً في التكليف مع تعليمة «لا تقرأ المستودع».
- `ASSIGN D2-1` بجلسة جديدة. الجلسة المنتفخة تُهمل.

## [2026-11-25 06:50] mode=internal stage=D2 action=REJECT status=D2-1_rejected_mocks_incomplete

- عاد `executor` (`ses_def9853bfffecioLw21xBcJ1Tu`) بـ 3 ملفات و6/6 Node + 92 Python، لكنه صرّح أن العقد وصله «مبتوراً».
- **تحقق مستقل (grep + read لـ `gas_mocks.js` سطور 325–419):** المحاكي يفتقد الفخاخ الحرجة كلها: `UrlFetchApp.fetch` لا يرمي تحت القفل؛ `CacheService.put` بلا حد 100KB؛ `computeDigest`/HMAC تُرجع بايتات غير موقّعة `0..255`؛ `formatDate` يتجاهل المنطقة الزمنية والصيغة؛ لا `setNow`/`forceLockFail`/`muteHttpExceptions`. اختبار `mocks_smoke.test.js` غير موجود (أُنشئ `gas_mocks.test.js` بـ 6 حالات أساسية فقط).
- السبب الجذري: التكليف الطويل جداً بُتر عند الإرسال. `rejections[D2-1] = 1`.
- إعادة التكليف في نفس الجلسة بنص **قصير مركّز** على 6 تعديلات + 9 اختبارات smoke فقط.

## [2026-11-25 07:10] mode=internal stage=D2 action=ACCEPT status=D2-1_done

- عاد `executor` بالتقوية الستة + `mocks_smoke.test.js` (9 اختبارات). **تحقق مستقل من المخطط:** `.\run_tests.cmd unit` → Python `Ran 92 OK (skipped=1)` + Node `tests 15 / pass 15 / fail 0` → `[PASS]`.
- grep على `gas_mocks.js` أكّد الفخاخ في المحاكي نفسه (لا في الاختبار فقط): `FORBIDDEN` تحت القفل (:465)، `CACHE_MAX_BYTES = 102400` (:8)، `toSignedBytes` (:18) مطبّقة على digest/HMAC/base64Decode/newBlob، `hourCycle: 'h12'` + `formatToParts` (:273)، `MockDate` (:502)، `forceLockFail` + `muteHttpExceptions`.
- ملفات D2-1 على القرص: `apps_script/appsscript.json`, `tests/node/mocks/gas_mocks.js`, `tests/node/gas_mocks.test.js` (6), `tests/node/mocks_smoke.test.js` (9).
- `rejections[D2-1]` بقي 1 (رفض واحد ثم قبول). درس مُثبت: التكليفات الطويلة تُبتر → `D2-2`/`D2-3` بتكليفات أقصر مجزأة.
- التالي: `D2-2` (`apps_script/Code.gs`) بجلسة `executor` جديدة — بانتظار اعتماد `Antigravity`.

**[STAGE_APPROVED D2-1]**

## [2026-11-25 04:25] mode=internal stage=D2 action=ASSIGN status=D2-2_in_progress

- استئناف رسمي بعد `40k checkpoint`: قرأ المخطط `duet_resume.json` + `DUET_LOG.md` (145–188) + `PLAN.md` §3/§4/§6/§8/§15 + `TASKS.json` بند `D2.T1` + واجهة المحاكي `createGasEnv` (sandbox بلا `require`/`setTimeout`، فخ `UrlFetchApp` تحت القفل :524، بايتات موقّعة، `env.run`/`loadGasScripts`) + القيم المرجعية الثلاث لـ sha256 من `test_hub_common.py:34-36`.
- `ASSIGN D2-2`: ملف واحد فقط `apps_script/Code.gs` في **جلسة `executor` جديدة** `ses_def820fc5ffeLkPp5OMeLxFvfE`. العقد مضمّن حرفياً (11 قسماً: الهيكل والأسماء الثابتة، رؤوس التبويبات الـ 12، التوكنات، CWE-598 + GET/POST + 426، canonicalJson_/sha256Hex_ مع المراجع الثلاثة، قاعدة القفل + outbox، reviews whitelist، الأكشنات الـ 14، validator §6، recomputeProviderSummary_، cache chunking). تعليمة «لا تقرأ المستودع» باستثناء `prompts/master_prompt.md`. تحقق ذاتي للمنفذ: `node --check` فقط.
- قيود GAS/vm مُثبتة في التكليف: دوال عامة `function` على المستوى الأعلى وثوابت `var` (لا `const/let`/`class` أعلى المستوى).
- التحقق المخطط بعد العودة: `.\run_tests.cmd unit` + تكليف نفس الجلسة بـ `tests/node/code_gs_smoke.test.js` + grep أمني (توكن في الشيت، `e.parameter.token`، `UrlFetchApp` داخل قفل، `owner_correction` في مسار `reviews/`). `critic` مؤجل لـ D2-3.

## [2026-11-25 04:55] mode=internal stage=D2 action=VERIFY status=D2-2_written_then_REJECT_for_fixes

- عاد `executor` (`ses_def820fc5ffeLkPp5OMeLxFvfE`): `apps_script/Code.gs` 2103 سطراً (`node --check EXIT=0`) + `tests/node/code_gs_smoke.test.js` (8 حالات). المالك شغّل `.\run_tests.cmd unit` بنفسه: `92 Python (skipped=1) + 23/23 Node OK`.
- مراجعة المخطط اليدوية للمقاطع الأمنية ناجحة: `hasTokenInQuery_` :897 قبل كل شيء في `handleRequest_` :953، التوكن من `postData.contents` فقط، أدوار 403، بوابة 426، `UrlFetchApp.fetch` واحد :1122 خارج أي قفل، `submitPieceFlow_` :1619 (قفل→إدراج→`finally release`→دفع→ميكروي/outbox)، `buildReviewEvent_` :1212–1232 قائمة بيضاء بلا `owner_correction`.
- **REJECT جزئي (المالك، مراجعة كاملة 1–2103):** 10 تعارضات مع عقد D1 (`schemas/` + `validate_piece.py`) كانت ستُسقط ملفات القطع عند الوصول لـ GitHub: موديلات خاطئة في `MODEL_TAGS` :66 (`gemini-4/grok-5/llama-5`) بدل الـ 9 المعتمدة؛ `AUTH_METHODS` :63 مخالفة لـ `enums.json` وغياب فحص `flow/captcha/oauth_providers`؛ `buildPieceJson_` :1185 مسطّح بينما `piece.base` يشترط `provider/agent/evidence` متداخلة مع `additionalProperties:false`؛ `provider_id` :1422 بـ `ulid_('pv_')` بدل `^prov_[0-9a-f]{8}$`؛ payload `report_captcha` :1799 مخالف لـ `auth_flow.schema`؛ `sync_from_github` :1926 يقرأ المسطح فقط؛ `SUMMARY_MAX` 500 بدل 1000 و`BLOCKED_HOSTS` ناقصة (33 في `enums.json`)؛ `flushOutbox_` :1256 يكتب على `_row` قديم بعد fetch؛ `resolve_review` :1883 حالة المزود غير دقيقة + `report_captcha` غائب عن `nameIsPayload` :992؛ `models_found_compact` بلا عائلات + لا تسجيل `identity.payload.aliases`.
- تحقق المخطط من كل القوائم بيديه من `schemas/enums.json` و`piece.base.schema.json` و`schemas/types/{auth_flow,free_tier,guest_chat,identity}` قبل التفويض (لا قيمة من الذاكرة).
- `rejections[D2-2] = 1` (الحد 3).

## [2026-11-25 04:58] mode=internal stage=D2 action=ASSIGN status=D2-2-fix_in_progress

- `ASSIGN D2-2-fix` في **جلسة `executor` جديدة** `ses_def6bbd81ffeLx2fd0rTn9pCZm`: الإصلاحات الـ 10 في `apps_script/Code.gs` فقط (+ `code_gs_smoke.test.js` بالحد الأدنى إن احتاج قيماً متوافقة)، العقد مضمّن حرفياً (الـ 9 موديلات + `MODEL_SHORT`/`MODEL_FAMILIES`، 8 طرق مصادقة + 10 oauth + 9 captcha، المفاتيح الـ 16 المسموحة في `piece.base`، الـ 33 مضيفاً ممنوعاً، `prov_`+sha256[:8]).
- التحقق المخطط بعد العودة: grep صفر لـ `gemini-4|grok-5|llama-5|'pv_'` + وجود `schema_version: 1`/`provider: {`/`agent: {`/`evidence: {` في `buildPieceJson_` + `.\run_tests.cmd unit` + قراءة `buildPieceJson_` و`flushOutbox_` بالعين. ثم `D2-2_fixed` → `D2-3` (`code_gs.test.js` الشامل + `critic LENS: fish`).

## [2026-11-25 05:05] mode=internal stage=D2 action=ACCEPT status=D2-2_fixed

- عاد `executor` (`ses_def6bbd81ffeLx2fd0rTn9pCZm`) بالإصلاحات الـ 10 في `apps_script/Code.gs` فقط (لم يُلمس `code_gs_smoke.test.js`): الموديلات :68/:85/:93/:396 + قاعدة المجاني :1416-1428؛ `auth_flow` :63-65 + :1430-1449؛ `buildPieceJson_` :1228-1254؛ `provider_id` :1490؛ `report_captcha` :1894-1907؛ `sync_from_github` :2049-2058؛ `SUMMARY_MAX` :56 + الـ 33 مانعاً :70؛ `microUpdateOutbox_` :1130 + `flushOutbox_` :1301-1339؛ `nameIsPayload` :1008 + حالة المزود :2012-2023؛ `recomputeProviderSummary_` :1558-1590 + aliases :1700-1711.
- **تحقق المخطط المستقل:** grep = صفر لـ `gemini-4|grok-5|llama-5|'pv_'`؛ الـ 33 مانعاً حرفياً؛ `SUMMARY_MAX: 1000`؛ قراءة بالعين: `buildPieceJson_` = الـ 16 مفتاحاً فقط (`provider/agent/evidence` متداخلة، `model_tag||null`، `canonicalJson_`)، `microUpdateOutbox_` قفل→`findRow_` داخله→كتابة→`finally`، `flushOutbox_` بلا كتابة على `_row` قديم بعد `pushToGithub_`.
- `.\run_tests.cmd unit` (المخطط): `Ran 92 tests OK (skipped=1)` + `Node tests 23 pass 23 fail 0` `[PASS]`.
- `rejections[D2-2]` يبقى 1 (أُغلق). ميزانية critic لـ D2 = 0/2 حتى الآن (مؤجل لـ D2-3).
- التالي: `D2-3` في جلسة `executor` جديدة — `tests/node/code_gs.test.js` الشامل (الأكشنات الـ 14، أكواد 422 الجديدة، فخ fetch تحت القفل، outbox retry/dead، 426، شكل `buildPieceJson_`، regex `prov_`، aliases) → تحقق المخطط → `critic LENS: fish` → `[STAGE_APPROVED D2]`.

**[STAGE_APPROVED D2-2]**


## [2026-11-25 04:59] mode=autonomous_fallback stage=D2-3..D4 action=HANDOFF status=upstage_401_detected

- أثناء التحضير لتشغيل `D2-3` عبر `OpenCode`، انتهت صلاحية جلسة `Upstage Studio` (`upstage_session.json`) بكود `HTTP 401`. التزاماً بحدود البيئة والأمان، لم يتم لمس ملف الجلسة أو محاولة تجاوز المصادقة، واستُكملت الأعمال المتبقية محلياً عبر `Antigravity` مع تفعيل مراجع قراءة نظيف مستقل (`research`).
- يظل اعتماد `Fable 5.1` الرسمي مقتصراً على: `PLAN.md` (`v2 LOCKED_FOR_EXECUTION`)، `TASKS.json`، ودفعات `D1`، `D2-1`، `D2-2_fixed` (`ses_def87575effeznfvm32dTjAzUp`).

## [2026-11-25 05:17] mode=antigravity+independent_critic stage=D2-3,D3,D4 action=VERIFY status=LOCALLY_VERIFIED

- **D3 (`apps_script/GmailProbe.gs`, `apps_script/GmailProbe.appsscript.json`, `tests/fixtures/emails/*.json`, `tests/node/gmail_probe.test.js`) + تكامل `Code.gs`:** Web App منفصل بصلاحية `gmail.readonly`، توقيع `HMAC-SHA256` بمقارنة ثابتة الزمن، `5` دقائق نافذة زمنية + قفل `nonce` لـ `10` دقائق في `CacheService`، فحص حجم UTF-8، بحث `after:<epoch> in:anywhere to:jdpx6218@gmail.com`، تصنيف `otp | magic_link | none` دون تسريب أي محتوى بريد، وحجز حصة `probe_calls` ذرياً قبل الاستدعاء الخارجي في `Code.gs` خارج القفل.
- **D2-3 (`tests/node/code_gs.test.js` + تقوية `gas_mocks.js`):** 10 اختبارات شاملة تشمل `setupProduction`، إبطال كاش `onEdit` وبوابة `426`، 20 إرسالاً متتالية على نفس المضيف (`^prov_[0-9a-f]{8}$`) تمر جميعاً عبر `python scripts/validate_piece.py` الحقيقي، `identity_mismatch`، دورة حياة التوكنات، تقسيم الكاش `>110KB`، التصفح والعقود الزمنية، `flag_piece`/`blind_reverify`/`resolve_review` وتمرير أحداث المراجعة لـ `validate_piece.py`، `github_outbox` حتى `dead`، `sync_from_github` بلا حلقات، وحدود الجسم والسرعة والـ prototype keys.
- **D4 (`test_canonical_parity.py`, `live_smoke.py`, `prompts/agent_connect/*`, `README_DEPLOY.md`, `CATALOG.md`/`docs/index.html`, إصلاح `run_tests.cmd`):** تحقق بايتي بالـ SHA-256 بين Node `Code.gs` وPython `hub_common.py` (شاملاً non-BMP `🚀`)، سكريبت دخان حي، قوالب توصيل الوكلاء، ودليل النشر الصباحي.
- **مراجعة نظيفة مستقلة (`research` Subagent `8e60e589-3254-4745-aa92-c39981116408`):** رصدت 6 ثغرات/تناقضات وتم إصلاحها جميعاً قبل الاختبار النهائي (اسم السر `HUB_URL` في الدليل، حالة أحرف `Browser` وتطبيع `access_types`، حظر `BLOCKED_HOSTS` في `register_submit_intent`/`report_captcha`/`probe_email`، وحدة بحث Gmail `after:<epoch>` بدلاً من `newer_than:20m`، قياس UTF-8 بالبايت في `GmailProbe.gs`، وتحديث `custom_gpt_openapi.yaml`/`opencode.md`/`generic_script.md`).
- **نتيجة الاختبار النهائي بعد آخر تعديل (`run_tests.cmd all`):** `Python: Ran 96 tests in 5.059s OK (skipped=1 test_symlink_forbidden on Windows; test_symlink_forbidden_mocked + test_canonical_parity passed)` + `Node: tests 38, pass 38, fail 0 (391ms)` + `SKIPPED LIVE SMOKE` + صفر جداول Markdown في المستندات المولّدة (`TABLES_FOUND: 0`).
- **متبقي حي صباحاً:** نشر `Code.gs` و`GmailProbe.gs` وربط GitHub Secrets وتشغيل `live_smoke.py` مع `HUB_URL` و`HUB_TEST_TOKEN` (وتجديد جلسة `Upstage` اختيارياً لأخذ توقيع `Fable 5.1` على `D2-3..D4`).

**[LOCALLY_APPROVED_BY_ANTIGRAVITY D2-3,D3,D4 — FABLE_SIGNOFF_PENDING_401_REFRESH]**
