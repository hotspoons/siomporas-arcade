"""A forked worker pool for per-tile export and mosaic work.

The long offline stages are chains of independent, CPU-heavy per-tile jobs — one `.pack` per 1 km
tile (network_tiles.export_tiles), one pyramid tile per (z, x, y) (pyramid.bake). They used to run
in a serial `for` loop, which is why 643 tiles of the Capital Beltway took ~67 minutes and its
1,272-tile pyramid another ~60 (corridor-bake-495-mutyn7k8, 2026-10-04).

WHY A FORK POOL AND NOT THREADS. Every worker opens its own rasterio datasets (never shares a GDAL
handle across processes — a shared file offset corrupts pread), and most of the wall time is inside
PIL PNG encode and numpy, both of which hold the GIL, so threads would serialize on it. Fork gives
real parallelism. It is safe only because `corridor/__main__` pins BLAS/OpenMP/GDAL to one thread
before numpy loads: forking a process with a BLAS thread pool alive deadlocks the child on the
inherited lock (dc-metro-take-2, 2026-10-05). `default_jobs` is deliberately conservative and can be
overridden with `CORRIDOR_TILE_JOBS`.

The worker callable must be a module-level function (it is pickled by reference); its arguments must
be picklable too, which is why the tile stages pass paths and plain data rather than closures —
`vivid` used to be a closure inside `export.export_site` and is now `export.vivid` at module scope.
"""
from __future__ import annotations

import os

#: overrides everything; the container and the charts set CORRIDOR_JOBS for the profile pool but a
#: tile stage is lighter per worker (no 20 GiB cloud inherited), so it may want a different number.
_ENV = "CORRIDOR_TILE_JOBS"


def default_jobs(n_tasks: int) -> int:
    """Workers for a tile pool: CORRIDOR_TILE_JOBS, else CORRIDOR_JOBS, else min(cpu, 16)."""
    for name in (_ENV, "CORRIDOR_JOBS"):
        env = os.environ.get(name, "").strip()
        if env:
            try:
                return max(1, min(int(env), n_tasks or 1))
            except ValueError:
                pass
    # 16, not the profile pool's 32: each worker holds its own GDAL block cache and PIL buffers,
    # and tiled reads are as much I/O as CPU, so more workers past this stop helping.
    return max(1, min(16, os.cpu_count() or 1, n_tasks or 1))


def map_chunks(fn, chunks: list, label: str, jobs: int | None = None):
    """Run `fn(chunk)` for every chunk, forked across `jobs` processes, and return results in order.

    `chunks` is a list of argument tuples for `fn`. The work is split into `jobs` contiguous slices
    so each worker opens its rasters once; order is preserved by index, and a single element
    (`jobs == 1`) runs in-process with no pool at all, so a small site or a test never pays for a
    fork. A heartbeat (`progress.Progress`) prints one line a minute, so a stage that takes twenty
    minutes no longer looks like one that is wedged.
    """
    chunks = list(chunks)
    if not chunks:
        return []
    jobs = default_jobs(len(chunks)) if jobs is None else max(1, int(jobs))
    jobs = max(1, min(jobs, len(chunks)))
    if jobs == 1:
        return [fn(c) for c in chunks]

    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor, as_completed

    from . import progress

    try:
        ctx = mp.get_context("fork")
    except ValueError:  # not Linux: no fork, run in-process rather than reimplement
        return [fn(c) for c in chunks]
    out: list = [None] * len(chunks)
    with ProcessPoolExecutor(max_workers=jobs, mp_context=ctx) as ex:
        # Fork every worker BEFORE the heartbeat thread exists. `progress.install_timestamps`
        # wraps stdout in a stream guarded by a module lock, and a child that inherits that lock
        # while the heartbeat holds it deadlocks on its first print; starting the thread after the
        # forks leaves the lock unlocked in every child.
        pending = {ex.submit(fn, c): i for i, c in enumerate(chunks)}
        p = progress.Progress(label, len(chunks))
        try:
            for fut in as_completed(pending):
                out[pending[fut]] = fut.result()
                p.tick()
        finally:
            p.close()
    return out


def chunk(items: list, jobs: int) -> list[list]:
    """Split `items` into `jobs` contiguous, near-equal slices (the last gets the remainder)."""
    items = list(items)
    if not items:
        return []
    if jobs <= 1 or len(items) <= 1:
        return [items]
    n = len(items)
    per = -(-n // jobs)
    return [items[i : i + per] for i in range(0, n, per)]
