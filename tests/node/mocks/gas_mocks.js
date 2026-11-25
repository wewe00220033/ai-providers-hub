'use strict';
// Google Apps Script mock environment for Node tests (built-ins only).
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const CACHE_MAX_BYTES = 102400;

function fmt(template, args) {
  let i = 0;
  let out = String(template).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s'));
  for (; i < args.length; i++) out += ' ' + String(args[i]);
  return out;
}

// Signed-byte helpers (GAS Byte[] is -128..127)
function toSignedBytes(buf) {
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] > 127 ? buf[i] - 256 : buf[i];
  return out;
}
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value.map((b) => b & 0xff));
  return Buffer.from(String(value), 'utf8');
}

function createRange(sheet, row, col, numRows, numCols) {
  const range = {
    getRow: () => row,
    getColumn: () => col,
    getNumRows: () => numRows,
    getNumColumns: () => numCols,
    getA1Notation: () => `R${row}C${col}:R${row + numRows - 1}C${col + numCols - 1}`,
    getSheet: () => sheet,
    getValues() {
      const out = [];
      for (let r = 0; r < numRows; r++) {
        const line = [];
        for (let c = 0; c < numCols; c++) {
          const rowData = sheet._data[row - 1 + r] || [];
          line.push(rowData[col - 1 + c] === undefined ? '' : rowData[col - 1 + c]);
        }
        out.push(line);
      }
      return out;
    },
    getValue() { return range.getValues()[0][0]; },
    getDisplayValues() { return range.getValues().map((r) => r.map((v) => String(v))); },
    setValues(values) {
      for (let r = 0; r < values.length; r++) {
        const rowIdx = row - 1 + r;
        if (!sheet._data[rowIdx]) sheet._data[rowIdx] = [];
        for (let c = 0; c < values[r].length; c++) {
          sheet._data[rowIdx][col - 1 + c] = values[r][c];
        }
      }
      sheet._writes.push({ sheet: sheet.getName(), row, col, values: values.map((r) => r.slice()) });
      return range;
    },
    setValue(value) { return range.setValues([[value]]); },
    clearContent() {
      for (let r = 0; r < numRows; r++) {
        const rowIdx = row - 1 + r;
        if (!sheet._data[rowIdx]) continue;
        for (let c = 0; c < numCols; c++) sheet._data[rowIdx][col - 1 + c] = '';
      }
      return range;
    },
    clear() { return range.clearContent(); },
    setFontWeight() { return range; },
    setFontColor() { return range; },
    setBackground() { return range; },
    setBackgrounds() { return range; },
    setNumberFormat() { return range; },
    setNumberFormats() { return range; },
    setHorizontalAlignment() { return range; },
    setVerticalAlignment() { return range; },
    setWrap() { return range; },
    setWrapStrategy() { return range; },
    setBorder() { return range; },
    setNote() { return range; },
    setFormula(f) { return range.setValue(f); },
    setFormulas(f) { return range.setValues(f); },
    setDataValidation() { return range; },
    getLastRow: () => row + numRows - 1,
    getLastColumn: () => col + numCols - 1,
    offset(rowOffset, colOffset, nr, nc) {
      return createRange(sheet, row + rowOffset, col + colOffset, nr || numRows, nc || numCols);
    },
  };
  return range;
}

function createSheet(spreadsheet, name) {
  const sheet = {
    _data: [],
    _writes: [],
    _rules: [],
    _frozenRows: 0,
    _name: name,
    getName: () => sheet._name,
    setName(n) { sheet._name = n; return sheet; },
    getParent: () => spreadsheet,
    getLastRow() { return sheet._data.length; },
    getLastColumn() { return sheet._data.reduce((m, r) => Math.max(m, r ? r.length : 0), 0); },
    getMaxRows() { return Math.max(1000, sheet._data.length); },
    getMaxColumns() { return Math.max(26, sheet.getLastColumn()); },
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(a.replace(/^.*!/, ''));
        const colOf = (s) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
        if (!m) return createRange(sheet, 1, 1, 1, 1);
        const r1 = Number(m[2]); const c1 = colOf(m[1]);
        const r2 = m[4] ? Number(m[4]) : r1; const c2 = m[3] ? colOf(m[3]) : c1;
        return createRange(sheet, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
      }
      return createRange(sheet, a, b, c || 1, d || 1);
    },
    getDataRange() {
      return createRange(sheet, 1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn()));
    },
    appendRow(values) {
      const row = sheet._data.length + 1;
      return createRange(sheet, row, 1, 1, values.length).setValues([values]);
    },
    insertRowAfter() { return sheet; },
    insertRowBefore() { return sheet; },
    insertRows() { return sheet; },
    deleteRow(r) { sheet._data.splice(r - 1, 1); return sheet; },
    deleteRows(r, n) { sheet._data.splice(r - 1, n); return sheet; },
    clear() { sheet._data = []; return sheet; },
    clearContents() { sheet._data = []; return sheet; },
    setFrozenRows(n) { sheet._frozenRows = n; return sheet; },
    getFrozenRows: () => sheet._frozenRows,
    getIndex: () => spreadsheet._sheets.indexOf(sheet) + 1,
    setRowHeight() { return sheet; },
    getRowHeight: () => 21,
    setColumnWidth() { return sheet; },
    setColumnWidths() { return sheet; },
    _hiddenColumns: new Set(),
    hideColumns(colIndex, numColumns = 1) {
      for (let i = 0; i < numColumns; i++) sheet._hiddenColumns.add(Number(colIndex) + i);
      return sheet;
    },
    isColumnHiddenByUser(colIndex) { return sheet._hiddenColumns.has(Number(colIndex)); },
    autoResizeColumns() { return sheet; },
    hideSheet() { return sheet; },
    showSheet() { return sheet; },
    getSheetId: () => Math.abs(hashCode(sheet._name)),
    getConditionalFormatRules() { return sheet._rules.slice(); },
    setConditionalFormatRules(rules) { sheet._rules = Array.isArray(rules) ? rules.slice() : []; return sheet; },
    clearConditionalFormatRules() { sheet._rules = []; return sheet; },
    getFilter: () => null,
    _protections: [],
    getProtections(type) {
      return type ? sheet._protections.filter((p) => !p._type || p._type === type) : sheet._protections.slice();
    },
    protect() {
      const p = {
        _desc: '',
        _type: 'SHEET',
        setDescription(d) { p._desc = String(d || ''); return p; },
        getDescription: () => p._desc,
        getEditors: () => [],
        removeEditors() { return p; },
        addEditor() { return p; },
        setWarningOnly() { return p; },
        isWarningOnly: () => false,
        canDomainEdit: () => false,
        setDomainEdit() { return p; },
      };
      sheet._protections.push(p);
      return p;
    },
    createTextFinder(text) {
      let entireCell = false;
      let matchCase = true;
      const findAll = () => {
        const needle = matchCase ? String(text) : String(text).toLowerCase();
        const hits = [];
        for (let r = 0; r < sheet._data.length; r++) {
          const row = sheet._data[r] || [];
          for (let c = 0; c < row.length; c++) {
            const cellStr = row[c] === undefined ? '' : String(row[c]);
            const hay = matchCase ? cellStr : cellStr.toLowerCase();
            const ok = entireCell ? hay === needle : hay.indexOf(needle) !== -1;
            if (ok) hits.push(createRange(sheet, r + 1, c + 1, 1, 1));
          }
        }
        return hits;
      };
      const finder = {
        matchEntireCell(b) { entireCell = b !== false; return finder; },
        matchCase(b) { matchCase = b !== false; return finder; },
        findAll,
        findNext() { return findAll()[0] || null; },
      };
      return finder;
    },
    _inspectAllWrites() { return sheet._writes.map((w) => ({ ...w, values: w.values.map((r) => r.slice()) })); },
  };
  return sheet;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function createSpreadsheet(id, name) {
  const ss = {
    _sheets: [],
    getId: () => id,
    getName: () => name,
    getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
    getSheets: () => ss._sheets.slice(),
    getSheetByName(n) { return ss._sheets.find((s) => s.getName() === n) || null; },
    insertSheet(n) {
      const s = createSheet(ss, n || `Sheet${ss._sheets.length + 1}`);
      ss._sheets.push(s);
      return s;
    },
    deleteSheet(s) { ss._sheets = ss._sheets.filter((x) => x !== s); return ss; },
    getActiveSheet() { return ss._sheets[0] || ss.insertSheet('Sheet1'); },
    setActiveSheet(s) { ss._activeSheet = s; return s; },
    moveActiveSheet(pos) {
      const target = ss._activeSheet || ss.getActiveSheet();
      const idx = ss._sheets.indexOf(target);
      if (idx >= 0) {
        ss._sheets.splice(idx, 1);
        const dest = Math.max(0, Math.min(ss._sheets.length, Number(pos) - 1));
        ss._sheets.splice(dest, 0, target);
      }
      return ss;
    },
    toast() {},
    _inspectAllWrites() {
      const out = [];
      for (const s of ss._sheets) out.push(...s._inspectAllWrites());
      return out;
    },
  };
  return ss;
}

function createConditionalFormatRuleBuilder() {
  const rule = { _ranges: [], _condition: null, _background: null, _fontColor: null };
  const builder = {
    whenFormulaSatisfied(f) { rule._condition = { type: 'FORMULA', value: f }; return builder; },
    whenTextContains(t) { rule._condition = { type: 'TEXT_CONTAINS', value: t }; return builder; },
    whenTextEqualTo(t) { rule._condition = { type: 'TEXT_EQ', value: t }; return builder; },
    whenNumberGreaterThan(n) { rule._condition = { type: 'NUMBER_GT', value: n }; return builder; },
    whenNumberLessThan(n) { rule._condition = { type: 'NUMBER_LT', value: n }; return builder; },
    whenCellEmpty() { rule._condition = { type: 'EMPTY' }; return builder; },
    whenCellNotEmpty() { rule._condition = { type: 'NOT_EMPTY' }; return builder; },
    setBackground(c) { rule._background = c; return builder; },
    setFontColor(c) { rule._fontColor = c; return builder; },
    setBold() { return builder; },
    setRanges(r) { rule._ranges = r.slice(); return builder; },
    build() {
      return {
        getRanges: () => rule._ranges.slice(),
        getBooleanCondition: () => rule._condition,
        _background: rule._background,
        _fontColor: rule._fontColor,
      };
    },
  };
  return builder;
}

function createScriptApp(state) {
  function makeTrigger(handler, spec) {
    const id = `trg_${++state.triggerSeq}`;
    return {
      getUniqueId: () => id,
      getHandlerFunction: () => handler,
      getEventType: () => spec.eventType,
      getTriggerSource: () => spec.source,
      _spec: spec,
    };
  }
  return {
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    EventType: { CLOCK: 'CLOCK', ON_EDIT: 'ON_EDIT', ON_OPEN: 'ON_OPEN', ON_FORM_SUBMIT: 'ON_FORM_SUBMIT' },
    TriggerSource: { CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS' },
    newTrigger(handler) {
      return {
        timeBased() {
          const spec = { eventType: 'CLOCK', source: 'CLOCK', everyMinutes: null, everyHours: null, everyDays: null, at: null };
          const clock = {
            everyMinutes(n) { spec.everyMinutes = n; return clock; },
            everyHours(n) { spec.everyHours = n; return clock; },
            everyDays(n) { spec.everyDays = n; return clock; },
            atHour(h) { spec.atHour = h; return clock; },
            nearMinute(m) { spec.nearMinute = m; return clock; },
            at(d) { spec.at = d; return clock; },
            after(ms) { spec.after = ms; return clock; },
            inTimezone(tz) { spec.tz = tz; return clock; },
            create() {
              const t = makeTrigger(handler, spec);
              state.triggers.push(t);
              return t;
            },
          };
          return clock;
        },
        forSpreadsheet(ss) {
          const spec = { eventType: null, source: 'SPREADSHEETS', spreadsheet: ss };
          const sb = {
            onEdit() { spec.eventType = 'ON_EDIT'; return sb; },
            onOpen() { spec.eventType = 'ON_OPEN'; return sb; },
            onFormSubmit() { spec.eventType = 'ON_FORM_SUBMIT'; return sb; },
            create() {
              const t = makeTrigger(handler, spec);
              state.triggers.push(t);
              return t;
            },
          };
          return sb;
        },
      };
    },
    getProjectTriggers() { return state.triggers.slice(); },
    getScriptTriggers() { return state.triggers.slice(); },
    deleteTrigger(t) { state.triggers = state.triggers.filter((x) => x !== t); },
    getScriptId: () => 'mock-script-id',
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/mock/exec' }),
    getOAuthToken: () => 'mock-oauth-token',
  };
}

function formatDateWithIntl(date, tz, format) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC',
    hourCycle: 'h12',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const hour12 = parseInt(p.hour, 10);
  const isPM = /pm/i.test(p.dayPeriod || '');
  const hour24 = isPM ? (hour12 % 12) + 12 : hour12 % 12;
  const pad2 = (n) => String(n).padStart(2, '0');
  const tokens = {
    yyyy: p.year,
    MM: p.month,
    dd: p.day,
    HH: pad2(hour24),
    hh: pad2(hour12),
    mm: p.minute,
    ss: p.second,
    a: isPM ? 'PM' : 'AM',
  };
  return String(format).replace(/yyyy|MM|dd|HH|hh|mm|ss|a/g, (t) => tokens[t]);
}

function createGasEnv(options = {}) {
  const logs = [];
  const state = {
    triggers: [],
    triggerSeq: 0,
    properties: { script: {}, user: {}, document: {} },
    cache: {},
    fetchCalls: [],
    lock: { held: false, forceLockFail: false, contention: 0 },
    nowMs: null,
  };

  const spreadsheetId = options.spreadsheetId || 'mock-spreadsheet-id';
  const spreadsheet = createSpreadsheet(spreadsheetId, options.spreadsheetName || 'Mock Spreadsheet');
  for (const name of options.sheets || []) spreadsheet.insertSheet(name);
  const spreadsheets = { [spreadsheetId]: spreadsheet };

  const Logger = {
    log(template, ...args) {
      const line = args.length ? fmt(template, args) : (typeof template === 'object' ? JSON.stringify(template) : String(template));
      logs.push(line);
      return Logger;
    },
    getLog: () => logs.join('\n'),
    clear() { logs.length = 0; },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    getActive: () => spreadsheet,
    getActiveSheet: () => spreadsheet.getActiveSheet(),
    openById(id) {
      if (!spreadsheets[id]) spreadsheets[id] = createSpreadsheet(id, `Spreadsheet ${id}`);
      return spreadsheets[id];
    },
    openByUrl(url) {
      const m = /\/d\/([^/]+)/.exec(url);
      return SpreadsheetApp.openById(m ? m[1] : url);
    },
    create(name) {
      const id = `ss_${Object.keys(spreadsheets).length + 1}`;
      spreadsheets[id] = createSpreadsheet(id, name);
      return spreadsheets[id];
    },
    newConditionalFormatRule: createConditionalFormatRuleBuilder,
    newDataValidation: () => {
      const b = { requireValueInList() { return b; }, requireValueInRange() { return b; }, setAllowInvalid() { return b; }, setHelpText() { return b; }, build: () => ({}) };
      return b;
    },
    flush() {},
    getUi: () => ({ alert() {}, toast() {}, createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }),
    BorderStyle: { SOLID: 'SOLID', DASHED: 'DASHED' },
    WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' },
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    _inspectAllWrites() {
      const out = [];
      for (const ss of Object.values(spreadsheets)) out.push(...ss._inspectAllWrites());
      return out;
    },
  };

  const ScriptApp = createScriptApp(state);

  const Utilities = {
    base64Encode(input) {
      return toBuffer(input).toString('base64');
    },
    base64Decode(s) { return toSignedBytes(Buffer.from(String(s), 'base64')); },
    base64EncodeWebSafe(input) {
      return Utilities.base64Encode(input).replace(/\+/g, '-').replace(/\//g, '_');
    },
    newBlob(data) {
      const bytes = toSignedBytes(toBuffer(data));
      return {
        getBytes: () => bytes.slice(),
        getDataAsString: () => toBuffer(bytes).toString('utf8'),
      };
    },
    getUuid: () => crypto.randomUUID(),
    sleep() {},
    formatDate: formatDateWithIntl,
    formatString: (t, ...a) => fmt(t, a),
    computeDigest(_algo, value) {
      return toSignedBytes(crypto.createHash('sha256').update(toBuffer(value)).digest());
    },
    computeHmacSha256Signature(value, key) {
      return toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest());
    },
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5', SHA_1: 'SHA_1' },
    Charset: { UTF_8: 'UTF_8' },
  };

  const MimeType = { JSON: 'application/json', TEXT: 'text/plain', HTML: 'text/html', JAVASCRIPT: 'application/javascript', CSV: 'text/csv', XML: 'application/xml' };
  const ContentService = {
    MimeType,
    createTextOutput(content) {
      const out = {
        _content: content === undefined ? '' : String(content),
        _mime: MimeType.TEXT,
        setMimeType(m) { out._mime = m; return out; },
        getMimeType: () => out._mime,
        setContent(c) { out._content = String(c); return out; },
        append(c) { out._content += String(c); return out; },
        getContent: () => out._content,
        downloadAsFile() { return out; },
      };
      return out;
    },
  };

  function makeProps(store) {
    return {
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setProperty(k, v) { store[k] = String(v); return this; },
      setProperties(obj, del) { if (del) for (const k of Object.keys(store)) delete store[k]; for (const k of Object.keys(obj)) store[k] = String(obj[k]); return this; },
      deleteProperty(k) { delete store[k]; return this; },
      deleteAllProperties() { for (const k of Object.keys(store)) delete store[k]; return this; },
      getProperties: () => ({ ...store }),
      getKeys: () => Object.keys(store),
    };
  }
  const PropertiesService = {
    getScriptProperties: () => makeProps(state.properties.script),
    getUserProperties: () => makeProps(state.properties.user),
    getDocumentProperties: () => makeProps(state.properties.document),
  };

  const getNowMs = () => (state.nowMs != null ? state.nowMs : Date.now());

  function assertCacheSize(v) {
    if (Buffer.byteLength(String(v), 'utf8') > CACHE_MAX_BYTES) throw new Error('Argument too large: value');
  }
  function getValidCacheEntry(k) {
    if (!Object.prototype.hasOwnProperty.call(state.cache, k)) return null;
    const entry = state.cache[k];
    if (entry && typeof entry === 'object' && 'val' in entry) {
      if (entry.exp != null && getNowMs() >= entry.exp) {
        delete state.cache[k];
        return null;
      }
      return entry.val;
    }
    return entry;
  }
  function putCacheEntry(k, v, ttlSec) {
    assertCacheSize(v);
    const exp = typeof ttlSec === 'number' && ttlSec > 0 ? getNowMs() + ttlSec * 1000 : null;
    state.cache[k] = { val: String(v), exp };
  }
  const cacheApi = {
    get: (k) => getValidCacheEntry(k),
    put(k, v, ttlSec) { putCacheEntry(k, v, ttlSec); },
    remove(k) { delete state.cache[k]; },
    getAll(keys) {
      const o = {};
      for (const k of keys) {
        const val = getValidCacheEntry(k);
        if (val !== null) o[k] = val;
      }
      return o;
    },
    putAll(obj, ttlSec) {
      for (const k of Object.keys(obj)) assertCacheSize(obj[k]);
      for (const k of Object.keys(obj)) putCacheEntry(k, obj[k], ttlSec);
    },
    removeAll(keys) { for (const k of keys) delete state.cache[k]; },
  };
  const CacheService = { getScriptCache: () => cacheApi, getUserCache: () => cacheApi, getDocumentCache: () => cacheApi };

  function lockBlocked() {
    return state.lock.held || state.lock.forceLockFail === true;
  }
  function makeLock() {
    return {
      tryLock() {
        if (lockBlocked()) { state.lock.contention++; return false; }
        state.lock.held = true;
        return true;
      },
      waitLock(_timeoutMs) {
        if (lockBlocked()) { state.lock.contention++; throw new Error('Lock timeout'); }
        state.lock.held = true;
      },
      releaseLock() { state.lock.held = false; },
      hasLock: () => state.lock.held,
    };
  }
  const LockService = { getScriptLock: makeLock, getUserLock: makeLock, getDocumentLock: makeLock };

  let fetchHandler = options.fetch || null;
  const UrlFetchApp = {
    fetch(url, params = {}) {
      if (state.lock.held) throw new Error('FORBIDDEN: UrlFetchApp called while LockService lock is held!');
      state.fetchCalls.push({ url, params });
      let res = fetchHandler ? fetchHandler(url, params) : { code: 200, body: '{}' };
      if (typeof res === 'string') res = { code: 200, body: res };
      if (!res || typeof res !== 'object') res = { code: 200, body: '' };
      const code = res.code === undefined ? 200 : res.code;
      const body = res.body === undefined ? '' : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
      if (!(params && params.muteHttpExceptions === true) && code >= 400) {
        throw new Error('Request failed for ' + url + ' returned code ' + code);
      }
      return {
        getResponseCode: () => code,
        getContentText: () => body,
        getHeaders: () => res.headers || {},
        getAllHeaders: () => res.headers || {},
        getBlob: () => Utilities.newBlob(body),
      };
    },
    fetchAll(reqs) { return reqs.map((r) => UrlFetchApp.fetch(r.url || r, r)); },
  };

  state.gmailSearchQueries = [];
  function normalizeMessage(m) {
    if (m && typeof m.getFrom === 'function') return m;
    const baseMs = getNowMs();
    const d = m && m.date ? new Date(m.date) : new Date(baseMs + ((m && m.dateOffsetMin) || 0) * 60000);
    return {
      getFrom: () => String((m && m.from) || ''),
      getTo: () => String((m && m.to) || ''),
      getSubject: () => String((m && m.subject) || ''),
      getPlainBody: () => String((m && m.plainBody) || ''),
      getBody: () => String((m && (m.body || m.htmlBody)) || ''),
      getDate: () => new Date(d.getTime()),
      isInSpam: () => Boolean(m && m.inSpam),
      isInTrash: () => Boolean(m && m.inTrash),
    };
  }
  function normalizeThread(t) {
    if (t && typeof t.getMessages === 'function') return t;
    const msgs = Array.isArray(t && t.messages) ? t.messages.map(normalizeMessage) : [];
    return { getMessages: () => msgs.slice() };
  }
  state.gmailThreads = Array.isArray(options.gmailThreads) ? options.gmailThreads.map(normalizeThread) : [];

  const GmailApp = {
    search(query, start = 0, max = 500) {
      const q = String(query || '');
      state.gmailSearchQueries.push(q);
      const hasInAnywhere = /\bin:anywhere\b/i.test(q);
      const toMatch = /\bto:([^\s]+)/i.exec(q);
      const toTarget = toMatch ? toMatch[1].toLowerCase() : '';
      const newerMatch = /\bnewer_than:(\d+)([dmy])\b/i.exec(q);
      const afterMatch = /\bafter:(\d+)\b/i.exec(q);
      let minMs = null;
      if (afterMatch) {
        minMs = parseInt(afterMatch[1], 10) * 1000;
      } else if (newerMatch) {
        const val = parseInt(newerMatch[1], 10);
        const unit = newerMatch[2].toLowerCase();
        // Real Gmail newer_than uses d=days, m=months, y=years (not minutes)
        const mult = unit === 'd' ? 86400000 : (unit === 'm' ? 30 * 86400000 : 365 * 86400000);
        minMs = getNowMs() - val * mult;
      }
      const matched = state.gmailThreads.filter((thread) => {
        const msgs = thread.getMessages();
        return msgs.some((msg) => {
          if (!hasInAnywhere && (msg.isInSpam() || msg.isInTrash())) return false;
          if (toTarget && !msg.getTo().toLowerCase().includes(toTarget)) return false;
          if (minMs != null && msg.getDate().getTime() < minMs) return false;
          return true;
        });
      });
      const s = Math.max(0, Number(start) || 0);
      const count = Math.max(0, Number(max) || 500);
      return matched.slice(s, s + count);
    },
  };

  const Session = {
    getScriptTimeZone: () => options.timeZone || 'Africa/Cairo',
    getActiveUser: () => ({ getEmail: () => options.userEmail || 'mock@example.com' }),
    getEffectiveUser: () => ({ getEmail: () => options.userEmail || 'mock@example.com' }),
    getTemporaryActiveUserKey: () => 'mock-user-key',
  };

  const HtmlService = {
    createHtmlOutput(html) {
      const o = { _html: String(html || ''), getContent() { return o._html; }, setTitle() { return o; }, setXFrameOptionsMode() { return o; }, append(h) { o._html += h; return o; } };
      return o;
    },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
  };

  // Date wrapper so scripts see a frozen "now" when env.setNow(ms) is used.
  class MockDate extends Date {
    constructor(...a) {
      if (a.length === 0 && state.nowMs != null) super(state.nowMs);
      else super(...a);
    }
    static now() { return state.nowMs != null ? state.nowMs : Date.now(); }
  }
  MockDate.parse = Date.parse;
  MockDate.UTC = Date.UTC;

  const sandbox = {
    SpreadsheetApp,
    ScriptApp,
    Utilities,
    ContentService,
    Logger,
    PropertiesService,
    CacheService,
    LockService,
    UrlFetchApp,
    GmailApp,
    Session,
    HtmlService,
    console: { log: (...a) => Logger.log(a.map(String).join(' ')), error: (...a) => Logger.log(a.map(String).join(' ')), warn: (...a) => Logger.log(a.map(String).join(' ')), info: (...a) => Logger.log(a.map(String).join(' ')) },
    JSON,
    Math,
    Date: MockDate,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    setTimeout: undefined,
  };
  if (options.globals) Object.assign(sandbox, options.globals);

  const context = vm.createContext(sandbox);

  function loadGasScripts(files) {
    const list = Array.isArray(files) ? files : [files];
    for (const file of list) {
      const code = fs.readFileSync(file, 'utf8');
      new vm.Script(code, { filename: path.basename(file) }).runInContext(context);
    }
    return context;
  }

  const env = {
    sandbox,
    context,
    logs,
    state,
    spreadsheet,
    loadGasScripts,
    lock: {
      isLockHeld: () => state.lock.held,
      get forceLockFail() { return state.lock.forceLockFail; },
      set forceLockFail(v) { state.lock.forceLockFail = v === true; },
      get contention() { return state.lock.contention; },
    },
    urlFetch: {
      requests: state.fetchCalls,
      setFetchHandler(fn) { fetchHandler = typeof fn === 'function' ? fn : null; },
    },
    gmail: {
      searchQueries: state.gmailSearchQueries,
      setThreads(arr) { state.gmailThreads = (arr || []).map(normalizeThread); },
      clear() { state.gmailThreads = []; state.gmailSearchQueries.length = 0; },
    },
    setNow(ms) { state.nowMs = ms == null ? null : Number(ms); },
    run(fnName, ...args) {
      const fn = context[fnName];
      if (typeof fn !== 'function') throw new Error(`GAS function not found: ${fnName}`);
      return fn(...args);
    },
    reset() {
      logs.length = 0;
      state.triggers = [];
      state.fetchCalls.length = 0;
      state.gmailSearchQueries.length = 0;
      state.gmailThreads = Array.isArray(options.gmailThreads) ? options.gmailThreads.map(normalizeThread) : [];
      state.lock.held = false;
      state.lock.forceLockFail = false;
      state.lock.contention = 0;
      state.nowMs = null;
    },
  };
  return env;
}

module.exports = { createGasEnv };
