"""Tests for scripts/build_catalog.py (stdlib unittest only)."""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts import build_catalog as bc  # noqa: E402
from scripts.hub_common import to_cairo_time  # noqa: E402

FX = ROOT / "tests" / "fixtures"
VALID_PIECES = FX / "pieces" / "valid" / "pieces"
U = "01HZXK3M9PQR7T2V4W6Y8A0B"


def _make_repo(tmp: Path) -> Path:
    """valid fixtures + one flag review (guest_chat pc_...02) + a conflicting guest_chat from ag_beta."""
    shutil.copytree(VALID_PIECES, tmp / "pieces")
    (tmp / "reviews").mkdir()
    shutil.copy(FX / "reviews" / "valid" / "reviews" / f"rv_{U}D1.json", tmp / "reviews" / f"rv_{U}D1.json")
    src = tmp / "pieces" / "chat.deepseek.com" / f"ag_alpha_pc_{U}02.json"
    with open(src, encoding="utf-8") as fh:
        guest = json.load(fh)
    other = deepcopy(guest)
    other["piece_id"] = f"pc_{U}E1"
    other["agent"] = {"agent_id": "ag_beta", "display_name": "Beta", "source_kind": "github"}
    other["payload"]["mode"] = "fast"
    other["payload"]["models_named"] = ["Claude Fable 5.2"]
    other["created_at_utc"] = "2026-11-25T00:05:00Z"
    other["summary"] = "بيتا: شات ضيف بوضع سريع </script> <!-- x"
    with open(tmp / "pieces" / "chat.deepseek.com" / f"ag_beta_pc_{U}E1.json", "w", encoding="utf-8") as fh:
        json.dump(other, fh, ensure_ascii=False)
    return tmp


def _card(md: str, heading_prefix: str) -> str:
    start = md.index(heading_prefix)
    nxt = md.find("\n## ", start + 1)
    return md[start:] if nxt < 0 else md[start:nxt]


class TestBuildCatalog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.repo = _make_repo(Path(cls._tmp.name))
        cls.md, cls.html, cls.providers, cls.generated_at = bc.build(cls.repo)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_deterministic_bytes(self):
        md2, html2, _, gen2 = bc.build(self.repo)
        self.assertEqual(self.md.encode("utf-8"), md2.encode("utf-8"))
        self.assertEqual(self.html.encode("utf-8"), html2.encode("utf-8"))
        self.assertEqual(self.generated_at, gen2)

    def test_generated_at_is_max_created_not_now(self):
        self.assertEqual(self.generated_at, "2026-11-25T00:10:00Z")  # the review is the latest stamp
        self.assertIn(f"آخر تحديث: {to_cairo_time('2026-11-25T00:10:00Z')}", self.md)

    def test_generated_at_deterministic_when_empty(self):
        self.assertEqual(bc.compute_generated_at([], []), "1970-01-01T00:00:00Z")
        md = bc.render_markdown([], "1970-01-01T00:00:00Z")
        self.assertIn("آخر تحديث: 1970-01-01 02:00 ص", md)
        with tempfile.TemporaryDirectory() as tmp:
            a = bc.build(tmp)
            b = bc.build(tmp)
            self.assertEqual(a[0], b[0])
            self.assertEqual(a[3], "1970-01-01T00:00:00Z")

    def test_needs_reverify_in_status_and_card(self):
        card = _card(self.md, "## DeepSeek (chat.deepseek.com)")
        heading = card.splitlines()[0]
        self.assertIn("🔁 يحتاج إعادة فحص", heading)
        body = "\n".join(card.splitlines()[1:])
        self.assertIn("🔁 يحتاج إعادة فحص", body)
        deepseek = next(p for p in self.providers if p["host"] == "chat.deepseek.com")
        self.assertTrue(deepseek["reverify"])
        self.assertEqual(deepseek["status_key"], "needs_reverify")

    def test_conflict_marker_with_both_agents(self):
        card = _card(self.md, "## DeepSeek (chat.deepseek.com)")
        line = next(ln for ln in card.splitlines() if ln.startswith("🆓 بدون تسجيل:"))
        self.assertIn("⚠️ تعارض: Alpha vs Beta", line)
        self.assertIn("— Alpha ·", card)
        self.assertIn("— Beta ·", card)

    def test_usage_url_first_line_after_heading(self):
        lines = self.md.splitlines()
        headings = [i for i, ln in enumerate(lines) if ln.startswith("## ")]
        self.assertGreaterEqual(len(headings), 2)
        for i in headings:
            self.assertTrue(lines[i + 1].startswith("🔗 الاستخدام: https://"), lines[i + 1])

    def test_no_markdown_tables(self):
        for ln in self.md.splitlines():
            self.assertIsNone(re.match(r"^\|", ln), ln)

    def test_model_compression(self):
        self.assertIn("Fable 5 / 5.2", self.md)
        self.assertNotIn("Fable 5 / Fable", self.md)
        groups, others = bc.compress_models(["Claude Fable 5", "Claude Fable 5.2", "GPT-6 Astra", "DeepSeek-V4"])
        self.assertEqual(groups, ["Fable 5 / 5.2", "Astra 6"])
        self.assertEqual(others, ["DeepSeek-V4"])
        self.assertEqual(bc.compress_models([]), ([], []))

    def test_empty_section_absent(self):
        openrouter = _card(self.md, "## OpenRouter (openrouter.ai)")
        self.assertNotIn("💳 المدفوع", openrouter)
        self.assertNotIn("🆓 بدون تسجيل", openrouter)
        self.assertIn("🚫 دليل سلبي:", openrouter)
        self.assertNotIn("غير متوفر", self.md)
        heading = openrouter.splitlines()[0]
        self.assertIn("🚫 دليل سلبي", heading)

    def test_section_order(self):
        card = _card(self.md, "## DeepSeek (chat.deepseek.com)")
        order = ["🆓 بدون تسجيل:", "🎁 الباقة المجانية:", "📈 بعد التسجيل:", "🔐 التسجيل والدخول:", "💳 المدفوع:", "🤝 الإحالات:"]
        idx = [card.index(t) for t in order]
        self.assertEqual(idx, sorted(idx))

    def test_html_safety(self):
        self.assertIn('dir="rtl"', self.html)
        self.assertIn('lang="ar"', self.html)
        self.assertIn('id="hub-data"', self.html)
        self.assertNotIn("innerHTML", self.html)
        self.assertNotIn("http://", self.html)
        self.assertNotIn("https://cdn", self.html)
        self.assertNotIn("<link", self.html)
        start = self.html.index('id="hub-data">') + len('id="hub-data">')
        end = self.html.index("</script>", start)
        block = self.html[start:end]
        self.assertNotIn("</", block)
        self.assertNotIn("<!--", block)
        data = json.loads(block)
        self.assertEqual(len(data["providers"]), 2)
        self.assertEqual(len(data["models"]), 9)

    def test_safe_json_roundtrip(self):
        s = bc.safe_json_for_script({"a": "</script><!--x"})
        self.assertNotIn("</", s)
        self.assertNotIn("<!--", s)
        self.assertEqual(json.loads(s), {"a": "</script><!--x"})

    def test_apply_reviews_latest_wins(self):
        pieces = [{"piece_id": "pc_1", "created_at_utc": "2026-01-01T00:00:00Z"}]
        reviews = [
            {"review_id": "rv_b", "piece_id": "pc_1", "action": "resolve", "created_at_utc": "2026-01-02T00:00:00Z"},
            {"review_id": "rv_a", "piece_id": "pc_1", "action": "flag", "created_at_utc": "2026-01-02T00:00:00Z"},
        ]
        self.assertEqual(bc.apply_reviews(pieces, reviews)[0]["review_status"], "resolved")
        reviews[1]["created_at_utc"] = "2026-01-03T00:00:00Z"
        self.assertEqual(bc.apply_reviews(pieces, reviews)[0]["review_status"], "needs_reverify")

    def test_main_writes_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_md = Path(tmp) / "CATALOG.md"
            out_html = Path(tmp) / "docs" / "index.html"
            rc = bc.main(["--repo", str(self.repo), "--out-md", str(out_md), "--out-html", str(out_html)])
            self.assertEqual(rc, 0)
            self.assertEqual(out_md.read_bytes(), self.md.encode("utf-8"))
            self.assertEqual(out_html.read_bytes(), self.html.encode("utf-8"))
            self.assertNotIn(b"\xef\xbb\xbf", out_md.read_bytes()[:3])


if __name__ == "__main__":
    unittest.main()
