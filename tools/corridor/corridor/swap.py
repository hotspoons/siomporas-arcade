"""Stage a bake somewhere else, then put it live in one step.

Rich, 2026-09-21: the pipeline is getting a management app that drives bakes from a console, so a
re-export must never be a window during which the served tree is half-written. Today `export_site`
writes straight into the live `web/`: a viewer that reloads midway through gets a manifest that
does not match the rasters beside it, and a re-export that fails leaves the site broken with no
way back.

So: build into a staging directory, then swap. The swap is the only moment anything changes, and
it is one syscall.

## How atomic, exactly

`renameat2(RENAME_EXCHANGE)` swaps two directory entries in a single, uninterruptible step. There
is no instant at which `web/` does not exist, and the old tree survives as the staging directory —
which makes rollback the same operation run again. That is the path we want, and it is verified
present at import time rather than assumed.

It is Linux-only and not every filesystem implements it (it works on the fuse mount this repo
lives on; it does NOT work on some overlay and network filesystems, which is exactly where a
Kubernetes job might run). The fallback is two renames with a sub-millisecond window where `web/`
is missing. `swap_dir` reports which one it used so a caller can log it honestly rather than
claiming an atomicity it did not get.

**No symlinks.** A symlink under /workspaces/apex-conduit is a standing hazard in this repo — one
committed from a worktree lands in main at the path it points at — and the symlink-flip trick is
the usual way to do this. We do not use it.
"""
from __future__ import annotations

import ctypes
import errno
import os
import shutil
from pathlib import Path

AT_FDCWD = -100
RENAME_EXCHANGE = 2
RENAME_NOREPLACE = 1

_libc = None


def _exchange(a: Path, b: Path) -> bool:
    """Atomically swap two existing directory entries. False if the platform cannot."""
    global _libc
    if _libc is None:
        try:
            _libc = ctypes.CDLL("libc.so.6", use_errno=True)
        except OSError:
            _libc = False
    if not _libc or not hasattr(_libc, "renameat2"):
        return False
    ctypes.set_errno(0)
    r = _libc.renameat2(AT_FDCWD, str(a).encode(), AT_FDCWD, str(b).encode(), RENAME_EXCHANGE)
    if r == 0:
        return True
    e = ctypes.get_errno()
    # ENOSYS/EINVAL/EOPNOTSUPP: this kernel or filesystem has no RENAME_EXCHANGE. Anything else is
    # a real error and should not be quietly downgraded to the racy path.
    if e in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.ENOTTY):
        return False
    raise OSError(e, os.strerror(e), str(a), None, str(b))


def swap_dir(live: Path, staged: Path) -> str:
    """
    Put `staged` at `live`, keeping the previous tree.

    Returns "exchange" when the swap was a single atomic syscall and the old tree is now at
    `staged` (so calling this again is an exact rollback), or "rename" when it had to fall back to
    two renames, in which case the old tree is at `staged` too but there was a brief moment with
    no `live`. Raises rather than guessing if `staged` is missing.
    """
    staged = Path(staged)
    live = Path(live)
    if not staged.is_dir():
        raise FileNotFoundError(f"nothing staged at {staged}")
    if not live.exists():
        # first publish: a plain rename IS atomic, there is nothing to displace
        staged.rename(live)
        return "rename-new"
    if not live.is_dir():
        raise NotADirectoryError(f"{live} exists and is not a directory")
    if _exchange(live, staged):
        return "exchange"
    # Fallback: the window here is one rename long. Ordering matters — move the old one OUT before
    # moving the new one IN, or the second rename lands inside the first.
    hold = live.with_name(live.name + ".swapping")
    if hold.exists():
        shutil.rmtree(hold)
    live.rename(hold)
    try:
        staged.rename(live)
    except Exception:
        hold.rename(live)  # put it back; better a stale site than no site
        raise
    hold.rename(staged)
    return "rename"


def staging_dir(live: Path, tag: str = "staging") -> Path:
    """A sibling of `live` to build into. A sibling so the swap is a rename, never a copy."""
    return Path(live).with_name(f"{Path(live).name}.{tag}")


def missing_from(staged: Path, live: Path) -> list[str]:
    """
    Relative paths present in `live` but absent from `staged`.

    The gate before a promote. A staging directory starts EMPTY, so an export that partly failed —
    `export.py` catches a tile failure and carries on, by design — produces a tree that is missing
    files the served one has. Swapping that in would silently un-publish them. This is also the
    honest way to notice that a layer stopped being generated at all.
    """
    if not live.is_dir():
        return []
    out = []
    for f in sorted(live.rglob("*")):
        if f.is_file() and not (staged / f.relative_to(live)).exists():
            out.append(str(f.relative_to(live)))
    return out
