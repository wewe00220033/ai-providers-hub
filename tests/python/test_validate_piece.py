"""Tests for scripts/validate_piece.py (stdlib unittest only).

Fixture layout (path rule: pieces/<host>/<agent_id>_<piece_id>.json, reviews/<review_id>.json):
  tests/fixtures/pieces/valid/pieces/<host>/...    -> repo_root = tests/fixtures/pieces/valid
  tests/fixtures/pieces/invalid/pieces/<host>/...  -> repo_root = tests/fixtures/pieces/invalid
  tests/fixtures/reviews/{valid,invalid}/reviews/<review_id>.json
  tests/fixtures/diffs/{ok,modified,out_of_scope}.txt
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts import validate_piece as vp  # noqa: E402

FX = ROOT / "tests" / "fixtures"
VALID = FX / "pieces" / "valid"
INVALID = FX / "pieces" / "invalid"
RV_VALID = FX / "reviews" / "valid"
RV_INVALID = FX / "reviews" / "invalid"
DIFFS = FX / "diffs"
U = "01HZXK3M9PQR7T2V4W6Y8A0B"

# Codes without a static fixture (tested elsewhere): path_content_mismatch, invalid_json,
# duplicate_piece_id, duplicate_review_id, and symlink_forbidden (tempfile + os.symlink test).
INVALID_EXPECTATIONS = {
    "C1": "schema_violation",
    "C2": "payload_schema_violation",
    "C3": "invalid_canonical_host",
    "C4": "blocked_host",
    "C5": "evidence_not_https",
    "C6": "evidence_host_mismatch",
    "C7": "evidence_excerpt_length",
    "C8": "suspicious_path_segment",
    "C9": "double_slash_in_path",
    "CA": "repeated_path_segment",
    "CB": "tracking_params_present",
    "CC": "free_claim_unsupported",
    "CD": "free_claim_contradiction",
    "CE": "target_model_not_named",
    "CF": "target_model_not_in_evidence",
    "CG": "captcha_type_inconsistent",
    "CH": "probe_result_invalid",
    "CJ": "checked_page_host_mismatch",
}


def codes(errors):
    return {vp.error_code(e) for e in errors}


def repo_codes(lines):
    return {vp.error_code(line.split(" ", 1)[1]) for line in lines}


def _find(base: Path, suffix: str) -> Path:
    matches = list(base.rglob(f"*pc_{U}{suffix}.json"))
    assert len(matches) == 1, (suffix, matches)
    return matches[0]


class TestValidPieces(unittest.TestCase):
    def test_each_valid_fixture_passes(self):
        files = sorted((VALID / "pieces").rglob("*.json"))
        self.assertGreaterEqual(len(files), 6)
        for f in files:
            with self.subTest(file=f.name):
                self.assertEqual(vp.validate_piece_file(f, VALID), [])

    def test_valid_repo_has_no_errors(self):
        self.assertEqual(vp.validate_repo(VALID), [])

    def test_valid_fixture_covers_each_known_type(self):
        types = set()
        for f in (VALID / "pieces").rglob("*.json"):
            with open(f, encoding="utf-8") as fh:
                types.add(json.load(fh)["piece_type"])
        for t in ("identity", "guest_chat", "free_tier", "auth_flow", "not_found", "paid_pricing"):
            self.assertIn(t, types)


class TestInvalidPieces(unittest.TestCase):
    def test_each_error_code_has_a_fixture(self):
        for suffix, code in INVALID_EXPECTATIONS.items():
            with self.subTest(code=code):
                self.assertIn(code, codes(vp.validate_piece_file(_find(INVALID, suffix), INVALID)))

    def test_path_content_mismatch(self):
        f = INVALID / "pieces" / "chat.deepseek.com" / "ag_alpha_wrong.json"
        self.assertIn("path_content_mismatch", codes(vp.validate_piece_file(f, INVALID)))

    def test_invalid_json(self):
        f = INVALID / "pieces" / "chat.deepseek.com" / "broken.json"
        self.assertEqual(codes(vp.validate_piece_file(f, INVALID)), {"invalid_json"})

    def test_invalid_repo_reports_every_code(self):
        found = repo_codes(vp.validate_repo(INVALID))
        expected = set(INVALID_EXPECTATIONS.values()) | {"path_content_mismatch", "invalid_json"}
        self.assertTrue(expected <= found, expected - found)

    def test_non_dict_piece(self):
        self.assertIn("schema_violation", codes(vp.validate_piece_obj([1, 2])))

    def test_alias_host_accepted_via_known_aliases(self):
        with open(_find(VALID, "02"), encoding="utf-8") as fh:
            piece = json.load(fh)
        piece["evidence"]["url"] = "https://deepseek.com/pricing"
        self.assertIn("evidence_host_mismatch", codes(vp.validate_piece_obj(piece)))
        self.assertNotIn(
            "evidence_host_mismatch",
            codes(vp.validate_piece_obj(piece, known_aliases={"deepseek.com": "prov_9aafff29"})),
        )


class TestReviews(unittest.TestCase):
    def test_valid_reviews_pass(self):
        files = sorted((RV_VALID / "reviews").rglob("*.json"))
        self.assertGreaterEqual(len(files), 2)
        for f in files:
            with self.subTest(file=f.name):
                self.assertEqual(vp.validate_piece_file(f, RV_VALID), [])
        self.assertEqual(vp.validate_repo(RV_VALID), [])

    def test_owner_correction_forbidden(self):
        f = RV_INVALID / "reviews" / f"rv_{U}D3.json"
        self.assertIn("owner_correction_forbidden", codes(vp.validate_piece_file(f, RV_INVALID)))

    def test_review_schema_violation(self):
        f = RV_INVALID / "reviews" / f"rv_{U}D4.json"
        self.assertIn("review_schema_violation", codes(vp.validate_piece_file(f, RV_INVALID)))

    def test_review_path_mismatch(self):
        with open(RV_VALID / "reviews" / f"rv_{U}D1.json", encoding="utf-8") as fh:
            review = json.load(fh)
        self.assertIn("path_content_mismatch", codes(vp.validate_review_obj(review, "reviews/other.json")))
        self.assertEqual(vp.validate_review_obj(review, f"reviews/rv_{U}D1.json"), [])


class TestDiff(unittest.TestCase):
    def _read(self, name):
        with open(DIFFS / name, encoding="utf-8") as fh:
            return fh.read()

    def test_ok(self):
        self.assertEqual(vp.check_diff(self._read("ok.txt")), [])

    def test_modified(self):
        errs = vp.check_diff(self._read("modified.txt"))
        self.assertEqual(len(errs), 3)
        self.assertEqual(repo_codes(errs), {"modify_or_delete_forbidden"})

    def test_out_of_scope(self):
        errs = vp.check_diff(self._read("out_of_scope.txt"))
        self.assertEqual(len(errs), 2)
        self.assertEqual(repo_codes(errs), {"out_of_scope_path"})

    def test_parse_error(self):
        self.assertEqual(repo_codes(vp.check_diff("XYZ garbage line\n")), {"diff_parse_error"})


class TestDuplicates(unittest.TestCase):
    def test_duplicate_piece_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            src = _find(VALID, "02")
            dst_dir = repo / "pieces" / "chat.deepseek.com"
            dst_dir.mkdir(parents=True)
            shutil.copy(src, dst_dir / src.name)
            shutil.copy(src, dst_dir / f"ag_beta_pc_{U}02.json")
            errs = vp.validate_repo(repo)
            self.assertIn("duplicate_piece_id", repo_codes(errs))
            self.assertEqual(sum(1 for e in errs if "duplicate_piece_id" in e), 2)

    def test_symlink_forbidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            src = _find(VALID, "02")
            dst_dir = repo / "pieces" / "chat.deepseek.com"
            dst_dir.mkdir(parents=True)
            target = dst_dir / src.name
            shutil.copy(src, target)
            link = dst_dir / f"ag_beta_pc_{U}02.json"
            try:
                os.symlink(target, link)
            except (OSError, NotImplementedError):
                self.skipTest("symlink not permitted")
            errs = vp.validate_repo(repo)
            self.assertIn("symlink_forbidden", repo_codes(errs))
            self.assertTrue(any(e.startswith(f"pieces/chat.deepseek.com/{link.name} symlink_forbidden") for e in errs), errs)
            self.assertEqual(vp.validate_piece_file(target, repo), [])

    def test_symlink_forbidden_mocked(self):
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            src = _find(VALID, "02")
            dst_dir = repo / "pieces" / "chat.deepseek.com"
            dst_dir.mkdir(parents=True)
            real_file = dst_dir / src.name
            shutil.copy(src, real_file)
            fake_link = dst_dir / f"ag_beta_pc_{U}02.json"
            shutil.copy(src, fake_link)

            orig_is_symlink = Path.is_symlink

            def fake_is_symlink(p):
                if p.name == fake_link.name:
                    return True
                return orig_is_symlink(p)

            with mock.patch.object(Path, "is_symlink", fake_is_symlink):
                errs = vp.validate_repo(repo)
            self.assertIn("symlink_forbidden", repo_codes(errs))
            self.assertTrue(
                any(e.startswith(f"pieces/chat.deepseek.com/{fake_link.name} symlink_forbidden") for e in errs),
                errs,
            )

    def test_duplicate_review_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            src = RV_VALID / "reviews" / f"rv_{U}D1.json"
            (repo / "reviews").mkdir()
            shutil.copy(src, repo / "reviews" / src.name)
            shutil.copy(src, repo / "reviews" / "copy.json")
            self.assertIn("duplicate_review_id", repo_codes(vp.validate_repo(repo)))


class TestMain(unittest.TestCase):
    def _run(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = vp.main(argv)
        return rc, buf.getvalue()

    def test_exit_0(self):
        rc, out = self._run(["--repo", str(VALID)])
        self.assertEqual(rc, 0)
        self.assertIn("VALIDATION: 0 errors", out)

    def test_exit_1(self):
        rc, out = self._run(["--repo", str(INVALID)])
        self.assertEqual(rc, 1)
        self.assertIn("ERROR pieces/", out)
        self.assertNotIn("VALIDATION: 0 errors", out)

    def test_exit_2_missing_path(self):
        rc, _ = self._run(["--repo", str(VALID), "does_not_exist.json"])
        self.assertEqual(rc, 2)

    def test_exit_2_missing_diff(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, _ = self._run(["--repo", str(VALID), "--diff", str(Path(tmp) / "missing.txt")])
        self.assertEqual(rc, 2)

    def test_diff_modified_exit_1(self):
        rc, out = self._run(["--repo", str(VALID), "--diff", str(DIFFS / "modified.txt")])
        self.assertEqual(rc, 1)
        self.assertIn("modify_or_delete_forbidden", out)


if __name__ == "__main__":
    unittest.main()
