"""The shared cache is written atomically, and a broken entry is fetched again, never fatal.

2026-10-10: one dc-metro shard read an EPT hierarchy file another shard was still writing — empty —
and died on `json.loads`, failing a 25-shard bake. Plain unittest (the image's CI runs no pytest).
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import lidar, write_atomic  # noqa: E402


class WriteAtomicTest(unittest.TestCase):
    def test_writes_text_and_bytes_and_leaves_no_temp(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sub" / "a.json"
            write_atomic(p, '{"a": 1}')
            self.assertEqual(json.loads(p.read_text()), {"a": 1})
            write_atomic(p, b'{"a": 2}')
            self.assertEqual(json.loads(p.read_text()), {"a": 2})
            self.assertEqual([x.name for x in p.parent.iterdir()], ["a.json"])

    def test_a_reader_never_sees_a_partial_document(self):
        big = json.dumps({"k": "x" * 2_000_000})
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "h.json"
            write_atomic(p, big)
            stop = threading.Event()
            bad = []

            def writer():
                while not stop.is_set():
                    write_atomic(p, big)

            t = threading.Thread(target=writer)
            t.start()
            try:
                for _ in range(300):
                    try:
                        json.loads(p.read_text())
                    except ValueError:
                        bad.append(1)
            finally:
                stop.set()
                t.join()
            self.assertEqual(bad, [], f"{len(bad)} reads saw a half-written file")


class GetJsonTest(unittest.TestCase):
    def test_a_cached_file_that_does_not_parse_is_fetched_again(self):
        with tempfile.TemporaryDirectory() as d:
            hit = Path(d) / "ept" / "h" / "0-0-0-0.json"
            hit.parent.mkdir(parents=True)
            hit.write_text("")  # what a reader saw mid-write before the fix
            resp = mock.Mock(content=b'{"0-0-0-0": 12}')
            resp.json.return_value = {"0-0-0-0": 12}
            resp.raise_for_status.return_value = None
            with mock.patch.object(lidar.session, "get", return_value=resp) as get:
                self.assertEqual(lidar._get_json("http://x/ept-hierarchy/0-0-0-0.json", hit), {"0-0-0-0": 12})
            get.assert_called_once()
            self.assertEqual(json.loads(hit.read_text()), {"0-0-0-0": 12})

    def test_a_good_cached_file_is_not_fetched(self):
        with tempfile.TemporaryDirectory() as d:
            hit = Path(d) / "h.json"
            hit.write_text('{"a": 1}')
            with mock.patch.object(lidar.session, "get") as get:
                self.assertEqual(lidar._get_json("http://x", hit), {"a": 1})
            get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
