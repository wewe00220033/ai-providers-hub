"""Schema loading + structural validation tests (stdlib unittest only)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.hub_common import load_schema, load_enums, validate_schema_dict  # noqa: E402

SCHEMAS_DIR = ROOT / "schemas"
DRAFT07 = "http://json-schema.org/draft-07/schema#"

VALID_PIECE = {
    "schema_version": 1,
    "piece_id": "pc_01HZXK3M9PQR7T2V4W6Y8A0BCD",
    "provider": {
        "provider_id": "prov_9aafff29",
        "canonical_host": "chat.deepseek.com",
        "display_name": "DeepSeek",
    },
    "agent": {"agent_id": "ag_test", "display_name": "Test Agent", "source_kind": "sheet"},
    "piece_type": "guest_chat",
    "model_tag": "Claude Fable 5",
    "channels": ["Chat"],
    "summary": "شات مجاني بدون تسجيل متاح للجميع",
    "payload": {
        "works_without_signup": True,
        "mode": "instant",
        "models_named": ["Claude Fable 5"],
        "none_found": False,
    },
    "evidence": {
        "url": "https://chat.deepseek.com/",
        "excerpt": "Try it now without an account",
        "captured_at_utc": "2026-11-24T23:44:00Z",
    },
    "confidence": "observed",
    "origin": "sheet",
    "created_at_utc": "2026-11-24T23:44:00Z",
}

VALID_REVIEW = {
    "schema_version": 1,
    "review_id": "rv_01HZXK3M9PQR7T2V4W6Y8A0BCD",
    "piece_id": "pc_01HZXK3M9PQR7T2V4W6Y8A0BCD",
    "provider_id": "prov_9aafff29",
    "canonical_host": "chat.deepseek.com",
    "action": "flag",
    "status": "needs_reverify",
    "severity": "minor",
    "blind_hint": "model list looks outdated",
    "flagged_agent_id": "ag_test",
    "created_at_utc": "2026-11-24T23:44:00Z",
}


class TestSchemaFilesLoad(unittest.TestCase):
    def _all_schema_files(self):
        files = sorted(SCHEMAS_DIR.rglob("*.json"))
        self.assertTrue(files, "no schema files found")
        return files

    def test_all_json_files_parse(self):
        for p in self._all_schema_files():
            with self.subTest(file=p.name):
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                self.assertIsInstance(data, dict)

    def test_non_enum_schemas_are_draft07_objects(self):
        for p in self._all_schema_files():
            if p.name == "enums.json":
                continue
            with self.subTest(file=p.name):
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                self.assertEqual(data.get("$schema"), DRAFT07)
                self.assertEqual(data.get("type"), "object")

    def test_expected_type_schemas_exist(self):
        for name in [
            "identity", "guest_chat", "signup_delta", "free_tier", "auth_flow",
            "paid_pricing", "referrals", "not_found", "_generic",
        ]:
            with self.subTest(name=name):
                self.assertIsInstance(load_schema(f"types/{name}"), dict)


class TestEnums(unittest.TestCase):
    def test_models_full_exact(self):
        enums = load_enums()
        self.assertEqual(
            enums["models_full"],
            [
                "Claude Fable 5", "Claude Fable 5.1", "Claude Fable 5.2",
                "Claude Opus 5.5",
                "Claude Mythos 5", "Claude Mythos 5.1", "Claude Mythos 5.2",
                "GPT-6 Astra", "GPT-6.2 Astra",
            ],
        )

    def test_model_families_compact(self):
        fam = load_enums()["model_families"]
        self.assertEqual(len(fam), 4)
        self.assertEqual(fam["Claude Fable"]["compact"], "Fable 5 / 5.1 / 5.2")
        self.assertEqual(fam["Claude Opus"]["compact"], "Opus 5.5")
        self.assertEqual(fam["Claude Mythos"]["compact"], "Mythos 5 / 5.1 / 5.2")
        self.assertEqual(fam["GPT Astra"]["compact"], "Astra 6 / 6.2")
        members = [m for f in fam.values() for m in f["members"]]
        self.assertEqual(sorted(members), sorted(load_enums()["models_full"]))

    def test_channels_order(self):
        self.assertEqual(load_enums()["channels"], ["Chat", "Browser", "API", "CLI", "IDE", "Desktop"])


class TestPieceBase(unittest.TestCase):
    def test_valid_piece_passes(self):
        self.assertEqual(validate_schema_dict(VALID_PIECE, load_schema("piece.base")), [])

    def test_non_ulid_piece_id_fails(self):
        bad = dict(VALID_PIECE, piece_id="pc_not-a-ulid")
        errors = validate_schema_dict(bad, load_schema("piece.base"))
        self.assertTrue(errors)
        self.assertTrue(any("piece_id" in e for e in errors))


class TestReviewEvent(unittest.TestCase):
    def test_valid_review_passes(self):
        self.assertEqual(validate_schema_dict(VALID_REVIEW, load_schema("review_event")), [])

    def test_owner_correction_rejected(self):
        bad = dict(VALID_REVIEW, owner_correction="private note")
        errors = validate_schema_dict(bad, load_schema("review_event"))
        self.assertTrue(errors)
        self.assertTrue(any("owner_correction" in e for e in errors))


class TestTypePayloads(unittest.TestCase):
    def test_guest_chat_valid(self):
        self.assertEqual(validate_schema_dict(VALID_PIECE["payload"], load_schema("types/guest_chat")), [])

    def test_guest_chat_bad_mode_fails(self):
        bad = dict(VALID_PIECE["payload"], mode="turbo")
        self.assertTrue(validate_schema_dict(bad, load_schema("types/guest_chat")))

    def test_free_tier_valid(self):
        payload = {
            "exists": True,
            "includes_target_models": True,
            "models_named": ["GPT-6 Astra"],
            "free_models_other": [],
            "free_credits_or_quota": "50 messages/day",
            "requires_card": False,
            "auto_charges_after_trial": None,
            "none_found": False,
        }
        self.assertEqual(validate_schema_dict(payload, load_schema("types/free_tier")), [])

    def test_auth_flow_valid(self):
        payload = {
            "flow": "signup",
            "methods": ["email_otp", "oauth"],
            "oauth_providers": ["google", "github"],
            "captcha": {"detected": True, "type": "turnstile"},
        }
        self.assertEqual(validate_schema_dict(payload, load_schema("types/auth_flow")), [])

    def test_auth_flow_empty_methods_fails(self):
        payload = {"flow": "login", "methods": [], "captcha": {"detected": False, "type": "none"}}
        self.assertTrue(validate_schema_dict(payload, load_schema("types/auth_flow")))

    def test_not_found_valid(self):
        payload = {
            "checked_pages": ["https://example-provider.ai/pricing"],
            "checked_at_utc": "2026-11-24T23:44:00Z",
            "reason": "no target models listed",
        }
        self.assertEqual(validate_schema_dict(payload, load_schema("types/not_found")), [])

    def test_not_found_requires_https_and_pages(self):
        bad = {"checked_pages": [], "checked_at_utc": "2026-11-24T23:44:00Z"}
        self.assertTrue(validate_schema_dict(bad, load_schema("types/not_found")))
        bad2 = {"checked_pages": ["http://x.ai"], "checked_at_utc": "2026-11-24T23:44:00Z"}
        self.assertTrue(validate_schema_dict(bad2, load_schema("types/not_found")))


if __name__ == "__main__":
    unittest.main()
