"""progress: a clock on every line, and a status line for the stages that used to go quiet.

dc-metro-take-2 sat for an unknown stretch in branch profiling with no output between "struct"
lines and "branch ... profiled" (Rich, 2026-10-05). These tests pin the two fixes without waiting
a minute: the timestamp stream prefixes each line, and `Progress` reports a count and an ETA that
can be read back synchronously.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import io
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import progress  # noqa: E402


class StampStreamTest(unittest.TestCase):
    def test_every_line_gets_one_utc_clock(self):
        raw = io.StringIO()
        s = progress._StampStream(raw)
        s.write("hello\n")
        s.write("wor")   # print() writes the text and the newline separately
        s.write("ld\n")
        out = raw.getvalue()
        self.assertRegex(out, r"^\[\d\d:\d\d:\d\dZ\] hello\n\[\d\d:\d\d:\d\dZ\] world\n$")

    def test_a_blank_write_does_not_emit_a_prefix(self):
        raw = io.StringIO()
        progress._StampStream(raw).write("")
        self.assertEqual(raw.getvalue(), "")


class DurationTest(unittest.TestCase):
    def test_readable_units(self):
        self.assertEqual(progress._dur(45), "45s")
        self.assertEqual(progress._dur(150), "2m30s")
        self.assertEqual(progress._dur(3 * 3600 + 61), "3h01m")
        self.assertEqual(progress._dur(float("inf")), "?")


class ProgressTest(unittest.TestCase):
    def _capture(self, fn):
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            fn()
        finally:
            sys.stdout = old
        return buf.getvalue()

    def test_a_finished_loop_reports_count_and_time(self):
        def run():
            p = progress.Progress("branch", 10, every=0)  # every=0: no thread, deterministic
            for _ in range(7):
                p.tick()
            p.close()

        out = self._capture(run)
        self.assertIn("branch", out)
        self.assertIn("7/10", out)
        self.assertIn("done", out)

    def test_a_running_status_has_a_percent_and_an_eta(self):
        def run():
            p = progress.Progress("branch", 100, every=0)
            p.tick(40)
            p._t0 -= 5.0  # force a nonzero elapsed so a rate and an ETA exist
            p._status()

        out = self._capture(run)
        self.assertIn("40/100 (40%)", out)
        self.assertIn("eta", out)

    def test_an_untotalled_heartbeat_reports_elapsed_and_its_note(self):
        def run():
            p = progress.Progress("lidar", None, every=0)
            p.tick(note="reading points")
            p._status()

        out = self._capture(run)
        self.assertIn("elapsed", out)
        self.assertIn("reading points", out)

    def test_a_totalled_status_is_padded_to_the_log_column(self):
        def run():
            p = progress.Progress("profile", 2, every=0)
            p.tick()
            p._status()

        out = self._capture(run)
        self.assertTrue(re.match(r"^  profile (1/2|2/2) ", out), out)


if __name__ == "__main__":
    unittest.main()
