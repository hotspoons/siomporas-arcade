"""GPU-compressed textures: a .ktx2 twin beside every baked .jpg.

A 1000x1000 NAIP tile decodes to ~5.3 MB of RGBA-plus-mipmaps on the GPU. crofton-triangle has 59
such tiles and crofton-crownsville 125, so streaming them as JPEG means **314 MB and 666 MB of
texture memory** — against the 226 MB the viewer already carries for the single overview. It does
not fit, and that, not the fetch count, is what decides whether tiled streaming is possible at all.

ETC1S (BasisU, transcoded to BC1/ETC1/ASTC by whatever the client has) is 4 bits a pixel: the same
tile is ~0.67 MB resident including mips, **8x less**. Measured here on a real crofton-triangle
tile: 292 498 B jpg -> 176 492 B ktx2, so it is also 40% smaller on the wire, and the ktx2 carries
its mipmaps where the jpg has them generated on upload. trailworks reached the same numbers
(pipeline/bake/globe2_ktx2.py) and judged the quality on NAIP visually indistinguishable.

Purely additive. The .jpg stays as the universal fallback — a client that cannot transcode, or a
bake run where the tool is missing, still works. That is also why the texture is NOT inside the
tile pack (see pack.py): it has to be independently selectable.

The encoder is Khronos' `ktx` (KTX-Software >= 4.3). It is NOT vendored — it is a 7 MB binary with
shared libraries and the repo should not carry one. `scripts/fetch_ktx.sh` puts it in
tools/corridor/.bin, and CORRIDOR_KTX overrides the path. Absent, encoding is skipped with a note
and the bake carries on.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def encoder() -> Path | None:
    """The `ktx` binary, or None. Checked once a run by the caller, not per tile."""
    env = os.environ.get("CORRIDOR_KTX")
    if env and Path(env).exists():
        return Path(env)
    local = HERE / ".bin" / "KTX-Software" / "bin" / "ktx"
    if local.exists():
        return local
    found = shutil.which("ktx")
    return Path(found) if found else None


def _env(exe: Path) -> dict:
    """The tarball's `ktx` needs its own lib/ on the loader path."""
    e = dict(os.environ)
    lib = exe.parent.parent / "lib"
    if lib.is_dir():
        e["LD_LIBRARY_PATH"] = f"{lib}:{e.get('LD_LIBRARY_PATH', '')}".rstrip(":")
    return e


def encode(src: Path, exe: Path | None = None, force: bool = False) -> tuple[str, int, int]:
    """
    Encode one image to a `.ktx2` twin. Returns (status, src_bytes, out_bytes).

    status is "ok", "skip" (already current) or "fail" — a failure is never fatal, the `.jpg` is
    still there and the client falls back to it.
    """
    exe = exe or encoder()
    if exe is None:
        return ("noexe", 0, 0)
    out = src.with_suffix(".ktx2")
    if not force and out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return ("skip", 0, 0)
    r = subprocess.run(
        [str(exe), "create", "--format", "R8G8B8_SRGB", "--encode", "basis-lz",
         "--generate-mipmap", "--assign-tf", "srgb", str(src), str(out)],
        capture_output=True, env=_env(exe),
    )
    if r.returncode != 0:
        out.unlink(missing_ok=True)
        return ("fail", 0, 0)
    return ("ok", src.stat().st_size, out.stat().st_size)


def encode_dir(d: Path, pattern: str = "*.jpg", force: bool = False, workers: int = 0) -> dict:
    """Encode every match under `d`. Returns a summary; never raises."""
    exe = encoder()
    if exe is None:
        return {"status": "no encoder", "ok": 0}
    import concurrent.futures as cf

    files = sorted(d.rglob(pattern))
    if not files:
        return {"status": "nothing to encode", "ok": 0}
    n = workers or min(8, (os.cpu_count() or 4))
    ok = skip = fail = 0
    sj = sk = 0
    with cf.ThreadPoolExecutor(max_workers=n) as ex:
        for st, a, b in ex.map(lambda f: encode(f, exe, force), files):
            if st == "ok":
                ok += 1
                sj += a
                sk += b
            elif st == "skip":
                skip += 1
            else:
                fail += 1
    return {"status": "ok", "ok": ok, "skip": skip, "fail": fail, "jpg_bytes": sj, "ktx2_bytes": sk}
