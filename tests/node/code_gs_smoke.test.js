'use strict';
// D2-2b — اختبار دخاني لـ apps_script/Code.gs داخل محاكي GAS (node:test فقط، بلا npm)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createGasEnv } = require('./mocks/gas_mocks.js');

const CODE_GS = path.join(__dirname, '..', '..', 'apps_script', 'Code.gs');

const EXPECTED_SHEETS = [
  'MASTER_PROMPT', 'providers', 'provider_aliases', 'pieces', 'claim_leases', 'search_tasks',
  'submit_log', 'owner_reviews', 'agent_scores', 'dashboard_view', 'logs', 'github_outbox'
];

const REQUIRED_FUNCS = [
  'doGet', 'doPost', 'setupProduction', 'onEdit', 'handleRequest_',
  'canonicalJson_', 'sha256Hex_', 'buildReviewEvent_', 'flushOutbox_'
];

function freshEnv() {
  const env = createGasEnv();
  env.loadGasScripts(CODE_GS);
  return env;
}

function setupEnv() {
  const env = freshEnv();
  env.run('setupProduction');
  return env;
}

function fnOf(env, name) {
  if (env.sandbox && typeof env.sandbox[name] === 'function') return env.sandbox[name];
  if (env.context && typeof env.context[name] === 'function') return env.context[name];
  return undefined;
}

function sheetByName(env, name) {
  return env.spreadsheet.getSheets().find((s) => s.getName() === name);
}

function loadTokens(env) {
  const raw = env.sandbox.PropertiesService.getScriptProperties().getProperty('AGENT_TOKENS_JSON');
  assert.ok(raw, 'AGENT_TOKENS_JSON يجب أن تكون موجودة بعد setupProduction');
  return JSON.parse(raw);
}

function tokenByRole(tokens, role) {
  const t = Object.keys(tokens).find((k) => tokens[k].role === role);
  assert.ok(t, 'لا يوجد توكن بالدور ' + role);
  return t;
}

function postEvent(body, extra) {
  return Object.assign({ postData: { contents: JSON.stringify(body), type: 'application/json' } }, extra || {});
}

// 1 ─────────────────────────────────────────────────────────────
test('Code.gs: يُحمَّل بلا أخطاء وتوجد الدوال الأساسية', () => {
  const env = freshEnv();
  for (const name of REQUIRED_FUNCS) {
    assert.strictEqual(typeof fnOf(env, name), 'function', 'الدالة مفقودة: ' + name);
  }
});

// 2 ─────────────────────────────────────────────────────────────
test('setupProduction: idempotent — 12 تبويباً، MASTER_PROMPT أولاً، A1/B1 صحيحتان، مؤقت واحد', () => {
  const env = freshEnv();
  env.run('setupProduction');
  env.run('setupProduction');

  const names = env.spreadsheet.getSheets().map((s) => s.getName());
  for (const n of EXPECTED_SHEETS) assert.ok(names.includes(n), 'التبويب مفقود: ' + n);
  assert.strictEqual(names.filter((n) => EXPECTED_SHEETS.includes(n)).length, 12, 'يجب أن تكون 12 تبويباً بالضبط بلا تكرار');
  assert.strictEqual(env.spreadsheet.getSheets()[0].getName(), 'MASTER_PROMPT', 'MASTER_PROMPT يجب أن يكون التبويب الأول');

  const mp = sheetByName(env, 'MASTER_PROMPT');
  const a1 = String(mp.getRange('A1').getValue() || '');
  const b1 = String(mp.getRange('B1').getValue() || '');
  assert.ok(a1.trim().length > 0, 'A1 يجب ألا تكون فارغة');
  assert.match(b1, /^[0-9a-f]{12}$/, 'B1 يجب أن تكون 12-hex، الفعلي: ' + JSON.stringify(b1));

  const triggers = env.sandbox.ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'flushOutbox_');
  assert.strictEqual(triggers.length, 1, 'يجب أن يوجد مؤقت flushOutbox_ واحد فقط بعد تشغيلين');
});

// 3 ─────────────────────────────────────────────────────────────
test('التوكنات: 12 مدخلاً (10 agent + owner + sync) ولا توكن كامل في أي كتابة للشيت', () => {
  const env = setupEnv();
  const tokens = loadTokens(env);
  const keys = Object.keys(tokens);
  assert.strictEqual(keys.length, 12, 'عدد التوكنات يجب أن يكون 12');
  const roles = keys.map((k) => tokens[k].role);
  assert.strictEqual(roles.filter((r) => r === 'agent').length, 10);
  assert.strictEqual(roles.filter((r) => r === 'owner').length, 1);
  assert.strictEqual(roles.filter((r) => r === 'sync').length, 1);

  const writes = env.sandbox.SpreadsheetApp._inspectAllWrites();
  assert.ok(Array.isArray(writes), '_inspectAllWrites يجب أن تُرجع مصفوفة');
  for (const token of keys) {
    assert.ok(token.length >= 10, 'توكن قصير بشكل مريب: ' + token);
    for (const v of writes) {
      assert.strictEqual(String(v).includes(token), false, 'تم تسريب توكن كامل إلى الشيت: ' + token);
    }
  }
});

// 4 ─────────────────────────────────────────────────────────────
test('باريتي canonicalJson_ + sha256Hex_ الثلاثي (بايتاً بايت)', () => {
  const env = freshEnv();
  const cases = [
    [{ summary: 'شات مجاني بدون تسجيل', models_named: ['Claude Fable 5', 'GPT-6 Astra'], works_without_signup: true },
      'dc0bafb4abcd51166f56ad4f1bb452d1a127409837b95884a90e73da5e32f83d'],
    [{ b: { y: 2, x: 1 }, a: [{ k: 'v', a: 1 }, { z: null }], n: 10, f: 1.5 },
      '579c2706f0ebbbbcb9fd366700e4dba5c4a9b8efb115bd8b74690d74235dcb45'],
    [[{ id: 2, name: 'ب' }, { id: 1, name: 'أ' }],
      'ca9292b3baefb3363b0a6960d7fddfecfca98319a456a86682482a6ff685cdf9']
  ];
  for (const [obj, expected] of cases) {
    const canon = env.run('canonicalJson_', obj);
    const hex = env.run('sha256Hex_', canon);
    assert.strictEqual(hex, expected, 'sha256 مختلف للمدخل: ' + canon);
  }
  assert.strictEqual(
    env.run('canonicalJson_', { 'ب': 1, 'أ': { z: [3, 1, 2], a: true }, x: null }),
    '{"x":null,"أ":{"a":true,"z":[3,1,2]},"ب":1}'
  );
});

// 5 ─────────────────────────────────────────────────────────────
test('CWE-598: التوكن في الاستعلام مرفوض 400 لـ GET و POST حتى مع جسم سليم', () => {
  const env = setupEnv();
  const get = env.run('handleRequest_', 'GET', { parameter: { action: 'ping', token: 'x' } });
  assert.strictEqual(get.code, 400);
  assert.strictEqual(get.error, 'token_in_query_forbidden');
  assert.strictEqual(get.ok, false);

  const owner = tokenByRole(loadTokens(env), 'owner');
  const post = env.run('handleRequest_', 'POST', postEvent({ action: 'ping', token: owner }, { parameter: { token: 'x' } }));
  assert.strictEqual(post.code, 400);
  assert.strictEqual(post.error, 'token_in_query_forbidden');
});

// 6 ─────────────────────────────────────────────────────────────
test('GET عام: ping → 200 ok، get_prompt → prompt نص و prompt_version يساوي B1', () => {
  const env = setupEnv();
  const ping = env.run('handleRequest_', 'GET', { parameter: { action: 'ping' } });
  assert.strictEqual(ping.ok, true);
  assert.strictEqual(ping.code, 200);

  const gp = env.run('handleRequest_', 'GET', { parameter: { action: 'get_prompt' } });
  assert.strictEqual(gp.ok, true);
  assert.strictEqual(gp.code, 200);
  assert.strictEqual(typeof gp.data.prompt, 'string');
  assert.ok(gp.data.prompt.trim().length > 0, 'prompt يجب ألا يكون فارغاً');
  const b1 = String(sheetByName(env, 'MASTER_PROMPT').getRange('B1').getValue());
  assert.strictEqual(gp.data.prompt_version, b1);
});

// 7 ─────────────────────────────────────────────────────────────
test('POST: بلا توكن → 401، وبتوكن agent على issue_token → 403 role_not_allowed', () => {
  const env = setupEnv();
  const noTok = env.run('handleRequest_', 'POST', postEvent({ action: 'ping' }));
  assert.strictEqual(noTok.code, 401);
  assert.strictEqual(noTok.ok, false);

  const tokens = loadTokens(env);
  const agentTok = tokenByRole(tokens, 'agent');
  const ownerTok = tokenByRole(tokens, 'owner');
  assert.notStrictEqual(agentTok, ownerTok);

  const forbidden = env.run('handleRequest_', 'POST', postEvent({ action: 'issue_token', token: agentTok, display_name: 'X' }));
  assert.strictEqual(forbidden.code, 403);
  assert.strictEqual(forbidden.error, 'role_not_allowed');
  assert.strictEqual(forbidden.agent && forbidden.agent.role, 'agent');
});

// 8 ─────────────────────────────────────────────────────────────
test('buildReviewEvent_: whitelist — لا owner_correction ولا tok_tail في الحدث', () => {
  const env = freshEnv();
  const row = {
    review_id: 'rv_1', piece_id: 'pc_1', provider_id: 'pr_1', canonical_host: 'example.com',
    severity: 'high', blind_hint: 'hint', flagged_agent_id: 'agent_01',
    owner_correction: 'SECRET', tok_tail: 'zzzz'
  };
  const out = env.run('buildReviewEvent_', row, 'flag');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'owner_correction'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'tok_tail'), false);
  assert.strictEqual(out.schema_version, 1);
  assert.strictEqual(out.action, 'flag');
  assert.strictEqual(out.status, 'needs_reverify');
  assert.strictEqual(out.review_id, 'rv_1');
  assert.strictEqual(JSON.stringify(out).includes('SECRET'), false);
  assert.strictEqual(JSON.stringify(out).includes('zzzz'), false);
});
