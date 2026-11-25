# سجل القرارات والتعديلات — `ai-providers-hub`

## 1. توثيق المواصفات الحية + نموذج `Apps Script` التجريبي (`v0.1`)
- **المشكلة / الطلب:** المالك طلب حفظ كل قرارات المشروع في ملف `.md` بنظام الإلحاق (`Append-Only`)، وبناء تجربة حية مصغّرة لـ `Google Apps Script` قبل إغلاق خطة التنفيذ النهائية مع `Claude Fable 5.1`.
- **ما تم:**
  - تحديث [SPEC_AND_MEMORY.md](../../SPEC_AND_MEMORY.md) بكل قرارات الجولة 2 (فصل حساب الشيت عن `jdpx6218@gmail.com`، تصنيف الشاتات المقفولة للقراءة فقط، نظام GitHub ملف لكل قطعة + Google Sheets، واشتراط تجربة `Apps Script` أولاً).
  - إنشاء نموذج [Code.gs](../../prototype_apps_script/Code.gs) يدعم: `setupPrototype()` (إنشاء 3 تبويبات + مفتاحي اختبار عشوائيين في `ScriptProperties`)، `doGet` (`ping`, `list`)، و`doPost` (مصادقة `token` في الجسم لأن `Apps Script` لا يمرّر هيدرز مخصصة، تطبيع الدومين، قفل ذري `LockService`، منع تكرار المزود في `providers`، وإضافة قطع كل وكيل في صف منفصل مع idempotency).
- **التحقق:** تم فحص الصياغة والمنطق محلياً بمحاكاة Node `vm` (`providers: 1, pieces: 2, r2_reused_provider: true, rDup_idempotent: true`)، **ثم تم التحقق الحي الفعلي ضد رابط Web App المنشور (`task-225`, exit 0):** نجاح `ping (200)`، رفض `401`، رفض `422`، سباق متزامن بين `Python urllib` و`Node fetch` أنشأ مزوداً واحداً (`prov_9aafff29` / `openrouter.ai`) + قطعتين منفصلتين (`pc_5b60e8af-caf` و`pc_74b986a6-ec5`)، ونجاح `idempotent: true` في المحاولة المكررة.
- **الدروس والمخاطر:**
  - `Apps Script` يُسقط HTTP `Authorization` headers ويعيد `302` بعد `doPost` ويرد دائماً بـ HTTP `200`؛ لذا تم وضع `token` في JSON body وأكواد الحالة المنطقية داخل JSON (`code: 201/401/422`).
  - **إثبات عملي للـ `302 Redirect`:** كل من Python `urllib` وNode `fetch` تبعا تحويل `302` وحصلا على رد `doPost` الكامل بلا أخطاء.
  - تنبيه: لا تُسلّم مفاتيح Google/GitHub الرئيسية لأي وكيل خارجي؛ هذا النموذج للتجربة المعزولة فقط على حساب Google النظيف.


## 2. إقفال البوابة الرئيسية وبريد التحقق والاختبارات الشاملة ووثائق النشر (`D2-3`, `D3`, `D4`)
- **المشكلة / السياق:** بعد توقيع `Claude Fable 5.1` على `PLAN.md` و `TASKS.json` و `D1` و `D2-1` و `D2-2_fixed`، انتهت صلاحية جلسة `Upstage Studio` (`upstage_session.json`) بكود `401` الساعة `04:59 ص` قبل إتمام `D2-3` و `D3` و `D4`.
- **ما تم بواسطة `Antigravity` + مراجع نظيف (`research`):**
  - **تحديث [Code.gs](../../apps_script/Code.gs) (`D2` / `D3` integration):** ضبط `hmacHex_` باستخدام `Utilities.Charset.UTF_8`، تطبيع متغيرات `report_captcha` مع حظر `BLOCKED_HOSTS` في `register_submit_intent`/`report_captcha`/`probe_email`، تحصين `authenticate_`/`ACTIONS_` بـ `hasOwnProperty`، تطبيع `identity.payload.access_types` ليتطابق مع enum المخطط، إعادة `200` في تكرار `report_captcha`، وحجز حصة `probe_calls` ذرياً داخل `MICRO_LOCK_MS` بعد التحقق من النية والإعداد وقبل `UrlFetchApp.fetch` خارج القفل.
  - **بناء [GmailProbe.gs](../../apps_script/GmailProbe.gs) و[GmailProbe.appsscript.json](../../apps_script/GmailProbe.appsscript.json) (`D3`):** ويب آب معزول بصلاحية `gmail.readonly` فقط على `jdpx6218@gmail.com`، مقارنة HMAC ثابتة الزمن، نافذة `5` دقائق + قفل `nonce` لـ `10` دقائق في `CacheService` بعد التحقق من التوقيع، فحص حجم UTF-8 بـ `Utilities.newBlob`, بحث `after:<epoch> in:anywhere to:<target>` بدلاً من `newer_than:20m` (الذي يعني `20 شهراً` في Gmail)، وإرجاع `{ result: otp|magic_link|none, matched_sender_domain, received_at_utc }` فقط بلا أي تسريب لمحتوى الرسالة.
  - **توسيع [gas_mocks.js](../../tests/node/mocks/gas_mocks.js) والاختبارات (`D2-3`, `D3`, `D4`):** إضافة `GmailApp` (بأخطاء ومحددات Gmail الحقيقية `after:` و`newer_than: d/m/y` و`in:anywhere`)، تتبع `CacheService` TTL، تتبع `hideColumns`/`ProtectionType`، [code_gs.test.js](../../tests/node/code_gs.test.js) (10 سيناريوهات كبرى شاملة السباق العشريني والتحقق العابر عبر تشغيل `scripts/validate_piece.py` على كل الملفات المرفوعة)، [gmail_probe.test.js](../../tests/node/gmail_probe.test.js) + 5 fixtures بريد، [test_canonical_parity.py](../../tests/python/test_canonical_parity.py)، [live_smoke.py](../../tests/smoke/live_smoke.py)، إصلاح خلل `if defined` المتداخل في [run_tests.cmd](../../run_tests.cmd)، قوالب [prompts/agent_connect/](../../prompts/agent_connect/)، ودليل [README_DEPLOY.md](../../README_DEPLOY.md).
- **التحقق بعد آخر تعديل:** تشغيل `run_tests.cmd all` ← `Python: Ran 96 tests in 5.059s OK (skipped=1 test_symlink_forbidden on Windows; test_symlink_forbidden_mocked + 3 canonical parity passed)` + `Node: 38/38 passed (0 failed, 391ms)` + `SKIPPED LIVE SMOKE` + فحص صفر جداول Markdown في المستندات المولّدة (`TABLES_FOUND: 0`).
- **الدروس والمخاطر:**
  - `newer_than:20m` في Gmail تعني **20 شهراً** لا 20 دقيقة؛ البديل الدقيق هو `after:<unix_epoch_sec>`.
  - عدم تصديق اختبارات التكامل مع محاكي فارغ: التأكيد العددي الصريح `assert.equal(Object.keys(pushedFiles).length, 20)` ضروري قبل تشغيل `validate_piece.py`.
  - في ملفات `.cmd` بـ Windows، تداخل `if defined A if defined B (...) else (...)` يربط `else` بالشرط الداخلي فقط؛ استخدم `goto`.


## 3. الرفع الحي على GitHub وإصلاح خللين في GitHub Actions (`validate-and-sync.yml` + `pages.yml`)
- **المشكلة / السياق:**
  1. بعد تهيئة مستودع `wewe00220033/ai-providers-hub` وإزالة `.github/workflows/static.yml` الافتراضي، فشل التشغيل الأول لـ `validate-and-sync.yml` قبل تشغيل أي Job (`Invalid workflow file: #L146`).
  2. وبعد إصلاح السطر 146، فشل تشغيل `pages.yml` (`#2`) عبر `workflow_run` في خطوة `Deploy to GitHub Pages` بعد 320ms فقط من الرفع (`No artifacts named "github-pages" were found`).
- **ما تم:**
  - `.github/workflows/validate-and-sync.yml:146`: تحويل السطر `run: echo 'SKIPPED sync: ...'` إلى كتلة متعددة الأسطر `run: |` وتجنّب `: ` داخل scalar YAML غير مقتبس.
  - `.github/workflows/pages.yml:49-53`: الترقية من `actions/deploy-pages@v4` إلى `actions/deploy-pages@v5` وإضافة `sleep 3` لفهرسة artifact الصفحات قبل النشر.
  - تهيئة الريبو المحلي ورفع الفرعين **`main`** (الإنتاج + البيانات + الأتمتة + الذاكرة + الكود) و**`scripts`** (مرجع التطوير، مع إبقاء نفس السجل لتجنب تعارض حذف البيانات عند `git merge`) دون حفظ أي توكن في `.git/config`.
- **التحقق الحي:**
  - تشغيل `run_tests.cmd unit` بنجاح (`RC=0`).
  - على commit `c0c949a`: نجح `validate-and-sync` (`#4`, `conclusion=success`) ونجح `pages` (`#3`, `conclusion=success`) وفتح الرابط الحي `https://wewe00220033.github.io/ai-providers-hub/` بـ `HTTP 200` وعنوان `📚 كتالوج مزودي الموديلات`.
- **الدروس:**
  - أي تعبير `word: space` داخل سطر `run: ...` في YAML بدون علامات تنصيص خارجية أو `|` يُكسر على GitHub Parser.
  - الرفع السريع عبر `upload-pages-artifact@v3` ثم الاستعلام الفوري من `deploy-pages@v4` قد يصطدم بفارق فهرسة أجزاء من الثانية؛ استخدام `deploy-pages@v5` + مهلة قصيرة `3s` عالج السباق تماماً.
