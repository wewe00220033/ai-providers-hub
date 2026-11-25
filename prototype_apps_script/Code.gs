/**
 * AI Providers Puzzle Hub — Prototype Apps Script (v0.1)
 * Purpose: Live test of token auth, domain normalization, atomic LockService,
 *          duplicate provider prevention, and multi-agent puzzle pieces.
 *
 * Note on Apps Script HTTP behavior:
 * - Apps Script Web Apps do not expose custom HTTP headers (e.g. Authorization)
 *   to doGet/doPost, so `token` must be sent in the JSON body (POST) or query (GET).
 * - Apps Script always returns HTTP 200 after its 302 redirect; logical status
 *   codes (200, 201, 401, 422, 429, 500) are returned in the JSON `code` field.
 */

const SHEET_PROVIDERS = "providers";
const SHEET_PIECES = "pieces";
const SHEET_LOGS = "logs";
const PROP_TOKENS = "AGENT_TOKENS_JSON";

/**
 * Run this ONCE manually from the Apps Script editor to initialize
 * the 3 sheet tabs and generate 2 isolated test agent tokens.
 */
function setupPrototype() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab_(ss, SHEET_PROVIDERS, [
    "provider_id",
    "canonical_host",
    "display_name",
    "created_by",
    "created_at",
  ]);
  ensureTab_(ss, SHEET_PIECES, [
    "piece_id",
    "provider_id",
    "canonical_host",
    "agent_id",
    "piece_type",
    "summary",
    "payload_json",
    "evidence_url",
    "created_at",
  ]);
  ensureTab_(ss, SHEET_LOGS, [
    "timestamp",
    "agent_id",
    "action",
    "code",
    "detail",
  ]);

  const props = PropertiesService.getScriptProperties();
  let rawTokens = props.getProperty(PROP_TOKENS);
  let tokenMap;
  if (!rawTokens) {
    const t1 = "ag_" + Utilities.getUuid().replace(/-/g, "");
    const t2 = "ag_" + Utilities.getUuid().replace(/-/g, "");
    tokenMap = {};
    tokenMap[t1] = "agent_antigravity";
    tokenMap[t2] = "agent_second_tester";
    props.setProperty(PROP_TOKENS, JSON.stringify(tokenMap));
    Logger.log("=== COPY THESE PROTOTYPE TEST TOKENS ===");
  } else {
    tokenMap = JSON.parse(rawTokens);
    Logger.log("=== EXISTING PROTOTYPE TOKENS ===");
  }

  Object.keys(tokenMap).forEach(function (tok) {
    Logger.log(tokenMap[tok] + " -> " + tok);
  });
  Logger.log("Setup complete! Now click Deploy -> New deployment -> Web app (Execute as: Me, Access: Anyone).");
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || "ping").trim();

  if (action === "ping") {
    return jsonResponse_({
      ok: true,
      code: 200,
      service: "ai-providers-puzzle-hub-prototype",
      timestamp: new Date().toISOString(),
    });
  }

  const agentId = authenticate_(params.token);
  if (!agentId) {
    return jsonResponse_({ ok: false, code: 401, error: "invalid_or_missing_token" });
  }

  if (action === "list") {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const providers = readRowsAsObjects_(ss.getSheetByName(SHEET_PROVIDERS));
    const pieces = readRowsAsObjects_(ss.getSheetByName(SHEET_PIECES));
    return jsonResponse_({
      ok: true,
      code: 200,
      agent_id: agentId,
      providers_count: providers.length,
      pieces_count: pieces.length,
      providers: providers,
      pieces: pieces,
    });
  }

  return jsonResponse_({ ok: false, code: 400, error: "unknown_get_action" });
}

function doPost(e) {
  let body;
  try {
    const raw = (e && e.postData && e.postData.contents) || "";
    if (!raw) {
      return jsonResponse_({ ok: false, code: 400, error: "empty_body" });
    }
    body = JSON.parse(raw);
  } catch (err) {
    return jsonResponse_({ ok: false, code: 400, error: "invalid_json" });
  }

  const agentId = authenticate_(body.token);
  if (!agentId) {
    return jsonResponse_({ ok: false, code: 401, error: "invalid_or_missing_token" });
  }

  const action = String(body.action || "submit_piece").trim();
  if (action !== "submit_piece") {
    return jsonResponse_({ ok: false, code: 400, error: "unknown_post_action" });
  }

  const canonicalHost = normalizeHost_(body.url || body.domain || "");
  const pieceType = String(body.piece_type || "").trim();
  const summary = String(body.summary || "").trim();
  const displayName = String(body.display_name || canonicalHost).trim();
  const evidenceUrl = String(body.evidence_url || body.url || "").trim();
  const payloadObj = body.payload && typeof body.payload === "object" ? body.payload : {};
  const payloadJson = JSON.stringify(payloadObj);

  if (!canonicalHost || canonicalHost.indexOf(".") === -1) {
    return jsonResponse_({ ok: false, code: 422, error: "invalid_domain_or_url" });
  }
  if (!pieceType) {
    return jsonResponse_({ ok: false, code: 422, error: "missing_piece_type" });
  }
  if (!summary) {
    return jsonResponse_({ ok: false, code: 422, error: "missing_summary" });
  }
  if (!/^https?:\/\/\S+/i.test(evidenceUrl)) {
    return jsonResponse_({ ok: false, code: 422, error: "invalid_evidence_url" });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (lockErr) {
    return jsonResponse_({ ok: false, code: 429, error: "lock_timeout_retry" });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const provSheet = ss.getSheetByName(SHEET_PROVIDERS);
    const pieceSheet = ss.getSheetByName(SHEET_PIECES);
    const logSheet = ss.getSheetByName(SHEET_LOGS);
    const now = new Date().toISOString();

    const existingProv = findProviderByHost_(provSheet, canonicalHost);
    let providerId;
    let providerCreated = false;

    if (existingProv) {
      providerId = existingProv.provider_id;
    } else {
      providerId = "prov_" + Utilities.getUuid().slice(0, 8);
      provSheet.appendRow([providerId, canonicalHost, displayName, agentId, now]);
      providerCreated = true;
    }

    const dupPieceId = findExactPiece_(pieceSheet, canonicalHost, agentId, pieceType, payloadJson);
    if (dupPieceId) {
      logSheet.appendRow([now, agentId, "submit_piece", 200, "idempotent:" + dupPieceId]);
      return jsonResponse_({
        ok: true,
        code: 200,
        idempotent: true,
        provider_created: false,
        provider_id: providerId,
        piece_id: dupPieceId,
        canonical_host: canonicalHost,
        agent_id: agentId,
      });
    }

    const pieceId = "pc_" + Utilities.getUuid().slice(0, 12);
    pieceSheet.appendRow([
      pieceId,
      providerId,
      canonicalHost,
      agentId,
      pieceType,
      summary,
      payloadJson,
      evidenceUrl,
      now,
    ]);
    logSheet.appendRow([
      now,
      agentId,
      "submit_piece",
      201,
      canonicalHost + " | " + pieceType + " | prov_new=" + providerCreated,
    ]);

    return jsonResponse_({
      ok: true,
      code: 201,
      idempotent: false,
      provider_created: providerCreated,
      provider_id: providerId,
      piece_id: pieceId,
      canonical_host: canonicalHost,
      agent_id: agentId,
    });
  } finally {
    lock.releaseLock();
  }
}

function authenticate_(token) {
  if (!token || typeof token !== "string") return null;
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_TOKENS);
  if (!raw) return null;
  const map = JSON.parse(raw);
  return map[token.trim()] || null;
}

function normalizeHost_(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/[\/?#].*$/, "");
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

function findProviderByHost_(sheet, canonicalHost) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]).trim().toLowerCase() === canonicalHost) {
      return {
        row: i + 1,
        provider_id: String(values[i][0]),
        canonical_host: String(values[i][1]),
        display_name: String(values[i][2]),
      };
    }
  }
  return null;
}

function findExactPiece_(sheet, canonicalHost, agentId, pieceType, payloadJson) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (
      String(values[i][2]) === canonicalHost &&
      String(values[i][3]) === agentId &&
      String(values[i][4]) === pieceType &&
      String(values[i][6]) === payloadJson
    ) {
      return String(values[i][0]);
    }
  }
  return null;
}

function ensureTab_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function readRowsAsObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[String(headers[j])] = values[i][j];
    }
    out.push(obj);
  }
  return out;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
