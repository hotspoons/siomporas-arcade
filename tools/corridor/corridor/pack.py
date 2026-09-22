"""One request per tile: the trailworks tile-pack container, baked rather than assembled.

Corridor writes three loose files per tile (`<x>_<y>.dem.png`, `.chm.png`, `.naip.jpg`), so
crofton-triangle's 59 tiles are 177 objects and crofton-crownsville's 125 are 375. trailworks
profiled exactly this and found every LOD tier **fetch-bound** — ~300 ms a tile, decode 5–15 ms
and mesh build 1–11 ms being noise, and ~1.1 s an asset over a Cloudflare tunnel. Their fix was to
collapse a tile's data assets into one fetch, and the format is deliberately dependency-free so a
Rust server and a TS worker each parse it in a few lines:

    [ uint32 LE: header length H ]
    [ H bytes: header JSON, utf-8 ]
    [ blob region: every file's bytes, concatenated ]

    header = {"rev": <int>, "files": {"<name>": [offset, length], ...}}

Offsets are relative to the start of the blob region, i.e. after the 4-byte length and the header.
A tile that legitimately lacks a file just omits the key.

## Two deliberate differences from trailworks

**Baked, not assembled.** trailworks builds packs on the fly in `prominence-rs`. Corridor is
heading for R2 behind a Worker, which serves static objects and has nowhere to run assembly logic,
so the pack is a file the bake writes. Same bytes either way — a reader ported in either direction
just works.

**The texture stays outside.** Same call trailworks made, for the same reasons: it is a different
content type with a different cache lifetime, it is shared between tiles by the client's texture
pool, and — the one that decides it for us — a `.ktx2` twin has to be independently selectable, so
a client that cannot transcode falls back to the `.jpg`. That is 2 requests a tile rather than 3,
and the third would cost us GPU-compressed textures.
"""
from __future__ import annotations

import json
import os
import struct
from pathlib import Path


def write_pack(dest: Path, files: dict[str, bytes], rev: int | None = None) -> int:
    """Write `files` as one pack. Returns the total byte length. Atomic: tmp then replace."""
    blob = bytearray()
    index: dict[str, list[int]] = {}
    for name, data in files.items():
        index[name] = [len(blob), len(data)]
        blob += data
    header = json.dumps({"rev": rev if rev is not None else 0, "files": index}, separators=(",", ":")).encode("utf-8")
    body = struct.pack("<I", len(header)) + header + bytes(blob)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(body)
    os.replace(tmp, dest)
    return len(body)


def read_pack(src: Path) -> tuple[dict, dict[str, bytes]]:
    """Inverse of `write_pack` — used by the tests and by anything that has to inspect a bake."""
    raw = src.read_bytes()
    (hlen,) = struct.unpack_from("<I", raw, 0)
    header = json.loads(raw[4 : 4 + hlen].decode("utf-8"))
    base = 4 + hlen
    out = {}
    for name, (off, ln) in header["files"].items():
        out[name] = raw[base + off : base + off + ln]
    return header, out
