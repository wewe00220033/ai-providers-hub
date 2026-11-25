/**
 * GmailProbe.gs — AI Providers Puzzle Hub (Isolated Email Verification Probe)
 *
 * هذا المشروع المنفصل يُنشر على حساب البريد المخصص للتحقق فقط (افتراضياً jdpx6218@gmail.com)
 * بصلاحية قراءة Gmail فقط (gmail.readonly)، دون أي وصول لجدول البيانات الرئيسي أو أسرار GitHub.
 *
 * خصائص السكريبت المطلوبة (Project Settings -> Script Properties):
 * - SHARED_SECRET : نفس السر المشترك المعرَّف في Code.gs (مطلوب؛ بلا أي قيمة افتراضية في الكود).
 * - TARGET_EMAIL  : اختياري — البريد المستلم لرسائل التحقق (الافتراضي: jdpx6218@gmail.com).
 *
 * ضمان أمان صارم:
 * يُرجع النتيجة المصنّفة فقط ('otp' | 'magic_link' | 'none') ونطاق المرسل ووقت الاستلام —
 * ولا يُرجع أبداً نص البريد أو العنوان أو أرقام الكود أو رابط التحقق.
 */

var PROBE_CFG = {
  DEFAULT_TARGET_EMAIL: 'jdpx6218@gmail.com',
  WINDOW_MINUTES: 20,
  MAX_THREADS: 20,
  MAX_CLOCK_SKEW_MS: 300000, // 5 دقائق
  NONCE_TTL_SEC: 600,        // 10 دقائق ضد إعادة الاستخدام
  MAX_BODY_BYTES: 16384
};

function probeStr_(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function probeJson_(code, body) {
  var payload = body && typeof body === 'object' ? body : {};
  payload.code = code;
  if (payload.ok === undefined) payload.ok = (code >= 200 && code < 300);
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function probeErr_(code, error, hint) {
  var out = { ok: false, error: error };
  if (hint) out.hint = hint;
  return probeJson_(code, out);
}

function probeHasQueryAuth_(e) {
  var has = Object.prototype.hasOwnProperty;
  var keys = ['token', 'sig', 'secret', 'hmac', 'api_key'];
  var p = (e && e.parameter && typeof e.parameter === 'object') ? e.parameter : null;
  var ps = (e && e.parameters && typeof e.parameters === 'object') ? e.parameters : null;
  for (var i = 0; i < keys.length; i++) {
    if (p && has.call(p, keys[i])) return true;
    if (ps && has.call(ps, keys[i])) return true;
  }
  var qs = (e && typeof e.queryString === 'string') ? e.queryString : '';
  return /(^|&)(?:token|sig|secret|hmac|api_key)=/i.test(qs);
}

function normalizeProbeHost_(input) {
  var s = probeStr_(input).trim().toLowerCase();
  if (!s) return '';
  if (s.indexOf('://') >= 0) {
    s = s.replace(/^[a-z0-9+.-]+:\/\//i, '');
  }
  s = s.split('/')[0].split('?')[0].split('#')[0];
  if (s.indexOf('@') >= 0) s = s.split('@').pop();
  s = s.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!s || s.indexOf('.') < 0 || !/^[a-z0-9.-]+$/.test(s)) return '';
  if (s.indexOf('..') >= 0) return '';
  return s;
}

function hmacSha256Hex_(value, secret) {
  var bytes = Utilities.computeHmacSha256Signature(
    String(value),
    String(secret),
    Utilities.Charset.UTF_8
  );
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    out += ((bytes[i] & 0xff).toString(16)).padStart(2, '0');
  }
  return out;
}

// مقارنة ثابتة الزمن لتوقيع SHA-256 hex (64 محرفاً بالضبط)
function constantTimeHexEqual_(a, b) {
  var sa = String(a || '').toLowerCase();
  var sb = String(b || '').toLowerCase();
  var maxLen = Math.max(sa.length, sb.length, 64);
  var diff = (sa.length ^ sb.length) | (sa.length ^ 64);
  for (var i = 0; i < maxLen; i++) {
    var ca = i < sa.length ? sa.charCodeAt(i) : 0;
    var cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

function extractSenderDomain_(fromHeader) {
  var raw = probeStr_(fromHeader).trim();
  if (!raw) return '';
  var m = /<([^<>@\s]+@([^<>@\s]+))>/.exec(raw);
  var domain = m ? m[2] : '';
  if (!domain) {
    var plain = /([A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}))/.exec(raw);
    domain = plain ? plain[2] : '';
  }
  return normalizeProbeHost_(domain);
}

function domainMatchesCandidate_(senderDomain, candidates) {
  if (!senderDomain) return false;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c) continue;
    if (senderDomain === c) return true;
    if (senderDomain.length > c.length + 1 &&
        senderDomain.slice(-(c.length + 1)) === '.' + c) {
      return true;
    }
  }
  return false;
}

function stripHtmlTags_(html) {
  return probeStr_(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyEmailContent_(subject, plainBody, htmlBody) {
  var subj = probeStr_(subject);
  var bodyText = probeStr_(plainBody).trim();
  if (!bodyText && htmlBody) bodyText = stripHtmlTags_(htmlBody);
  var combined = (subj + '\n' + bodyText).trim();
  var urlSource = bodyText + '\n' + probeStr_(htmlBody);

  // 1) فحص Magic Link — روابط HTTPS تحتوي مسار/معامل تأكيد أو تسجيل دخول
  var urls = urlSource.match(/https?:\/\/[^\s"'<>()]+/gi) || [];
  var magicUrlRe = /(?:token=|verify|magic|confirm|auth|callback|ticket=|one[-_]?time|login[-_]?link|signin|activate|activation)/i;
  for (var u = 0; u < urls.length; u++) {
    if (magicUrlRe.test(urls[u])) {
      return 'magic_link';
    }
  }

  // 2) فحص OTP — رقم من 4 إلى 8 خانات بجوار كلمات رمز التحقق أو منفرد بسطر (مع استبعاد سنوات الحقوق © 2026)
  var cleaned = combined.replace(/(?:©|copyright|\(c\))\s*(?:19|20)\d{2}/gi, ' ');
  var otpCueRe = /(?:verification|verify|otp|passcode|one[- ]time|security\s*code|login\s*code|auth\s*code|\bcode\b|\bpin\b|رمز|تحقق|تفعيل|كود|تأكيد)/i;
  var nearCueAfter = /(?:verification|verify|otp|passcode|one[- ]time|security\s*code|login\s*code|auth\s*code|\bcode\b|\bpin\b|رمز|تحقق|تفعيل|كود|تأكيد)[^0-9]{0,40}\b(\d{4,8})\b/i;
  var nearCueBefore = /\b(\d{4,8})\b[^0-9]{0,40}(?:verification|verify|otp|passcode|one[- ]time|security\s*code|login\s*code|auth\s*code|\bcode\b|\bpin\b|رمز|تحقق|تفعيل|كود|تأكيد)/i;
  var standaloneLineDigit = /(?:^|[\r\n])\s*(\d{4,8})\s*(?:$|[\r\n])/;

  if (nearCueAfter.test(cleaned) || nearCueBefore.test(cleaned)) {
    return 'otp';
  }
  if (standaloneLineDigit.test(cleaned) && otpCueRe.test(cleaned)) {
    return 'otp';
  }
  return 'none';
}

function doGet(e) {
  if (probeHasQueryAuth_(e)) {
    return probeErr_(400, 'query_auth_forbidden', 'لا ترسل الأسرار أو التوقيع في URL');
  }
  return probeErr_(400, 'post_only_required', 'استخدم POST مع توقيع HMAC-SHA256 داخل JSON');
}

function doPost(e) {
  if (probeHasQueryAuth_(e)) {
    return probeErr_(400, 'query_auth_forbidden', 'لا ترسل الأسرار أو التوقيع في URL');
  }
  var rawBody = (e && e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
  if (!rawBody) return probeErr_(400, 'empty_body');
  if (Utilities.newBlob(rawBody).getBytes().length > PROBE_CFG.MAX_BODY_BYTES) {
    return probeErr_(413, 'body_too_large');
  }

  var body;
  try {
    body = JSON.parse(rawBody);
  } catch (_err) {
    return probeErr_(400, 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return probeErr_(400, 'invalid_json_object');
  }

  var props = PropertiesService.getScriptProperties();
  var secret = probeStr_(props.getProperty('SHARED_SECRET')).trim();
  if (!secret) {
    return probeErr_(500, 'secret_not_configured', 'عرّف SHARED_SECRET في Script Properties');
  }

  var rawHost = probeStr_(body.host).trim().toLowerCase();
  var host = normalizeProbeHost_(rawHost);
  var agentId = probeStr_(body.agent_id).trim();
  var tsUtc = probeStr_(body.ts_utc || body.ts).trim();
  var nonce = probeStr_(body.nonce).trim();
  var sig = probeStr_(body.sig).trim().toLowerCase();

  if (!host || host !== rawHost || !agentId || !tsUtc || !nonce || !sig) {
    return probeErr_(400, 'missing_or_invalid_auth_fields');
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(nonce)) {
    return probeErr_(400, 'invalid_nonce_format');
  }

  var tsMs = Date.parse(tsUtc);
  if (isNaN(tsMs)) {
    return probeErr_(400, 'invalid_timestamp');
  }
  if (Math.abs(Date.now() - tsMs) > PROBE_CFG.MAX_CLOCK_SKEW_MS) {
    return probeErr_(401, 'timestamp_expired');
  }

  var expectedSig = hmacSha256Hex_(host + '|' + agentId + '|' + tsUtc + '|' + nonce, secret);
  if (!constantTimeHexEqual_(sig, expectedSig)) {
    return probeErr_(401, 'invalid_signature');
  }

  // قفل الـ nonce بعد التحقق من التوقيع لمنع DoS قبل المصادقة
  var cache = CacheService.getScriptCache();
  var nonceKey = 'probe_nonce:' + nonce;
  if (cache.get(nonceKey)) {
    return probeErr_(401, 'nonce_replayed');
  }
  cache.put(nonceKey, '1', PROBE_CFG.NONCE_TTL_SEC);

  var targetEmail = probeStr_(props.getProperty('TARGET_EMAIL') || PROBE_CFG.DEFAULT_TARGET_EMAIL).trim().toLowerCase();
  var candidates = [host];
  if (Array.isArray(body.aliases)) {
    for (var i = 0; i < body.aliases.length; i++) {
      var al = normalizeProbeHost_(body.aliases[i]);
      if (al && candidates.indexOf(al) < 0) candidates.push(al);
    }
  }

  var afterEpochSec = Math.floor((Date.now() - PROBE_CFG.WINDOW_MINUTES * 60000) / 1000);
  var query = 'after:' + afterEpochSec + ' in:anywhere to:' + targetEmail;
  var threads = GmailApp.search(query, 0, PROBE_CFG.MAX_THREADS) || [];
  var minMs = Date.now() - PROBE_CFG.WINDOW_MINUTES * 60 * 1000;
  var matches = [];

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages() || [];
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      var msgDate = msg.getDate ? msg.getDate() : null;
      var msgMs = msgDate ? msgDate.getTime() : 0;
      if (msgMs < minMs) continue;
      var toHeader = probeStr_(msg.getTo ? msg.getTo() : '').toLowerCase();
      if (toHeader) {
        var toAddrs = toHeader.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
        if (toAddrs.indexOf(targetEmail) < 0) continue;
      }
      var senderDomain = extractSenderDomain_(msg.getFrom ? msg.getFrom() : '');
      if (!domainMatchesCandidate_(senderDomain, candidates)) continue;
      matches.push({
        ms: msgMs,
        iso: msgDate.toISOString(),
        senderDomain: senderDomain,
        subject: msg.getSubject ? msg.getSubject() : '',
        plainBody: msg.getPlainBody ? msg.getPlainBody() : '',
        htmlBody: msg.getBody ? msg.getBody() : ''
      });
    }
  }

  matches.sort(function (a, b) { return b.ms - a.ms; });

  for (var k = 0; k < matches.length; k++) {
    var item = matches[k];
    var kind = classifyEmailContent_(item.subject, item.plainBody, item.htmlBody);
    if (kind !== 'none') {
      return probeJson_(200, {
        ok: true,
        result: kind,
        matched_sender_domain: item.senderDomain,
        received_at_utc: item.iso
      });
    }
  }

  return probeJson_(200, {
    ok: true,
    result: 'none',
    matched_sender_domain: '',
    received_at_utc: ''
  });
}
