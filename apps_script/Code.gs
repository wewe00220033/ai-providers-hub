/**
 * AI Providers Puzzle Hub — Google Apps Script backend (Code.gs)
 * بيئة التشغيل: GAS V8 (وتُختبر داخل node vm). لذلك:
 *  - كل الدوال العامة `function name(){}` على المستوى الأعلى، والثوابت `var` فقط.
 *  - لا setTimeout / require / class على المستوى الأعلى.
 * القاعدة المطلقة (§3.9): لا UrlFetchApp.fetch بينما القفل محجوز.
 */

// ───────────────────────────── §0 الثوابت والهيكل ─────────────────────────────
var HUB = {
  SHEETS: {
    MASTER_PROMPT: 'MASTER_PROMPT',
    PROVIDERS: 'providers',
    ALIASES: 'provider_aliases',
    PIECES: 'pieces',
    LEASES: 'claim_leases',
    TASKS: 'search_tasks',
    SUBMIT_LOG: 'submit_log',
    REVIEWS: 'owner_reviews',
    SCORES: 'agent_scores',
    DASHBOARD: 'dashboard_view',
    LOGS: 'logs',
    OUTBOX: 'github_outbox'
  },
  // ترتيب الإنشاء (MASTER_PROMPT يُنقل للموضع 1 لاحقاً)
  ORDER: ['MASTER_PROMPT', 'providers', 'provider_aliases', 'pieces', 'claim_leases', 'search_tasks', 'submit_log', 'owner_reviews', 'agent_scores', 'dashboard_view', 'logs', 'github_outbox'],
  // الرؤوس الحرفية (الترتيب ملزم)
  HEADERS: {
    providers: ['provider_id', 'canonical_host', 'display_name', 'status', 'channels', 'usage_url', 'agents_contributed', 'models_found_compact', 'free_summary', 'auth_summary', 'owner_review_note', 'first_seen_by', 'first_seen_at_utc', 'first_seen_at_cairo', 'pieces_count', 'last_piece_at_cairo', 'github_dir'],
    provider_aliases: ['alias_host', 'provider_id', 'kind', 'added_by', 'added_at_cairo'],
    pieces: ['piece_id', 'provider_id', 'canonical_host', 'agent_id', 'display_name', 'tok_tail', 'piece_type', 'model_tag', 'channels', 'summary', 'payload_json', 'evidence_url', 'evidence_excerpt', 'confidence', 'status', 'supersedes_piece_id', 'conflict_with', 'origin', 'idempotency_key', 'github_path', 'github_state', 'github_sha', 'created_at_utc', 'created_at_cairo'],
    claim_leases: ['task_id', 'agent_id', 'lease_until_utc', 'lease_until_cairo', 'state'],
    search_tasks: ['task_id', 'type', 'canonical_host', 'piece_type', 'state', 'blind_hint', 'excluded_agent_id', 'claimed_by', 'lease_until_utc', 'result_piece_id', 'block_reason', 'created_at_cairo', 'updated_at_cairo'],
    submit_log: ['canonical_host', 'agent_id', 'state', 'captcha_type', 'probe_result', 'intent_at_utc', 'window_until_utc', 'probe_calls', 'updated_at_cairo'],
    owner_reviews: ['review_id', 'piece_id', 'provider_id', 'flagged_agent_id', 'severity', 'owner_correction', 'blind_hint', 'state', 'reverify_task_id', 'resolved_by_piece_id', 'github_path', 'github_state', 'created_at_cairo', 'resolved_at_cairo'],
    agent_scores: ['agent_id', 'display_name', 'owner_label', 'role', 'source_kind', 'pieces_submitted', 'verified_count', 'flagged_minor', 'flagged_major', 'blind_fixes', 'accuracy_pct', 'score', 'last_active_cairo', 'last_flag_cairo'],
    logs: ['ts_utc', 'ts_cairo', 'agent_id', 'action', 'code', 'trace_id', 'detail'],
    github_outbox: ['piece_id', 'kind', 'path', 'attempts', 'next_retry_utc', 'last_error', 'state', 'updated_at_cairo']
  },
  LIMITS: {
    BODY_MAX_BYTES: 20480,
    RATE_PER_HOUR: 60,
    LOCK_MS: 25000,
    MICRO_LOCK_MS: 2500,
    LEASE_MIN: 15,
    INTENT_WINDOW_MIN: 15,
    PROBE_MAX: 3,
    OUTBOX_BATCH: 25,
    OUTBOX_MAX_ATTEMPTS: 6,
    OUTBOX_BUDGET_MS: 60000,
    LIST_MAX: 200,
    PAYLOAD_PUBLIC_MAX_BYTES: 2048,
    CACHE_CHUNK_CHARS: 30000, // ≤ 90000 بايت حتى مع UTF-8 ثلاثي البايت
    PROMPT_CACHE_SEC: 60,
    SUMMARY_MIN: 10,
    SUMMARY_MAX: 1000,
    EXCERPT_MIN: 20,
    EXCERPT_MAX: 600
  },
  ENUMS: {
    PIECE_TYPES: ['identity', 'guest_chat', 'signup_delta', 'free_tier', 'auth_flow', 'paid_pricing', 'referrals', 'not_found'],
    CONFIDENCE: ['observed', 'inferred'],
    AUTH_METHODS: ['email_password', 'email_otp', 'magic_link', 'username_password', 'phone_otp', 'oauth', 'passkey', 'sso'],
    OAUTH_PROVIDERS: ['google', 'github', 'microsoft', 'apple', 'gitlab', 'discord', 'x', 'facebook', 'linkedin', 'other'],
    CAPTCHA_TYPES: ['none', 'turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'arkose', 'geetest', 'image_captcha', 'unknown'],
    BLOCK_REASONS: ['captcha', 'paywall', 'geo_block', 'site_down', 'not_found'],
    SEVERITY: ['minor', 'major'],
    MODEL_TAGS: ['Claude Fable 5', 'Claude Fable 5.1', 'Claude Fable 5.2', 'Claude Opus 5.5', 'Claude Mythos 5', 'Claude Mythos 5.1', 'Claude Mythos 5.2', 'GPT-6 Astra', 'GPT-6.2 Astra'],
    CHANNELS: ['Chat', 'Browser', 'API', 'CLI', 'IDE', 'Desktop'],
    BLOCKED_HOSTS: ['localhost', 't.me', 'x.com', 'twitter.com', 'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'google.com', 'bing.com', 'duckduckgo.com', 'youtube.com', 'facebook.com', 'reddit.com', 'linkedin.com', 'github.com', 'gist.github.com', 'medium.com', 'wikipedia.org', 'instagram.com', 'tiktok.com', 'discord.com', 'discord.gg', 'ow.ly', 'is.gd', 'cutt.ly', 'rb.gy', 'yahoo.com', 'yandex.com', 'baidu.com', 'example.com', 'example.org', 'example.net'],
    LIST_SHEETS: ['providers', 'provider_aliases', 'pieces', 'claim_leases', 'search_tasks', 'submit_log', 'owner_reviews', 'agent_scores', 'logs', 'github_outbox']
  },
  // §4 الأدوار
  ROLE_ACTIONS: {
    agent: ['submit_piece', 'claim_task', 'release_task', 'complete_task', 'register_submit_intent', 'report_captcha', 'probe_email', 'heartbeat', 'list', 'get_tasks', 'get_provider', 'my_score', 'ping', 'catalog_summary'],
    owner: ['submit_piece', 'claim_task', 'release_task', 'complete_task', 'register_submit_intent', 'report_captcha', 'probe_email', 'heartbeat', 'list', 'get_tasks', 'get_provider', 'my_score', 'ping', 'catalog_summary',
      'flag_piece', 'resolve_review', 'set_prompt', 'issue_token', 'rotate_token', 'revoke_token', 'set_agent_label'],
    sync: ['sync_from_github', 'heartbeat', 'list', 'ping']
  },
  PUBLIC_GET: ['ping', 'get_prompt', 'get_tasks', 'catalog_summary', 'get_provider'],
  PROMPT_GATED: ['submit_piece', 'claim_task', 'complete_task']
};

// الاسم المختصر المعتمد لكل model_tag (الاسم الكامل → المختصر)
var MODEL_SHORT = {
  'Claude Fable 5': 'Fable 5', 'Claude Fable 5.1': 'Fable 5.1', 'Claude Fable 5.2': 'Fable 5.2',
  'Claude Opus 5.5': 'Opus 5.5',
  'Claude Mythos 5': 'Mythos 5', 'Claude Mythos 5.1': 'Mythos 5.1', 'Claude Mythos 5.2': 'Mythos 5.2',
  'GPT-6 Astra': 'Astra 6', 'GPT-6.2 Astra': 'Astra 6.2'
};

// عائلات الموديلات لعرض models_found_compact
var MODEL_FAMILIES = {
  'Claude Fable': { members: ['Claude Fable 5', 'Claude Fable 5.1', 'Claude Fable 5.2'], compact: 'Fable 5 / 5.1 / 5.2' },
  'Claude Opus': { members: ['Claude Opus 5.5'], compact: 'Opus 5.5' },
  'Claude Mythos': { members: ['Claude Mythos 5', 'Claude Mythos 5.1', 'Claude Mythos 5.2'], compact: 'Mythos 5 / 5.1 / 5.2' },
  'GPT Astra': { members: ['GPT-6 Astra', 'GPT-6.2 Astra'], compact: 'Astra 6 / 6.2' }
};

var AUTH_METHOD_LABELS = {
  email_password: 'Email + Password', email_otp: 'Email OTP', magic_link: 'Magic link', username_password: 'Username + Password',
  phone_otp: 'Phone OTP', oauth: 'OAuth', passkey: 'Passkey', sso: 'SSO'
};

// ───────────────────────────── §0.1 بذرة البرومبت ─────────────────────────────
// تُكتب في MASTER_PROMPT!A1 فقط إن كانت الخلية فارغة (setupProduction).
var MASTER_PROMPT_SEED = `# 🧩 البرومبت الرئيسي — AI Providers Puzzle Hub (v1)

## 1) مهمتك
إنت وكيل بحث بتوثّق مزودين الموديلات دي **بالاسم الكامل بس**: \`Claude Fable 5\` / \`Claude Fable 5.1\` / \`Claude Fable 5.2\` / \`Claude Opus 5.5\` / \`Claude Mythos 5\` / \`Claude Mythos 5.1\` / \`Claude Mythos 5.2\` / \`GPT-6 Astra\` / \`GPT-6.2 Astra\`.
كل معلومة = قطعة بازل (\`piece\`) ليها دليل حرفي من موقع المزود نفسه. القنوات المسموحة ست بس: \`Chat / Browser / API / CLI / IDE / Desktop\` — تطبيقات الموبايل برّه الشغل خالص.
أول قطعة لأي مزود جديد: \`identity\` (\`display_name\`, \`usage_url\`, \`access_types\`).

## 2) المجاني الأول، ثم المجاني
ترتيب القطع لكل مزود:
1. \`guest_chat\` — شات من غير تسجيل: \`works_without_signup\`, \`mode\` (\`instant\` / \`fast\` / \`quick\` / \`auto\` / \`model_select\` / \`unknown\`), \`models_named\`, \`free_credits_or_quota\`, \`requires_card\`, \`none_found\`.
2. \`free_tier\` — الباقة المجانية بعد التسجيل: \`exists\`, \`includes_target_models\`, \`models_named\`, \`free_models_other\` (بالاسم)، \`free_credits_or_quota\`, \`requires_card\` (true/false)، \`auto_charges_after_trial\` (true/false/null)، \`how_to_use\`, \`none_found\`.
3. \`signup_delta\` — إيه اللي بيتغير بعد التسجيل: \`credits_increase\`, \`unlocked_models\`.
4. \`auth_flow\` — \`flow\` (\`signup\`/\`login\`)، \`methods\` من القايمة المغلقة (\`email_password / email_otp / magic_link / username_password / phone_otp / oauth / passkey / sso\`)، \`oauth_providers\`، \`captcha: {detected, type}\`.
5. \`paid_pricing\` — \`plans[]\` أو \`per_million_tokens\` + \`terms_excerpt\` زي ما هو في المصدر.
6. \`referrals\` — \`exists\`, \`reward_immediate\`, \`requires_invitee_payment\`, \`reward_description\`.

دوّرت ومفيش؟ ابعت قطعة \`not_found\` بـ \`checked_pages\` (روابط https من نفس الدومين) + \`checked_at_utc\` + \`reason\`. ممنوع تسيب مزود من غير قطعة.

## 3) الدليل أو مفيش
- \`evidence_url\` لازم يبدأ بـ \`https://\` ومن نفس دومين المزود (أو subdomain منه).
- \`evidence_excerpt\` اقتباس **حرفي** من الصفحة، 20–600 حرف. انسخ، ما تلخّصش.
- \`confidence: observed\` بس لو شفتها بعينك في الصفحة دلوقتي. غير كده \`inferred\`.
- ممنوع تخترع من الذاكرة. مش لاقي = \`not_found\`.
- \`includes_target_models: true\` يلزمه \`model_tag\` من التسعة + اسم الموديل (كامل أو مختصر زي \`Fable 5.1\`) يظهر حرفياً جوه \`evidence_excerpt\`.

## 4) الروابط
ممنوع أي رابط فيه مقطع \`/-2\` (أو أي \`/-رقم\`)، أو \`//\` جوه المسار، أو مقطع متكرر أكتر من مرتين، أو \`utm_\` / \`ref=\` / \`fbclid\` / \`gclid\`. نضّفه قبل ما تبعته، ولو مش قادر تنضّفه ارفضه — الحارس هيرفضه بـ \`422\` على أي حال.

## 5) التسجيل والبريد
- **قبل ما تملى أي نموذج تسجيل:** ابعت \`register_submit_intent\` بـ \`host\`. لو الرد \`409 host_already_submitted\` = الدومين ده اتجرّب قبل كده — ما تحاولش تاني **أبداً**.
- البريد: \`jdpx6218@gmail.com\` + يوزر وباسورد عشوائيين. **مرة واحدة لكل دومين للأبد.**
- أي CAPTCHA (turnstile / recaptcha / hcaptcha / arkose / geetest / صور): **وقف فوراً** وابعت \`report_captcha\` بنوعها. ممنوع تحلها أو تتخطاها.
- بعد ما تبعت النموذج: \`probe_email\` بـ \`host\` عشان الحارس يشوف وصل OTP ولا magic link (حد أقصى 3 مرات لكل intent).

## 6) بروتوكول الاتصال بالحارس
- كل حاجة \`POST\` بجسم JSON على رابط الحارس. **التوكن في الجسم بس** (\`"token": "ag_..."\`). لو حطيته في الـ URL هيترفض فوراً \`400 token_in_query_forbidden\`.
- **ما تبعتش \`agent_id\` ولا \`display_name\` بتاعك.** السيرفر بيشتقهم من التوكن وبيتجاهل أي حاجة تبعتها.
- ابدأ بـ \`GET <url>?action=get_prompt\` وخزّن \`prompt_version\`. ابعته مع كل \`submit_piece\` / \`claim_task\` / \`complete_task\`.
- رد \`code: 426\` = البرومبت اتحدّث: اقرا \`data.prompt\`، خد \`data.prompt_version\` الجديد، وكمّل فوراً من غير ما توقف.
- **النجاح = \`ok === true\` و\`code\` يساوي \`200\` أو \`201\` بس.** HTTP 200 لوحده ما يعنيش نجاح: Apps Script بيرد 200 دايماً بعد التحويل 302، وجوه الـ JSON ممكن يبقى \`code: 422\`. اقرا الـ JSON دايماً.
- \`curl\`: استخدم \`curl -sL -H "Content-Type: application/json" -d '{...}' <URL>\` **بدون \`-X POST\`** عشان التحويل 302 بعد \`doPost\` يتبع بـ \`GET\` (صفحة \`echo\` بتقبل GET بس وبترد 405 لو POST — ثابت من التجربة الحية). الأفضل \`fetch\` في Node أو \`urllib\` في Python بالإعدادات الافتراضية.
- \`429\` → استنى 2 ثم 4 ثم 8 ثواني وأعد. \`409 task_claimed\` / \`409 host_already_submitted\` → ما تكررش. \`422\` → اقرا \`error\` وصحّح. \`401\` → التوكن غلط أو ملغي، وقف.
- \`claim_task\` قبل ما تشتغل على مهمة من \`get_tasks\`، و\`complete_task\` لما تخلص: \`done\` مع \`piece_id\`، أو \`blocked\` بسبب من \`captcha | paywall | geo_block | site_down | not_found\`.

## 7) شكل الكارت (عشان تعرف شغلك بيتعرض إزاي)
- السطر الأول بعد اسم المزود: \`🔗 الاستخدام: <usage_url>\`.
- بعدين: \`🆓 بدون تسجيل\` ← \`🎁 الباقة المجانية\` ← \`📈 بعد التسجيل\` ← \`🔐 التسجيل والدخول\` ← \`💳 المدفوع\` ← \`🤝 الإحالات\`.
- أسماء الموديلات مضغوطة بلا تكرار العيلة: \`Fable 5 / 5.1\`، \`Mythos 5.2\`، \`Astra 6 / 6.2\`.
- أي قسم مفيهوش قطعة بيتخفي خالص. مفيش «غير متوفر» ولا حشو.

## 8) القوالب
\`register_submit_intent\` (قبل أي نموذج):
\`\`\`json
{"token": "ag_...", "action": "register_submit_intent", "host": "chat.example-provider.ai"}
\`\`\`
\`report_captcha\` (أول ما تشوفها):
\`\`\`json
{"token": "ag_...", "action": "report_captcha", "host": "chat.example-provider.ai", "captcha_type": "turnstile"}
\`\`\`
\`submit_piece\` — القالب القياسي الكامل:
\`\`\`json
{
  "token": "ag_...",
  "action": "submit_piece",
  "prompt_version": "<12-hex من get_prompt>",
  "url": "https://chat.example-provider.ai/",
  "display_name": "Example Provider",
  "piece_type": "free_tier",
  "model_tag": "Claude Fable 5.1",
  "channels": ["Chat", "API"],
  "summary": "باقة مجانية بعد التسجيل تشمل Fable 5.1 بحد 50 رسالة يومياً بدون بطاقة",
  "payload": {
    "exists": true,
    "includes_target_models": true,
    "models_named": ["Claude Fable 5.1"],
    "free_models_other": ["Example-Lite"],
    "free_credits_or_quota": "50 messages/day",
    "requires_card": false,
    "auto_charges_after_trial": null,
    "how_to_use": "Sign up with email then pick the model from the dropdown",
    "none_found": false
  },
  "evidence_url": "https://chat.example-provider.ai/pricing",
  "evidence_excerpt": "Free plan: Claude Fable 5.1, 50 messages per day, no credit card required.",
  "confidence": "observed"
}
\`\`\`
`;

// ───────────────────────────── §1 أدوات عامة ─────────────────────────────

// تحويل قيمة أي خلية إلى نص (التواريخ → ISO)
function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function nowIso_() {
  return new Date().toISOString();
}

function addMinutes_(d, minutes) {
  return new Date(d.getTime() + minutes * 60000);
}

// التوقيت المصري: 'yyyy-MM-dd hh:mm a' مع ص/م
function cairoNow_(d) {
  d = d || new Date();
  return Utilities.formatDate(d, 'Africa/Cairo', 'yyyy-MM-dd hh:mm a').replace('AM', 'ص').replace('PM', 'م');
}

// تشغيل آمن للعمليات التجميلية (لا تُسقط الطلب أبداً)
function safe_(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

function byteLength_(s) {
  s = String(s || '');
  var bytes = safe_(function () { return Utilities.newBlob(s).getBytes().length; });
  if (typeof bytes === 'number') return bytes;
  // بديل: حساب UTF-8 يدوياً
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function uuid_() {
  var u = safe_(function () { return Utilities.getUuid(); });
  if (u) return String(u);
  var hex = '0123456789abcdef', out = '';
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return out;
}

// ULID: prefix + 10 حروف وقت + 16 عشوائي (Crockford base32)
function ulid_(prefix) {
  var ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var t = Date.now();
  var time = '';
  for (var i = 0; i < 10; i++) {
    time = ENC.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  var rand = '';
  for (var j = 0; j < 16; j++) rand += ENC.charAt(Math.floor(Math.random() * 32));
  return (prefix || '') + time + rand;
}

function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ((bytes[i] & 0xff).toString(16)).padStart(2, '0');
  return out;
}

// SHA-256 hex (البايتات موقّعة -128..127 في GAS)
function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function hmacHex_(value, secret) {
  var bytes = Utilities.computeHmacSha256Signature(String(value), String(secret || ''), Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

// ترتيب المفاتيح بنقاط كود Unicode (لا وحدات UTF-16) — باريتي مع Python sort_keys
function compareCodepoints_(a, b) {
  var A = Array.from(String(a)), B = Array.from(String(b));
  var n = Math.min(A.length, B.length);
  for (var i = 0; i < n; i++) {
    var ca = A[i].codePointAt(0), cb = B[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length - B.length;
}

// JSON قانوني عودي: مفاتيح مرتبة، بلا مسافات، UTF-8 خام
function canonicalJson_(obj) {
  var t = typeof obj;
  if (obj === null) return 'null';
  if (t === 'number') return isFinite(obj) ? JSON.stringify(obj) : 'null';
  if (t === 'boolean') return obj ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(obj);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
  if (obj instanceof Date) return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    var items = [];
    for (var i = 0; i < obj.length; i++) {
      var s = canonicalJson_(obj[i]);
      items.push(s === undefined ? 'null' : s);
    }
    return '[' + items.join(',') + ']';
  }
  if (typeof obj.toJSON === 'function') return canonicalJson_(obj.toJSON());
  var keys = Object.keys(obj).sort(compareCodepoints_);
  var parts = [];
  for (var k = 0; k < keys.length; k++) {
    var v = canonicalJson_(obj[keys[k]]);
    if (v === undefined) continue;
    parts.push(JSON.stringify(keys[k]) + ':' + v);
  }
  return '{' + parts.join(',') + '}';
}

// تطبيع المضيف: lowercase، بلا scheme/port/path/query/www.
function normalizeHost_(input) {
  if (input === null || input === undefined) return null;
  var s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, '');
  s = s.replace(/^\/\//, '');
  s = s.split(/[\/?#]/)[0];
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\.+$/, '');
  if (!s || s.indexOf('.') < 0) return null;
  if (s === 'localhost' || s.indexOf('[') >= 0) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  if (!/^[\p{L}\p{N}.\-]+$/u.test(s)) return null;
  if (/^[.\-]|[.\-]$|\.\./.test(s)) return null;
  return s;
}

function isBlockedHost_(host) {
  var list = HUB.ENUMS.BLOCKED_HOSTS;
  for (var i = 0; i < list.length; i++) {
    if (host === list[i] || host.slice(-(list[i].length + 1)) === '.' + list[i]) return true;
  }
  return false;
}

// تنظيف الرابط + فخ المسارات (/-رقم، // داخل المسار، مقطع مكرر > مرتين)
function cleanUrl_(u) {
  if (typeof u !== 'string') return { url: '', suspicious: false, invalid: true };
  u = u.trim();
  var m = u.match(/^(https?:\/\/[^\/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!m) return { url: u, suspicious: false, invalid: true };
  var origin = m[1], path = m[2] || '', query = m[3] || '', hash = m[4] || '';
  var suspicious = false;
  if (/\/-\d+/.test(path)) suspicious = true;
  if (path.indexOf('//') >= 0) suspicious = true;
  var counts = {};
  var segs = path.split('/');
  for (var i = 0; i < segs.length; i++) {
    if (!segs[i]) continue;
    counts[segs[i]] = (counts[segs[i]] || 0) + 1;
    if (counts[segs[i]] > 2) suspicious = true;
  }
  if (query) {
    var kept = [];
    var params = query.slice(1).split('&');
    for (var j = 0; j < params.length; j++) {
      if (!params[j]) continue;
      var key = params[j].split('=')[0].toLowerCase();
      if (/^utm_/.test(key) || key === 'ref' || key === 'fbclid' || key === 'gclid') continue;
      kept.push(params[j]);
    }
    query = kept.length ? '?' + kept.join('&') : '';
  }
  return { url: origin + path + query + hash, suspicious: suspicious, invalid: false };
}

// مفتاح مقارنة متسامح: أحرف صغيرة، المسافات/الشرطات تُحذف
function modelKey_(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_]+/g, '');
}

// يقبل الاسم الكامل أو المختصر (case-insensitive، متسامح في المسافات/الشرطات) ويُرجع الاسم الكامل المعتمد أو ''
function normalizeModelTag_(raw) {
  var k = modelKey_(raw);
  if (!k) return '';
  var tags = HUB.ENUMS.MODEL_TAGS;
  for (var i = 0; i < tags.length; i++) {
    var full = tags[i];
    if (k === modelKey_(full) || k === modelKey_(MODEL_SHORT[full])) return full;
  }
  // أشكال شائعة: gpt-6.2 astra / gpt6.2astra ↔ GPT-6.2 Astra، claude fable 5.1 ↔ Claude Fable 5.1
  for (var j = 0; j < tags.length; j++) {
    var t = tags[j];
    if (k === modelKey_('claude ' + MODEL_SHORT[t])) return t;
    if (/^GPT-/.test(t) && k === modelKey_(t.replace(/^GPT-/, 'gpt'))) return t;
  }
  return '';
}

// هل يذكر المقتطف الاسم الكامل أو المختصر حرفياً (case-insensitive)
function excerptMentionsTag_(excerpt, tag) {
  var ex = String(excerpt || '').toLowerCase();
  if (!ex || !tag) return false;
  var full = String(tag).toLowerCase();
  var short = String(MODEL_SHORT[tag] || '').toLowerCase();
  if (ex.indexOf(full) >= 0) return true;
  if (short && ex.indexOf(short) >= 0) return true;
  return false;
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// قيمة خلية: المصفوفات بفاصل ' · '، الكائنات JSON
function cellVal_(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x); }).join(' · ');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function splitDots_(s) {
  return str_(s).split(' · ').map(function (x) { return x.trim(); }).filter(Boolean);
}

function parseJsonSafe_(s, fallback) {
  try { var v = JSON.parse(str_(s)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}

// ───────────────────────────── §2 الخصائص والتوكنات (§3.6) ─────────────────────────────

function prop_(key) {
  return safe_(function () { return PropertiesService.getScriptProperties().getProperty(key); }) || '';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function loadTokens_() {
  var raw = prop_('AGENT_TOKENS_JSON');
  if (!raw) return {};
  return parseJsonSafe_(raw, {});
}

function saveTokens_(tokens) {
  setProp_('AGENT_TOKENS_JSON', JSON.stringify(tokens));
}

function newToken_() {
  return 'ag_' + uuid_();
}

// توليد التوكنات مرة واحدة فقط إن غابت الخاصية؛ تُطبع بـ Logger.log مرة واحدة ولا تُكتب في أي تبويب
function ensureTokens_() {
  var raw = prop_('AGENT_TOKENS_JSON');
  if (raw) return parseJsonSafe_(raw, {});
  var tokens = {};
  var now = nowIso_();
  var lines = [];
  for (var i = 1; i <= 10; i++) {
    var t = newToken_();
    tokens[t] = { agent_id: 'agent_' + pad2_(i), display_name: 'Agent ' + pad2_(i), owner_label: '', role: 'agent', source_kind: 'llm', created_at: now, revoked: false };
    lines.push('agent_' + pad2_(i) + ' = ' + t);
  }
  var to = newToken_();
  tokens[to] = { agent_id: 'owner', display_name: 'Owner', owner_label: 'owner', role: 'owner', source_kind: 'human', created_at: now, revoked: false };
  lines.push('owner = ' + to);
  var ts = newToken_();
  tokens[ts] = { agent_id: 'github_sync', display_name: 'GitHub Sync', owner_label: '', role: 'sync', source_kind: 'ci', created_at: now, revoked: false };
  lines.push('github_sync = ' + ts);
  saveTokens_(tokens);
  Logger.log('AGENT TOKENS (printed once — store them now):\n' + lines.join('\n'));
  return tokens;
}

function authenticate_(token) {
  var tokens = loadTokens_();
  var entry = Object.prototype.hasOwnProperty.call(tokens, token) ? tokens[token] : null;
  if (!entry) return { ok: false, error: 'invalid_token' };
  if (entry.revoked) return { ok: false, error: 'token_revoked' };
  return {
    ok: true,
    agent: {
      agent_id: str_(entry.agent_id),
      display_name: str_(entry.display_name),
      owner_label: str_(entry.owner_label),
      role: str_(entry.role),
      source_kind: str_(entry.source_kind),
      tok_tail: String(token).slice(-4)
    }
  };
}

function nextAgentId_(tokens, role) {
  var max = 0;
  var prefix = role === 'sync' ? 'sync_' : 'agent_';
  Object.keys(tokens).forEach(function (t) {
    var id = str_(tokens[t].agent_id);
    if (id.indexOf(prefix) === 0) { var n = parseInt(id.slice(prefix.length), 10); if (n > max) max = n; }
  });
  return prefix + pad2_(max + 1);
}

// ───────────────────────────── §3 أدوات الشيت ─────────────────────────────

function ss_() {
  var id = prop_('SPREADSHEET_ID');
  if (id) { var byId = safe_(function () { return SpreadsheetApp.openById(id); }); if (byId) return byId; }
  var ss = safe_(function () { return SpreadsheetApp.getActiveSpreadsheet(); });
  if (!ss) ss = safe_(function () { return SpreadsheetApp.getActive(); });
  if (!ss) throw new Error('spreadsheet_unavailable');
  return ss;
}

function headersOf_(name) {
  return HUB.HEADERS[name] || [];
}

// يحصل على التبويب (ينشئه مع رؤوسه إن غاب)
function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var h = headersOf_(name);
    if (h.length) sh.getRange(1, 1, 1, h.length).setValues([h]);
  }
  return sh;
}

// قراءة كل الصفوف ككائنات بالرؤوس (+ _row رقم الصف)
function readSheet_(name) {
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var rows = [];
  var lastRow = sh.getLastRow();
  if (lastRow >= 2 && headers.length) {
    var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var obj = { _row: i + 2 };
      var empty = true;
      for (var j = 0; j < headers.length; j++) {
        var v = values[i][j];
        if (v !== '' && v !== null && v !== undefined) empty = false;
        obj[headers[j]] = v;
      }
      if (!empty) rows.push(obj);
    }
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function appendObj_(name, obj) {
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var row = headers.map(function (h) { return cellVal_(obj[h]); });
  sh.appendRow(row);
  return sh.getLastRow();
}

function setCells_(name, rowIdx, updates) {
  var sh = sheet_(name);
  var headers = headersOf_(name);
  Object.keys(updates).forEach(function (k) {
    var col = headers.indexOf(k) + 1;
    if (col > 0) sh.getRange(rowIdx, col).setValue(cellVal_(updates[k]));
  });
}

// إيجاد صف بقيمة عمود (createTextFinder ثم مسح احتياطي)
function findRow_(name, colName, value) {
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var col = headers.indexOf(colName) + 1;
  if (!col) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var target = str_(value);
  var rng = sh.getRange(2, col, last - 1, 1);
  var found = safe_(function () {
    if (typeof rng.createTextFinder !== 'function') return 0;
    var f = rng.createTextFinder(target);
    if (f && typeof f.matchEntireCell === 'function') f = f.matchEntireCell(true);
    var cell = f && typeof f.findNext === 'function' ? f.findNext() : null;
    return cell ? cell.getRow() : 0;
  }, 0);
  if (found) return found;
  var vals = rng.getValues();
  for (var i = 0; i < vals.length; i++) if (str_(vals[i][0]) === target) return i + 2;
  return 0;
}

function rowObj_(name, rowIdx) {
  if (!rowIdx) return null;
  var sh = sheet_(name);
  var headers = headersOf_(name);
  var vals = sh.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
  var obj = { _row: rowIdx };
  for (var j = 0; j < headers.length; j++) obj[headers[j]] = vals[j];
  return obj;
}

// صف للعرض: نسخة نصية بلا _row (ويُحذف owner_correction دائماً)
function publicRow_(row, dropCols) {
  var out = {};
  Object.keys(row).forEach(function (k) {
    if (k === '_row' || k === 'owner_correction') return;
    if (dropCols && dropCols.indexOf(k) >= 0) return;
    var v = row[k];
    out[k] = (typeof v === 'number' || typeof v === 'boolean') ? v : str_(v);
  });
  return out;
}

function log_(agentId, action, code, traceId, detail) {
  try {
    var d = new Date();
    sheet_(HUB.SHEETS.LOGS).appendRow([d.toISOString(), cairoNow_(d), str_(agentId), str_(action), code || '', str_(traceId),
      typeof detail === 'string' ? detail.slice(0, 1000) : JSON.stringify(detail || '').slice(0, 1000)]);
  } catch (e) { /* السجل لا يُسقط الطلب */ }
}

// ───────────────────────────── §4 الكاش (§3.8) ─────────────────────────────

function cache_() {
  return CacheService.getScriptCache();
}

// تخزين فهرس كقطع idx:<name>:<i> + meta
function cacheSetIdx_(name, obj) {
  var cache = cache_();
  var s = JSON.stringify(obj || {});
  var size = HUB.LIMITS.CACHE_CHUNK_CHARS;
  var chunks = [];
  for (var i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  if (!chunks.length) chunks.push('{}');
  var kv = {};
  for (var c = 0; c < chunks.length; c++) kv['idx:' + name + ':' + c] = chunks[c];
  kv['idx:' + name + ':meta'] = JSON.stringify({ chunks: chunks.length, updated_utc: nowIso_() });
  if (typeof cache.putAll === 'function') cache.putAll(kv, 21600);
  else Object.keys(kv).forEach(function (k) { cache.put(k, kv[k], 21600); });
}

// قراءة فهرس؛ أي غياب → null (يُعاد البناء من الشيت)
function cacheGetIdx_(name) {
  var cache = cache_();
  var metaRaw = cache.get('idx:' + name + ':meta');
  if (!metaRaw) return null;
  var meta = parseJsonSafe_(metaRaw, null);
  if (!meta || !meta.chunks) return null;
  var s = '';
  for (var i = 0; i < meta.chunks; i++) {
    var part = cache.get('idx:' + name + ':' + i);
    if (part === null || part === undefined) return null;
    s += part;
  }
  var obj = parseJsonSafe_(s, null);
  return obj && typeof obj === 'object' ? obj : null;
}

// إعادة بناء فهرس من الشيت (يُستدعى داخل القفل عند الكتابة)
function rebuildIdx_(name) {
  var idx = {};
  if (name === 'providers') {
    readSheet_(HUB.SHEETS.PROVIDERS).rows.forEach(function (r) { var h = str_(r.canonical_host); if (h) idx[h] = str_(r.provider_id); });
  } else if (name === 'aliases') {
    readSheet_(HUB.SHEETS.ALIASES).rows.forEach(function (r) { var h = str_(r.alias_host); if (h) idx[h] = str_(r.provider_id); });
  } else if (name === 'idem') {
    readSheet_(HUB.SHEETS.PIECES).rows.forEach(function (r) { var k = str_(r.idempotency_key); if (k) idx[k] = str_(r.piece_id); });
  }
  cacheSetIdx_(name, idx);
  return idx;
}

function getIdx_(name) {
  var idx = cacheGetIdx_(name);
  return idx || rebuildIdx_(name);
}

// ───────────────────────────── §5 البرومبت ونسخته ─────────────────────────────

function readPrompt_() {
  return str_(sheet_(HUB.SHEETS.MASTER_PROMPT).getRange(1, 1).getValue());
}

function computePromptVersion_() {
  return sha256Hex_(readPrompt_().trim()).slice(0, 12);
}

// نسخة البرومبت مع كاش prompt:v لمدة 60 ثانية
function getPromptVersion_() {
  var cache = cache_();
  var cached = cache.get('prompt:v');
  if (cached) return String(cached);
  var v = computePromptVersion_();
  cache.put('prompt:v', v, HUB.LIMITS.PROMPT_CACHE_SEC);
  return v;
}

function safePromptVersion_() {
  return safe_(function () { return getPromptVersion_(); }, '');
}

// إعادة الحساب + كتابة B1/C1 + مسح الكاش
function refreshPromptVersion_() {
  var sh = sheet_(HUB.SHEETS.MASTER_PROMPT);
  var v = computePromptVersion_();
  sh.getRange(1, 2).setValue(v);
  sh.getRange(1, 3).setValue(cairoNow_(new Date()));
  safe_(function () { cache_().remove('prompt:v'); });
  return v;
}

// عند تعديل MASTER_PROMPT!A1 يدوياً
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (!sh || sh.getName() !== HUB.SHEETS.MASTER_PROMPT) return;
    var r1 = e.range.getRow(), c1 = e.range.getColumn();
    var nr = typeof e.range.getNumRows === 'function' ? e.range.getNumRows() : 1;
    var nc = typeof e.range.getNumColumns === 'function' ? e.range.getNumColumns() : 1;
    if (r1 <= 1 && r1 + nr - 1 >= 1 && c1 <= 1 && c1 + nc - 1 >= 1) refreshPromptVersion_();
  } catch (err) {
    log_('', 'onEdit', 500, '', String(err));
  }
}

// ───────────────────────────── §6 الإعداد الإنتاجي (idempotent) ─────────────────────────────

function setupProduction() {
  var ss = ss_();
  // 1) التبويبات والرؤوس
  HUB.ORDER.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    var h = headersOf_(name);
    if (h.length) {
      var current = safe_(function () { return sh.getRange(1, 1, 1, h.length).getValues()[0]; }, []);
      var same = current && current.length === h.length && h.every(function (x, i) { return str_(current[i]) === x; });
      if (!same) sh.getRange(1, 1, 1, h.length).setValues([h]);
      safe_(function () { sh.setFrozenRows(1); });
      safe_(function () {
        sh.getRange(1, 1, 1, h.length).setBackground('#1f2937').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
      });
      safe_(function () { for (var c = 1; c <= h.length; c++) sh.setColumnWidth(c, c === 1 ? 220 : 160); });
      safe_(function () { sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), h.length).setWrap(true); });
    }
  });

  // 2) تنسيق شرطي للحالات
  applyStatusColors_(HUB.SHEETS.PIECES, 'status');
  applyStatusColors_(HUB.SHEETS.PIECES, 'github_state');
  applyStatusColors_(HUB.SHEETS.PROVIDERS, 'status');
  applyStatusColors_(HUB.SHEETS.TASKS, 'state');
  applyStatusColors_(HUB.SHEETS.OUTBOX, 'state');
  applyStatusColors_(HUB.SHEETS.REVIEWS, 'state');
  applyStatusColors_(HUB.SHEETS.LEASES, 'state');

  // 3) MASTER_PROMPT: بذر A1 إن فارغة + الموضع الأول + حماية
  var mp = sheet_(HUB.SHEETS.MASTER_PROMPT);
  if (!readPrompt_().trim()) mp.getRange(1, 1).setValue(MASTER_PROMPT_SEED);
  var webUrl = prop_('WEBAPP_URL') || safe_(function () { return ScriptApp.getService().getUrl(); }, '') || '';
  mp.getRange(1, 4).setValue(webUrl ? webUrl + '?action=get_prompt' : '');
  safe_(function () { ss.setActiveSheet(mp); ss.moveActiveSheet(1); });
  safe_(function () { mp.getRange(1, 1).setBackground('#fff9c4').setWrap(true); mp.setRowHeight(1, 600); mp.setColumnWidth(1, 900); });
  safe_(function () { if (!mp.getProtections || !mp.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) mp.protect().setDescription('MASTER_PROMPT — يعدَّل عبر set_prompt أو المالك فقط'); });

  // 4) owner_reviews: حماية + إخفاء عمود owner_correction (العمود 6)
  var rv = sheet_(HUB.SHEETS.REVIEWS);
  safe_(function () { if (!rv.getProtections || !rv.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) rv.protect().setDescription('owner_reviews — المالك فقط'); });
  safe_(function () { rv.hideColumns(6); });

  // 5) لوحة المتابعة (صيغ فقط)
  setupDashboard_();

  // 6) التوكنات (مرة واحدة) + صفوف agent_scores
  var tokens = ensureTokens_();
  Object.keys(tokens).forEach(function (t) { ensureScoreRow_(tokens[t]); });

  // 7) مؤقت flushOutbox_ كل 10 دقائق إن لم يوجد
  safe_(function () {
    var exists = ScriptApp.getProjectTriggers().some(function (tr) { return tr.getHandlerFunction() === 'flushOutbox_'; });
    if (!exists) ScriptApp.newTrigger('flushOutbox_').timeBased().everyMinutes(10).create();
  });

  // 8) نسخة البرومبت
  var v = refreshPromptVersion_();
  log_('', 'setupProduction', 200, '', 'prompt_version=' + v);
  return v;
}

function applyStatusColors_(sheetName, colName) {
  safe_(function () {
    var sh = sheet_(sheetName);
    var col = headersOf_(sheetName).indexOf(colName) + 1;
    if (!col) return;
    var L = colLetter_(col);
    var range = sh.getRange(L + '2:' + L);
    var mk = function (text, bg, fg) {
      return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg || '#111111').setRanges([range]).build();
    };
    var rules = (sh.getConditionalFormatRules && sh.getConditionalFormatRules()) || [];
    rules = rules.concat([
      mk('verified', '#c8e6c9'), mk('needs_reverify', '#ffcdd2'), mk('claimed', '#fff59d'),
      mk('dead', '#b71c1c', '#ffffff'), mk('queued', '#e0e0e0'), mk('pushed', '#c8e6c9'),
      mk('open', '#e3f2fd'), mk('done', '#c8e6c9'), mk('blocked', '#ffe0b2'), mk('pending', '#fff59d')
    ]);
    sh.setConditionalFormatRules(rules);
  });
}

function setFormula_(sh, row, col, formula) {
  var r = sh.getRange(row, col);
  if (typeof r.setFormula === 'function') r.setFormula(formula); else r.setValue(formula);
}

function setupDashboard_() {
  var sh = sheet_(HUB.SHEETS.DASHBOARD);
  var S = HUB.SHEETS;
  var items = [
    ['prompt_version', '=' + S.MASTER_PROMPT + '!B1'],
    ['prompt_updated_cairo', '=' + S.MASTER_PROMPT + '!C1'],
    ['providers_total', '=COUNTA(' + S.PROVIDERS + '!A2:A)'],
    ['providers_verified', '=COUNTIF(' + S.PROVIDERS + '!D2:D,"verified")'],
    ['providers_needs_reverify', '=COUNTIF(' + S.PROVIDERS + '!D2:D,"needs_reverify")'],
    ['providers_active', '=COUNTIF(' + S.PROVIDERS + '!D2:D,"active")'],
    ['pieces_total', '=COUNTA(' + S.PIECES + '!A2:A)'],
    ['pieces_needs_reverify', '=COUNTIF(' + S.PIECES + '!O2:O,"needs_reverify")'],
    ['tasks_open', '=COUNTIF(' + S.TASKS + '!E2:E,"open")'],
    ['tasks_claimed', '=COUNTIF(' + S.TASKS + '!E2:E,"claimed")'],
    ['outbox_pending', '=COUNTIF(' + S.OUTBOX + '!G2:G,"pending")'],
    ['outbox_dead', '=COUNTIF(' + S.OUTBOX + '!G2:G,"dead")'],
    ['reviews_open', '=COUNTIF(' + S.REVIEWS + '!H2:H,"open")'],
    ['oldest_open_task_cairo', '=IFERROR(INDEX(SORT(FILTER(' + S.TASKS + '!L2:L,' + S.TASKS + '!E2:E="open"),1,TRUE),1),"-")']
  ];
  for (var i = 0; i < items.length; i++) {
    sh.getRange(i + 1, 1).setValue(items[i][0]);
    setFormula_(sh, i + 1, 2, items[i][1]);
  }
  var top = items.length + 2;
  sh.getRange(top, 1).setValue('top_agents (agent_id · display_name · score · accuracy_pct)');
  setFormula_(sh, top + 1, 1, '=IFERROR(QUERY(' + S.SCORES + '!A2:N,"select A,B,L,K where A<>\'\' order by L desc limit 10",0),"-")');
  safe_(function () { sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 220); sh.getRange(1, 1, items.length, 1).setFontWeight('bold'); });
}

// ───────────────────────────── §7 الطلب/الرد/الأمن (§4) ─────────────────────────────

function jsonOut_(res) {
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return jsonOut_(handleRequest_('GET', e || {}));
}

function doPost(e) {
  return jsonOut_(handleRequest_('POST', e || {}));
}

function ok_(code, data, hint) {
  return { code: code, data: data === undefined ? {} : data, hint: hint || '' };
}

function err_(code, error, hint, data) {
  var r = { code: code, error: error, hint: hint || '' };
  if (data !== undefined) r.data = data;
  return r;
}

// الرد الموحد
function envelope_(res, action, agent, traceId) {
  var d = new Date();
  var out = {
    ok: res.code >= 200 && res.code < 300,
    code: res.code,
    action: str_(action),
    agent: agent ? { agent_id: agent.agent_id, display_name: agent.display_name, role: agent.role, source_kind: agent.source_kind } : null,
    server_time_utc: d.toISOString(),
    server_time_cairo: cairoNow_(d),
    prompt_version: safePromptVersion_()
  };
  if (out.ok) {
    out.data = res.data === undefined ? {} : res.data;
  } else {
    out.error = res.error || 'error';
    if (res.data !== undefined) out.data = res.data;
  }
  out.hint = res.hint || '';
  out.trace_id = traceId;
  return out;
}

// توكن في الاستعلام = مرفوض قبل أي شيء
function hasTokenInQuery_(e) {
  var has = Object.prototype.hasOwnProperty;
  if (e && e.parameter && typeof e.parameter === 'object' && has.call(e.parameter, 'token')) return true;
  if (e && e.parameters && typeof e.parameters === 'object' && has.call(e.parameters, 'token')) return true;
  var qs = e && typeof e.queryString === 'string' ? e.queryString : '';
  if (qs && /(^|&)token=/.test(qs)) return true;
  return false;
}

// حد 60/ساعة/وكيل عبر الكاش
function rateAllow_(agentId) {
  var cache = cache_();
  var key = 'rate:' + agentId + ':' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  var n = parseInt(cache.get(key) || '0', 10) || 0;
  if (n >= HUB.LIMITS.RATE_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3600);
  return true;
}

var ACTIONS_ = {
  submit_piece: act_submit_piece_,
  claim_task: act_claim_task_,
  release_task: act_release_task_,
  complete_task: act_complete_task_,
  register_submit_intent: act_register_submit_intent_,
  report_captcha: act_report_captcha_,
  probe_email: act_probe_email_,
  heartbeat: act_heartbeat_,
  list: act_list_,
  get_tasks: act_get_tasks_,
  get_provider: act_get_provider_,
  my_score: act_my_score_,
  ping: act_ping_,
  catalog_summary: act_catalog_summary_,
  flag_piece: act_flag_piece_,
  resolve_review: act_resolve_review_,
  set_prompt: act_set_prompt_,
  issue_token: act_issue_token_,
  rotate_token: act_rotate_token_,
  revoke_token: act_revoke_token_,
  set_agent_label: act_set_agent_label_,
  sync_from_github: act_sync_from_github_
};

// نقطة التوجيه الرئيسية — تُرجع كائن JS عادياً
function handleRequest_(method, e) {
  var traceId = ulid_('tr_');
  var action = '';
  var agent = null;
  try {
    e = e || {};
    method = String(method || 'GET').toUpperCase();

    // (1) أمن: التوكن في الاستعلام ممنوع
    if (hasTokenInQuery_(e)) {
      log_('', 'token_in_query', 400, traceId, method);
      return envelope_(err_(400, 'token_in_query_forbidden', 'ضع التوكن داخل جسم JSON فقط (POST)'), '', null, traceId);
    }

    // (2) GET عام بلا توكن
    if (method !== 'POST') {
      var params = (e.parameter && typeof e.parameter === 'object') ? e.parameter : {};
      action = str_(params.action).trim();
      return envelope_(handlePublicGet_(action, params), action, null, traceId);
    }

    // (3) POST: الحجم ثم JSON ثم التوكن
    var contents = (e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
    if (byteLength_(contents) > HUB.LIMITS.BODY_MAX_BYTES) {
      log_('', 'payload_too_large', 422, traceId, String(byteLength_(contents)));
      return envelope_(err_(422, 'payload_too_large', 'الحد ' + HUB.LIMITS.BODY_MAX_BYTES + ' بايت'), '', null, traceId);
    }
    var body;
    try { body = JSON.parse(contents || '{}'); } catch (pe) { return envelope_(err_(400, 'invalid_json'), '', null, traceId); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return envelope_(err_(400, 'invalid_json'), '', null, traceId);
    action = str_(body.action).trim();

    var token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) { log_('', action, 401, traceId, 'token_required'); return envelope_(err_(401, 'token_required', 'أرسل "token" داخل الجسم'), action, null, traceId); }
    var auth = authenticate_(token);
    if (!auth.ok) { log_('', action, 401, traceId, auth.error + ' tail=' + token.slice(-4)); return envelope_(err_(401, auth.error), action, null, traceId); }
    agent = auth.agent;

    if (!action) return envelope_(err_(400, 'missing_action'), action, agent, traceId);
    if (!Object.prototype.hasOwnProperty.call(ACTIONS_, action)) { log_(agent.agent_id, action, 400, traceId, 'unknown_action'); return envelope_(err_(400, 'unknown_action'), action, agent, traceId); }

    // (4) الدور
    var allowed = HUB.ROLE_ACTIONS[agent.role] || [];
    if (allowed.indexOf(action) < 0) {
      log_(agent.agent_id, action, 403, traceId, 'role_not_allowed role=' + agent.role);
      return envelope_(err_(403, 'role_not_allowed'), action, agent, traceId);
    }

    // (5) الهوية من التوكن فقط؛ أي agent_id/display_name في الجسم يُتجاهل
    var hint = '';
    var nameIsPayload = ['submit_piece', 'set_agent_label', 'issue_token', 'sync_from_github', 'report_captcha'].indexOf(action) >= 0;
    var idMismatch = body.agent_id !== undefined && str_(body.agent_id) !== agent.agent_id && ['rotate_token', 'revoke_token', 'set_agent_label', 'sync_from_github'].indexOf(action) < 0;
    var nameMismatch = !nameIsPayload && body.display_name !== undefined && str_(body.display_name) !== agent.display_name;
    if (idMismatch || nameMismatch) {
      log_(agent.agent_id, action, 200, traceId, 'identity_mismatch body.agent_id=' + str_(body.agent_id) + ' body.display_name=' + str_(body.display_name));
      hint = 'identity_mismatch: agent_id/display_name في الجسم تم تجاهلهما؛ الهوية تُشتق من التوكن فقط';
    }

    var ctx = { agent: agent, trace_id: traceId, action: action, now: new Date(), hint: hint };

    // (6) بوابة 426
    if (HUB.PROMPT_GATED.indexOf(action) >= 0) {
      var pv = getPromptVersion_();
      if (str_(body.prompt_version).trim() !== pv) {
        log_(agent.agent_id, action, 426, traceId, 'got=' + str_(body.prompt_version));
        return envelope_(err_(426, 'PROMPT_UPDATED_RE_READ_REQUIRED', 'اقرأ data.prompt واستخدم data.prompt_version ثم أعد الطلب', { prompt: readPrompt_(), prompt_version: pv }), action, agent, traceId);
      }
    }

    // (7) حد المعدل
    if (action === 'submit_piece' && !rateAllow_(agent.agent_id)) {
      log_(agent.agent_id, action, 429, traceId, 'agent_rate_limited');
      return envelope_(err_(429, 'agent_rate_limited', 'الحد ' + HUB.LIMITS.RATE_PER_HOUR + ' قطعة/ساعة'), action, agent, traceId);
    }

    // (8) التنفيذ
    var res = ACTIONS_[action](ctx, body);
    if (hint && !res.hint) res.hint = hint;
    if (res.code >= 400) log_(agent.agent_id, action, res.code, traceId, res.error || '');
    return envelope_(res, action, agent, traceId);
  } catch (errAll) {
    log_(agent ? agent.agent_id : '', action, 500, traceId, String(errAll && errAll.stack ? errAll.stack : errAll));
    return envelope_(err_(500, 'internal_error', 'أعد المحاولة لاحقاً وأرسل trace_id للمالك'), action, agent, traceId);
  }
}

// GET عام: ping, get_prompt, get_tasks(open), catalog_summary, get_provider
function handlePublicGet_(action, params) {
  if (action === 'ping') return ok_(200, { pong: true });
  if (action === 'get_prompt') return ok_(200, { prompt: readPrompt_(), prompt_version: getPromptVersion_() });
  if (action === 'get_tasks') {
    var state = str_(params.state).trim() || 'open';
    if (state !== 'open') return err_(400, 'public_get_tasks_open_only', 'عبر GET يُسمح state=open فقط');
    var rows = readSheet_(HUB.SHEETS.TASKS).rows.filter(function (r) { return str_(r.state) === 'open'; })
      .map(function (r) { return publicRow_(r, ['excluded_agent_id', 'claimed_by']); });
    return ok_(200, { tasks: rows, count: rows.length });
  }
  if (action === 'catalog_summary') return ok_(200, catalogSummary_());
  if (action === 'get_provider') return providerView_(str_(params.host), true);
  return err_(400, 'unknown_action');
}

function catalogSummary_() {
  var provs = readSheet_(HUB.SHEETS.PROVIDERS).rows;
  var byStatus = {};
  provs.forEach(function (p) { var s = str_(p.status) || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1; });
  var pieces = readSheet_(HUB.SHEETS.PIECES).rows;
  var tasks = readSheet_(HUB.SHEETS.TASKS).rows;
  var outbox = readSheet_(HUB.SHEETS.OUTBOX).rows;
  var reviews = readSheet_(HUB.SHEETS.REVIEWS).rows;
  var count = function (arr, col, val) { return arr.filter(function (r) { return str_(r[col]) === val; }).length; };
  return {
    providers_total: provs.length,
    providers_by_status: byStatus,
    pieces_total: pieces.length,
    pieces_active: count(pieces, 'status', 'active'),
    pieces_needs_reverify: count(pieces, 'status', 'needs_reverify'),
    tasks_open: count(tasks, 'state', 'open'),
    tasks_claimed: count(tasks, 'state', 'claimed'),
    reviews_open: count(reviews, 'state', 'open'),
    outbox_pending: count(outbox, 'state', 'pending'),
    outbox_dead: count(outbox, 'state', 'dead'),
    agents_total: readSheet_(HUB.SHEETS.SCORES).rows.length
  };
}

// عرض مزود: عام (بلا tok_tail، payload_json > 2KB يُحذف) أو كامل عبر POST
function providerView_(hostRaw, isPublic) {
  var host = normalizeHost_(hostRaw);
  if (!host) return err_(422, 'invalid_host');
  var pid = getIdx_('providers')[host] || getIdx_('aliases')[host] || '';
  if (!pid) return err_(422, 'provider_not_found');
  var prow = rowObj_(HUB.SHEETS.PROVIDERS, findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', pid));
  if (!prow) return err_(422, 'provider_not_found');
  var pieces = readSheet_(HUB.SHEETS.PIECES).rows.filter(function (r) {
    return str_(r.provider_id) === pid && (isPublic ? str_(r.status) === 'active' : str_(r.status) !== 'superseded');
  }).map(function (r) {
    var o = publicRow_(r, isPublic ? ['tok_tail'] : []);
    if (isPublic && byteLength_(o.payload_json) > HUB.LIMITS.PAYLOAD_PUBLIC_MAX_BYTES) delete o.payload_json;
    return o;
  });
  return ok_(200, { provider: publicRow_(prow), pieces: pieces, pieces_count: pieces.length });
}

// ───────────────────────────── §8 الأقفال والتحديث الميكروي ─────────────────────────────

function acquireLock_(ms) {
  var lock = LockService.getScriptLock();
  try {
    if (typeof lock.waitLock === 'function') { lock.waitLock(ms); return lock; }
    if (typeof lock.tryLock === 'function' && lock.tryLock(ms)) return lock;
    return null;
  } catch (e) {
    return null;
  }
}

// تحديث ميكروي: قفل قصير → createTextFinder → كتابة خلايا (لا fetch هنا أبداً)
function microUpdate_(sheetName, keyCol, keyVal, updates) {
  var lock = acquireLock_(HUB.LIMITS.MICRO_LOCK_MS);
  if (!lock) return false;
  try {
    var row = findRow_(sheetName, keyCol, keyVal);
    if (!row) return false;
    setCells_(sheetName, row, updates);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// تحديث ميكروي لصف outbox بالمفتاح المركب (piece_id + path) — أول صف state='pending' مطابق؛ الإيجاد داخل القفل، لا fetch
function microUpdateOutbox_(pieceId, path, updates) {
  var lock = acquireLock_(HUB.LIMITS.MICRO_LOCK_MS);
  if (!lock) return false;
  try {
    var pid = str_(pieceId), pth = str_(path);
    var first = findRow_(HUB.SHEETS.OUTBOX, 'piece_id', pid); // createTextFinder داخل القفل
    var target = 0;
    if (first) {
      var fr = rowObj_(HUB.SHEETS.OUTBOX, first);
      if (fr && str_(fr.state) === 'pending' && (!pth || str_(fr.path) === pth)) target = first;
    }
    if (!target) {
      var rows = readSheet_(HUB.SHEETS.OUTBOX).rows;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (str_(r.piece_id) === pid && str_(r.state) === 'pending' && (!pth || str_(r.path) === pth)) { target = r._row; break; }
      }
    }
    if (!target) return false;
    setCells_(HUB.SHEETS.OUTBOX, target, updates);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────────── §9 GitHub (§3.9) ─────────────────────────────

function encodePath_(path) {
  return String(path).split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

function githubRequest_(method, url, headers, payloadObj) {
  var opts = { method: method, headers: headers, muteHttpExceptions: true };
  if (payloadObj) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payloadObj); }
  var resp = UrlFetchApp.fetch(url, opts);
  var code = typeof resp.getResponseCode === 'function' ? resp.getResponseCode() : 0;
  var text = typeof resp.getContentText === 'function' ? resp.getContentText() : '';
  return { code: code, text: text || '', json: parseJsonSafe_(text, null) };
}

// PUT محتوى على GitHub — يُستدعى خارج القفل فقط
function pushToGithub_(path, jsonStr, message) {
  var pat = prop_('GITHUB_PAT'), owner = prop_('GITHUB_OWNER'), repo = prop_('GITHUB_REPO');
  if (!pat || !owner || !repo) return { ok: false, code: 0, sha: null, error: 'github_not_configured' };
  var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + encodePath_(path);
  var headers = { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    var body = { message: String(message || '[hub-sync] update ' + path), content: Utilities.base64Encode(String(jsonStr), Utilities.Charset.UTF_8), branch: 'main' };
    var r = githubRequest_('put', url, headers, body);
    var shaOf = function (res) { return res.json && res.json.content && res.json.content.sha ? String(res.json.content.sha) : null; };
    if (r.code === 200 || r.code === 201) return { ok: true, code: r.code, sha: shaOf(r), error: null };
    if (r.code === 422) {
      // الملف موجود: اجلب sha ثم حدّث
      var g = githubRequest_('get', url + '?ref=main', headers, null);
      var existingSha = g.code === 200 && g.json && g.json.sha ? String(g.json.sha) : null;
      if (existingSha) {
        body.sha = existingSha;
        var r2 = githubRequest_('put', url, headers, body);
        if (r2.code === 200 || r2.code === 201) return { ok: true, code: r2.code, sha: shaOf(r2) || existingSha, error: null };
        if (r2.code === 422 && /already exists/i.test(r2.text)) return { ok: true, code: 422, sha: existingSha, error: null };
        return { ok: false, code: r2.code, sha: null, error: ('github_' + r2.code + ': ' + r2.text).slice(0, 300) };
      }
      if (/already exists/i.test(r.text)) return { ok: true, code: 422, sha: null, error: null };
    }
    return { ok: false, code: r.code, sha: null, error: ('github_' + r.code + ': ' + r.text).slice(0, 300) };
  } catch (e) {
    return { ok: false, code: 0, sha: null, error: ('fetch_error: ' + String(e && e.message ? e.message : e)).slice(0, 300) };
  }
}

// إدراج في outbox (بلا قفل). origin=github لا يدخل أبداً
function enqueueOutbox_(id, kind, path, lastError) {
  var d = new Date();
  appendObj_(HUB.SHEETS.OUTBOX, {
    piece_id: id, kind: kind, path: path, attempts: 0,
    next_retry_utc: addMinutes_(d, 2).toISOString(), last_error: str_(lastError).slice(0, 300),
    state: 'pending', updated_at_cairo: cairoNow_(d)
  });
}

// الدفع بعد الإدراج: خارج القفل → نجاح = تحديث ميكروي، فشل = outbox
function finalizeGithubPush_(kind, id, path, jsonStr, message) {
  var sheetName = kind === 'review' ? HUB.SHEETS.REVIEWS : HUB.SHEETS.PIECES;
  var keyCol = kind === 'review' ? 'review_id' : 'piece_id';
  var res = pushToGithub_(path, jsonStr, message);
  if (res.ok) {
    var upd = { github_state: 'pushed' };
    if (kind !== 'review') upd.github_sha = res.sha || '';
    if (microUpdate_(sheetName, keyCol, id, upd)) return { github_state: 'pushed', sha: res.sha || '' };
    enqueueOutbox_(id, kind, path, 'micro_lock_timeout_after_push');
    return { github_state: 'queued', sha: res.sha || '' };
  }
  enqueueOutbox_(id, kind, path, res.error);
  return { github_state: 'queued', sha: '' };
}

// JSON القطعة للمستودع — يطابق piece.base.schema.json (additionalProperties:false؛ بلا tok_tail/status/idempotency_key)
function buildPieceJson_(row) {
  var host = str_(row.canonical_host);
  var providerId = str_(row.provider_id);
  var provDisplay = '';
  var prow = providerId ? findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', providerId) : null;
  var prov = prow ? rowObj_(HUB.SHEETS.PROVIDERS, prow) : null;
  if (prov) { provDisplay = str_(prov.display_name); if (!host) host = str_(prov.canonical_host); }
  var ag = agentIdentityById_(str_(row.agent_id));
  return canonicalJson_({
    schema_version: 1,
    piece_id: str_(row.piece_id),
    provider: { provider_id: providerId, canonical_host: host, display_name: provDisplay || str_(row.display_name) || host },
    agent: { agent_id: str_(ag.agent_id), display_name: str_(ag.display_name) || str_(row.agent_id), source_kind: str_(ag.source_kind) || 'unknown' },
    piece_type: str_(row.piece_type),
    model_tag: str_(row.model_tag) || null,
    channels: Array.isArray(row.channels) ? row.channels : splitDots_(row.channels),
    summary: str_(row.summary),
    payload: parseJsonSafe_(row.payload_json, {}),
    evidence: { url: str_(row.evidence_url), excerpt: str_(row.evidence_excerpt), captured_at_utc: str_(row.created_at_utc) },
    confidence: str_(row.confidence),
    origin: str_(row.origin),
    created_at_utc: str_(row.created_at_utc),
    created_at_cairo: str_(row.created_at_cairo),
    conflict_with: str_(row.conflict_with) || null,
    supersedes_piece_id: str_(row.supersedes_piece_id) || null
  });
}

// حدث المراجعة (§3.10) — قائمة بيضاء صريحة فقط، لا نسخ للصف
function buildReviewEvent_(row, action) {
  var act = action === 'resolve' ? 'resolve' : 'flag';
  var d = new Date();
  var cairo = act === 'resolve' ? (str_(row.resolved_at_cairo) || cairoNow_(d)) : (str_(row.created_at_cairo) || cairoNow_(d));
  return {
    schema_version: 1,
    review_id: str_(row.review_id),
    piece_id: str_(row.piece_id),
    provider_id: str_(row.provider_id),
    canonical_host: str_(row.canonical_host),
    action: act,
    status: act === 'resolve' ? 'resolved' : 'needs_reverify',
    severity: str_(row.severity),
    blind_hint: str_(row.blind_hint),
    resolved_by_piece_id: str_(row.resolved_by_piece_id) || null,
    flagged_agent_id: str_(row.flagged_agent_id),
    created_at_utc: d.toISOString(),
    created_at_cairo: cairo
  };
}

function reviewHost_(reviewRow) {
  var pr = rowObj_(HUB.SHEETS.PROVIDERS, findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', str_(reviewRow.provider_id)));
  return pr ? str_(pr.canonical_host) : '';
}

// محتوى صف outbox لإعادة الدفع
function outboxContent_(ob) {
  var kind = str_(ob.kind);
  var id = str_(ob.piece_id);
  if (kind === 'review') {
    var rv = rowObj_(HUB.SHEETS.REVIEWS, findRow_(HUB.SHEETS.REVIEWS, 'review_id', id));
    if (!rv) return null;
    rv.canonical_host = reviewHost_(rv);
    var action = str_(rv.state) === 'resolved' ? 'resolve' : 'flag';
    return { jsonStr: canonicalJson_(buildReviewEvent_(rv, action)), message: '[hub-sync] review ' + id + ' ' + action, sheet: HUB.SHEETS.REVIEWS, keyCol: 'review_id', skip: false };
  }
  var pc = rowObj_(HUB.SHEETS.PIECES, findRow_(HUB.SHEETS.PIECES, 'piece_id', id));
  if (!pc) return null;
  if (str_(pc.origin) === 'github') return { skip: true };
  return { jsonStr: buildPieceJson_(pc), message: '[hub-sync] piece ' + id + ' ' + str_(pc.canonical_host) + ' ' + str_(pc.piece_type), sheet: HUB.SHEETS.PIECES, keyCol: 'piece_id', skip: false };
}

// إعادة المحاولة (مؤقت كل 10 دقائق): ≤ 25 صف، ميزانية 60 ثانية، backoff 2^attempts دقائق
function flushOutbox_() {
  var start = Date.now();
  var nowIso = nowIso_();
  var all = readSheet_(HUB.SHEETS.OUTBOX).rows;
  var due = all.filter(function (r) {
    return str_(r.state) === 'pending' && (!str_(r.next_retry_utc) || str_(r.next_retry_utc) <= nowIso);
  }).slice(0, HUB.LIMITS.OUTBOX_BATCH);
  var done = 0, failed = 0;
  for (var i = 0; i < due.length; i++) {
    if (Date.now() - start > HUB.LIMITS.OUTBOX_BUDGET_MS) break;
    var ob = due[i];
    var obId = str_(ob.piece_id), obPath = str_(ob.path);
    var d = new Date();
    var content = outboxContent_(ob);
    if (!content) { microUpdateOutbox_(obId, obPath, { state: 'dead', last_error: 'source_row_missing', updated_at_cairo: cairoNow_(d) }); failed++; continue; }
    if (content.skip) { microUpdateOutbox_(obId, obPath, { state: 'done', last_error: 'origin_github_skip', updated_at_cairo: cairoNow_(d) }); continue; }
    var res = pushToGithub_(obPath, content.jsonStr, content.message); // خارج القفل
    if (res.ok) {
      var upd = { github_state: 'pushed' };
      if (content.keyCol === 'piece_id') upd.github_sha = res.sha || '';
      microUpdate_(content.sheet, content.keyCol, obId, upd);
      microUpdateOutbox_(obId, obPath, { state: 'done', last_error: '', updated_at_cairo: cairoNow_(d) });
      done++;
    } else {
      var attempts = num_(ob.attempts) + 1;
      var dead = attempts >= HUB.LIMITS.OUTBOX_MAX_ATTEMPTS;
      microUpdateOutbox_(obId, obPath, {
        attempts: attempts,
        next_retry_utc: addMinutes_(d, Math.pow(2, attempts)).toISOString(),
        last_error: str_(res.error).slice(0, 300),
        state: dead ? 'dead' : 'pending',
        updated_at_cairo: cairoNow_(d)
      });
      failed++;
    }
  }
  log_('', 'flushOutbox_', 200, '', 'due=' + due.length + ' done=' + done + ' failed=' + failed);
  return { due: due.length, done: done, failed: failed };
}

// ───────────────────────────── §10 التحقق من القطعة (§6) ─────────────────────────────

function hostMatches_(evHost, host, ctx) {
  if (!evHost || !host) return false;
  if (evHost === host) return true;
  if (evHost.slice(-(host.length + 1)) === '.' + host) return true;
  var providers = (ctx && ctx.idxProviders) || getIdx_('providers');
  var aliases = (ctx && ctx.idxAliases) || getIdx_('aliases');
  var pid = providers[host] || aliases[host];
  var evPid = providers[evHost] || aliases[evHost];
  return !!(pid && evPid && pid === evPid);
}

// تُرجع {ok:true, piece} أو {ok:false, code:422, error}
function validatePiece_(body, ctx) {
  var L = HUB.LIMITS, E = HUB.ENUMS;
  var fail = function (error, hint) { return { ok: false, code: 422, error: error, hint: hint || '' }; };
  if (!body || typeof body !== 'object') return fail('invalid_body');

  var rawHost = body.url || body.domain || body.host || body.canonical_host;
  var host = normalizeHost_(rawHost);
  if (!host) return fail('invalid_host', 'أرسل url أو domain صالحاً');
  if (isBlockedHost_(host)) return fail('host_blocked');

  var piece_type = str_(body.piece_type).trim();
  if (E.PIECE_TYPES.indexOf(piece_type) < 0) return fail('invalid_piece_type', E.PIECE_TYPES.join('|'));

  var channels = body.channels;
  if (!Array.isArray(channels)) return fail('channels_required');
  channels = channels.map(function (c) { return str_(c).trim(); }).filter(Boolean).map(function (c) {
    for (var i = 0; i < E.CHANNELS.length; i++) if (E.CHANNELS[i].toLowerCase() === c.toLowerCase()) return E.CHANNELS[i];
    return c;
  });
  if (!channels.length) return fail('channels_required');

  var confidence = str_(body.confidence).trim();
  if (E.CONFIDENCE.indexOf(confidence) < 0) return fail('invalid_confidence', 'observed|inferred');

  var summary = str_(body.summary).trim();
  if (summary.length < L.SUMMARY_MIN || summary.length > L.SUMMARY_MAX) return fail('summary_length', L.SUMMARY_MIN + '–' + L.SUMMARY_MAX + ' حرفاً');

  var payloadIn = body.payload;
  if (!payloadIn || typeof payloadIn !== 'object' || Array.isArray(payloadIn)) return fail('payload_required');
  var payload = {};
  Object.keys(payloadIn).forEach(function (k) { if (k !== 'probe_result') payload[k] = payloadIn[k]; }); // probe_result سيرفري فقط

  // الدليل
  var ev = typeof body.evidence_url === 'string' ? body.evidence_url.trim() : '';
  if (!/^https:\/\//i.test(ev)) return fail('evidence_url_https_required');
  var cu = cleanUrl_(ev);
  if (cu.invalid) return fail('evidence_url_invalid');
  if (cu.suspicious) return fail('suspicious_path');
  var evHost = normalizeHost_(cu.url);
  if (!evHost || !hostMatches_(evHost, host, ctx)) return fail('evidence_host_mismatch');

  var excerpt = str_(body.evidence_excerpt).trim();
  if (confidence === 'observed' && !excerpt) return fail('evidence_excerpt_required');
  if (excerpt && (excerpt.length < L.EXCERPT_MIN || excerpt.length > L.EXCERPT_MAX)) return fail('evidence_excerpt_length', L.EXCERPT_MIN + '–' + L.EXCERPT_MAX + ' حرفاً');

  var model_tag = '';
  if (body.model_tag !== undefined && body.model_tag !== null && str_(body.model_tag).trim() !== '') {
    model_tag = normalizeModelTag_(body.model_tag);
    if (!model_tag) return fail('invalid_model_tag', E.MODEL_TAGS.join('|'));
  }

  // فخ المسارات داخل payload.usage_url
  if (typeof payload.usage_url === 'string' && payload.usage_url) {
    var uu = cleanUrl_(payload.usage_url);
    if (uu.suspicious) return fail('suspicious_path');
    if (!uu.invalid) payload.usage_url = uu.url;
  }

  // قواعد حسب النوع
  if (piece_type === 'free_tier' || piece_type === 'guest_chat') {
    var models = payload.models_named;
    var namedList = Array.isArray(models) ? models.map(function (m) { return str_(m).trim(); }).filter(Boolean) : [];
    var hasModels = Array.isArray(models) && namedList.length >= 1;
    if (!hasModels && payload.none_found !== true) return fail('models_or_none_required', 'payload.models_named[] أو none_found:true');
    if (namedList.length > 0 && payload.none_found === true) return fail('free_claim_contradiction', 'models_named غير فارغة مع none_found:true');
    if (payload.includes_target_models === true) {
      var targets = [];
      if (model_tag) targets.push(model_tag);
      namedList.forEach(function (m) { var nt = normalizeModelTag_(m); if (nt && targets.indexOf(nt) < 0) targets.push(nt); });
      if (!targets.length) return fail('target_model_required', 'model_tag أو models_named[] يجب أن يحوي موديلاً مستهدفاً');
      var mentioned = false;
      for (var ti = 0; ti < targets.length; ti++) if (excerptMentionsTag_(excerpt, targets[ti])) { mentioned = true; break; }
      if (!mentioned) return fail('model_tag_not_in_excerpt', 'يجب أن يذكر evidence_excerpt اسم الموديل الكامل أو المختصر حرفياً');
    }
  }
  if (piece_type === 'auth_flow') {
    var flow = str_(payload.flow).trim();
    if (flow !== 'signup' && flow !== 'login') return fail('invalid_auth_flow', 'signup|login');
    payload.flow = flow;
    var methods = payload.methods;
    if (!Array.isArray(methods) || !methods.length) return fail('invalid_auth_method', E.AUTH_METHODS.join('|'));
    for (var mi = 0; mi < methods.length; mi++) if (E.AUTH_METHODS.indexOf(str_(methods[mi])) < 0) return fail('invalid_auth_method', E.AUTH_METHODS.join('|'));
    payload.methods = methods.map(String);
    if (payload.oauth_providers !== undefined) {
      var ops = payload.oauth_providers;
      if (!Array.isArray(ops)) return fail('invalid_oauth_provider', E.OAUTH_PROVIDERS.join('|'));
      for (var oi = 0; oi < ops.length; oi++) if (E.OAUTH_PROVIDERS.indexOf(str_(ops[oi])) < 0) return fail('invalid_oauth_provider', E.OAUTH_PROVIDERS.join('|'));
      payload.oauth_providers = ops.map(String);
    }
    var cap = payload.captcha;
    if (!cap || typeof cap !== 'object' || Array.isArray(cap) || typeof cap.detected !== 'boolean') return fail('invalid_captcha_type', 'captcha: {detected: boolean, type}');
    var capType = str_(cap.type).trim();
    if (E.CAPTCHA_TYPES.indexOf(capType) < 0) return fail('invalid_captcha_type', E.CAPTCHA_TYPES.join('|'));
    if (cap.detected === true && capType === 'none') return fail('captcha_type_inconsistent', 'detected:true مع type:none');
    payload.captcha = { detected: cap.detected, type: capType };
  }
  if (piece_type === 'identity' && Array.isArray(payload.access_types)) {
    payload.access_types = payload.access_types.map(function (c) {
      var s = str_(c).trim();
      for (var ci = 0; ci < E.CHANNELS.length; ci++) {
        if (E.CHANNELS[ci].toLowerCase() === s.toLowerCase()) return E.CHANNELS[ci];
      }
      return s;
    }).filter(Boolean);
    for (var ai = 0; ai < payload.access_types.length; ai++) {
      if (E.CHANNELS.indexOf(payload.access_types[ai]) < 0) return fail('invalid_channel', E.CHANNELS.join('|'));
    }
  }
  if (piece_type === 'not_found') {
    var pages = payload.checked_pages;
    if (!Array.isArray(pages) || !pages.length) return fail('checked_pages_required');
    for (var pi = 0; pi < pages.length; pi++) {
      var pg = str_(pages[pi]).trim();
      if (!/^https:\/\//i.test(pg)) return fail('checked_pages_required', 'روابط https من نفس المضيف');
      var pcu = cleanUrl_(pg);
      if (pcu.suspicious) return fail('suspicious_path');
      var ph = normalizeHost_(pg);
      if (!ph || !hostMatches_(ph, host, ctx)) return fail('checked_pages_required', 'روابط من نفس المضيف فقط');
    }
    if (!str_(payload.checked_at_utc).trim()) return fail('checked_at_utc_required');
  }

  return {
    ok: true,
    piece: {
      canonical_host: host,
      display_name: str_(body.display_name).trim() || host,
      piece_type: piece_type,
      model_tag: model_tag,
      channels: channels,
      summary: summary,
      payload: payload,
      evidence_url: cu.url,
      evidence_excerpt: excerpt,
      confidence: confidence
    }
  };
}

// ───────────────────────────── §11 المزودون والدرجات (داخل القفل) ─────────────────────────────

// يضمن وجود المزود؛ يُرجع {provider_id, created}
function ensureProviderLocked_(host, displayName, agent, d) {
  var providers = getIdx_('providers');
  var aliases = getIdx_('aliases');
  var pid = providers[host] || aliases[host];
  if (pid) return { provider_id: pid, created: false };
  pid = 'prov_' + sha256Hex_(host).slice(0, 8);
  appendObj_(HUB.SHEETS.PROVIDERS, {
    provider_id: pid, canonical_host: host, display_name: displayName || host, status: 'active', channels: '',
    usage_url: '', agents_contributed: '', models_found_compact: '', free_summary: '', auth_summary: '', owner_review_note: '',
    first_seen_by: agent ? agent.agent_id : '', first_seen_at_utc: d.toISOString(), first_seen_at_cairo: cairoNow_(d),
    pieces_count: 0, last_piece_at_cairo: '', github_dir: 'pieces/' + host
  });
  providers[host] = pid;
  cacheSetIdx_('providers', providers);
  return { provider_id: pid, created: true };
}

function scoreFormula_(s) {
  return num_(s.pieces_submitted) + num_(s.verified_count) * 2 + num_(s.blind_fixes) * 3 - num_(s.flagged_minor) - num_(s.flagged_major) * 3;
}

// صف agent_scores (ينشئه إن غاب) → رقم الصف
function ensureScoreRow_(identity) {
  var row = findRow_(HUB.SHEETS.SCORES, 'agent_id', identity.agent_id);
  if (row) return row;
  return appendObj_(HUB.SHEETS.SCORES, {
    agent_id: identity.agent_id, display_name: identity.display_name || identity.agent_id, owner_label: identity.owner_label || '',
    role: identity.role || 'agent', source_kind: identity.source_kind || '', pieces_submitted: 0, verified_count: 0,
    flagged_minor: 0, flagged_major: 0, blind_fixes: 0, accuracy_pct: 0, score: 0, last_active_cairo: '', last_flag_cairo: ''
  });
}

// تعديل العدّادات بالفرق + إعادة حساب accuracy/score
function bumpScore_(identity, deltas, extra) {
  var row = ensureScoreRow_(identity);
  var s = rowObj_(HUB.SHEETS.SCORES, row);
  var upd = {};
  ['pieces_submitted', 'verified_count', 'flagged_minor', 'flagged_major', 'blind_fixes'].forEach(function (k) {
    var v = num_(s[k]) + (deltas && deltas[k] ? deltas[k] : 0);
    s[k] = v; upd[k] = v;
  });
  var submitted = num_(s.pieces_submitted);
  upd.accuracy_pct = submitted > 0 ? Math.round((num_(s.verified_count) / submitted) * 1000) / 10 : 0;
  upd.score = scoreFormula_(s);
  if (extra) Object.keys(extra).forEach(function (k) { upd[k] = extra[k]; });
  setCells_(HUB.SHEETS.SCORES, row, upd);
  return upd;
}

// هوية الوكيل من AGENT_TOKENS_JSON (tokensMap اختياري لتجنب إعادة التحميل داخل الحلقات)
function agentIdentityById_(agentId, tokensMap) {
  var tokens = tokensMap || loadTokens_();
  var keys = Object.keys(tokens);
  for (var i = 0; i < keys.length; i++) {
    var t = tokens[keys[i]];
    if (str_(t.agent_id) === agentId) return { agent_id: agentId, display_name: str_(t.display_name), owner_label: str_(t.owner_label), role: str_(t.role), source_kind: str_(t.source_kind) };
  }
  return { agent_id: agentId, display_name: agentId, owner_label: '', role: 'agent', source_kind: '' };
}

// ملخص المزود المركّب (داخل القفل فقط)
function recomputeProviderSummary_(providerId) {
  var prow = findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', providerId);
  if (!prow) return null;
  var prov = rowObj_(HUB.SHEETS.PROVIDERS, prow);
  var host = str_(prov.canonical_host);
  var pieces = readSheet_(HUB.SHEETS.PIECES).rows.filter(function (r) {
    var st = str_(r.status);
    return str_(r.provider_id) === providerId && (st === 'active' || st === 'needs_reverify');
  });
  pieces.forEach(function (p) { p._payload = parseJsonSafe_(p.payload_json, {}); if (typeof p._payload !== 'object' || p._payload === null) p._payload = {}; });
  pieces.sort(function (a, b) { return str_(a.created_at_utc) < str_(b.created_at_utc) ? -1 : 1; });

  var tokensMap = loadTokens_(); // مرة واحدة خارج الحلقات

  // agents_contributed
  var byAgent = {};
  pieces.forEach(function (p) { var n = str_(p.display_name_agent) || agentIdentityById_(str_(p.agent_id), tokensMap).display_name || str_(p.agent_id); byAgent[n] = (byAgent[n] || 0) + 1; });
  var agents = Object.keys(byAgent).sort(function (a, b) { return byAgent[b] - byAgent[a] || compareCodepoints_(a, b); })
    .map(function (n) { return n + '(' + byAgent[n] + ')'; }).join(' · ');

  // models_found_compact: الموديلات المعتمدة مجمّعة حسب MODEL_FAMILIES، ثم الأسماء غير المعتمدة كما هي
  var known = [], unknown = [];
  var addModel = function (m) {
    m = str_(m).trim(); if (!m) return;
    var nt = normalizeModelTag_(m);
    if (nt) { if (known.indexOf(nt) < 0) known.push(nt); }
    else if (unknown.indexOf(m) < 0) unknown.push(m);
  };
  pieces.forEach(function (p) {
    var mn = p._payload.models_named;
    if (Array.isArray(mn)) mn.forEach(addModel);
    addModel(p.model_tag);
  });
  var famParts = [];
  Object.keys(MODEL_FAMILIES).forEach(function (fam) {
    var f = MODEL_FAMILIES[fam];
    var present = f.members.filter(function (m) { return known.indexOf(m) >= 0; });
    if (!present.length) return;
    if (present.length === f.members.length) { famParts.push(f.compact); return; }
    // جزئي: البادئة مرة واحدة ثم الإصدارات (مثل Fable 5.1 / 5.2)
    var shorts = present.map(function (m) { return MODEL_SHORT[m] || m; });
    var prefix = shorts[0].split(' ')[0];
    var vers = shorts.map(function (s) { return s.indexOf(prefix + ' ') === 0 ? s.slice(prefix.length + 1) : s; });
    famParts.push(prefix + ' ' + vers.join(' / '));
  });
  var models = famParts.concat(unknown);

  // free_summary
  var latestOf = function (type) { var r = null; pieces.forEach(function (p) { if (str_(p.piece_type) === type) r = p; }); return r; };
  var guest = latestOf('guest_chat'), free = latestOf('free_tier');
  var freeParts = [];
  if (guest) freeParts.push('Guest: ' + str_(guest.summary));
  if (free) freeParts.push('Free: ' + str_(free.summary));
  var card = (free && free._payload.requires_card !== undefined && free._payload.requires_card !== null) ? free._payload.requires_card
    : (guest && guest._payload.requires_card !== undefined && guest._payload.requires_card !== null) ? guest._payload.requires_card : null;
  if (card !== null) freeParts.push('بطاقة: ' + (card === true || card === 'true' ? 'نعم' : 'لا'));

  // auth_summary
  var authPieces = pieces.filter(function (p) { return str_(p.piece_type) === 'auth_flow'; });
  var authSummary = '';
  if (authPieces.length) {
    var methods = [], captcha = 'لا';
    authPieces.forEach(function (p) {
      (Array.isArray(p._payload.methods) ? p._payload.methods : []).forEach(function (m) { m = str_(m); if (m && methods.indexOf(m) < 0) methods.push(m); });
      if (p._payload.captcha_detected === true) captcha = str_(p._payload.captcha_type) || 'yes';
      else if (p._payload.captcha && p._payload.captcha.detected === true) captcha = str_(p._payload.captcha.type) || 'yes';
    });
    var sl = rowObj_(HUB.SHEETS.SUBMIT_LOG, findRow_(HUB.SHEETS.SUBMIT_LOG, 'canonical_host', host));
    var probe = sl && str_(sl.probe_result) ? str_(sl.probe_result) : '-';
    authSummary = 'Sign up: ' + (methods.length ? methods.map(function (m) { return AUTH_METHOD_LABELS[m] || m; }).join(' · ') : '-') + ' | CAPTCHA: ' + captcha + ' | Probe: ' + probe;
  }

  // usage_url
  var identity = latestOf('identity');
  var usage = identity && str_(identity._payload.usage_url) ? str_(identity._payload.usage_url) : (pieces.length ? str_(pieces[0].evidence_url) : '');

  // channels المجمّعة
  var channels = [];
  pieces.forEach(function (p) { splitDots_(p.channels).forEach(function (c) { if (channels.indexOf(c) < 0) channels.push(c); }); });

  // owner_review_note: آخر مراجعة مفتوحة + التعارض (بلا owner_correction)
  var notes = [];
  var openReviews = readSheet_(HUB.SHEETS.REVIEWS).rows.filter(function (r) { return str_(r.provider_id) === providerId && str_(r.state) === 'open'; });
  if (openReviews.length) {
    var lastRv = openReviews[openReviews.length - 1];
    notes.push('🔎 مراجعة مفتوحة ' + str_(lastRv.review_id) + ' (' + str_(lastRv.severity) + ')' + (str_(lastRv.blind_hint) ? ': ' + str_(lastRv.blind_hint) : ''));
  }
  pieces.forEach(function (p) {
    if (!str_(p.conflict_with)) return;
    var other = null;
    pieces.forEach(function (q) { if (str_(q.piece_id) === str_(p.conflict_with)) other = q; });
    var a = agentIdentityById_(str_(p.agent_id), tokensMap).display_name;
    var b = other ? agentIdentityById_(str_(other.agent_id), tokensMap).display_name : str_(p.conflict_with);
    var line = '⚠️ تعارض: ' + b + ' vs ' + a + ' (' + str_(p.piece_type) + ')';
    if (notes.indexOf(line) < 0) notes.push(line);
  });

  var last = pieces.length ? pieces[pieces.length - 1] : null;
  var upd = {
    agents_contributed: agents,
    models_found_compact: models.join(' · '),
    free_summary: freeParts.join(' · '),
    auth_summary: authSummary,
    usage_url: usage,
    channels: channels.join(' · '),
    pieces_count: pieces.length,
    last_piece_at_cairo: last ? str_(last.created_at_cairo) : '',
    owner_review_note: notes.join(' | ')
  };
  setCells_(HUB.SHEETS.PROVIDERS, prow, upd);
  return upd;
}

// ───────────────────────────── §12 مسار القطعة (§6 قفل ثم دفع) ─────────────────────────────

// داخل القفل: idempotency → مزود → تعارض → appendRow → ملخص → درجات → كاش
function insertPieceCore_(ctx, piece) {
  var d = new Date();
  var agent = ctx.agent;
  var idem = getIdx_('idem');
  if (idem[piece.idempotency_key]) {
    var existingId = idem[piece.idempotency_key];
    var ex = rowObj_(HUB.SHEETS.PIECES, findRow_(HUB.SHEETS.PIECES, 'piece_id', existingId));
    return { idempotent: true, piece_id: existingId, provider_id: ex ? str_(ex.provider_id) : '', github_path: ex ? str_(ex.github_path) : '', github_state: ex ? str_(ex.github_state) : '' };
  }
  var prov = ensureProviderLocked_(piece.canonical_host, piece.display_name, agent, d);
  var providerId = prov.provider_id;
  var pieceId = ulid_('pc_');
  var payloadJson = canonicalJson_(piece.payload);

  // كشف التعارض: قطعة active لنفس host+piece_type من وكيل آخر بـ payload مختلف
  var conflictWith = '';
  var conflictRow = null;
  readSheet_(HUB.SHEETS.PIECES).rows.forEach(function (r) {
    if (conflictWith) return;
    if (str_(r.canonical_host) === piece.canonical_host && str_(r.piece_type) === piece.piece_type && str_(r.status) === 'active' &&
        str_(r.agent_id) !== agent.agent_id && str_(r.payload_json) !== payloadJson) { conflictWith = str_(r.piece_id); conflictRow = r; }
  });

  var githubPath = 'pieces/' + piece.canonical_host + '/' + agent.agent_id + '_' + pieceId + '.json';
  var row = {
    piece_id: pieceId, provider_id: providerId, canonical_host: piece.canonical_host, agent_id: agent.agent_id,
    display_name: piece.display_name, tok_tail: agent.tok_tail || '', piece_type: piece.piece_type, model_tag: piece.model_tag || '',
    channels: piece.channels, summary: piece.summary, payload_json: payloadJson, evidence_url: piece.evidence_url,
    evidence_excerpt: piece.evidence_excerpt, confidence: piece.confidence, status: 'active', supersedes_piece_id: piece.supersedes_piece_id || '',
    conflict_with: conflictWith, origin: 'sheet', idempotency_key: piece.idempotency_key, github_path: githubPath,
    github_state: 'queued', github_sha: '', created_at_utc: d.toISOString(), created_at_cairo: cairoNow_(d)
  };
  appendObj_(HUB.SHEETS.PIECES, row);

  if (conflictWith) {
    setCells_(HUB.SHEETS.PIECES, conflictRow._row, { conflict_with: pieceId });
    createTaskLocked_({ type: 'fill_piece', canonical_host: piece.canonical_host, piece_type: piece.piece_type, blind_hint: 'تعارض بين قطعتين — تحقق مستقل مطلوب', excluded_agent_id: '' }, d);
  }

  // aliases من قطعة identity (داخل القفل): payload.aliases[] → provider_aliases + كاش idx:aliases
  if (piece.piece_type === 'identity' && Array.isArray(piece.payload.aliases)) {
    var idxA = getIdx_('aliases'), idxP = getIdx_('providers'), addedAlias = false;
    piece.payload.aliases.forEach(function (al) {
      if (typeof al !== 'string') return;
      var ah = normalizeHost_(al);
      if (!ah || ah === piece.canonical_host || idxA[ah] || idxP[ah]) return;
      appendObj_(HUB.SHEETS.ALIASES, { alias_host: ah, provider_id: providerId, kind: 'identity_payload', added_by: agent.agent_id, added_at_cairo: cairoNow_(d) });
      idxA[ah] = providerId; addedAlias = true;
    });
    if (addedAlias) cacheSetIdx_('aliases', idxA);
  }

  recomputeProviderSummary_(providerId);
  bumpScore_(agent, { pieces_submitted: 1 }, { last_active_cairo: cairoNow_(d) });
  idem[piece.idempotency_key] = pieceId;
  cacheSetIdx_('idem', idem);

  return { idempotent: false, piece_id: pieceId, provider_id: providerId, github_path: githubPath, github_state: 'queued', conflict_with: conflictWith, jsonStr: buildPieceJson_(row), row: row };
}

// قفل → إدراج → تحرير → دفع خارج القفل → تحديث ميكروي/outbox
function submitPieceFlow_(ctx, piece) {
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry', 'أعد المحاولة بعد ثوانٍ');
  var core;
  try {
    core = insertPieceCore_(ctx, piece);
  } finally {
    lock.releaseLock();
  }
  if (core.idempotent) return ok_(200, { idempotent: true, piece_id: core.piece_id, provider_id: core.provider_id, github_path: core.github_path, github_state: core.github_state });
  var push = finalizeGithubPush_('piece', core.piece_id, core.github_path, core.jsonStr, '[hub-sync] piece ' + core.piece_id + ' ' + piece.canonical_host + ' ' + piece.piece_type);
  var data = { piece_id: core.piece_id, github_path: core.github_path, github_state: push.github_state, provider_id: core.provider_id };
  if (core.conflict_with) data.conflict_with = core.conflict_with;
  return ok_(201, data, core.conflict_with ? 'تعارض مع قطعة سابقة — أُنشئت مهمة fill_piece' : '');
}

function createTaskLocked_(t, d) {
  d = d || new Date();
  var taskId = ulid_('tk_');
  appendObj_(HUB.SHEETS.TASKS, {
    task_id: taskId, type: t.type, canonical_host: t.canonical_host, piece_type: t.piece_type || '', state: 'open',
    blind_hint: t.blind_hint || '', excluded_agent_id: t.excluded_agent_id || '', claimed_by: '', lease_until_utc: '',
    result_piece_id: '', block_reason: '', created_at_cairo: cairoNow_(d), updated_at_cairo: cairoNow_(d)
  });
  return taskId;
}

// ───────────────────────────── §13 الأكشنات (§3.4) ─────────────────────────────

// 1) submit_piece
function act_submit_piece_(ctx, body) {
  ctx.idxProviders = getIdx_('providers');
  ctx.idxAliases = getIdx_('aliases');
  var v = validatePiece_(body, ctx);
  if (!v.ok) return err_(422, v.error, v.hint);
  var piece = v.piece;
  piece.idempotency_key = sha256Hex_(ctx.agent.agent_id + '|' + piece.canonical_host + '|' + piece.piece_type + '|' + canonicalJson_(piece.payload));
  return submitPieceFlow_(ctx, piece);
}

function findTask_(body) {
  var taskId = str_(body.task_id).trim();
  if (taskId) {
    var row = findRow_(HUB.SHEETS.TASKS, 'task_id', taskId);
    return row ? rowObj_(HUB.SHEETS.TASKS, row) : null;
  }
  var host = normalizeHost_(body.host || body.url || body.domain || body.canonical_host);
  var ptype = str_(body.piece_type).trim();
  if (!host) return null;
  var nowIso = nowIso_();
  var candidates = readSheet_(HUB.SHEETS.TASKS).rows.filter(function (r) {
    return str_(r.canonical_host) === host && (!ptype || str_(r.piece_type) === ptype) && (str_(r.state) === 'open' || str_(r.state) === 'claimed');
  });
  var open = candidates.filter(function (r) { return str_(r.state) === 'open' || str_(r.lease_until_utc) <= nowIso; });
  return open[0] || candidates[0] || null;
}

// 2) claim_task
function act_claim_task_(ctx, body) {
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var task = findTask_(body);
    if (!task) return err_(422, 'task_not_found');
    var me = ctx.agent.agent_id;
    if (str_(task.excluded_agent_id) && str_(task.excluded_agent_id) === me) return err_(403, 'excluded_from_blind_task');
    var state = str_(task.state);
    var d = new Date();
    var nowIso = d.toISOString();
    if (state === 'claimed' && str_(task.claimed_by) !== me && str_(task.lease_until_utc) > nowIso) {
      return err_(409, 'task_claimed', 'مطالَب بها حتى ' + str_(task.lease_until_utc), { task_id: str_(task.task_id), lease_until_utc: str_(task.lease_until_utc), lease_until_cairo: cairoNow_(new Date(str_(task.lease_until_utc))) });
    }
    if (state !== 'open' && state !== 'claimed') return err_(409, 'task_not_open', 'state=' + state);
    var until = addMinutes_(d, HUB.LIMITS.LEASE_MIN);
    // إنهاء عقد قديم نشط لنفس المهمة
    readSheet_(HUB.SHEETS.LEASES).rows.forEach(function (l) {
      if (str_(l.task_id) === str_(task.task_id) && str_(l.state) === 'active') setCells_(HUB.SHEETS.LEASES, l._row, { state: str_(l.agent_id) === me ? 'renewed' : 'expired' });
    });
    appendObj_(HUB.SHEETS.LEASES, { task_id: task.task_id, agent_id: me, lease_until_utc: until.toISOString(), lease_until_cairo: cairoNow_(until), state: 'active' });
    setCells_(HUB.SHEETS.TASKS, task._row, { state: 'claimed', claimed_by: me, lease_until_utc: until.toISOString(), updated_at_cairo: cairoNow_(d) });
    bumpScore_(ctx.agent, {}, { last_active_cairo: cairoNow_(d) });
    return ok_(201, { task_id: str_(task.task_id), type: str_(task.type), canonical_host: str_(task.canonical_host), piece_type: str_(task.piece_type), blind_hint: str_(task.blind_hint), lease_until_utc: until.toISOString(), lease_until_cairo: cairoNow_(until) });
  } finally {
    lock.releaseLock();
  }
}

function leaseOwnerCheck_(ctx, task) {
  var me = ctx.agent.agent_id;
  if (str_(task.claimed_by) === me) return true;
  return ctx.agent.role === 'owner';
}

// 3) release_task / complete_task
function act_release_task_(ctx, body) {
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var task = findTask_(body);
    if (!task) return err_(422, 'task_not_found');
    if (!leaseOwnerCheck_(ctx, task)) return err_(403, 'not_lease_owner');
    var d = new Date();
    readSheet_(HUB.SHEETS.LEASES).rows.forEach(function (l) {
      if (str_(l.task_id) === str_(task.task_id) && str_(l.state) === 'active') setCells_(HUB.SHEETS.LEASES, l._row, { state: 'released' });
    });
    setCells_(HUB.SHEETS.TASKS, task._row, { state: 'open', claimed_by: '', lease_until_utc: '', updated_at_cairo: cairoNow_(d) });
    return ok_(200, { task_id: str_(task.task_id), state: 'open' });
  } finally {
    lock.releaseLock();
  }
}

function act_complete_task_(ctx, body) {
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var task = findTask_(body);
    if (!task) return err_(422, 'task_not_found');
    if (!leaseOwnerCheck_(ctx, task)) return err_(403, 'not_lease_owner');
    var d = new Date();
    var pieceId = str_(body.piece_id).trim();
    var reason = str_(body.block_reason).trim();
    var upd = { claimed_by: str_(task.claimed_by), updated_at_cairo: cairoNow_(d) };
    if (pieceId) {
      if (!findRow_(HUB.SHEETS.PIECES, 'piece_id', pieceId)) return err_(422, 'piece_not_found');
      upd.state = 'done'; upd.result_piece_id = pieceId;
    } else if (reason) {
      if (HUB.ENUMS.BLOCK_REASONS.indexOf(reason) < 0) return err_(422, 'invalid_block_reason', HUB.ENUMS.BLOCK_REASONS.join('|'));
      upd.state = 'blocked'; upd.block_reason = reason;
    } else {
      return err_(422, 'piece_id_or_block_reason_required');
    }
    readSheet_(HUB.SHEETS.LEASES).rows.forEach(function (l) {
      if (str_(l.task_id) === str_(task.task_id) && str_(l.state) === 'active') setCells_(HUB.SHEETS.LEASES, l._row, { state: 'done' });
    });
    setCells_(HUB.SHEETS.TASKS, task._row, upd);
    bumpScore_(ctx.agent, {}, { last_active_cairo: cairoNow_(d) });
    return ok_(200, { task_id: str_(task.task_id), state: upd.state, result_piece_id: upd.result_piece_id || '', block_reason: upd.block_reason || '' });
  } finally {
    lock.releaseLock();
  }
}

// 4) register_submit_intent — صف واحد لكل host للأبد
function act_register_submit_intent_(ctx, body) {
  var host = normalizeHost_(body.host || body.url || body.domain);
  if (!host) return err_(422, 'invalid_host');
  if (isBlockedHost_(host)) return err_(422, 'host_blocked');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var row = findRow_(HUB.SHEETS.SUBMIT_LOG, 'canonical_host', host);
    if (row) {
      var ex = rowObj_(HUB.SHEETS.SUBMIT_LOG, row);
      return err_(409, 'host_already_submitted', 'هذا المضيف جُرّب من قبل — لا تحاول مجدداً', { canonical_host: host, state: str_(ex.state), updated_at_cairo: str_(ex.updated_at_cairo) });
    }
    var d = new Date();
    var until = addMinutes_(d, HUB.LIMITS.INTENT_WINDOW_MIN);
    appendObj_(HUB.SHEETS.SUBMIT_LOG, {
      canonical_host: host, agent_id: ctx.agent.agent_id, state: 'intent', captcha_type: '', probe_result: '',
      intent_at_utc: d.toISOString(), window_until_utc: until.toISOString(), probe_calls: 0, updated_at_cairo: cairoNow_(d)
    });
    return ok_(201, { canonical_host: host, state: 'intent', window_until_utc: until.toISOString(), window_until_cairo: cairoNow_(until) });
  } finally {
    lock.releaseLock();
  }
}

// 5) report_captcha — submit_log + قطعة auth_flow تلقائية بنفس مسار submit_piece
function act_report_captcha_(ctx, body) {
  var host = normalizeHost_(body.host || body.url || body.domain);
  if (!host) return err_(422, 'invalid_host');
  if (isBlockedHost_(host)) return err_(422, 'host_blocked');
  var rawCap = str_(body.captcha_type).trim().toLowerCase();
  if (rawCap === 'cloudflare' || rawCap === 'cloudflare_turnstile') rawCap = 'turnstile';
  else if (rawCap === 'recaptcha') rawCap = 'recaptcha_v2';
  else if (rawCap === 'image') rawCap = 'image_captcha';
  var captchaType = rawCap || 'unknown';
  if (HUB.ENUMS.CAPTCHA_TYPES.indexOf(captchaType) < 0) captchaType = 'unknown';
  if (captchaType === 'none') return err_(422, 'captcha_type_inconsistent', 'report_captcha يتطلب captcha_type غير none');
  var methodsIn = Array.isArray(body.methods) ? body.methods.map(function (m) { return str_(m).trim(); }).filter(Boolean) : [];
  for (var mi = 0; mi < methodsIn.length; mi++) if (HUB.ENUMS.AUTH_METHODS.indexOf(methodsIn[mi]) < 0) return err_(422, 'invalid_auth_method', HUB.ENUMS.AUTH_METHODS.join('|'));
  var d = new Date();
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  var core;
  try {
    var row = findRow_(HUB.SHEETS.SUBMIT_LOG, 'canonical_host', host);
    if (row) setCells_(HUB.SHEETS.SUBMIT_LOG, row, { state: 'captcha_blocked', captcha_type: captchaType, updated_at_cairo: cairoNow_(d) });
    else appendObj_(HUB.SHEETS.SUBMIT_LOG, { canonical_host: host, agent_id: ctx.agent.agent_id, state: 'captcha_blocked', captcha_type: captchaType, probe_result: '', intent_at_utc: d.toISOString(), window_until_utc: '', probe_calls: 0, updated_at_cairo: cairoNow_(d) });
    var payload = { flow: 'signup', methods: (methodsIn.length ? methodsIn : ['email_password']), captcha: { detected: true, type: captchaType }, notes: 'stopped_at_captcha_before_submit' };
    var piece = {
      canonical_host: host, display_name: str_(body.display_name).trim() || host, piece_type: 'auth_flow', model_tag: '',
      channels: ['Browser'], summary: 'CAPTCHA (' + captchaType + ') يمنع التسجيل على ' + host + ' — أُبلغ عبر report_captcha',
      payload: payload, evidence_url: 'https://' + host + '/',
      evidence_excerpt: 'CAPTCHA detected: ' + captchaType + ' — reported via report_captcha by ' + ctx.agent.agent_id + ' at ' + d.toISOString(),
      confidence: 'observed'
    };
    piece.idempotency_key = sha256Hex_(ctx.agent.agent_id + '|' + host + '|auth_flow|' + canonicalJson_(payload));
    core = insertPieceCore_(ctx, piece);
  } finally {
    lock.releaseLock();
  }
  var data = { canonical_host: host, state: 'captcha_blocked', captcha_type: captchaType, piece_id: core.piece_id, github_path: core.github_path };
  if (core.idempotent) { data.github_state = core.github_state; data.idempotent = true; return ok_(200, data); }
  var push = finalizeGithubPush_('piece', core.piece_id, core.github_path, core.jsonStr, '[hub-sync] piece ' + core.piece_id + ' ' + host + ' auth_flow');
  data.github_state = push.github_state;
  return ok_(201, data);
}

// 6) probe_email — التحقق من النية ثم فحص الإعداد ثم حجز العداد ذرياً ثم الاستدعاء الخارجي خارج القفل
function act_probe_email_(ctx, body) {
  var host = normalizeHost_(body.host || body.url || body.domain);
  if (!host) return err_(422, 'invalid_host');
  if (isBlockedHost_(host)) return err_(422, 'host_blocked');
  var probeUrl = prop_('GMAIL_PROBE_URL').trim();
  var hasLocalFn = (typeof runGmailProbe_ === 'function');
  var secret = (prop_('SHARED_SECRET') || prop_('HUB_HMAC_SECRET')).trim();

  // حجز الحصة ذرياً داخل قفل قصير بعد التحقق من النية وتوافر الإعداد
  var lock = acquireLock_(HUB.LIMITS.MICRO_LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  var calls = 0;
  var ts = nowIso_();
  try {
    var row = findRow_(HUB.SHEETS.SUBMIT_LOG, 'canonical_host', host);
    var sl = rowObj_(HUB.SHEETS.SUBMIT_LOG, row);
    if (!sl || str_(sl.agent_id) !== ctx.agent.agent_id || (str_(sl.state) !== 'intent' && str_(sl.state) !== 'probed') || !(str_(sl.window_until_utc) > ts)) {
      return err_(403, 'no_active_submit_intent', 'سجّل register_submit_intent أولاً خلال نافذة 15 دقيقة');
    }
    if (num_(sl.probe_calls) >= HUB.LIMITS.PROBE_MAX) return err_(429, 'probe_limit_reached');
    if (!probeUrl && !hasLocalFn) {
      return err_(503, 'gmail_probe_not_configured', 'عرّف GMAIL_PROBE_URL في Script Properties بعد نشر GmailProbe.gs');
    }
    if (!secret) {
      return err_(500, 'probe_secret_not_configured', 'عرّف SHARED_SECRET في خصائص Script Properties للمشروعين');
    }
    calls = num_(sl.probe_calls) + 1;
    setCells_(HUB.SHEETS.SUBMIT_LOG, row, { probe_calls: calls, state: 'probed', updated_at_cairo: cairoNow_(new Date()) });
  } finally {
    lock.releaseLock();
  }

  var idxP = getIdx_('providers');
  var idxA = getIdx_('aliases');
  var pid = idxP[host] || idxA[host] || '';
  var aliases = [];
  if (pid) {
    Object.keys(idxP).forEach(function (h) { if (idxP[h] === pid && h !== host) aliases.push(h); });
    Object.keys(idxA).forEach(function (h) { if (idxA[h] === pid && h !== host && aliases.indexOf(h) < 0) aliases.push(h); });
  }
  var nonce = uuid_();
  var sig = hmacHex_(host + '|' + ctx.agent.agent_id + '|' + ts + '|' + nonce, secret);
  var reqPayload = { host: host, aliases: aliases, agent_id: ctx.agent.agent_id, ts_utc: ts, nonce: nonce, sig: sig };
  // الاستدعاء الخارجي خارج أي قفل تماماً
  var probe;
  if (probeUrl) {
    var resp = UrlFetchApp.fetch(probeUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(reqPayload),
      muteHttpExceptions: true
    });
    var pCode = resp.getResponseCode();
    var pObj = parseJsonSafe_(resp.getContentText(), null);
    if (pCode < 200 || pCode >= 300 || !pObj || pObj.ok === false || (pObj.code && pObj.code >= 400)) {
      return err_(502, 'gmail_probe_failed', pObj && pObj.error ? str_(pObj.error) : 'HTTP ' + pCode);
    }
    probe = {
      probe_result: str_(pObj.result || pObj.probe_result || 'none'),
      matched_sender_domain: str_(pObj.matched_sender_domain || ''),
      received_at_utc: str_(pObj.received_at_utc || ''),
      note: str_(pObj.note || '')
    };
  } else {
    probe = runGmailProbe_(reqPayload);
  }
  var result = probe && probe.probe_result ? str_(probe.probe_result) : 'none';
  if (['otp', 'magic_link', 'none'].indexOf(result) < 0) result = 'none';
  var updated = microUpdate_(HUB.SHEETS.SUBMIT_LOG, 'canonical_host', host, { probe_result: result, probe_calls: calls, state: 'probed', updated_at_cairo: cairoNow_(new Date()) });
  return ok_(200, {
    canonical_host: host,
    probe_result: result,
    matched_sender_domain: probe && probe.matched_sender_domain ? str_(probe.matched_sender_domain) : '',
    received_at_utc: probe && probe.received_at_utc ? str_(probe.received_at_utc) : '',
    probe_calls: calls,
    note: probe && probe.note ? str_(probe.note) : '',
    persisted: updated
  });
}

// 7) flag_piece (owner)
function act_flag_piece_(ctx, body) {
  var pieceId = str_(body.piece_id).trim();
  if (!pieceId) return err_(422, 'piece_id_required');
  var severity = str_(body.severity).trim() || 'minor';
  if (HUB.ENUMS.SEVERITY.indexOf(severity) < 0) return err_(422, 'invalid_severity', 'minor|major');
  var correction = str_(body.owner_correction).trim();
  var blindHint = str_(body.blind_hint).trim();
  if (!correction) return err_(422, 'owner_correction_required');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  var reviewRow, host;
  try {
    var prow = findRow_(HUB.SHEETS.PIECES, 'piece_id', pieceId);
    var piece = rowObj_(HUB.SHEETS.PIECES, prow);
    if (!piece) return err_(422, 'piece_not_found');
    var d = new Date();
    host = str_(piece.canonical_host);
    var reviewId = ulid_('rv_');
    var taskId = createTaskLocked_({ type: 'blind_reverify', canonical_host: host, piece_type: str_(piece.piece_type), blind_hint: blindHint, excluded_agent_id: str_(piece.agent_id) }, d);
    reviewRow = {
      review_id: reviewId, piece_id: pieceId, provider_id: str_(piece.provider_id), flagged_agent_id: str_(piece.agent_id), severity: severity,
      owner_correction: correction, blind_hint: blindHint, state: 'open', reverify_task_id: taskId, resolved_by_piece_id: '',
      github_path: 'reviews/' + reviewId + '.json', github_state: 'queued', created_at_cairo: cairoNow_(d), resolved_at_cairo: ''
    };
    appendObj_(HUB.SHEETS.REVIEWS, reviewRow);
    setCells_(HUB.SHEETS.PIECES, prow, { status: 'needs_reverify' });
    var provRow = findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', str_(piece.provider_id));
    if (provRow) setCells_(HUB.SHEETS.PROVIDERS, provRow, { status: 'needs_reverify' });
    var flagged = agentIdentityById_(str_(piece.agent_id));
    var deltas = {}; deltas[severity === 'major' ? 'flagged_major' : 'flagged_minor'] = 1;
    bumpScore_(flagged, deltas, { last_flag_cairo: cairoNow_(d) });
    recomputeProviderSummary_(str_(piece.provider_id));
  } finally {
    lock.releaseLock();
  }
  // خارج القفل: دفع حدث المراجعة (قائمة بيضاء)
  var evt = buildReviewEvent_({ review_id: reviewRow.review_id, piece_id: reviewRow.piece_id, provider_id: reviewRow.provider_id, canonical_host: host, severity: reviewRow.severity, blind_hint: reviewRow.blind_hint, flagged_agent_id: reviewRow.flagged_agent_id, created_at_cairo: reviewRow.created_at_cairo, resolved_by_piece_id: '' }, 'flag');
  var push = finalizeGithubPush_('review', reviewRow.review_id, reviewRow.github_path, canonicalJson_(evt), '[hub-sync] review ' + reviewRow.review_id + ' flag');
  return ok_(201, { review_id: reviewRow.review_id, reverify_task_id: reviewRow.reverify_task_id, piece_id: pieceId, github_path: reviewRow.github_path, github_state: push.github_state });
}

// 8) resolve_review (owner)
function act_resolve_review_(ctx, body) {
  var reviewId = str_(body.review_id).trim();
  var newPieceId = str_(body.resolved_by_piece_id || body.piece_id).trim();
  if (!reviewId || !newPieceId) return err_(422, 'review_id_and_resolved_by_piece_id_required');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  var rv, host, blindFix = false;
  try {
    var rrow = findRow_(HUB.SHEETS.REVIEWS, 'review_id', reviewId);
    rv = rowObj_(HUB.SHEETS.REVIEWS, rrow);
    if (!rv) return err_(422, 'review_not_found');
    if (str_(rv.state) === 'resolved') return err_(409, 'review_already_resolved');
    var nrow = findRow_(HUB.SHEETS.PIECES, 'piece_id', newPieceId);
    var np = rowObj_(HUB.SHEETS.PIECES, nrow);
    if (!np) return err_(422, 'piece_not_found');
    var d = new Date();
    var oldId = str_(rv.piece_id);
    var orow = findRow_(HUB.SHEETS.PIECES, 'piece_id', oldId);
    if (orow) setCells_(HUB.SHEETS.PIECES, orow, { status: 'superseded' });
    setCells_(HUB.SHEETS.PIECES, nrow, { supersedes_piece_id: oldId, status: 'active' });
    setCells_(HUB.SHEETS.REVIEWS, rrow, { state: 'resolved', resolved_by_piece_id: newPieceId, resolved_at_cairo: cairoNow_(d), github_state: 'queued' });
    // حالة المزود بعد الحل: needs_reverify إن بقيت مراجعات مفتوحة؛ verified إن 0 مفتوحة و≥2 وكلاء مختلفين لهم قطع active؛ وإلا active
    var provId = str_(rv.provider_id);
    var stillOpen = readSheet_(HUB.SHEETS.REVIEWS).rows.filter(function (r) {
      return str_(r.provider_id) === provId && str_(r.state) === 'open' && str_(r.review_id) !== reviewId;
    }).length;
    var activeAgents = {};
    readSheet_(HUB.SHEETS.PIECES).rows.forEach(function (r) {
      if (str_(r.provider_id) === provId && str_(r.status) === 'active' && str_(r.agent_id)) activeAgents[str_(r.agent_id)] = true;
    });
    var provStatus = stillOpen > 0 ? 'needs_reverify' : (Object.keys(activeAgents).length >= 2 ? 'verified' : 'active');
    var provRow = findRow_(HUB.SHEETS.PROVIDERS, 'provider_id', provId);
    if (provRow) setCells_(HUB.SHEETS.PROVIDERS, provRow, { status: provStatus });
    var trow = findRow_(HUB.SHEETS.TASKS, 'task_id', str_(rv.reverify_task_id));
    if (trow) setCells_(HUB.SHEETS.TASKS, trow, { state: 'done', result_piece_id: newPieceId, updated_at_cairo: cairoNow_(d) });
    // إصلاح أعمى: payload الجديدة تحوي نص تصحيح المالك
    var correctionText = str_(rv.owner_correction).trim();
    var payloadCanon = canonicalJson_(parseJsonSafe_(np.payload_json, {}));
    if (correctionText && (payloadCanon.indexOf(correctionText) >= 0 || str_(np.payload_json).indexOf(correctionText) >= 0)) blindFix = true;
    var fixer = agentIdentityById_(str_(np.agent_id));
    bumpScore_(fixer, { verified_count: 1, blind_fixes: blindFix ? 1 : 0 }, { last_active_cairo: cairoNow_(d) });
    host = reviewHost_(rv);
    rv.state = 'resolved'; rv.resolved_by_piece_id = newPieceId; rv.resolved_at_cairo = cairoNow_(d);
    recomputeProviderSummary_(str_(rv.provider_id));
  } finally {
    lock.releaseLock();
  }
  var evt = buildReviewEvent_({ review_id: str_(rv.review_id), piece_id: str_(rv.piece_id), provider_id: str_(rv.provider_id), canonical_host: host, severity: str_(rv.severity), blind_hint: str_(rv.blind_hint), flagged_agent_id: str_(rv.flagged_agent_id), resolved_by_piece_id: newPieceId, resolved_at_cairo: rv.resolved_at_cairo }, 'resolve');
  var push = finalizeGithubPush_('review', reviewId, str_(rv.github_path) || ('reviews/' + reviewId + '.json'), canonicalJson_(evt), '[hub-sync] review ' + reviewId + ' resolve');
  return ok_(201, { review_id: reviewId, state: 'resolved', resolved_by_piece_id: newPieceId, blind_fix: blindFix, github_state: push.github_state });
}

// 9) sync_from_github (sync) — لا دفع عكسي ولا outbox
function act_sync_from_github_(ctx, body) {
  var pieceId = str_(body.piece_id).trim();
  var p = body.piece && typeof body.piece === 'object' ? body.piece : null;
  if (!pieceId || !p) return err_(422, 'piece_id_and_piece_required');
  // صيغة piece.base المتداخلة أولاً (provider/agent/evidence) ثم البديل المسطح احتياطاً
  var pProv = p.provider && typeof p.provider === 'object' ? p.provider : {};
  var pAgent = p.agent && typeof p.agent === 'object' ? p.agent : {};
  var pEv = p.evidence && typeof p.evidence === 'object' ? p.evidence : {};
  var host = normalizeHost_(pProv.canonical_host || p.canonical_host || p.url || p.domain);
  if (!host) return err_(422, 'invalid_host');
  var ptype = str_(p.piece_type).trim();
  if (HUB.ENUMS.PIECE_TYPES.indexOf(ptype) < 0) return err_(422, 'invalid_piece_type');
  var provDisplay = str_(pProv.display_name) || str_(p.display_name) || host;
  var agentId = str_(pAgent.agent_id) || str_(p.agent_id) || ctx.agent.agent_id;
  var evUrl = str_(pEv.url) || str_(p.evidence_url);
  var evExcerpt = str_(pEv.excerpt) || str_(p.evidence_excerpt);
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    if (findRow_(HUB.SHEETS.PIECES, 'piece_id', pieceId)) return ok_(200, { idempotent: true, piece_id: pieceId });
    var d = new Date();
    var prov = ensureProviderLocked_(host, provDisplay, { agent_id: agentId }, d);
    var payload = p.payload && typeof p.payload === 'object' ? p.payload : {};
    var idemKey = str_(p.idempotency_key) || sha256Hex_(agentId + '|' + host + '|' + ptype + '|' + canonicalJson_(payload));
    var idem = getIdx_('idem');
    if (idem[idemKey]) return ok_(200, { idempotent: true, piece_id: idem[idemKey] });
    appendObj_(HUB.SHEETS.PIECES, {
      piece_id: pieceId, provider_id: prov.provider_id, canonical_host: host, agent_id: agentId, display_name: provDisplay,
      tok_tail: '', piece_type: ptype, model_tag: str_(p.model_tag), channels: Array.isArray(p.channels) ? p.channels : splitDots_(p.channels),
      summary: str_(p.summary), payload_json: canonicalJson_(payload), evidence_url: evUrl, evidence_excerpt: evExcerpt,
      confidence: str_(p.confidence) || 'inferred', status: str_(p.status) || 'active', supersedes_piece_id: str_(p.supersedes_piece_id), conflict_with: str_(p.conflict_with),
      origin: 'github', idempotency_key: idemKey, github_path: str_(body.path) || ('pieces/' + host + '/' + agentId + '_' + pieceId + '.json'),
      github_state: 'pushed', github_sha: str_(body.sha || p.github_sha), created_at_utc: str_(p.created_at_utc) || d.toISOString(), created_at_cairo: str_(p.created_at_cairo) || cairoNow_(d)
    });
    idem[idemKey] = pieceId;
    cacheSetIdx_('idem', idem);
    recomputeProviderSummary_(prov.provider_id);
    return ok_(201, { piece_id: pieceId, provider_id: prov.provider_id, origin: 'github', github_state: 'pushed' });
  } finally {
    lock.releaseLock();
  }
}

// 10) issue_token (owner) — التوكن يُرجع مرة واحدة فقط في الرد
function act_issue_token_(ctx, body) {
  var role = str_(body.role).trim() || 'agent';
  if (role !== 'agent' && role !== 'sync') return err_(422, 'invalid_role', 'agent|sync');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var tokens = loadTokens_();
    var agentId = str_(body.agent_id).trim() || nextAgentId_(tokens, role);
    var token = newToken_();
    var identity = { agent_id: agentId, display_name: str_(body.display_name).trim() || agentId, owner_label: str_(body.owner_label).trim(), role: role, source_kind: str_(body.source_kind).trim() || 'llm', created_at: nowIso_(), revoked: false };
    tokens[token] = identity;
    saveTokens_(tokens);
    ensureScoreRow_(identity);
    return ok_(201, { token: token, agent_id: agentId, display_name: identity.display_name, role: role });
  } finally {
    lock.releaseLock();
  }
}

// 11) rotate_token / revoke_token (owner)
function act_rotate_token_(ctx, body) {
  var agentId = str_(body.agent_id).trim();
  if (!agentId) return err_(422, 'agent_id_required');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var tokens = loadTokens_();
    var identity = null;
    Object.keys(tokens).forEach(function (t) {
      if (str_(tokens[t].agent_id) === agentId && !tokens[t].revoked) { identity = tokens[t]; tokens[t].revoked = true; tokens[t].revoked_at = nowIso_(); }
    });
    if (!identity) return err_(422, 'agent_not_found');
    var token = newToken_();
    tokens[token] = { agent_id: identity.agent_id, display_name: identity.display_name, owner_label: identity.owner_label, role: identity.role, source_kind: identity.source_kind, created_at: nowIso_(), revoked: false };
    saveTokens_(tokens);
    return ok_(201, { token: token, agent_id: agentId });
  } finally {
    lock.releaseLock();
  }
}

function act_revoke_token_(ctx, body) {
  var agentId = str_(body.agent_id).trim();
  if (!agentId) return err_(422, 'agent_id_required');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var tokens = loadTokens_();
    var n = 0;
    Object.keys(tokens).forEach(function (t) {
      if (str_(tokens[t].agent_id) === agentId && !tokens[t].revoked) { tokens[t].revoked = true; tokens[t].revoked_at = nowIso_(); n++; }
    });
    if (!n) return err_(422, 'agent_not_found');
    saveTokens_(tokens);
    return ok_(201, { agent_id: agentId, revoked: n });
  } finally {
    lock.releaseLock();
  }
}

// 12) set_agent_label (owner)
function act_set_agent_label_(ctx, body) {
  var agentId = str_(body.agent_id).trim();
  if (!agentId) return err_(422, 'agent_id_required');
  var lock = acquireLock_(HUB.LIMITS.LOCK_MS);
  if (!lock) return err_(429, 'lock_timeout_retry');
  try {
    var tokens = loadTokens_();
    var found = null;
    Object.keys(tokens).forEach(function (t) {
      if (str_(tokens[t].agent_id) !== agentId) return;
      if (body.display_name !== undefined) tokens[t].display_name = str_(body.display_name).trim();
      if (body.owner_label !== undefined) tokens[t].owner_label = str_(body.owner_label).trim();
      found = tokens[t];
    });
    if (!found) return err_(422, 'agent_not_found');
    saveTokens_(tokens);
    var row = ensureScoreRow_(found);
    var upd = {};
    if (body.display_name !== undefined) upd.display_name = str_(body.display_name).trim();
    if (body.owner_label !== undefined) upd.owner_label = str_(body.owner_label).trim();
    setCells_(HUB.SHEETS.SCORES, row, upd);
    return ok_(200, { agent_id: agentId, display_name: str_(found.display_name), owner_label: str_(found.owner_label) });
  } finally {
    lock.releaseLock();
  }
}

// 13) set_prompt (owner)
function act_set_prompt_(ctx, body) {
  var prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return err_(422, 'prompt_required');
  sheet_(HUB.SHEETS.MASTER_PROMPT).getRange(1, 1).setValue(prompt);
  var v = refreshPromptVersion_();
  return ok_(200, { prompt_version: v });
}

// 14) heartbeat / my_score / list / get_tasks / get_provider / ping / catalog_summary
function act_heartbeat_(ctx, body) {
  var d = new Date();
  var lock = acquireLock_(HUB.LIMITS.MICRO_LOCK_MS);
  var persisted = false;
  if (lock) {
    try { bumpScore_(ctx.agent, {}, { last_active_cairo: cairoNow_(d) }); persisted = true; } finally { lock.releaseLock(); }
  }
  return ok_(200, { alive: true, last_active_cairo: cairoNow_(d), persisted: persisted });
}

function act_my_score_(ctx, body) {
  var row = findRow_(HUB.SHEETS.SCORES, 'agent_id', ctx.agent.agent_id);
  var s = row ? rowObj_(HUB.SHEETS.SCORES, row) : null;
  return ok_(200, s ? publicRow_(s) : { agent_id: ctx.agent.agent_id, pieces_submitted: 0, score: 0 });
}

function act_ping_(ctx, body) {
  return ok_(200, { pong: true });
}

function act_catalog_summary_(ctx, body) {
  return ok_(200, catalogSummary_());
}

function act_list_(ctx, body) {
  var name = str_(body.sheet).trim();
  if (HUB.ENUMS.LIST_SHEETS.indexOf(name) < 0) return err_(422, 'invalid_sheet', HUB.ENUMS.LIST_SHEETS.join('|'));
  var limit = Math.max(1, Math.min(HUB.LIMITS.LIST_MAX, parseInt(body.limit, 10) || 50));
  var cursor = Math.max(0, parseInt(body.cursor, 10) || 0);
  var rows = readSheet_(name).rows;
  var slice = rows.slice(cursor, cursor + limit).map(function (r) { return publicRow_(r); });
  return ok_(200, { sheet: name, rows: slice, count: slice.length, total: rows.length, next_cursor: cursor + limit < rows.length ? String(cursor + limit) : null });
}

function act_get_tasks_(ctx, body) {
  var state = str_(body.state).trim();
  var rows = readSheet_(HUB.SHEETS.TASKS).rows.filter(function (r) { return !state || str_(r.state) === state; }).map(function (r) { return publicRow_(r); });
  return ok_(200, { tasks: rows, count: rows.length });
}

function act_get_provider_(ctx, body) {
  return providerView_(str_(body.host || body.url || body.domain), false);
}
