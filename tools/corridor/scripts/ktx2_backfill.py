"""Encode .ktx2 twins into already-written trees, and point their manifests at them.

`export` does this inline now, but a tree written before that (or on a machine without the
encoder) can be brought up to date without a re-export — the twins are additive and the manifest
only gains a `ktx2` key per layer.

    .venv/bin/python scripts/ktx2_backfill.py [--staging] [slug ...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from corridor import ktx2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "data" / "sites"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sub = "web.staging" if "--staging" in sys.argv else "web"
    if ktx2.encoder() is None:
        print("no ktx encoder — tools/corridor/scripts/fetch_ktx.sh")
        return 1
    slugs = args or sorted(p.parent.name for p in ROOT.glob(f"*/{sub}") if p.is_dir())
    tj = tk = 0
    for s in slugs:
        web = ROOT / s / sub
        if not web.is_dir():
            continue
        r = ktx2.encode_dir(web, "*.jpg")
        man = web / "manifest.json"
        changed = 0
        if man.exists():
            m = json.loads(man.read_text())
            for lay in (m.get("layers") or {}).values():
                if not isinstance(lay, dict):
                    continue
                f = lay.get("file", "")
                if f.endswith(".jpg") and (web / f).with_suffix(".ktx2").exists() and lay.get("ktx2") != f[:-4] + ".ktx2":
                    lay["ktx2"] = f[:-4] + ".ktx2"
                    changed += 1
            t = (m.get("layers") or {}).get("tiles")
            if isinstance(t, dict) and any(web.glob("tiles/**/*.ktx2")) and t.get("texture_ktx2") != "naip.ktx2":
                t["texture_ktx2"] = "naip.ktx2"
                changed += 1
            if changed:
                tmp = man.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(m, separators=(",", ":")))
                tmp.replace(man)
        tj += r.get("jpg_bytes", 0)
        tk += r.get("ktx2_bytes", 0)
        print(f"  {s:26} {r.get('ok', 0):4} encoded, {r.get('skip', 0):4} current, {r.get('fail', 0)} failed, manifest +{changed}", flush=True)
    if tj:
        print(f"\n{tj / 2**20:.1f} MiB of jpg -> {tk / 2**20:.1f} MiB of ktx2 on the wire; roughly 8x less on the GPU")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
