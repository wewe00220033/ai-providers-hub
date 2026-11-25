"""sync_to_sheet.py - push github-origin pieces to the guardian (Apps Script) - HTTP-200-trap safe.

Python 3.15 stdlib ONLY (urllib.request, json, argparse, time). PLAN section 7.

Rules:
  * follows 302/303 (urllib default redirect handling - Apps Script redirects to a 200 page)
  * success ONLY when the JSON body has  ok is True  and  code in (200, 201)  - HTTP 200 alone is NOT success
  * code 429 -> sleep backoff_base * 2**n (2, 4, 8, 16 ...) and retry up to --max-retries, then SyncError
  * any other code -> SyncError carrying the guardian response (token redacted)
  * piece_id is written to the state file ONLY after guardian confirmation, saved after EVERY success
    (incremental, so progress is never lost) -> idempotent on rerun
  * the token is sent in the POST body only; it is never placed in a URL, printed, or included in errors

CLI:
    python scripts/sync_to_sheet.py [--repo <root>] [--hub-url URL] [--token TOKEN] [--state docs/.synced_ids.json]
                                    [--backoff-base 2.0] [--max-retries 4] [--timeout 30]
  --hub-url defaults to env HUB_URL, --token to env HUB_SYNC_TOKEN.
  Exit codes: 0 = synced / nothing to sync, 1 = sync failure, 2 = usage error (missing url/token/repo).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_STATE = "docs/.synced_ids.json"
SUCCESS_CODES = (200, 201)


class SyncError(Exception):
    """Raised when the guardian did not confirm a piece (never contains the token)."""


def redact(text: str, token: str | None) -> str:
    if token:
        return str(text).replace(token, "***")
    return str(text)


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------


def load_state(path: str | Path) -> dict:
    path = Path(path)
    if not path.is_file():
        return {"synced": []}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {"synced": []}
    synced = data.get("synced") if isinstance(data, dict) else None
    return {"synced": sorted({str(x) for x in synced}) if isinstance(synced, list) else []}


def save_state(path: str | Path, state: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"synced": sorted({str(x) for x in state.get("synced", [])})}
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------


def find_unsynced(repo_root: str | Path, state: dict) -> list[tuple[str, dict]]:
    """(relpath, piece) for every pieces/**/*.json with origin == 'github' not yet in state."""
    repo_root = Path(repo_root)
    synced = set(state.get("synced", []))
    out: list[tuple[str, dict]] = []
    base = repo_root / "pieces"
    if not base.is_dir():
        return out
    for path in sorted(p for p in base.rglob("*.json") if p.is_file()):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                piece = json.load(fh)
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        if not isinstance(piece, dict) or piece.get("origin") != "github":
            continue
        pid = piece.get("piece_id")
        if not isinstance(pid, str) or pid in synced:
            continue
        out.append((path.relative_to(repo_root).as_posix(), piece))
    return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def post_json(url: str, body: dict, timeout: float = 30, opener: Any = None) -> dict:
    """POST JSON, follow redirects (urllib default), return the parsed JSON dict or raise SyncError."""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
        method="POST",
    )
    opener = opener or urllib.request.build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = getattr(resp, "status", 200)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        status = exc.code
    except (urllib.error.URLError, OSError) as exc:
        raise SyncError(f"network_error: {getattr(exc, 'reason', exc)}") from None
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise SyncError(f"non_json_response http={status} body={raw[:300]!r}") from None
    if not isinstance(parsed, dict):
        raise SyncError(f"non_object_response http={status} body={raw[:300]!r}")
    return parsed


def sync_one(
    url: str,
    token: str,
    relpath: str,
    piece: dict,
    sleep: Callable[[float], Any] = time.sleep,
    backoff_base: float = 2.0,
    max_retries: int = 4,
    timeout: float = 30,
    opener: Any = None,
) -> dict:
    """Send one piece; return the guardian response only when ok is True and code in (200, 201)."""
    body = {
        "token": token,
        "action": "sync_from_github",
        "piece_id": piece.get("piece_id"),
        "path": relpath,
        "origin": "github",
        "piece": piece,
    }
    attempt = 0
    while True:
        resp = post_json(url, body, timeout=timeout, opener=opener)
        code = resp.get("code")
        if resp.get("ok") is True and code in SUCCESS_CODES:
            return resp
        safe = redact(json.dumps(resp, ensure_ascii=False)[:600], token)
        if code == 429:
            if attempt >= max_retries:
                raise SyncError(f"rate_limited after {max_retries} retries {relpath}: {safe}")
            sleep(backoff_base * (2**attempt))
            attempt += 1
            continue
        raise SyncError(f"guardian_rejected {relpath}: {safe}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None, sleep: Callable[[float], Any] = time.sleep) -> int:
    parser = argparse.ArgumentParser(prog="sync_to_sheet", description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--hub-url", default=None, help="default: env HUB_URL")
    parser.add_argument("--token", default=None, help="default: env HUB_SYNC_TOKEN (never printed)")
    parser.add_argument("--state", default=DEFAULT_STATE)
    parser.add_argument("--backoff-base", type=float, default=2.0)
    parser.add_argument("--max-retries", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0

    url = args.hub_url or os.environ.get("HUB_URL", "")
    token = args.token or os.environ.get("HUB_SYNC_TOKEN", "")
    repo = Path(args.repo)
    if not repo.is_dir():
        print(f"USAGE_ERROR repo root not found: {repo}")
        return 2
    if not url.strip():
        print("USAGE_ERROR HUB_URL missing (use --hub-url or env HUB_URL)")
        return 2
    if not token.strip():
        print("USAGE_ERROR HUB_SYNC_TOKEN missing (use --token or env HUB_SYNC_TOKEN)")
        return 2

    state_path = Path(args.state)
    if not state_path.is_absolute():
        state_path = repo / state_path
    state = load_state(state_path)
    pending = find_unsynced(repo, state)
    if not pending:
        print("SYNC: nothing to sync")
        return 0

    synced = set(state["synced"])
    for relpath, piece in pending:
        try:
            resp = sync_one(
                url, token, relpath, piece,
                sleep=sleep, backoff_base=args.backoff_base, max_retries=args.max_retries,
                timeout=args.timeout,
            )
        except SyncError as exc:
            print(f"SYNC_FAILED {relpath}: {redact(str(exc), token)}")
            return 1
        synced.add(str(piece["piece_id"]))
        state = {"synced": sorted(synced)}
        save_state(state_path, state)
        flag = " idempotent" if resp.get("idempotent") else ""
        print(f"SYNCED {piece['piece_id']} {relpath} code={resp.get('code')}{flag}")
    print(f"SYNC: {len(pending)} pieces confirmed")
    return 0


__all__ = [
    "SyncError",
    "redact",
    "load_state",
    "save_state",
    "find_unsynced",
    "post_json",
    "sync_one",
    "main",
]

if __name__ == "__main__":
    sys.exit(main())
