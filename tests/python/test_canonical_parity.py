import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import hub_common  # noqa: E402

FIXTURES_DIR = ROOT / "tests" / "fixtures" / "pieces" / "valid" / "pieces"


def eval_js_canonical_batch(items: list) -> list[dict]:
    """Run real apps_script/Code.gs inside gas_mocks via Node subprocess for canonical/SHA parity."""
    js_driver = r"""
const fs = require('node:fs');
const path = require('node:path');
const { createGasEnv } = require(process.argv[1]);
const codePath = process.argv[2];
const items = JSON.parse(fs.readFileSync(0, 'utf8'));
const env = createGasEnv();
env.loadGasScripts(codePath);
const results = items.map((obj) => {
  const canon = env.run('canonicalJson_', obj);
  const sha = env.run('sha256Hex_', canon);
  return { canon, sha };
});
process.stdout.write(JSON.stringify(results));
"""
    proc = subprocess.run(
        [
            "node",
            "-e",
            js_driver,
            str(ROOT / "tests" / "node" / "mocks" / "gas_mocks.js"),
            str(ROOT / "apps_script" / "Code.gs"),
        ],
        input=json.dumps(items, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
        timeout=30,
    )
    return json.loads(proc.stdout)


class TestCanonicalParity(unittest.TestCase):
    def test_tricky_fixtures_byte_and_sha_parity(self):
        cases = [
            {},
            [],
            {"a": 1, "b": "hello"},
            {"أ": 1, "ب": "مرحبا 🚀", "a": True},
            # Codepoint ordering: 0xE000 < 0xFFFD < 0x1F680 (UTF-16 alone gets surrogate pairs wrong!)
            {"\U0001F680": "rocket", "\uFFFD": "replacement", "\uE000": "private", "a": "ascii"},
            {"\U0001F9E9": "puzzle", "\uFFFF": "ffff", "\U00010000": "linear_b"},
            {"z": [{"b": 2, "a": 1}, {"d": [None, False, True, 0, -1.5, 42]}], "a": {"y": 2, "x": 1}},
            {"quotes": 'a"b\\c\nd\te', "slash": "https://example.ai/a/b?x=1&y=2"},
            {"nested_empty": {"arr": [{}, []], "empty_str": ""}},
            {"unicode_rtl_ltr": "مجاني 🆓 Free Tier — 100/day"},
        ]

        js_out = eval_js_canonical_batch(cases)
        self.assertEqual(len(js_out), len(cases))

        for idx, (obj, js_item) in enumerate(zip(cases, js_out)):
            with self.subTest(case=idx):
                py_canon = hub_common.canonical_json(obj)
                py_sha = hub_common.canonical_sha256(obj)
                self.assertEqual(js_item["canon"], py_canon)
                self.assertEqual(js_item["sha"], py_sha)

    def test_real_piece_fixtures_parity(self):
        piece_files = sorted(FIXTURES_DIR.rglob("*.json"))[:6]
        self.assertGreaterEqual(len(piece_files), 1)
        pieces = [json.loads(p.read_text(encoding="utf-8")) for p in piece_files]
        js_out = eval_js_canonical_batch(pieces)
        for pfile, obj, js_item in zip(piece_files, pieces, js_out):
            with self.subTest(file=pfile.name):
                self.assertEqual(js_item["canon"], hub_common.canonical_json(obj))
                self.assertEqual(js_item["sha"], hub_common.canonical_sha256(obj))

    def test_codepoint_key_order_explicit_vs_utf16(self):
        # Verify Code.gs output actually places \uFFFD BEFORE \U0001F680
        obj = {"\U0001F680": 2, "\uFFFD": 1}
        py_canon = hub_common.canonical_json(obj)
        js_canon = eval_js_canonical_batch([obj])[0]["canon"]
        self.assertEqual(py_canon, js_canon)
        self.assertTrue(js_canon.index("\uFFFD") < js_canon.index("\U0001F680"))


if __name__ == "__main__":
    unittest.main()
