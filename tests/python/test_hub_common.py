"""hub_common.py unit tests (stdlib unittest only)."""
from __future__ import annotations

import sys
import unittest
from datetime import timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts import hub_common  # noqa: E402
from scripts.hub_common import (  # noqa: E402
    canonical_json,
    canonical_sha256,
    normalize_host,
    to_cairo_time,
    validate_schema_dict,
)

# ---------------------------------------------------------------------------
# المرجع الحاكم لـ Code.gs: هذه القيم محسوبة فعلياً بـ canonical_sha256 ويجب أن
# تُنتج canonicalJson_ في apps_script/Code.gs نفس البايتات ونفس الـ sha256.
# ---------------------------------------------------------------------------
FIXTURE_ARABIC = {
    "summary": "شات مجاني بدون تسجيل",
    "models_named": ["Claude Fable 5", "GPT-6 Astra"],
    "works_without_signup": True,
}
FIXTURE_NESTED = {"b": {"y": 2, "x": 1}, "a": [{"k": "v", "a": 1}, {"z": None}], "n": 10, "f": 1.5}
FIXTURE_ARRAY = [{"id": 2, "name": "ب"}, {"id": 1, "name": "أ"}]

EXPECTED_SHA_ARABIC = "dc0bafb4abcd51166f56ad4f1bb452d1a127409837b95884a90e73da5e32f83d"
EXPECTED_SHA_NESTED = "579c2706f0ebbbbcb9fd366700e4dba5c4a9b8efb115bd8b74690d74235dcb45"
EXPECTED_SHA_ARRAY = "ca9292b3baefb3363b0a6960d7fddfecfca98319a456a86682482a6ff685cdf9"


class TestCanonicalJson(unittest.TestCase):
    def test_recursive_sort_and_compact(self):
        obj = {"ب": 1, "أ": {"z": [3, 1, 2], "a": True}, "x": None}
        self.assertEqual(canonical_json(obj), '{"x":null,"أ":{"a":true,"z":[3,1,2]},"ب":1}')

    def test_sha_arabic(self):
        self.assertEqual(canonical_sha256(FIXTURE_ARABIC), EXPECTED_SHA_ARABIC)

    def test_sha_nested(self):
        self.assertEqual(canonical_sha256(FIXTURE_NESTED), EXPECTED_SHA_NESTED)

    def test_sha_array(self):
        self.assertEqual(canonical_sha256(FIXTURE_ARRAY), EXPECTED_SHA_ARRAY)

    def test_key_order_independent(self):
        a = {"b": 1, "a": 2}
        b = {"a": 2, "b": 1}
        self.assertEqual(canonical_sha256(a), canonical_sha256(b))


class TestNormalizeHost(unittest.TestCase):
    def test_cases(self):
        cases = [
            ("HTTPS://WWW.OpenRouter.AI:443/path?x=1", "openrouter.ai"),
            ("openrouter", ""),
            ("127.0.0.1", ""),
            ("localhost:8080", ""),
            ("https://bit.ly/abc", ""),
            ("gist.github.com/x", ""),
            ("chat.deepseek.com", "chat.deepseek.com"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_host(raw), expected)

    def test_never_raises_on_non_string(self):
        self.assertEqual(normalize_host(None), "")  # type: ignore[arg-type]
        self.assertEqual(normalize_host(123), "")  # type: ignore[arg-type]


class TestCairoTime(unittest.TestCase):
    def test_conversions(self):
        cases = [
            ("2026-11-24T23:44:00Z", "2026-11-25 01:44 ص"),
            ("2026-11-25T12:30:00Z", "2026-11-25 02:30 م"),
            ("2026-11-25T10:00:00+00:00", "2026-11-25 12:00 م"),
            ("2026-11-25T22:05:00Z", "2026-11-26 12:05 ص"),
        ]
        for iso, expected in cases:
            with self.subTest(iso=iso):
                self.assertEqual(to_cairo_time(iso), expected)

    def test_fallback_when_zoneinfo_unavailable(self):
        # _cairo_tz falls back to fixed UTC+2 when zoneinfo raises; result must be identical.
        with mock.patch.object(
            hub_common, "_cairo_tz", return_value=timezone(timedelta(hours=2), "Africa/Cairo")
        ):
            self.assertEqual(to_cairo_time("2026-11-24T23:44:00Z"), "2026-11-25 01:44 ص")
            self.assertEqual(to_cairo_time("2026-11-25T22:05:00Z"), "2026-11-26 12:05 ص")

    def test_fallback_path_inside_cairo_tz_itself(self):
        # Force zoneinfo.ZoneInfo to raise so the except-branch of _cairo_tz is executed.
        import zoneinfo

        with mock.patch.object(zoneinfo, "ZoneInfo", side_effect=Exception("no tzdata")):
            tz = hub_common._cairo_tz()
            self.assertEqual(tz.utcoffset(None), timedelta(hours=2))
            self.assertEqual(to_cairo_time("2026-11-25T12:30:00Z"), "2026-11-25 02:30 م")


class TestValidateSchemaDict(unittest.TestCase):
    def test_type_mismatch(self):
        errors = validate_schema_dict("x", {"type": "integer"})
        self.assertTrue(any("type_mismatch" in e for e in errors))

    def test_missing_required(self):
        errors = validate_schema_dict({}, {"type": "object", "required": ["a"]})
        self.assertIn("$: missing_required:a", errors)

    def test_additional_properties(self):
        schema = {"type": "object", "properties": {"a": {}}, "additionalProperties": False}
        errors = validate_schema_dict({"a": 1, "b": 2}, schema)
        self.assertTrue(any("additional_property_not_allowed:b" in e for e in errors))

    def test_enum(self):
        errors = validate_schema_dict("c", {"enum": ["a", "b"]})
        self.assertTrue(any("enum_mismatch" in e for e in errors))
        self.assertEqual(validate_schema_dict("a", {"enum": ["a", "b"]}), [])

    def test_pattern(self):
        errors = validate_schema_dict("http://x", {"type": "string", "pattern": "^https://"})
        self.assertTrue(any("pattern_mismatch" in e for e in errors))

    def test_min_items(self):
        errors = validate_schema_dict([], {"type": "array", "minItems": 1})
        self.assertTrue(any("min_items" in e for e in errors))

    def test_bool_is_not_integer(self):
        errors = validate_schema_dict(True, {"type": "integer"})
        self.assertTrue(any("type_mismatch" in e for e in errors))
        self.assertEqual(validate_schema_dict(1, {"type": "integer"}), [])

    def test_bool_is_not_enum_integer(self):
        self.assertTrue(validate_schema_dict(True, {"enum": [1]}))


if __name__ == "__main__":
    unittest.main()
