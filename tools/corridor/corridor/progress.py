"""Timestamps on every log line, and a heartbeat for the stages that go quiet.

A bake's log is the only window into a job that runs for hours, and two things made it hard to
read (Rich, 2026-10-05): the lines carried no clock, so "how long has it been on this stage?" was
unanswerable, and the genuinely long operations — profiling 10,137 branches, exporting a few
hundred tiles, measuring surface over tens of thousands of stations — printed nothing between
their start and their finish, so a job making steady progress looked identical to one wedged.

`install_timestamps` prefixes every line with the UTC clock. `Progress` prints one status line
every `every` seconds while work is in flight, with a count and a rate and an ETA when a total is
known; `heartbeat` is the same thing for one opaque call. Both are cheap and thread-safe:

    p = Progress("branch", len(tasks))       # starts its own heartbeat thread
    for task in tasks:
        ...
        p.tick()                              # update the count; the thread does the printing
    p.close()

    with heartbeat("profile", f"primary {prim['ident']}"):
        prof = profile_tiled(...)             # one long call, no natural count

The heartbeat thread holds only a WEAK reference to its Progress, so if the instrumented code
raises, the local goes out of scope, `__del__` stops the thread, and the log does not fill with
orphaned status lines while the bake moves on to the next stage. The status goes through the same
lock and the same timestamped stdout as everything else, so it can never split a stage's line.
"""
from __future__ import annotations

import math
import sys
import threading
import time
import weakref

# Reentrant: _emit takes it, then sys.stdout (the _StampStream) takes it again in write().
_LOCK = threading.RLock()
DEFAULT_EVERY = 60.0


def _clock() -> str:
    return time.strftime("%H:%M:%SZ", time.gmtime())


def _emit(text: str) -> None:
    """One whole, timestamped line, under the lock, so a heartbeat is all-or-nothing."""
    with _LOCK:
        try:
            stream = sys.stdout
            stream.write(f"{text}\n")
            stream.flush()
        except Exception:
            pass  # a log line must never be the reason a bake dies


class _StampStream:
    """A stdout/stderr proxy that puts `[HH:MM:SSZ] ` in front of every line.

    Wrapping the stream rather than editing several hundred `print` calls means every existing
    stage line gets a clock, including ones written by forked profile workers (they inherit this
    object across `fork`). `_bol` tracks whether the next byte starts a line, because `print`
    writes the text and the newline as two separate calls.
    """

    def __init__(self, raw):
        self._raw = raw
        self._bol = True

    def write(self, text):
        if not text:
            return 0
        with _LOCK:
            out = []
            for line in text.splitlines(keepends=True):
                if self._bol:
                    out.append(f"[{_clock()}] ")
                    self._bol = False
                out.append(line)
                if line.endswith("\n"):
                    self._bol = True
            self._raw.write("".join(out))
            self._raw.flush()
        return len(text)

    def flush(self):
        self._raw.flush()

    def writable(self) -> bool:
        return True

    def __getattr__(self, name):
        # fileno, encoding, isatty, ... must reach the real stream (subprocess, multiprocessing)
        return getattr(self._raw, name)


_INSTALLED = False


def install_timestamps() -> None:
    """Prefix every line on stdout/stderr with the UTC clock. Idempotent."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    sys.stdout = _StampStream(sys.stdout)
    if sys.stderr is not sys.stdout:
        sys.stderr = _StampStream(sys.stderr)


def _dur(seconds: float) -> str:
    if seconds is None or not math.isfinite(seconds) or seconds < 0:
        return "?"
    s = int(seconds)
    if s < 90:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 90:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


def _watch(stop: threading.Event, every: float, wref: "weakref.ReferenceType[Progress]") -> None:
    """Heartbeat thread body. Holds only the event and a WEAK ref, so the Progress stays collectable
    and a stage that raises leaves no thread printing orphaned status lines."""
    while not stop.wait(every):
        p = wref()
        if p is None:
            return
        p._status()


class Progress:
    """A periodic status line for a long loop, with a count, a rate and an ETA.

    `total` is optional: with it you get `done/total (pct%)  rate/s  eta X`; without it you get
    `<count> <elapsed>`. A daemon thread prints every `every` seconds (the first after one whole
    interval, so a stage shorter than a minute stays quiet and only the final line is seen);
    `tick`/`note` update the count from the working thread. `close` prints the final line and stops
    the thread; `__del__` stops it too, so it is safe to instrument a loop that may raise.
    """

    def __init__(self, label: str, total: int | None = None, every: float = DEFAULT_EVERY, unit: str = ""):
        self.label = label
        self.total = total
        self.every = every
        self.unit = unit
        self._done = 0
        self._note = ""
        self._t0 = time.time()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._closed = False
        if every and every > 0:
            self._thread = threading.Thread(target=_watch, args=(self._stop, every, weakref.ref(self)), name=f"progress-{label}", daemon=True)
            self._thread.start()

    # -- lifecycle ---------------------------------------------------------------------------
    def __enter__(self) -> "Progress":
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False

    def __del__(self) -> None:
        try:
            self._stop.set()
        except Exception:
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        el = time.time() - self._t0
        if self.total:
            rate = self._done / el if el > 0 else 0.0
            body = f"{self._done:,}/{self.total:,} in {_dur(el)}" + (f" ({rate:.1f}/s)" if rate else "")
        else:
            body = f"in {_dur(el)}"
        tail = f" — {self._note}" if self._note else ""
        _emit(f"  {self.label:<7} done {body}{tail}")

    # -- counting ----------------------------------------------------------------------------
    def tick(self, n: int = 1, note: str | None = None) -> None:
        self._done += n
        if note is not None:
            self._note = note

    def note(self, text: str) -> None:
        self._note = text

    def _status(self) -> None:
        el = time.time() - self._t0
        bits = [f"  {self.label:<7}"]
        if self.total:
            pct = 100.0 * self._done / self.total
            rate = self._done / el if el > 0 else 0.0
            bits.append(f"{self._done:,}/{self.total:,} ({pct:.0f}%)")
            if rate > 0 and self._done < self.total:
                bits.append(f"{rate:.1f}/s eta {_dur((self.total - self._done) / rate)}")
            else:
                bits.append(f"{_dur(el)} elapsed")
        else:
            if self._done:
                bits.append(f"{self._done:,}{self.unit}")
            bits.append(f"{_dur(el)} elapsed")
        if self._note:
            bits.append(self._note)
        _emit(" ".join(bits))


class heartbeat(Progress):
    """`Progress` for one opaque call: no count, just "still here, Ns in" every `every` seconds.

    Use it around a single expensive function that has no internal hook (a full `profile_tiled`,
    a gdalwarp) so a silent minute is visibly one status old, not an unknown quantity of silence.
    """

    def __init__(self, label: str, note: str = "", every: float = DEFAULT_EVERY):
        super().__init__(label, None, every=every)
        if note:
            self.note(note)
