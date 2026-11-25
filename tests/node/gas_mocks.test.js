'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGasEnv } = require('./mocks/gas_mocks.js');

test('createGasEnv exposes sandbox, context and logs', () => {
  const env = createGasEnv();
  assert.ok(env.sandbox);
  assert.ok(env.context);
  assert.ok(Array.isArray(env.logs));
  assert.strictEqual(typeof env.loadGasScripts, 'function');
});

test('SpreadsheetApp conditional format rules', () => {
  const env = createGasEnv();
  const { SpreadsheetApp } = env.sandbox;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet('Outbox');
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$A1="ERR"')
    .setBackground('#f4cccc')
    .setRanges([sheet.getRange('A1:C10')])
    .build();
  sheet.setConditionalFormatRules([rule]);
  assert.strictEqual(sheet.getConditionalFormatRules().length, 1);
  assert.strictEqual(sheet.getConditionalFormatRules()[0].getRanges().length, 1);
});

test('SpreadsheetApp records writes via _inspectAllWrites', () => {
  const env = createGasEnv({ sheets: ['Log'] });
  const { SpreadsheetApp } = env.sandbox;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  sheet.appendRow(['a', 1]);
  sheet.getRange(2, 1, 1, 2).setValues([['b', 2]]);
  const writes = SpreadsheetApp._inspectAllWrites();
  assert.strictEqual(writes.length, 2);
  assert.deepStrictEqual(writes[0].values, [['a', 1]]);
  assert.deepStrictEqual(writes[1].values, [['b', 2]]);
  assert.deepStrictEqual(sheet.getDataRange().getValues(), [['a', 1], ['b', 2]]);
});

test('ScriptApp triggers create, list and delete', () => {
  const env = createGasEnv();
  const { ScriptApp } = env.sandbox;
  ScriptApp.newTrigger('flushOutbox_').timeBased().everyMinutes(10).create();
  const triggers = ScriptApp.getProjectTriggers();
  assert.strictEqual(triggers.length, 1);
  assert.strictEqual(triggers[0].getHandlerFunction(), 'flushOutbox_');
  ScriptApp.deleteTrigger(triggers[0]);
  assert.strictEqual(ScriptApp.getProjectTriggers().length, 0);
});

test('loadGasScripts exposes globals', () => {
  const env = createGasEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-mock-'));
  const file = path.join(dir, 'hello.gs');
  fs.writeFileSync(file, "function hello_(){return Utilities.base64Encode('hi');}", 'utf8');
  try {
    env.loadGasScripts([file]);
    assert.strictEqual(typeof env.context.hello_, 'function');
    assert.strictEqual(env.context.hello_(), Buffer.from('hi').toString('base64'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ContentService + Logger', () => {
  const env = createGasEnv();
  const { ContentService, Logger } = env.sandbox;
  const out = ContentService.createTextOutput('{"a":1}').setMimeType(ContentService.MimeType.JSON);
  assert.strictEqual(out.getContent(), '{"a":1}');
  assert.strictEqual(out.getMimeType(), ContentService.MimeType.JSON);
  Logger.log('x %s', 1);
  assert.strictEqual(env.logs.length, 1);
  assert.ok(env.logs[0].includes('x 1'));
});
