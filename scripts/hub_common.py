"""hub_common.py - shared, dependency-free helpers for the AI Providers Puzzle Hub.

Python 3.15 stdlib ONLY (json, hashlib, re, ipaddress, datetime, zoneinfo-optional).

Contracts (PLAN.md section 3.4 / 5 / 6):
  * canonical_json(obj)        -> recursive key sort by Unicode code point, arrays keep order,
                                  separators=(',', ':'), ensure_ascii=False, numbers unchanged.
                                  MUST stay byte-identical with canonicalJson_ in apps_script/Code.gs.
  * canonical_sha256(obj)      -> sha256 hex digest over the UTF-8 bytes of canonical_json(obj).
  * normalize_host(raw)        -> canonical provider host or "" (never raises).
  * to_cairo_time(iso_utc)     -> 'yyyy-MM-dd hh:mm ص|م' in Africa/Cairo (never raises on missing tzdata).
  * validate_schema_dict(...)  -> minimal Draft-07 structural validator returning a list of errors.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = ROOT / "schemas"

# ---------------------------------------------------------------------------
# canonical JSON
# ---------------------------------------------------------------------------


def canonical_json(obj: Any) -> str:
    """Deterministic JSON serialisation shared with Code.gs canonicalJson_.

    json.dumps(sort_keys=True) sorts dict keys with Python string ordering which is
    Unicode code-point ordering, applied recursively; lists keep their order;
    ints stay ints (no trailing .0); null/true/false are emitted literally.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_sha256(obj: Any) -> str:
    """sha256 hex of the UTF-8 bytes of canonical_json(obj)."""
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# enums / schema loading
# ---------------------------------------------------------------------------

_ENUMS_CACHE: dict | None = None
_SCHEMA_CACHE: dict[str, dict] = {}


def _read_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_enums() -> dict:
    """Lazy-load schemas/enums.json once (relative to this file, not the CWD)."""
    global _ENUMS_CACHE
    if _ENUMS_CACHE is None:
        _ENUMS_CACHE = _read_json(SCHEMAS_DIR / "enums.json")
    return _ENUMS_CACHE


def load_schema(name: str) -> dict:
    """Load a schema from schemas/ by short name.

    Accepted names: 'enums', 'piece.base', 'review_event', 'types/guest_chat', ...
    A name already ending with '.json' is used verbatim (relative to schemas/).
    """
    key = name.replace("\\", "/").strip("/")
    if key in _SCHEMA_CACHE:
        return _SCHEMA_CACHE[key]
    if key.endswith(".json"):
        rel = key
    elif key == "enums":
        rel = "enums.json"
    else:
        rel = key + ".schema.json"
    data = _read_json(SCHEMAS_DIR / rel)
    _SCHEMA_CACHE[key] = data
    return data


# ---------------------------------------------------------------------------
# host normalisation (PLAN section 6 rule 1)
# ---------------------------------------------------------------------------

_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*://")
_PORT_RE = re.compile(r":\d+$")
_HOST_CHARS_RE = re.compile(r"^[a-z0-9.\-]+$")


def is_blocked_host(host: str) -> bool:
    """True when host, or any dot-suffix of it, is listed in enums.host_blocklist."""
    if not host:
        return False
    h = host.strip().lower().strip(".")
    if h == "localhost" or h.endswith(".localhost"):
        return True
    blocklist = {str(x).strip().lower().strip(".") for x in load_enums().get("host_blocklist", [])}
    labels = h.split(".")
    for i in range(len(labels)):
        if ".".join(labels[i:]) in blocklist:
            return True
    return False


def normalize_host(raw: str) -> str:
    """Canonical host for a provider, or "" when the input is not an acceptable host.

    Steps: strip, lowercase, drop scheme, cut at first '/', '?' or '#', drop userinfo,
    drop :port, drop leading 'www.'. Returns "" (never raises) for: empty, no dot,
    IP address, localhost, or a blocklisted domain / parent domain.
    """
    if not isinstance(raw, str):
        return ""
    h = raw.strip().lower()
    if not h:
        return ""
    h = _SCHEME_RE.sub("", h)
    h = re.split(r"[/?#]", h, maxsplit=1)[0]
    if "@" in h:
        h = h.rsplit("@", 1)[1]
    h = _PORT_RE.sub("", h)
    if h.startswith("www."):
        h = h[4:]
    h = h.strip(".")
    if not h or "." not in h:
        return ""
    try:
        ipaddress.ip_address(h)
        return ""
    except ValueError:
        pass
    if not _HOST_CHARS_RE.match(h):
        return ""
    if is_blocked_host(h):
        return ""
    return h


# ---------------------------------------------------------------------------
# Cairo time (PLAN section 3.7)
# ---------------------------------------------------------------------------

_ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _cairo_tz():
    """Africa/Cairo via zoneinfo when tzdata exists, else fixed UTC+2 (never raises)."""
    try:
        import zoneinfo  # stdlib

        return zoneinfo.ZoneInfo("Africa/Cairo")
    except Exception:  # ZoneInfoNotFoundError, ImportError, anything -> fallback
        return timezone(timedelta(hours=2), "Africa/Cairo")


def _parse_iso_utc(iso_utc: str) -> datetime:
    s = str(iso_utc).strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_cairo_time(iso_utc: str) -> str:
    """'yyyy-MM-dd hh:mm ص|م' (12h, two-digit hour, 12 instead of 00) in Africa/Cairo.

    Accepts ISO-8601 with 'Z', '+00:00', or no offset (treated as UTC).
    """
    dt_utc = _parse_iso_utc(iso_utc)
    local = dt_utc.astimezone(_cairo_tz())
    hour12 = local.hour % 12
    if hour12 == 0:
        hour12 = 12
    suffix = "ص" if local.hour < 12 else "م"
    return f"{local.year:04d}-{local.month:02d}-{local.day:02d} {hour12:02d}:{local.minute:02d} {suffix}"


def utc_now_iso() -> str:
    """Current UTC time as 'YYYY-MM-DDTHH:MM:SSZ'."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cairo_now() -> str:
    """Current Cairo time in the display format of to_cairo_time()."""
    return to_cairo_time(utc_now_iso())


# ---------------------------------------------------------------------------
# minimal Draft-07 validator
# ---------------------------------------------------------------------------


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "integer": _is_int,
    "number": _is_number,
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
}


def _json_type_name(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _json_equal(a: Any, b: Any) -> bool:
    """JSON equality where bool is NOT equal to 0/1 and 1 == 1.0."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    if type(a) is not type(b):
        return False
    return a == b


def validate_schema_dict(instance: Any, schema: Any, path: str = "$") -> list[str]:
    """Validate instance against a (subset of) Draft-07 schema; returns error strings.

    Supported keywords: type (string|list), required, properties, additionalProperties,
    enum, const, minLength, maxLength, pattern (re.search), minItems, maxItems, items.
    Empty list == valid.
    """
    errors: list[str] = []
    if schema is True or schema is None:
        return errors
    if schema is False:
        return [f"{path}: schema_false"]
    if not isinstance(schema, dict):
        return [f"{path}: invalid_schema"]

    # type
    if "type" in schema:
        types = schema["type"]
        if isinstance(types, str):
            types = [types]
        ok = any(_TYPE_CHECKS.get(t, lambda v: False)(instance) for t in types)
        if not ok:
            errors.append(
                f"{path}: type_mismatch expected {'|'.join(types)} got {_json_type_name(instance)}"
            )

    # enum / const
    if "enum" in schema:
        if not any(_json_equal(instance, e) for e in schema["enum"]):
            errors.append(f"{path}: enum_mismatch value={canonical_json(instance)}")
    if "const" in schema:
        if not _json_equal(instance, schema["const"]):
            errors.append(f"{path}: const_mismatch expected={canonical_json(schema['const'])}")

    # string keywords
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: min_length {len(instance)}<{schema['minLength']}")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append(f"{path}: max_length {len(instance)}>{schema['maxLength']}")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            errors.append(f"{path}: pattern_mismatch {schema['pattern']}")

    # object keywords
    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing_required:{key}")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in instance:
                errors.extend(validate_schema_dict(instance[key], sub, f"{path}.{key}"))
        addl = schema.get("additionalProperties", True)
        if addl is not True:
            for key in instance:
                if key in props:
                    continue
                if addl is False:
                    errors.append(f"{path}: additional_property_not_allowed:{key}")
                elif isinstance(addl, dict):
                    errors.extend(validate_schema_dict(instance[key], addl, f"{path}.{key}"))

    # array keywords
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: min_items {len(instance)}<{schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: max_items {len(instance)}>{schema['maxItems']}")
        items = schema.get("items")
        if isinstance(items, dict):
            for i, el in enumerate(instance):
                errors.extend(validate_schema_dict(el, items, f"{path}[{i}]"))
        elif isinstance(items, list):
            for i, (el, sub) in enumerate(zip(instance, items)):
                errors.extend(validate_schema_dict(el, sub, f"{path}[{i}]"))

    return errors


def validate_or_raise(instance: Any, schema: Any) -> None:
    """Raise ValueError with all errors joined by '; ' when instance is invalid."""
    errors = validate_schema_dict(instance, schema)
    if errors:
        raise ValueError("schema_validation_failed: " + "; ".join(errors))


__all__ = [
    "ROOT",
    "SCHEMAS_DIR",
    "canonical_json",
    "canonical_sha256",
    "load_enums",
    "load_schema",
    "is_blocked_host",
    "normalize_host",
    "to_cairo_time",
    "utc_now_iso",
    "cairo_now",
    "validate_schema_dict",
    "validate_or_raise",
]
