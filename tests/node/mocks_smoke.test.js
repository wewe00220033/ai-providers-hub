'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createGasEnv } = require('./mocks/gas_mocks.js');

function hexOfSigned(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

test('UrlFetchApp.fetch is forbidden while lock is held, allowed after release', () => {
  const env = createGasEnv();
  const { UrlFetchApp, LockService } = env.sandbox;
  const lock = LockService.getScriptLock();
  assert.equal(lock.tryLock(), true);
  assert.equal(env.lock.isLockHeld(), true);
  assert.throws(() => UrlFetchApp.fetch('https://example.com/a'), /FORBIDDEN/);
  lock.releaseLock();
  assert.equal(env.lock.isLockHeld(), false);
  const res = UrlFetchApp.fetch('https://example.com/a', { method: 'get' });
  assert.equal(res.getResponseCode(), 200);
  assert.equal(env.urlFetch.requests.length, 1);
  assert.equal(env.urlFetch.requests[0].url, 'https://example.com/a');
});

test('setFetchHandler + muteHttpExceptions semantics', () => {
  const env = createGasEnv();
  const { UrlFetchApp } = env.sandbox;
  env.urlFetch.setFetchHandler(() => ({ code: 503, body: '{}' }));
  const res = UrlFetchApp.fetch('https://example.com/x', { muteHttpExceptions: true });
  assert.equal(res.getResponseCode(), 503);
  assert.equal(res.getContentText(), '{}');
  assert.throws(
    () => UrlFetchApp.fetch('https://example.com/x'),
    /Request failed for https:\/\/example\.com\/x returned code 503/
  );
  assert.equal(env.urlFetch.requests.length, 2);
});

test('forceLockFail makes tryLock false, waitLock throw, contention increase', () => {
  const env = createGasEnv();
  const lock = env.sandbox.LockService.getScriptLock();
  env.lock.forceLockFail = true;
  assert.equal(env.lock.forceLockFail, true);
  assert.equal(env.lock.contention, 0);
  assert.equal(lock.tryLock(), false);
  assert.equal(env.lock.contention, 1);
  assert.throws(() => lock.waitLock(1000), /Lock timeout/);
  assert.equal(env.lock.contention, 2);
  assert.equal(env.lock.isLockHeld(), false);
  env.lock.forceLockFail = false;
  assert.equal(lock.tryLock(), true);
  lock.releaseLock();
});

test('CacheService enforces 100KB value limit', () => {
  const env = createGasEnv();
  const cache = env.sandbox.CacheService.getScriptCache();
  const tooBig = 'a'.repeat(102401);
  const maxOk = 'a'.repeat(102400);
  assert.throws(() => cache.put('k', tooBig), /Argument too large: value/);
  assert.doesNotThrow(() => cache.put('k', maxOk));
  assert.equal(cache.get('k').length, 102400);
  assert.throws(() => cache.putAll({ a: 'x', b: tooBig }), /Argument too large: value/);
  assert.doesNotThrow(() => cache.putAll({ a: 'x', b: maxOk }));
});

test('computeDigest and HMAC return signed bytes matching node:crypto', () => {
  const env = createGasEnv();
  const { Utilities } = env.sandbox;
  const str = 'شات مجاني بدون تسجيل';
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str);
  assert.equal(digest.length, 32);
  for (const b of digest) assert.ok(b >= -128 && b <= 127, `byte out of range: ${b}`);
  assert.equal(hexOfSigned(digest), crypto.createHash('sha256').update(str, 'utf8').digest('hex'));

  const hmac = Utilities.computeHmacSha256Signature(str, 'k');
  assert.equal(hmac.length, 32);
  for (const b of hmac) assert.ok(b >= -128 && b <= 127, `byte out of range: ${b}`);
  assert.equal(hexOfSigned(hmac), crypto.createHmac('sha256', 'k').update(str, 'utf8').digest('hex'));
});

test('base64Encode / base64Decode / newBlob roundtrip with UTF-8 and signed bytes', () => {
  const env = createGasEnv();
  const { Utilities } = env.sandbox;
  const str = 'أهلاً';
  const encoded = Utilities.base64Encode(str);
  assert.equal(encoded, Buffer.from(str, 'utf8').toString('base64'));
  const bytes = Utilities.base64Decode(encoded);
  for (const b of bytes) assert.ok(b >= -128 && b <= 127);
  assert.ok(bytes.some((b) => b < 0), 'UTF-8 Arabic should produce negative signed bytes');
  assert.equal(Utilities.newBlob(bytes).getDataAsString(), str);
  assert.equal(Utilities.base64Encode(bytes), encoded);
  assert.deepEqual(Utilities.newBlob(str).getBytes(), bytes);
});

test('formatDate uses Intl with Africa/Cairo and 12h tokens', () => {
  const env = createGasEnv();
  const { Utilities } = env.sandbox;
  const f = (iso) => Utilities.formatDate(new Date(iso), 'Africa/Cairo', 'yyyy-MM-dd hh:mm a');
  assert.equal(f('2026-11-24T23:44:00Z'), '2026-11-25 01:44 AM');
  assert.equal(f('2026-11-25T12:30:00Z'), '2026-11-25 02:30 PM');
  assert.equal(f('2026-11-25T10:00:00Z'), '2026-11-25 12:00 PM');
  assert.equal(f('2026-11-25T22:05:00Z'), '2026-11-26 12:05 AM');
  assert.equal(
    Utilities.formatDate(new Date('2026-11-25T22:05:00Z'), 'Africa/Cairo', 'yyyy-MM-dd HH:mm:ss'),
    '2026-11-26 00:05:00'
  );
  assert.equal(
    Utilities.formatDate(new Date('2026-11-25T10:00:00Z'), 'Africa/Cairo', 'HH'),
    '12'
  );
});

test('setNow freezes Date in the sandbox without affecting explicit dates', () => {
  const env = createGasEnv();
  env.setNow(Date.parse('2026-01-01T00:00:00Z'));
  const out = vm.runInContext('new Date().toISOString()+"|"+Date.now()', env.context);
  assert.equal(out, '2026-01-01T00:00:00.000Z|1767225600000');
  const explicit = vm.runInContext('new Date("2020-01-01").toISOString()', env.context);
  assert.equal(explicit, '2020-01-01T00:00:00.000Z');
  assert.equal(vm.runInContext('Date.parse("2020-01-01T00:00:00Z")', env.context), 1577836800000);
  assert.equal(vm.runInContext('Date.UTC(2020,0,1)', env.context), 1577836800000);
  env.setNow(null);
  const after = vm.runInContext('Date.now()', env.context);
  assert.ok(Math.abs(after - Date.now()) < 5000);
});

test('env.reset clears lock, fetch and now state', () => {
  const env = createGasEnv();
  env.sandbox.LockService.getScriptLock().tryLock();
  env.lock.forceLockFail = true;
  env.setNow(1000);
  env.reset();
  assert.equal(env.lock.isLockHeld(), false);
  assert.equal(env.lock.forceLockFail, false);
  assert.equal(env.lock.contention, 0);
  assert.equal(env.urlFetch.requests.length, 0);
  env.sandbox.UrlFetchApp.fetch('https://example.com/r');
  assert.equal(env.urlFetch.requests.length, 1);
  assert.ok(Math.abs(vm.runInContext('Date.now()', env.context) - Date.now()) < 5000);
});
