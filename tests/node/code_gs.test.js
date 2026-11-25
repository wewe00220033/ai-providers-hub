'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGasEnv } = require('./mocks/gas_mocks');

const ROOT = path.resolve(__dirname, '..', '..');
const CODE_GS = path.join(ROOT, 'apps_script', 'Code.gs');
const VALIDATOR_PY = path.join(ROOT, 'scripts', 'validate_piece.py');
const FIXED_NOW_MS = Date.parse('2026-11-25T10:00:00.000Z');

function setupHub(options = {}) {
  const env = createGasEnv(options);
  env.setNow(FIXED_NOW_MS);
  env.sandbox.PropertiesService.getScriptProperties().setProperty('GITHUB_OWNER', 'owner');
  env.sandbox.PropertiesService.getScriptProperties().setProperty('GITHUB_REPO', 'ai-providers-hub');
  env.sandbox.PropertiesService.getScriptProperties().setProperty('GITHUB_PAT', 'ghp_test_token_mock');
  env.sandbox.PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', 'https://script.google.com/macros/s/test-deploy/exec');
  const pushedFiles = {};
  env.urlFetch.setFetchHandler((url, params) => {
    assert.equal(env.lock.isLockHeld(), false, 'UrlFetchApp MUST NOT be called inside LockService');
    const m = /\/contents\/(.+)$/.exec(String(url));
    if (m && params && params.method === 'put') {
      const req = JSON.parse(params.payload);
      pushedFiles[m[1]] = Buffer.from(req.content, 'base64').toString('utf8');
      return { code: 201, body: JSON.stringify({ content: { sha: `sha_${Object.keys(pushedFiles).length}` } }) };
    }
    return { code: 200, body: '{}' };
  });
  env.loadGasScripts(CODE_GS);
  const promptVer = env.run('setupProduction');
  const tokens = JSON.parse(env.sandbox.PropertiesService.getScriptProperties().getProperty('AGENT_TOKENS_JSON'));
  const byId = (id) => Object.keys(tokens).find((k) => tokens[k].agent_id === id && !tokens[k].revoked);
  return { env, promptVer, tokens, byId, pushedFiles };
}

function callPost(env, body, extraEvent = {}) {
  const out = env.run('doPost', {
    parameter: {},
    ...extraEvent,
    postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) },
  });
  return JSON.parse(out.getContent());
}

function callGet(env, parameter = {}, queryString = '') {
  const out = env.run('doGet', { parameter, queryString });
  return JSON.parse(out.getContent());
}

function guestPayload(models = ['Claude Fable 5'], quota = '10 msg/day') {
  return {
    works_without_signup: true,
    mode: 'instant',
    models_named: models,
    free_credits_or_quota: quota,
    requires_card: false,
    none_found: false,
  };
}

function freePayload(models = ['Claude Fable 5'], quota = '25 msg/day', extras = {}) {
  return {
    exists: true,
    includes_target_models: true,
    models_named: models,
    free_models_other: [],
    free_credits_or_quota: quota,
    requires_card: false,
    none_found: false,
    ...extras,
  };
}

function makePiece(host, pieceType, payload, extra = {}) {
  const d = host.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  return {
    action: 'submit_piece',
    canonical_host: host,
    piece_type: pieceType,
    channels: ['Browser'],
    summary: extra.summary || `توثيق موثّق للخدمة ${d} لنوع ${pieceType} بمعلومات محددة من الصفحة`,
    payload,
    evidence_url: extra.evidence_url || `https://${d}/pricing`,
    evidence_excerpt: extra.evidence_excerpt || `Verified Claude Fable 5 and Claude Opus 5.5 details quoted from official ${d} page.`,
    confidence: extra.confidence || 'observed',
    ...extra,
  };
}

test('setupProduction is idempotent, creates 12 tabs, puts MASTER_PROMPT first, protects & hides column 6', () => {
  const { env, promptVer, tokens } = setupHub();
  assert.match(promptVer, /^[0-9a-f]{12}$/);
  assert.equal(env.spreadsheet.getSheets().length, 12);
  const mp = env.spreadsheet.getSheetByName('MASTER_PROMPT');
  assert.equal(mp.getIndex(), 1);
  assert.ok(mp.getProtections(env.sandbox.SpreadsheetApp.ProtectionType.SHEET).length >= 1);
  const rv = env.spreadsheet.getSheetByName('owner_reviews');
  assert.equal(rv.isColumnHiddenByUser(6), true);
  assert.ok(rv.getProtections(env.sandbox.SpreadsheetApp.ProtectionType.SHEET).length >= 1);

  assert.equal(Object.keys(tokens).length, 12);
  const roles = Object.values(tokens).map((t) => t.role);
  assert.equal(roles.filter((r) => r === 'agent').length, 10);
  assert.equal(roles.filter((r) => r === 'owner').length, 1);
  assert.equal(roles.filter((r) => r === 'sync').length, 1);

  // Edit A1 manually, verify re-running setupProduction keeps A1 and does not duplicate triggers or tokens
  mp.getRange(1, 1).setValue('# Custom Seed Prompt Kept\nUpdated text');
  const pv2 = env.run('setupProduction');
  assert.notEqual(pv2, promptVer);
  assert.match(mp.getRange(1, 1).getValue(), /Custom Seed Prompt Kept/);
  const triggers = env.sandbox.ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'flushOutbox_');
  assert.equal(triggers.length, 1);
  const tokens2 = JSON.parse(env.sandbox.PropertiesService.getScriptProperties().getProperty('AGENT_TOKENS_JSON'));
  assert.deepEqual(Object.keys(tokens2).sort(), Object.keys(tokens).sort());
});

test('onEdit invalidates prompt:v immediately and enforces 426 prompt_updated_re_read_required', () => {
  const { env, byId } = setupHub();
  const tok1 = byId('agent_01');
  const gp1 = callGet(env, { action: 'get_prompt' });
  assert.equal(gp1.ok, true);
  const oldVer = gp1.data.prompt_version;
  assert.ok(env.sandbox.CacheService.getScriptCache().get('prompt:v'));

  // Simulate manual owner edit in Google Sheet MASTER_PROMPT!A1 -> fires onEdit(e)
  const mp = env.spreadsheet.getSheetByName('MASTER_PROMPT');
  const editedPrompt = '# البرومبت المحدّث\nالتزم بإضافة جميع تفاصيل المجاني أولاً.';
  mp.getRange(1, 1).setValue(editedPrompt);
  env.run('onEdit', { range: mp.getRange(1, 1) });

  assert.equal(env.sandbox.CacheService.getScriptCache().get('prompt:v'), null);
  const newVer = mp.getRange(1, 2).getValue();
  assert.notEqual(newVer, oldVer);
  assert.match(String(mp.getRange(1, 3).getValue()), /[صم]/);

  // Submitting with stale prompt_version -> immediate 426 without waiting for 60s cache
  const pieceBody = makePiece('fresh-ai.org', 'guest_chat', guestPayload(['Claude Fable 5']), { model_tag: 'Claude Fable 5' });
  const staleRes = callPost(env, { ...pieceBody, token: tok1, prompt_version: oldVer });
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.code, 426);
  assert.equal(staleRes.error, 'PROMPT_UPDATED_RE_READ_REQUIRED');
  assert.equal(staleRes.data.prompt, editedPrompt);
  assert.equal(staleRes.data.prompt_version, newVer);

  // Retrying with new prompt_version succeeds
  const okRes = callPost(env, { ...pieceBody, token: tok1, prompt_version: newVer });
  assert.equal(okRes.code, 201);

  // Owner can also update via set_prompt, while agent is blocked
  const ownerTok = byId('owner');
  const denyAgent = callPost(env, { action: 'set_prompt', token: tok1, prompt: 'hacker' });
  assert.equal(denyAgent.code, 403);
  assert.equal(denyAgent.error, 'role_not_allowed');
  const sp = callPost(env, { action: 'set_prompt', token: ownerTok, prompt: '# V3 Prompt' });
  assert.equal(sp.code, 200);
  assert.notEqual(sp.data.prompt_version, newVer);
});

test('20 submissions on host variants collapse to single prov_<8-hex> and pass Python validate_piece.py', () => {
  const { env, promptVer, byId, pushedFiles } = setupHub();
  const hostVariants = [
    'https://www.RaceTest.AI/chat?ref=1',
    'http://racetest.ai/',
    'racetest.ai',
    'RACETEST.AI/models#top',
  ];

  const providerIds = new Set();
  for (let i = 1; i <= 20; i++) {
    const idx = ((i - 1) % 10) + 1;
    const aid = `agent_${String(idx).padStart(2, '0')}`;
    const tok = byId(aid);
    const variant = hostVariants[i % hostVariants.length];
    const ptype = i === 1 ? 'identity' : (i % 2 === 0 ? 'free_tier' : 'guest_chat');
    const payload = ptype === 'identity'
      ? { display_name: 'RaceTest AI', usage_url: 'https://racetest.ai/chat', access_types: ['Browser'], aliases: ['mirror.racetest.ai'] }
      : (ptype === 'free_tier'
        ? freePayload(['Claude Fable 5', 'Claude Fable 5.1'], `${20 + i} msg/day`)
        : guestPayload(['Claude Opus 5.5'], `${10 + i} guest msg/day`));

    const modelTag = ptype === 'identity' ? '' : (ptype === 'free_tier' ? 'Claude Fable 5' : 'Claude Opus 5.5');
    const res = callPost(env, {
      ...makePiece(variant, ptype, payload, { evidence_url: `https://racetest.ai/docs/${i}`, model_tag: modelTag }),
      token: tok,
      prompt_version: promptVer,
    });
    assert.equal(res.ok, true, `call ${i} failed: ${JSON.stringify(res)}`);
    assert.equal(res.code, 201);
    assert.match(res.data.provider_id, /^prov_[0-9a-f]{8}$/);
    providerIds.add(res.data.provider_id);
  }
  assert.equal(providerIds.size, 1, 'All 20 submissions must share one provider_id');

  // Verify providers sheet has compact models summary and only 1 row for racetest.ai
  const provSheet = env.spreadsheet.getSheetByName('providers');
  assert.equal(provSheet.getLastRow(), 2);
  const provHeaders = provSheet.getRange(1, 1, 1, 17).getValues()[0];
  const provRow = provSheet.getRange(2, 1, 1, 17).getValues()[0];
  const compactIdx = provHeaders.indexOf('models_found_compact');
  assert.match(String(provRow[compactIdx]), /Fable 5 \/ 5\.1/);
  assert.match(String(provRow[compactIdx]), /Opus 5\.5/);

  // Cross-check ALL 20 pushed JSON files against Python validate_piece.py in a real subprocess!
  assert.equal(Object.keys(pushedFiles).length, 20);
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hub_xcheck_'));
  try {
    for (const [relPath, content] of Object.entries(pushedFiles)) {
      const fullPath = path.join(tmpRepo, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    const py = spawnSync('python', [VALIDATOR_PY, '--repo', tmpRepo], { encoding: 'utf8', timeout: 20000 });
    assert.equal(py.status, 0, `validate_piece.py failed:\nSTDOUT:\n${py.stdout}\nSTDERR:\n${py.stderr}`);
    assert.match(py.stdout, /VALIDATION: 0 errors/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('token spoofing (identity_mismatch), query token block, token issue/rotate/revoke lifecycle', () => {
  const { env, promptVer, byId } = setupHub();
  const tok1 = byId('agent_01');
  const ownerTok = byId('owner');

  // 1) Token in URL query rejected immediately on both GET and POST
  const qGet = callGet(env, { action: 'ping', token: tok1 });
  assert.equal(qGet.code, 400);
  assert.equal(qGet.error, 'token_in_query_forbidden');

  const qPost = callPost(env, { action: 'ping', token: tok1 }, { parameter: { token: tok1 } });
  assert.equal(qPost.code, 400);
  assert.equal(qPost.error, 'token_in_query_forbidden');

  // 2) Spoofed agent_id in body ignored; server uses token owner + records identity_mismatch hint
  const spoofRes = callPost(env, {
    ...makePiece('spoof-check.ai', 'guest_chat', guestPayload(['Claude Mythos 5']), {
      model_tag: 'Claude Mythos 5',
      evidence_excerpt: 'Verified Claude Mythos 5 guest chat on spoof-check.ai documentation.',
    }),
    token: tok1,
    prompt_version: promptVer,
    agent_id: 'agent_99',
  });
  assert.equal(spoofRes.code, 201);
  assert.equal(spoofRes.agent.agent_id, 'agent_01');
  assert.match(spoofRes.hint, /identity_mismatch/);
  assert.ok(spoofRes.data.github_path.startsWith('pieces/spoof-check.ai/agent_01_'));

  // 3) issue_token -> rotate_token -> revoke_token + role enforcement
  const badRole = callPost(env, { action: 'issue_token', token: tok1, role: 'agent' });
  assert.equal(badRole.code, 403);
  assert.equal(badRole.error, 'role_not_allowed');

  const issued = callPost(env, { action: 'issue_token', token: ownerTok, role: 'agent', display_name: 'Temp Bot', owner_label: 'Night' });
  assert.equal(issued.code, 201);
  const newTok = issued.data.token;
  const newId = issued.data.agent_id;
  assert.equal(callPost(env, { action: 'ping', token: newTok }).code, 200);

  const rotated = callPost(env, { action: 'rotate_token', token: ownerTok, agent_id: newId });
  assert.equal(rotated.code, 201);
  assert.notEqual(rotated.data.token, newTok);
  const revokedOld = callPost(env, { action: 'ping', token: newTok });
  assert.equal(revokedOld.code, 401);
  assert.equal(revokedOld.error, 'token_revoked');
  assert.equal(callPost(env, { action: 'ping', token: rotated.data.token }).code, 200);

  const labeled = callPost(env, { action: 'set_agent_label', token: ownerTok, agent_id: newId, display_name: 'Renamed Bot', owner_label: 'Day' });
  assert.equal(labeled.code, 200);
  assert.equal(labeled.data.display_name, 'Renamed Bot');

  const revoked = callPost(env, { action: 'revoke_token', token: ownerTok, agent_id: newId });
  assert.equal(revoked.code, 201);
  assert.equal(callPost(env, { action: 'ping', token: rotated.data.token }).error, 'token_revoked');
});

test('CacheService chunking handles >110KB indexes and rebuilds cleanly when chunk deleted', () => {
  const { env } = setupHub();
  const largeIdx = {};
  for (let i = 0; i < 2400; i++) {
    largeIdx[`provider-host-${String(i).padStart(4, '0')}.example-domain-test.ai`] = `prov_${(i + 0x10000000).toString(16)}`;
  }
  const rawLen = Buffer.byteLength(JSON.stringify(largeIdx), 'utf8');
  assert.ok(rawLen > 110000, `Expected >110KB payload, got ${rawLen}`);

  env.run('cacheSetIdx_', 'providers', largeIdx);
  const cache = env.sandbox.CacheService.getScriptCache();
  const meta = JSON.parse(cache.get('idx:providers:meta'));
  assert.ok(meta.chunks >= 4, `Expected >=4 chunks under 90KB limit, got ${meta.chunks}`);
  const restored = env.run('cacheGetIdx_', 'providers');
  assert.equal(Object.keys(restored).length, 2400);
  assert.equal(restored['provider-host-1234.example-domain-test.ai'], largeIdx['provider-host-1234.example-domain-test.ai']);

  cache.remove('idx:providers:1');
  assert.equal(env.run('cacheGetIdx_', 'providers'), null);
  const rebuilt = JSON.parse(JSON.stringify(env.run('getIdx_', 'providers')));
  assert.deepEqual(rebuilt, {});
});

test('list pagination + public reads + claim_task 15m lease expiry + release/complete', () => {
  const { env, promptVer, byId } = setupHub();
  const tok1 = byId('agent_01');
  const tok2 = byId('agent_02');

  const hosts = ['p1.ai', 'p2.ai', 'p3.ai', 'p4.ai', 'p5.ai'];
  const createdPieces = [];
  for (const h of hosts) {
    const r = callPost(env, {
      ...makePiece(h, 'identity', { display_name: h, usage_url: `https://${h}`, access_types: ['Browser'] }),
      token: tok1,
      prompt_version: promptVer,
    });
    assert.equal(r.code, 201);
    createdPieces.push(r.data.piece_id);
  }

  const page1 = callPost(env, { action: 'list', token: tok1, sheet: 'pieces', limit: 2, cursor: 0 });
  const page2 = callPost(env, { action: 'list', token: tok1, sheet: 'pieces', limit: 2, cursor: page1.data.next_cursor });
  const page3 = callPost(env, { action: 'list', token: tok1, sheet: 'pieces', limit: 2, cursor: page2.data.next_cursor });
  assert.equal(page1.data.count, 2);
  assert.equal(page2.data.count, 2);
  assert.equal(page3.data.count, 1);
  assert.equal(page3.data.next_cursor, null);
  const seenIds = [...page1.data.rows, ...page2.data.rows, ...page3.data.rows].map((r) => r.piece_id);
  assert.deepEqual(seenIds, createdPieces);

  // Conflicting guest_chat pieces from two agents trigger open fill_piece task -> claim_task lifecycle
  assert.equal(callPost(env, {
    ...makePiece('p1.ai', 'guest_chat', guestPayload(['Claude Fable 5'], '10/day'), { model_tag: 'Claude Fable 5' }),
    token: tok1,
    prompt_version: promptVer,
  }).code, 201);
  const conflictRes = callPost(env, {
    ...makePiece('p1.ai', 'guest_chat', guestPayload(['Claude Fable 5.1'], '20/day'), {
      model_tag: 'Claude Fable 5.1',
      evidence_excerpt: 'Verified Claude Fable 5.1 with 20/day guest quota on p1.ai docs.',
    }),
    token: tok2,
    prompt_version: promptVer,
  });
  assert.equal(conflictRes.code, 201);
  assert.ok(conflictRes.data.conflict_with);

  const tasksRes = callGet(env, { action: 'get_tasks', state: 'open' });
  assert.ok(tasksRes.data.tasks.length >= 1);
  const task = tasksRes.data.tasks[0];

  const c1 = callPost(env, { action: 'claim_task', token: tok1, prompt_version: promptVer, task_id: task.task_id });
  assert.equal(c1.code, 201);

  const c2Blocked = callPost(env, { action: 'claim_task', token: tok2, prompt_version: promptVer, task_id: task.task_id });
  assert.equal(c2Blocked.code, 409);
  assert.equal(c2Blocked.error, 'task_claimed');

  env.setNow(FIXED_NOW_MS + 16 * 60000);
  const c2Win = callPost(env, { action: 'claim_task', token: tok2, prompt_version: promptVer, task_id: task.task_id });
  assert.equal(c2Win.code, 201);

  const relDeny = callPost(env, { action: 'release_task', token: tok1, task_id: task.task_id });
  assert.equal(relDeny.code, 403);
  assert.equal(relDeny.error, 'not_lease_owner');

  assert.equal(callPost(env, { action: 'release_task', token: tok2, task_id: task.task_id }).data.state, 'open');
  assert.equal(callPost(env, { action: 'claim_task', token: tok2, prompt_version: promptVer, task_id: task.task_id }).code, 201);
  const doneRes = callPost(env, { action: 'complete_task', token: tok2, prompt_version: promptVer, task_id: task.task_id, piece_id: createdPieces[0] });
  assert.equal(doneRes.code, 200);
  assert.equal(doneRes.data.state, 'done');
});

test('flag_piece -> blind_reverify exclusion -> owner_correction never leaked -> resolve_review -> validate_piece.py passes', () => {
  const { env, promptVer, byId, pushedFiles } = setupHub();
  const tok1 = byId('agent_01');
  const tok2 = byId('agent_02');
  const ownerTok = byId('owner');

  const p1 = callPost(env, {
    ...makePiece('blind-check.ai', 'free_tier', freePayload(['Claude Fable 5'], '10 msg/day'), { model_tag: 'Claude Fable 5' }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(p1.code, 201);

  const secretCorrection = 'الحد الحقيقي 25 رسالة يومياً';
  const flagRes = callPost(env, {
    action: 'flag_piece',
    token: ownerTok,
    piece_id: p1.data.piece_id,
    severity: 'major',
    owner_correction: secretCorrection,
    blind_hint: 'افحص جدول الباقة المجانية بعد تسجيل الدخول',
  });
  assert.equal(flagRes.code, 201);
  const revId = flagRes.data.review_id;
  const revTaskId = flagRes.data.reverify_task_id;
  const reviewPath = flagRes.data.github_path;

  // 1) Review file pushed to GitHub MUST NOT contain owner_correction
  assert.ok(pushedFiles[reviewPath]);
  assert.ok(!pushedFiles[reviewPath].includes(secretCorrection), 'owner_correction leaked into GitHub review file!');
  assert.ok(!('owner_correction' in JSON.parse(pushedFiles[reviewPath])));

  // 2) list owner_reviews & get_tasks MUST NOT expose owner_correction
  const listRev = JSON.stringify(callPost(env, { action: 'list', token: tok2, sheet: 'owner_reviews' }));
  assert.ok(!listRev.includes(secretCorrection), 'owner_correction leaked into list API!');
  const tasksJson = JSON.stringify(callGet(env, { action: 'get_tasks' }));
  assert.ok(!tasksJson.includes(secretCorrection));

  // 3) Original author excluded from claiming blind_reverify task
  const selfClaim = callPost(env, { action: 'claim_task', token: tok1, prompt_version: promptVer, task_id: revTaskId });
  assert.equal(selfClaim.code, 403);
  assert.equal(selfClaim.error, 'excluded_from_blind_task');

  // 4) Second agent claims blindly and submits corrected value
  assert.equal(callPost(env, { action: 'claim_task', token: tok2, prompt_version: promptVer, task_id: revTaskId }).code, 201);
  const fixPiece = callPost(env, {
    ...makePiece('blind-check.ai', 'free_tier', freePayload(['Claude Fable 5'], `25 msg/day — ${secretCorrection}`), { model_tag: 'Claude Fable 5' }),
    token: tok2,
    prompt_version: promptVer,
  });
  assert.equal(fixPiece.code, 201);

  const resolveRes = callPost(env, {
    action: 'resolve_review',
    token: ownerTok,
    review_id: revId,
    resolved_by_piece_id: fixPiece.data.piece_id,
  });
  assert.equal(resolveRes.code, 201);
  assert.equal(resolveRes.data.blind_fix, true);
  assert.equal(resolveRes.data.state, 'resolved');

  const score2 = callPost(env, { action: 'my_score', token: tok2 });
  assert.equal(score2.data.blind_fixes, 1);
  assert.equal(score2.data.verified_count, 1);
  const score1 = callPost(env, { action: 'my_score', token: tok1 });
  assert.equal(score1.data.flagged_major, 1);

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hub_rv_check_'));
  try {
    for (const [relPath, content] of Object.entries(pushedFiles)) {
      const fullPath = path.join(tmpRepo, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    const py = spawnSync('python', [VALIDATOR_PY, '--repo', tmpRepo], { encoding: 'utf8', timeout: 20000 });
    assert.equal(py.status, 0, py.stdout + '\n' + py.stderr);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('github_outbox queues on 500 failure, recovers after 2m backoff, and transitions to dead after 6 attempts', () => {
  const { env, promptVer, byId } = setupHub();
  const tok1 = byId('agent_01');
  let failGithub = true;
  env.urlFetch.setFetchHandler((_url, _params) => {
    assert.equal(env.lock.isLockHeld(), false);
    if (failGithub) return { code: 500, body: 'GitHub 500 down' };
    return { code: 201, body: JSON.stringify({ content: { sha: 'recovered_sha' } }) };
  });

  // 1) First piece fails push -> queued with +2m next_retry_utc -> succeeds when advanced +3m after recovery
  const q1 = callPost(env, {
    ...makePiece('outbox-recover.ai', 'identity', { display_name: 'Outbox Recover', usage_url: 'https://outbox-recover.ai', access_types: ['Browser'] }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(q1.code, 201);
  assert.equal(q1.data.github_state, 'queued');

  let curMs = FIXED_NOW_MS + 3 * 60000;
  env.setNow(curMs);
  failGithub = false;
  const fRecover = env.run('flushOutbox_');
  assert.equal(fRecover.done, 1);
  assert.equal(fRecover.failed, 0);
  const outboxAfterRecover = callPost(env, { action: 'list', token: tok1, sheet: 'github_outbox' }).data.rows;
  assert.equal(outboxAfterRecover[0].state, 'done');

  // 2) Second piece hits 6 consecutive failures across exponential backoff -> becomes dead
  failGithub = true;
  const q2 = callPost(env, {
    ...makePiece('outbox-dead.ai', 'identity', { display_name: 'Outbox Dead', usage_url: 'https://outbox-dead.ai', access_types: ['Browser'] }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(q2.data.github_state, 'queued');

  curMs += 3 * 60000;
  env.setNow(curMs);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const f = env.run('flushOutbox_');
    assert.equal(f.failed, 1);
    curMs += (Math.pow(2, attempt) + 1) * 60000;
    env.setNow(curMs);
  }
  const rows = callPost(env, { action: 'list', token: tok1, sheet: 'github_outbox' }).data.rows;
  const deadRow = rows.find((r) => r.piece_id === q2.data.piece_id);
  assert.equal(deadRow.state, 'dead');
  assert.equal(Number(deadRow.attempts), 6);
});

test('sync_from_github accepts nested piece.base shape and causes zero outbound GitHub/outbox loops', () => {
  const { env, byId } = setupHub();
  const syncTok = byId('github_sync');
  const fetchBefore = env.urlFetch.requests.length;

  const syncRes = callPost(env, {
    action: 'sync_from_github',
    token: syncTok,
    piece_id: 'pc_01KABC1234567890ABCDEFGHJK',
    path: 'pieces/synced.ai/agent_03_pc_01KABC1234567890ABCDEFGHJK.json',
    sha: 'git_sha_999',
    piece: {
      piece_id: 'pc_01KABC1234567890ABCDEFGHJK',
      piece_type: 'identity',
      provider: { canonical_host: 'synced.ai', display_name: 'Synced AI' },
      agent: { agent_id: 'agent_03', source_kind: 'pr' },
      channels: ['API'],
      summary: 'قطعة قادمة من GitHub PR مباشرة لا يجب إعادة دفعها أبداً',
      payload: { display_name: 'Synced AI', usage_url: 'https://synced.ai', access_types: ['API'] },
      evidence: { url: 'https://synced.ai/docs', excerpt: 'Official API documentation for Synced AI endpoints.' },
      confidence: 'observed',
    },
  });
  assert.equal(syncRes.code, 201);
  assert.equal(syncRes.data.origin, 'github');
  assert.equal(syncRes.data.github_state, 'pushed');

  // Zero outbox rows and zero UrlFetchApp calls!
  assert.equal(env.urlFetch.requests.length, fetchBefore);
  const obRows = callPost(env, { action: 'list', token: syncTok, sheet: 'github_outbox' }).data.rows;
  assert.equal(obRows.length, 0);

  // Calling again is idempotent
  const syncDup = callPost(env, {
    action: 'sync_from_github',
    token: syncTok,
    piece_id: 'pc_01KABC1234567890ABCDEFGHJK',
    piece: { piece_type: 'identity', provider: { canonical_host: 'synced.ai' } },
  });
  assert.equal(syncDup.code, 200);
  assert.equal(syncDup.data.idempotent, true);
});

test('enforces >20KB body limit, blocked hosts, auth errors, report_captcha normalization, and 60/hr rate limit', () => {
  const { env, promptVer, byId } = setupHub();
  const tok1 = byId('agent_01');

  // 1) Body > 20KB -> 422 payload_too_large
  const huge = 'x'.repeat(21000);
  const bigRes = callPost(env, JSON.stringify({ action: 'ping', token: tok1, pad: huge }));
  assert.equal(bigRes.code, 422);
  assert.equal(bigRes.error, 'payload_too_large');

  // 2) Auth errors, prototype-key hardening + unknown action
  assert.equal(callPost(env, { action: 'ping' }).error, 'token_required');
  assert.equal(callPost(env, { action: 'ping', token: 'ag_wrong' }).error, 'invalid_token');
  assert.equal(callPost(env, { action: 'ping', token: 'toString' }).error, 'invalid_token');
  assert.equal(callPost(env, { action: 'does_not_exist', token: tok1 }).error, 'unknown_action');
  assert.equal(callPost(env, { action: 'toString', token: tok1 }).error, 'unknown_action');

  // 3) Invalid host (localhost), blocked host (bit.ly), & blocked host on report_captcha/register_submit_intent
  const inv = callPost(env, {
    ...makePiece('localhost', 'identity', { display_name: 'Local', usage_url: 'https://localhost', access_types: ['CLI'] }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(inv.code, 422);
  assert.equal(inv.error, 'invalid_host');

  const blk = callPost(env, {
    ...makePiece('bit.ly', 'identity', { display_name: 'Shortener', usage_url: 'https://bit.ly/x', access_types: ['Browser'] }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(blk.code, 422);
  assert.equal(blk.error, 'host_blocked');

  const blkCap = callPost(env, { action: 'report_captcha', token: tok1, host: 'github.com', captcha_type: 'turnstile' });
  assert.equal(blkCap.code, 422);
  assert.equal(blkCap.error, 'host_blocked');
  const blkIntent = callPost(env, { action: 'register_submit_intent', token: tok1, host: 'google.com' });
  assert.equal(blkIntent.code, 422);
  assert.equal(blkIntent.error, 'host_blocked');

  // 4) report_captcha normalizes aliases like Cloudflare -> turnstile
  const capRes = callPost(env, {
    action: 'report_captcha',
    token: tok1,
    host: 'captcha-site.ai',
    captcha_type: 'Cloudflare',
    methods: ['email_password'],
  });
  assert.equal(capRes.code, 201);
  assert.equal(capRes.data.captcha_type, 'turnstile');
  assert.equal(capRes.data.state, 'captcha_blocked');

  // 5) Rate limit: prime current hour cache counter to 60 -> next submit_piece is rejected with 429
  const hourKey = 'rate:agent_01:' + env.sandbox.Utilities.formatDate(new Date(FIXED_NOW_MS), 'UTC', 'yyyyMMddHH');
  env.sandbox.CacheService.getScriptCache().put(hourKey, '60', 3600);
  const rlRes = callPost(env, {
    ...makePiece('rate-limit-test.ai', 'guest_chat', guestPayload(['Claude Fable 5']), { model_tag: 'Claude Fable 5' }),
    token: tok1,
    prompt_version: promptVer,
  });
  assert.equal(rlRes.code, 429);
  assert.equal(rlRes.error, 'agent_rate_limited');
});
