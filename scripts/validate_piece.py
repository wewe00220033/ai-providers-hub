"""validate_piece.py - deterministic, 0-token validator for pieces/** and reviews/** (PLAN section 6).

Python 3.15 stdlib ONLY. Every shared helper is imported from scripts/hub_common.py
(canonical_json, normalize_host, is_blocked_host, validate_schema_dict, load_schema, load_enums) -
nothing is re-implemented here.

PATH RULE (FINAL - adopted by this validator, the fixtures and the tests):
    pieces/<provider.canonical_host>/<agent.agent_id>_<piece_id>.json   (piece_id WITH its 'pc_' prefix)
    reviews/<review_id>.json                                              (review_id WITH its 'rv_' prefix)

CLI:
    python scripts/validate_piece.py [--repo <root>] [--diff <name-status-file>] [paths...]
  * no paths  -> every pieces/**/*.json and reviews/**/*.json under --repo (default: project root)
  * --diff    -> add-only check over a `git diff --name-status` text file (rule 11)
  Output: one line per error  'ERROR <relpath> <error_code>[: detail]'  then  'VALIDATION: N errors'.
  Exit codes: 0 = ok, 1 = validation errors, 2 = usage error (missing path / unreadable --diff file).

ERROR CODES (stable snake_case):
  rule 1  schema_violation, payload_schema_violation
  rule 2  invalid_canonical_host, blocked_host
  rule 3  evidence_not_https, evidence_host_mismatch, evidence_excerpt_length
  rule 4  suspicious_path_segment, double_slash_in_path, repeated_path_segment, tracking_params_present
  rule 5  free_claim_unsupported, free_claim_contradiction, target_model_not_named, target_model_not_in_evidence
  rule 6  captcha_type_inconsistent, probe_result_invalid
  rule 7  checked_page_host_mismatch
  rule 8  path_content_mismatch
  rule 9  duplicate_piece_id, duplicate_review_id
  rule 10 review_schema_violation, owner_correction_forbidden
  rule 11 modify_or_delete_forbidden, out_of_scope_path, diff_parse_error
  misc    invalid_json, symlink_forbidden (symlinks are never read under pieces/ or reviews/)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.hub_common import (  # noqa: E402
    canonical_json,
    is_blocked_host,
    load_enums,
    load_schema,
    normalize_host,
    validate_schema_dict,
)

PROBE_RESULTS = ("otp", "magic_link", "none", "unknown", "")
TRACKING_MARKERS = ("utm_", "ref=", "fbclid", "gclid")
_SUSPICIOUS_SEG_RE = re.compile(r"/-\d+")


def _err(code: str, detail: str = "") -> str:
    return f"{code}: {detail}" if detail else code


def error_code(error: str) -> str:
    """Return the snake_case code at the start of an error string produced by this module."""
    return error.split(":", 1)[0].strip()


def _relpath(path: Path, repo_root: Path) -> str:
    try:
        if path.is_symlink():
            # keep the link's own name; never resolve through the link target
            return (path.parent.resolve() / path.name).relative_to(repo_root.resolve()).as_posix()
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _payload_schema(piece_type: str) -> dict:
    candidate = ROOT / "schemas" / "types" / f"{piece_type}.schema.json"
    if piece_type and not piece_type.startswith("_") and candidate.is_file():
        return load_schema(f"types/{piece_type}")
    return load_schema("types/_generic")


def _host_matches(url_host: str, canonical_host: str, provider_id: Any, known_aliases: dict) -> bool:
    if not url_host or not canonical_host:
        return False
    if url_host == canonical_host or url_host.endswith("." + canonical_host):
        return True
    return known_aliases.get(url_host) == provider_id


def check_url_traps(url: str) -> list[str]:
    """Rule 4: fake-route traps on a single URL."""
    errors: list[str] = []
    try:
        parts = urlsplit(url)
    except ValueError:
        return [_err("suspicious_path_segment", "unparseable url")]
    path = parts.path or ""
    if _SUSPICIOUS_SEG_RE.search(path):
        errors.append(_err("suspicious_path_segment", url))
    if "//" in path:
        errors.append(_err("double_slash_in_path", url))
    segments = [s for s in path.split("/") if s]
    if any(n > 2 for n in Counter(segments).values()):
        errors.append(_err("repeated_path_segment", url))
    query = (parts.query or "").lower()
    if any(marker in query for marker in TRACKING_MARKERS):
        errors.append(_err("tracking_params_present", url))
    return errors


def _has_key_recursive(obj: Any, key: str) -> bool:
    if isinstance(obj, dict):
        if key in obj:
            return True
        return any(_has_key_recursive(v, key) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_key_recursive(v, key) for v in obj)
    return False


# ---------------------------------------------------------------------------
# pieces
# ---------------------------------------------------------------------------


def validate_piece_obj(piece: Any, relpath: str | None = None, known_aliases: dict | None = None) -> list[str]:
    """Validate one piece object (rules 1-8). known_aliases: normalized alias host -> provider_id."""
    known_aliases = known_aliases or {}
    errors: list[str] = []
    if not isinstance(piece, dict):
        return [_err("schema_violation", "piece is not a JSON object")]

    # rule 1 - envelope + payload schema
    for e in validate_schema_dict(piece, load_schema("piece.base")):
        errors.append(_err("schema_violation", e))
    piece_type = piece.get("piece_type")
    payload = piece.get("payload")
    if isinstance(piece_type, str) and isinstance(payload, dict):
        for e in validate_schema_dict(payload, _payload_schema(piece_type)):
            errors.append(_err("payload_schema_violation", e))

    # rule 2 - canonical host
    provider = piece.get("provider") if isinstance(piece.get("provider"), dict) else {}
    host = provider.get("canonical_host")
    provider_id = provider.get("provider_id")
    host_ok = False
    if isinstance(host, str) and host and is_blocked_host(host):
        errors.append(_err("blocked_host", host))
    elif not isinstance(host, str) or not host or normalize_host(host) != host:
        errors.append(_err("invalid_canonical_host", repr(host)))
    else:
        host_ok = True

    # rule 3 + 4 - evidence
    evidence = piece.get("evidence") if isinstance(piece.get("evidence"), dict) else {}
    url = evidence.get("url")
    excerpt = evidence.get("excerpt", "")
    if isinstance(url, str):
        if not url.startswith("https://"):
            errors.append(_err("evidence_not_https", url))
        elif host_ok and not _host_matches(normalize_host(url), host, provider_id, known_aliases):
            errors.append(_err("evidence_host_mismatch", f"{url} vs {host}"))
        errors.extend(check_url_traps(url))
    if piece.get("confidence") == "observed":
        n = len(str(excerpt).strip())
        if n < 20 or n > 600:
            errors.append(_err("evidence_excerpt_length", f"{n} chars (20..600 required for observed)"))

    # rule 5 - free claims
    if piece_type in ("guest_chat", "free_tier") and isinstance(payload, dict):
        named = payload.get("models_named")
        named = named if isinstance(named, list) else []
        none_found = payload.get("none_found")
        if not named and none_found is False:
            errors.append(_err("free_claim_unsupported", "models_named empty and none_found false"))
        if named and none_found is True:
            errors.append(_err("free_claim_contradiction", "models_named non-empty and none_found true"))
        if piece_type == "free_tier" and payload.get("includes_target_models") is True:
            enums = load_enums()
            full = enums["models_full"]
            short = enums.get("model_short", {})
            candidates = [m for m in [piece.get("model_tag")] + list(named) if isinstance(m, str) and m in full]
            if not candidates:
                errors.append(_err("target_model_not_named", "includes_target_models true without a target model"))
            else:
                ex = str(excerpt).lower()
                if not any(m.lower() in ex or str(short.get(m, m)).lower() in ex for m in candidates):
                    errors.append(_err("target_model_not_in_evidence", ", ".join(candidates)))

    # rule 6 - auth_flow
    if piece_type == "auth_flow" and isinstance(payload, dict):
        captcha = payload.get("captcha")
        if isinstance(captcha, dict) and captcha.get("detected") is True and captcha.get("type") == "none":
            errors.append(_err("captcha_type_inconsistent", "detected true but type none"))
        if "probe_result" in payload and payload.get("probe_result") not in PROBE_RESULTS:
            errors.append(_err("probe_result_invalid", repr(payload.get("probe_result"))))

    # rule 7 - not_found pages
    if piece_type == "not_found" and isinstance(payload, dict):
        pages = payload.get("checked_pages")
        for page in pages if isinstance(pages, list) else []:
            if not isinstance(page, str):
                continue
            if host_ok and not _host_matches(normalize_host(page), host, provider_id, known_aliases):
                errors.append(_err("checked_page_host_mismatch", f"{page} vs {host}"))
            errors.extend(check_url_traps(page))

    # rule 8 - path <-> content
    if relpath:
        rel = relpath.replace("\\", "/")
        if rel.startswith("pieces/"):
            agent = piece.get("agent") if isinstance(piece.get("agent"), dict) else {}
            expected = f"pieces/{host}/{agent.get('agent_id')}_{piece.get('piece_id')}.json"
            if rel != expected:
                errors.append(_err("path_content_mismatch", f"expected {expected}"))
    return errors


# ---------------------------------------------------------------------------
# reviews
# ---------------------------------------------------------------------------


def validate_review_obj(review: Any, relpath: str | None = None) -> list[str]:
    """Validate one review event (rule 10 + path rule)."""
    errors: list[str] = []
    if not isinstance(review, dict):
        return [_err("review_schema_violation", "review is not a JSON object")]
    if _has_key_recursive(review, "owner_correction"):
        errors.append(_err("owner_correction_forbidden", "private field must never reach reviews/"))
    for e in validate_schema_dict(review, load_schema("review_event")):
        errors.append(_err("review_schema_violation", e))
    if relpath:
        rel = relpath.replace("\\", "/")
        if rel.startswith("reviews/"):
            expected = f"reviews/{review.get('review_id')}.json"
            if rel != expected:
                errors.append(_err("path_content_mismatch", f"expected {expected}"))
    return errors


# ---------------------------------------------------------------------------
# files / repo
# ---------------------------------------------------------------------------


def _load_json_file(path: Path) -> tuple[Any, str | None]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        return None, str(exc).splitlines()[0] if str(exc) else exc.__class__.__name__


def validate_piece_file(path: str | Path, repo_root: str | Path, known_aliases: dict | None = None) -> list[str]:
    """Validate one file (piece or review, chosen by its relpath prefix). Returns error strings."""
    path = Path(path)
    repo_root = Path(repo_root)
    rel = _relpath(path, repo_root)
    if path.is_symlink():
        return [_err("symlink_forbidden", "symlinks are not allowed under pieces/ or reviews/")]
    obj, load_error = _load_json_file(path)
    if load_error is not None:
        return [_err("invalid_json", load_error)]
    if rel.startswith("reviews/"):
        return validate_review_obj(obj, rel)
    return validate_piece_obj(obj, rel, known_aliases)


def _repo_files(repo_root: Path) -> list[Path]:
    files: list[Path] = []
    for sub in ("pieces", "reviews"):
        base = repo_root / sub
        if base.is_dir():
            files.extend(sorted(p for p in base.rglob("*.json") if p.is_file()))
    return files


def build_known_aliases(repo_root: str | Path) -> dict[str, str]:
    """host/alias (normalized) -> provider_id, gathered from every loadable piece (rule 2 'alias')."""
    repo_root = Path(repo_root)
    aliases: dict[str, str] = {}
    for path in _repo_files(repo_root):
        if not _relpath(path, repo_root).startswith("pieces/"):
            continue
        obj, err = _load_json_file(path)
        if err is not None or not isinstance(obj, dict):
            continue
        provider = obj.get("provider") if isinstance(obj.get("provider"), dict) else {}
        pid = provider.get("provider_id")
        host = normalize_host(provider.get("canonical_host", ""))
        if host and isinstance(pid, str):
            aliases.setdefault(host, pid)
        if obj.get("piece_type") == "identity" and isinstance(obj.get("payload"), dict):
            for alias in obj["payload"].get("aliases", []) or []:
                a = normalize_host(alias) if isinstance(alias, str) else ""
                if a and isinstance(pid, str):
                    aliases.setdefault(a, pid)
    return aliases


def validate_repo(repo_root: str | Path, paths: list[str | Path] | None = None) -> list[str]:
    """Validate the given files (or the whole repo). Returns '<relpath> <code>[: detail]' strings.

    Raises FileNotFoundError for an explicit path that does not exist (CLI maps it to exit 2).
    """
    repo_root = Path(repo_root)
    if paths:
        files: list[Path] = []
        for p in paths:
            cand = Path(p)
            if not cand.exists():
                cand = repo_root / p
            if not cand.is_file():
                raise FileNotFoundError(str(p))
            files.append(cand)
    else:
        files = _repo_files(repo_root)

    known_aliases = build_known_aliases(repo_root)
    out: list[str] = []
    for path in files:
        rel = _relpath(path, repo_root)
        for e in validate_piece_file(path, repo_root, known_aliases):
            out.append(f"{rel} {e}")

    # rule 9 - duplicate ids across the WHOLE repo
    piece_ids: dict[str, list[str]] = {}
    review_ids: dict[str, list[str]] = {}
    for path in _repo_files(repo_root):
        rel = _relpath(path, repo_root)
        obj, err = _load_json_file(path)
        if err is not None or not isinstance(obj, dict):
            continue
        if rel.startswith("reviews/"):
            rid = obj.get("review_id")
            if isinstance(rid, str):
                review_ids.setdefault(rid, []).append(rel)
        else:
            pid = obj.get("piece_id")
            if isinstance(pid, str):
                piece_ids.setdefault(pid, []).append(rel)
    checked = {_relpath(p, repo_root) for p in files}
    for pid, rels in sorted(piece_ids.items()):
        if len(rels) > 1:
            for rel in rels:
                if rel in checked:
                    out.append(f"{rel} {_err('duplicate_piece_id', pid + ' also in ' + ', '.join(r for r in rels if r != rel))}")
    for rid, rels in sorted(review_ids.items()):
        if len(rels) > 1:
            for rel in rels:
                if rel in checked:
                    out.append(f"{rel} {_err('duplicate_review_id', rid + ' also in ' + ', '.join(r for r in rels if r != rel))}")
    return out


# ---------------------------------------------------------------------------
# --diff (rule 11: add-only under pieces/** and reviews/**)
# ---------------------------------------------------------------------------


def _in_scope(path: str) -> bool:
    return path.startswith("pieces/") or path.startswith("reviews/")


def check_diff(name_status_text: str) -> list[str]:
    """Check `git diff --name-status` text. Returns '<path> <code>' strings; .gitkeep files are ignored."""
    errors: list[str] = []
    for lineno, raw in enumerate(name_status_text.splitlines(), 1):
        line = raw.rstrip("\r")
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            parts = line.split()
        status = parts[0].strip().upper()
        paths = [p.replace("\\", "/").strip() for p in parts[1:] if p.strip()]
        if status in ("A", "M", "D") and len(paths) == 1:
            targets = paths
        elif status[:1] in ("R", "C") and len(paths) == 2:
            targets = paths
        else:
            errors.append(f"line:{lineno} {_err('diff_parse_error', line)}")
            continue
        if all(t.endswith(".gitkeep") for t in targets):
            continue
        if status == "A":
            if not _in_scope(targets[0]):
                errors.append(f"{targets[0]} {_err('out_of_scope_path', 'only pieces/** and reviews/** may be added')}")
            continue
        # M / D / R* / C*
        for t in targets:
            if _in_scope(t):
                errors.append(f"{t} {_err('modify_or_delete_forbidden', 'status ' + status)}")
                break
        else:
            errors.append(f"{targets[-1]} {_err('out_of_scope_path', 'status ' + status)}")
    return errors


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="validate_piece", description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(ROOT), help="repository root (default: project root)")
    parser.add_argument("--diff", default=None, help="git diff --name-status output file (add-only check)")
    parser.add_argument("paths", nargs="*", help="specific files to validate (default: whole repo)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0

    repo_root = Path(args.repo)
    if not repo_root.is_dir():
        print(f"USAGE_ERROR repo root not found: {repo_root}")
        return 2

    errors: list[str] = []
    if args.diff is not None:
        diff_path = Path(args.diff)
        try:
            with open(diff_path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            print(f"USAGE_ERROR cannot read --diff file: {exc}")
            return 2
        errors.extend(check_diff(text))
    try:
        errors.extend(validate_repo(repo_root, args.paths or None))
    except FileNotFoundError as exc:
        print(f"USAGE_ERROR path not found: {exc}")
        return 2

    for e in errors:
        print(f"ERROR {e}")
    print(f"VALIDATION: {len(errors)} errors")
    return 1 if errors else 0


__all__ = [
    "validate_piece_obj",
    "validate_review_obj",
    "validate_piece_file",
    "validate_repo",
    "build_known_aliases",
    "check_url_traps",
    "check_diff",
    "error_code",
    "main",
]

if __name__ == "__main__":
    sys.exit(main())
