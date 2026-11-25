"""Live Apps Script Web App smoke verification.

Triggered automatically by `run_tests.cmd all` when HUB_URL and HUB_TEST_TOKEN
are set in the environment. Uses Python standard library only.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Google Apps Script runs doPost then returns 302 to script.googleusercontent.com;
    # urllib.request automatically converts 302 POST -> GET on redirect target.
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    hub_url = os.environ.get("HUB_URL", "").strip()
    token = os.environ.get("HUB_TEST_TOKEN", "").strip()
    if not hub_url or not token:
        print("[SKIP] HUB_URL or HUB_TEST_TOKEN not set.")
        return 0

    print("[SMOKE 1/5] GET ?action=ping")
    ping_res = http_get_json(f"{hub_url}?{urllib.parse.urlencode({'action': 'ping'})}")
    assert_true(ping_res.get("ok") is True and ping_res.get("code") == 200, f"ping failed: {ping_res}")

    print("[SMOKE 2/5] GET ?action=get_prompt")
    prompt_res = http_get_json(f"{hub_url}?{urllib.parse.urlencode({'action': 'get_prompt'})}")
    assert_true(prompt_res.get("ok") is True, f"get_prompt failed: {prompt_res}")
    pv = prompt_res["data"]["prompt_version"]
    assert_true(bool(pv), f"missing prompt_version: {prompt_res}")

    print("[SMOKE 3/5] GET with ?token= MUST fail 400 token_in_query_forbidden")
    q_tok_res = http_get_json(
        f"{hub_url}?{urllib.parse.urlencode({'action': 'ping', 'token': token})}"
    )
    assert_true(
        q_tok_res.get("code") == 400 and q_tok_res.get("error") == "token_in_query_forbidden",
        f"query token was not rejected properly: {q_tok_res}",
    )

    print("[SMOKE 4/5] POST submit_piece x2 -> 201 then 200 idempotent:true")
    smoke_nonce = uuid.uuid4().hex[:10]
    piece_req = {
        "action": "submit_piece",
        "token": token,
        "prompt_version": pv,
        "canonical_host": "smoke-canary.free-ai-test.org",
        "piece_type": "identity",
        "channels": ["Browser"],
        "summary": f"اختبار دخان حي لـ AI Providers Hub ({smoke_nonce}) عبر المتصفح",
        "payload": {
            "display_name": "Smoke Canary Test",
            "usage_url": "https://smoke-canary.free-ai-test.org/",
            "access_types": ["Browser"],
            "notes": f"live_smoke_{smoke_nonce}",
        },
        "evidence_url": "https://smoke-canary.free-ai-test.org/",
        "evidence_excerpt": f"Live smoke verification canary {smoke_nonce} on smoke-canary.free-ai-test.org.",
        "confidence": "inferred",
    }
    first = http_post_json(hub_url, piece_req)
    assert_true(first.get("ok") is True and first.get("code") == 201, f"first submit failed: {first}")
    second = http_post_json(hub_url, piece_req)
    assert_true(
        second.get("ok") is True
        and second.get("code") == 200
        and (second.get("data") or {}).get("idempotent") is True,
        f"second idempotent submit failed: {second}",
    )

    print("[SMOKE 5/5] POST list pagination on pieces")
    lst = http_post_json(hub_url, {"action": "list", "token": token, "sheet": "pieces", "limit": 2, "cursor": 0})
    assert_true(lst.get("ok") is True and lst.get("code") == 200, f"list failed: {lst}")
    assert_true("rows" in (lst.get("data") or {}), f"missing rows in list output: {lst}")

    print("[PASS] All live Apps Script smoke checks passed cleanly.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (urllib.error.URLError, AssertionError, KeyError, json.JSONDecodeError) as exc:
        print(f"[FAIL] Live smoke error: {exc}", file=sys.stderr)
        raise SystemExit(1)
