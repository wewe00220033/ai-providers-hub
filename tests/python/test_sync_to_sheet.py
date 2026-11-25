"""Tests for scripts/sync_to_sheet.py with a real local HTTP server (stdlib unittest only)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts import sync_to_sheet as sts  # noqa: E402

FX_PIECES = ROOT / "tests" / "fixtures" / "pieces" / "valid" / "pieces"
U = "01HZXK3M9PQR7T2V4W6Y8A0B"
TOKEN = "sync_secret_token_XYZ987"


class _Handler(BaseHTTPRequestHandler):
    """Scripted responder: ALWAYS HTTP 200 with a JSON body (Apps Script behaviour)."""

    def log_message(self, *args):  # silence
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {"_raw": raw.decode("utf-8", "replace")}
        self.server.received.append({"path": self.path, "body": body})
        if self.server.redirect and self.path != "/final":
            self.send_response(302)
            self.send_header("Location", "/final")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._reply(body)

    def do_GET(self):
        self.server.gets.append(self.path)
        self._reply({})

    def _reply(self, body):
        scripted = self.server.responses.pop(0) if self.server.responses else {"ok": False, "code": 500, "error": "script_exhausted"}
        if isinstance(scripted, str):
            data = scripted.encode("utf-8")
        else:
            scripted = dict(scripted)
            if self.server.echo_token and isinstance(body, dict) and "token" in body:
                scripted["echo_token"] = body["token"]
            data = json.dumps(scripted).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _Server(HTTPServer):
    def __init__(self, responses, redirect=False, echo_token=False):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.responses = list(responses)
        self.received = []
        self.gets = []
        self.redirect = redirect
        self.echo_token = echo_token

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}/"


@contextlib.contextmanager
def serve(responses, **kw):
    srv = _Server(responses, **kw)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        t.join(timeout=5)


def _make_repo(tmp: Path, github_suffixes) -> Path:
    """Copy valid fixtures; pieces whose id ends with one of github_suffixes get origin='github'."""
    shutil.copytree(FX_PIECES, tmp / "pieces")
    for f in (tmp / "pieces").rglob("*.json"):
        with open(f, encoding="utf-8") as fh:
            piece = json.load(fh)
        piece["origin"] = "github" if piece["piece_id"][-2:] in github_suffixes else "sheet"
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(piece, fh, ensure_ascii=False)
    return tmp


def _run_main(argv, sleep=None):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = sts.main(argv, sleep=sleep or (lambda s: None))
    return rc, buf.getvalue()


class TestSyncOne(unittest.TestCase):
    def setUp(self):
        self.piece = {"piece_id": f"pc_{U}02", "origin": "github", "payload": {"x": "ب"}}

    def test_429_twice_then_201_with_backoff(self):
        sleeps = []
        with serve([{"code": 429}, {"code": 429}, {"ok": True, "code": 201}]) as srv:
            resp = sts.sync_one(srv.url, TOKEN, "pieces/h/a_x.json", self.piece, sleep=sleeps.append)
            self.assertEqual(resp["code"], 201)
            self.assertEqual(sleeps, [2.0, 4.0])
            self.assertEqual(len(srv.received), 3)
            body = srv.received[0]["body"]
            self.assertEqual(body["token"], TOKEN)
            self.assertEqual(body["action"], "sync_from_github")
            self.assertEqual(body["origin"], "github")
            self.assertEqual(body["piece_id"], self.piece["piece_id"])
            self.assertEqual(body["path"], "pieces/h/a_x.json")
            self.assertEqual(body["piece"]["payload"]["x"], "ب")
            self.assertNotIn(TOKEN, srv.received[0]["path"])

    def test_429_exhausted_raises(self):
        sleeps = []
        with serve([{"code": 429}] * 6) as srv:
            with self.assertRaises(sts.SyncError):
                sts.sync_one(srv.url, TOKEN, "p.json", self.piece, sleep=sleeps.append, max_retries=4)
            self.assertEqual(sleeps, [2.0, 4.0, 8.0, 16.0])
            self.assertEqual(len(srv.received), 5)

    def test_422_raises(self):
        with serve([{"ok": False, "code": 422, "error": "evidence_host_mismatch"}]) as srv:
            with self.assertRaises(sts.SyncError) as cm:
                sts.sync_one(srv.url, TOKEN, "p.json", self.piece)
            self.assertIn("evidence_host_mismatch", str(cm.exception))

    def test_http_200_without_ok_true_is_failure(self):
        with serve([{"code": 201}]) as srv:
            with self.assertRaises(sts.SyncError):
                sts.sync_one(srv.url, TOKEN, "p.json", self.piece)
        with serve([{"ok": "true", "code": 201}]) as srv:
            with self.assertRaises(sts.SyncError):
                sts.sync_one(srv.url, TOKEN, "p.json", self.piece)

    def test_200_idempotent_is_success(self):
        with serve([{"ok": True, "code": 200, "idempotent": True}]) as srv:
            resp = sts.sync_one(srv.url, TOKEN, "p.json", self.piece)
            self.assertTrue(resp["idempotent"])

    def test_token_not_in_error_even_if_echoed(self):
        with serve([{"ok": False, "code": 403, "error": "role_not_allowed"}], echo_token=True) as srv:
            with self.assertRaises(sts.SyncError) as cm:
                sts.sync_one(srv.url, TOKEN, "p.json", self.piece)
            self.assertNotIn(TOKEN, str(cm.exception))
            self.assertIn("***", str(cm.exception))

    def test_non_json_response(self):
        with serve(["<html>Moved</html>"]) as srv:
            with self.assertRaises(sts.SyncError) as cm:
                sts.post_json(srv.url, {"a": 1})
            self.assertIn("non_json_response", str(cm.exception))

    def test_follows_302_redirect(self):
        with serve([{"ok": True, "code": 200}], redirect=True) as srv:
            resp = sts.post_json(srv.url, {"token": TOKEN, "action": "ping"})
            self.assertEqual(resp, {"ok": True, "code": 200})
            self.assertEqual(srv.gets, ["/final"])
            self.assertEqual(len(srv.received), 1)
        with serve([{"ok": True, "code": 201}], redirect=True) as srv:
            self.assertEqual(sts.sync_one(srv.url, TOKEN, "p.json", self.piece)["code"], 201)


class TestFindUnsynced(unittest.TestCase):
    def test_only_github_origin_and_not_synced(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), {"02", "03"})
            found = sts.find_unsynced(repo, {"synced": []})
            ids = sorted(p["piece_id"][-2:] for _, p in found)
            self.assertEqual(ids, ["02", "03"])
            self.assertTrue(all(rel.startswith("pieces/") for rel, _ in found))
            found2 = sts.find_unsynced(repo, {"synced": [f"pc_{U}02"]})
            self.assertEqual([p["piece_id"][-2:] for _, p in found2], ["03"])

    def test_sheet_origin_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), set())
            self.assertEqual(sts.find_unsynced(repo, {"synced": []}), [])


class TestMain(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("HUB_URL", None)
        os.environ.pop("HUB_SYNC_TOKEN", None)

    def tearDown(self):
        self._env.stop()

    def test_missing_token_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, out = _run_main(["--repo", tmp, "--hub-url", "http://127.0.0.1:1/"])
            self.assertEqual(rc, 2)
            self.assertIn("HUB_SYNC_TOKEN", out)

    def test_missing_url_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, _ = _run_main(["--repo", tmp, "--token", TOKEN])
            self.assertEqual(rc, 2)

    def test_success_records_then_rerun_no_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), {"02", "03"})
            state = repo / "docs" / ".synced_ids.json"
            with serve([{"ok": True, "code": 201}, {"ok": True, "code": 200, "idempotent": True}]) as srv:
                rc, out = _run_main(["--repo", str(repo), "--hub-url", srv.url, "--token", TOKEN, "--state", str(state)])
                self.assertEqual(rc, 0)
                self.assertEqual(len(srv.received), 2)
                self.assertNotIn(TOKEN, out)
                self.assertIn("idempotent", out)
                self.assertEqual(sts.load_state(state)["synced"], [f"pc_{U}02", f"pc_{U}03"])
                rc2, out2 = _run_main(["--repo", str(repo), "--hub-url", srv.url, "--token", TOKEN, "--state", str(state)])
                self.assertEqual(rc2, 0)
                self.assertEqual(len(srv.received), 2)
                self.assertIn("nothing to sync", out2)

    def test_422_exit_1_and_not_recorded(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), {"02"})
            state = repo / "docs" / ".synced_ids.json"
            with serve([{"ok": False, "code": 422, "error": "schema_violation"}], echo_token=True) as srv:
                rc, out = _run_main(["--repo", str(repo), "--hub-url", srv.url, "--token", TOKEN, "--state", str(state)])
            self.assertEqual(rc, 1)
            self.assertIn("SYNC_FAILED", out)
            self.assertIn("schema_violation", out)
            self.assertNotIn(TOKEN, out)
            self.assertEqual(sts.load_state(state)["synced"], [])

    def test_incremental_save_before_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), {"02", "03"})
            state = repo / "docs" / ".synced_ids.json"
            with serve([{"ok": True, "code": 201}, {"ok": False, "code": 422}]) as srv:
                rc, _ = _run_main(["--repo", str(repo), "--hub-url", srv.url, "--token", TOKEN, "--state", str(state)])
            self.assertEqual(rc, 1)
            self.assertEqual(sts.load_state(state)["synced"], [f"pc_{U}02"])

    def test_429_backoff_through_main(self):
        sleeps = []
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), {"02"})
            with serve([{"code": 429}, {"code": 429}, {"ok": True, "code": 201}]) as srv:
                rc, _ = _run_main(["--repo", str(repo), "--hub-url", srv.url, "--token", TOKEN], sleep=sleeps.append)
            self.assertEqual(rc, 0)
            self.assertEqual(sleeps, [2.0, 4.0])

    def test_env_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp), set())
            with mock.patch.dict(os.environ, {"HUB_URL": "http://127.0.0.1:1/", "HUB_SYNC_TOKEN": TOKEN}):
                rc, out = _run_main(["--repo", str(repo)])
            self.assertEqual(rc, 0)
            self.assertIn("nothing to sync", out)


class TestState(unittest.TestCase):
    def test_roundtrip_sorted_unique(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "docs" / ".synced_ids.json"
            self.assertEqual(sts.load_state(p), {"synced": []})
            sts.save_state(p, {"synced": ["b", "a", "b"]})
            self.assertEqual(sts.load_state(p), {"synced": ["a", "b"]})
            self.assertNotEqual(p.read_bytes()[:3], b"\xef\xbb\xbf")


if __name__ == "__main__":
    unittest.main()
