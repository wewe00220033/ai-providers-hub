'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createGasEnv } = require('./mocks/gas_mocks');

const ROOT = path.resolve(__dirname, '..', '..');
const CODE_GS = path.join(ROOT, 'apps_script', 'Code.gs');
const PROBE_GS = path.join(ROOT, 'apps_script', 'GmailProbe.gs');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures', 'emails');

const FIXED_NOW_MS = Date.parse('2026-11-25T10:00:00.000Z');
const TEST_SECRET = 'test_shared_secret_only_for_unit_tests_32ch';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')).threads;
}

function signProbe(payload, secret = TEST_SECRET) {
  const msg = `${payload.host}|${payload.agent_id}|${payload.ts_utc}|${payload.nonce}`;
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}

function makeProbeEnv(threads = [], secret = TEST_SECRET) {
  const env = createGasEnv();
  env.setNow(FIXED_NOW_MS);
  env.loadGasScripts(PROBE_GS);
  if (secret !== null) {
    env.sandbox.PropertiesService.getScriptProperties().setProperty('SHARED_SECRET', secret);
  }
  env.gmail.setThreads(threads);
  return env;
}

function parseOut(textOut) {
  return JSON.parse(textOut.getContent());
}

test('GmailProbe source contains zero hardcoded secret literals', () => {
  const src = fs.readFileSync(PROBE_GS, 'utf8');
  assert.doesNotMatch(src, /SHARED_SECRET\s*['"]?\s*[:=]\s*['"][^'"]+['"]/);
  assert.doesNotMatch(src, /TEST_SECRET|hardcoded|default_secret/i);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps_script', 'GmailProbe.appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/gmail.readonly']);
});

test('GmailProbe doGet rejects bare GET and query auth parameters', () => {
  const env = makeProbeEnv();
  const r1 = parseOut(env.run('doGet', { parameter: {} }));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 400);
  assert.equal(r1.error, 'post_only_required');

  const r2 = parseOut(env.run('doGet', { parameter: { sig: 'abc123' } }));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 400);
  assert.equal(r2.error, 'query_auth_forbidden');

  const rEmpty = parseOut(env.run('doGet', { parameter: { token: '' } }));
  assert.equal(rEmpty.code, 400);
  assert.equal(rEmpty.error, 'query_auth_forbidden');
});

test('GmailProbe doPost rejects query auth, missing secret, invalid HMAC, expired ts, and replayed nonce', () => {
  const envNoSecret = makeProbeEnv([], null);
  const payload = {
    host: 'free-ai-test.org',
    aliases: [],
    agent_id: 'agent_01',
    ts_utc: new Date(FIXED_NOW_MS).toISOString(),
    nonce: 'nonce_12345678',
  };
  payload.sig = signProbe(payload);

  const noSecRes = parseOut(envNoSecret.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(payload) } }));
  assert.equal(noSecRes.code, 500);
  assert.equal(noSecRes.error, 'secret_not_configured');

  const env = makeProbeEnv(loadFixture('otp_inbox'));

  const queryAuthRes = parseOut(env.run('doPost', { parameter: { token: 'leak' }, postData: { contents: JSON.stringify(payload) } }));
  assert.equal(queryAuthRes.code, 400);
  assert.equal(queryAuthRes.error, 'query_auth_forbidden');

  const badSigPayload = { ...payload, sig: '0'.repeat(64) };
  const badSigRes = parseOut(env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(badSigPayload) } }));
  assert.equal(badSigRes.code, 401);
  assert.equal(badSigRes.error, 'invalid_signature');

  const expiredPayload = { ...payload, ts_utc: new Date(FIXED_NOW_MS - 6 * 60000).toISOString(), nonce: 'nonce_expired_01' };
  expiredPayload.sig = signProbe(expiredPayload);
  const expiredRes = parseOut(env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(expiredPayload) } }));
  assert.equal(expiredRes.code, 401);
  assert.equal(expiredRes.error, 'timestamp_expired');

  // First valid call passes and locks nonce
  const ok1 = parseOut(env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(payload) } }));
  assert.equal(ok1.code, 200);
  assert.equal(ok1.result, 'otp');

  // Replaying same nonce within 10 minutes fails
  const replayRes = parseOut(env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(payload) } }));
  assert.equal(replayRes.code, 401);
  assert.equal(replayRes.error, 'nonce_replayed');

  // Advancing 11 minutes expires the nonce TTL in CacheService, and fresh ts succeeds
  env.setNow(FIXED_NOW_MS + 11 * 60000);
  const afterExpiry = { ...payload, ts_utc: new Date(FIXED_NOW_MS + 11 * 60000).toISOString() };
  afterExpiry.sig = signProbe(afterExpiry);
  const resAfter = parseOut(env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(afterExpiry) } }));
  assert.equal(resAfter.code, 200);
});

test('GmailProbe classifies otp, spam magic_link, newsletter none, wrong domain, and Arabic alias without leaking body', () => {
  // 1) OTP inbox + zero leak of 849201 or subject
  const otpEnv = makeProbeEnv(loadFixture('otp_inbox'));
  const baseReq = { host: 'free-ai-test.org', aliases: [], agent_id: 'agent_02', ts_utc: new Date(FIXED_NOW_MS).toISOString(), nonce: 'n_otp_0001' };
  baseReq.sig = signProbe(baseReq);
  const otpText = otpEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(baseReq) } }).getContent();
  assert.doesNotMatch(otpText, /849201/);
  assert.doesNotMatch(otpText, /Your verification code/);
  assert.doesNotMatch(otpText, /Use verification/);
  const otpJson = JSON.parse(otpText);
  assert.equal(otpJson.result, 'otp');
  assert.equal(otpJson.matched_sender_domain, 'mail.free-ai-test.org');
  assert.ok(otpEnv.gmail.searchQueries[0].includes('in:anywhere'));
  assert.ok(otpEnv.gmail.searchQueries[0].includes('to:jdpx6218@gmail.com'));
  assert.match(otpEnv.gmail.searchQueries[0], /\bafter:\d+\b/);

  // 1b) UTF-8 > 16KB Arabic body rejected with 413 even when UTF-16 .length < 16384
  const bigArabic = JSON.stringify({ ...baseReq, nonce: 'n_big_ar_0001', pad: 'م'.repeat(9000) });
  assert.ok(bigArabic.length < 16384 && Buffer.byteLength(bigArabic, 'utf8') > 16384);
  const bigRes = parseOut(otpEnv.run('doPost', { parameter: {}, postData: { contents: bigArabic } }));
  assert.equal(bigRes.code, 413);
  assert.equal(bigRes.error, 'body_too_large');

  // 2) Magic link in Spam — found only via in:anywhere, zero token leak
  const spamEnv = makeProbeEnv(loadFixture('magic_link_spam'));
  const spamReq = { ...baseReq, nonce: 'n_spam_0002' };
  spamReq.sig = signProbe(spamReq);
  const spamText = spamEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(spamReq) } }).getContent();
  assert.doesNotMatch(spamText, /secret_magic_token_9911/);
  assert.doesNotMatch(spamText, /callback/);
  const spamJson = JSON.parse(spamText);
  assert.equal(spamJson.result, 'magic_link');
  assert.equal(spamJson.matched_sender_domain, 'free-ai-test.org');

  // 3) Newsletter with copyright 2026 & blog URL -> none (no false OTP/magic positive)
  const newsEnv = makeProbeEnv(loadFixture('newsletter_none'));
  const newsReq = { ...baseReq, nonce: 'n_news_0003' };
  newsReq.sig = signProbe(newsReq);
  const newsJson = parseOut(newsEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(newsReq) } }));
  assert.equal(newsJson.result, 'none');
  assert.equal(newsJson.matched_sender_domain, '');

  // 4) Phish / unrelated suffix domain -> blocked -> none
  const evilEnv = makeProbeEnv(loadFixture('other_domain'));
  const evilReq = { ...baseReq, nonce: 'n_evil_0004' };
  evilReq.sig = signProbe(evilReq);
  const evilJson = parseOut(evilEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(evilReq) } }));
  assert.equal(evilJson.result, 'none');

  // 5) Arabic OTP on registered alias domain -> matched -> otp
  const aliasEnv = makeProbeEnv(loadFixture('alias_domain'));
  const aliasReq = { host: 'free-ai-test.org', aliases: ['mirror-ai.io'], agent_id: 'agent_02', ts_utc: new Date(FIXED_NOW_MS).toISOString(), nonce: 'n_alias_0005' };
  aliasReq.sig = signProbe(aliasReq);
  const aliasText = aliasEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(aliasReq) } }).getContent();
  assert.doesNotMatch(aliasText, /739104/);
  const aliasJson = JSON.parse(aliasText);
  assert.equal(aliasJson.result, 'otp');
  assert.equal(aliasJson.matched_sender_domain, 'auth.mirror-ai.io');

  // 6) Old message > 20 minutes -> none
  const oldThreads = [{ messages: [{ from: 'no-reply@free-ai-test.org', to: 'jdpx6218@gmail.com', subject: 'Code', plainBody: 'Code 555666', dateOffsetMin: -25 }] }];
  const oldEnv = makeProbeEnv(oldThreads);
  const oldReq = { ...baseReq, nonce: 'n_old_0006' };
  oldReq.sig = signProbe(oldReq);
  const oldJson = parseOut(oldEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify(oldReq) } }));
  assert.equal(oldJson.result, 'none');
});

test('Guardian Integration: Code.gs probe_email calls GmailProbe via UrlFetchApp outside LockService without leaking content', () => {
  const hubEnv = createGasEnv();
  hubEnv.setNow(FIXED_NOW_MS);
  hubEnv.loadGasScripts(CODE_GS);
  const promptVer = hubEnv.run('setupProduction');
  const tokens = JSON.parse(hubEnv.sandbox.PropertiesService.getScriptProperties().getProperty('AGENT_TOKENS_JSON'));
  const agentToken = Object.keys(tokens).find((k) => tokens[k].agent_id === 'agent_01');

  // Missing GMAIL_PROBE_URL returns clean 503 and requires intent first
  const noIntentRes = JSON.parse(hubEnv.run('doPost', {
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, prompt_version: promptVer, host: 'free-ai-test.org' }) },
  }).getContent());
  assert.equal(noIntentRes.code, 403);
  assert.equal(noIntentRes.error, 'no_active_submit_intent');

  // Register submit intent
  const intentRes = JSON.parse(hubEnv.run('doPost', {
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'register_submit_intent', token: agentToken, host: 'free-ai-test.org' }) },
  }).getContent());
  assert.equal(intentRes.code, 201);

  // Without GMAIL_PROBE_URL -> 503 gmail_probe_not_configured (does not burn quota)
  const unconfRes = JSON.parse(hubEnv.run('doPost', {
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, host: 'free-ai-test.org' }) },
  }).getContent());
  assert.equal(unconfRes.code, 503);
  assert.equal(unconfRes.error, 'gmail_probe_not_configured');

  // Wire GmailProbe sandbox and configure GMAIL_PROBE_URL + SHARED_SECRET on Hub
  const probeEnv = makeProbeEnv(loadFixture('otp_inbox'));
  hubEnv.sandbox.PropertiesService.getScriptProperties().setProperty('GMAIL_PROBE_URL', 'https://gmail-probe.example/exec');
  hubEnv.sandbox.PropertiesService.getScriptProperties().setProperty('SHARED_SECRET', TEST_SECRET);

  hubEnv.urlFetch.setFetchHandler((url, params) => {
    if (url === 'https://gmail-probe.example/exec') {
      assert.equal(hubEnv.lock.isLockHeld(), false, 'Code.gs MUST release lock before calling GmailProbe');
      const rawOut = probeEnv.run('doPost', { parameter: {}, postData: { contents: params.payload } }).getContent();
      return { code: 200, body: rawOut };
    }
    return { code: 201, body: JSON.stringify({ content: { sha: 'abc123' } }) };
  });

  // Also submit an identity piece with an alias to verify aliases[] forwarding
  const idRes = JSON.parse(hubEnv.run('doPost', {
    parameter: {},
    postData: {
      contents: JSON.stringify({
        action: 'submit_piece',
        token: agentToken,
        prompt_version: promptVer,
        canonical_host: 'free-ai-test.org',
        piece_type: 'identity',
        channels: ['Browser'],
        summary: 'موقع يوفر تجربة عبر المتصفح مع نطاق بديل للتسجيل',
        payload: { display_name: 'Free AI Test', usage_url: 'https://free-ai-test.org/chat', access_types: ['Browser'], aliases: ['mirror-ai.io'] },
        evidence_url: 'https://free-ai-test.org/',
        evidence_excerpt: 'Free AI Test offers browser access and login at free-ai-test.org.',
        confidence: 'observed',
      }),
    },
  }).getContent());
  assert.equal(idRes.code, 201);

  const probeResText = hubEnv.run('doPost', {
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, host: 'free-ai-test.org' }) },
  }).getContent();
  assert.doesNotMatch(probeResText, /849201/);
  const probeRes = JSON.parse(probeResText);
  assert.equal(probeRes.ok, true);
  assert.equal(probeRes.code, 200);
  assert.equal(probeRes.data.probe_result, 'otp');
  assert.equal(probeRes.data.probe_calls, 1);
  assert.equal(probeRes.data.matched_sender_domain, 'mail.free-ai-test.org');

  // Verify Code.gs forwarded aliases in the signed request to GmailProbe
  const probeFetch = hubEnv.urlFetch.requests.find((r) => r.url === 'https://gmail-probe.example/exec');
  assert.ok(probeFetch);
  const forwardedPayload = JSON.parse(probeFetch.params.payload);
  assert.deepEqual(forwardedPayload.aliases, ['mirror-ai.io']);

  // Verify quota cap (3 max -> 4th call blocked with 429)
  hubEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, host: 'free-ai-test.org' }) } });
  hubEnv.run('doPost', { parameter: {}, postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, host: 'free-ai-test.org' }) } });
  const overQuota = JSON.parse(hubEnv.run('doPost', {
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'probe_email', token: agentToken, host: 'free-ai-test.org' }) },
  }).getContent());
  assert.equal(overQuota.code, 429);
  assert.equal(overQuota.error, 'probe_limit_reached');
});
