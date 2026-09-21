"""Is this site safe to publish? One command, every invariant a consumer relies on.

    .venv/bin/python -m corridor.verify [slug ...]      # all sites when no slug is given

Written after three bugs in one evening that a viewer would have rendered perfectly:

  * a literal `NaN` in `web/manifest.json` from a VRT's nodata — `JSON.parse` refuses the WHOLE
    file, so one bad number is a site that does not exist;
  * branch profiles keyed by POSITIONAL chain ids, which shifted when the chain set changed, so 21
    of 39 roads carried another road's grade;
  * a re-profile that matched the old file by those ids and wrote records with no `id` at all,
    which then took the manifest's entire `branches` block down.

None of those is visible by looking at the thing. They are all visible in thirty lines of checking,
so the checking lives here and runs before anyone believes a bake.

Exit code is the number of sites with errors, so it drops straight into a shell `&&` chain.
"""
from __future__ import annotations

import json
import math
from pathlib import Path


def _finite(v) -> bool:
    return not isinstance(v, float) or math.isfinite(v)


def _walk(o, path: str, bad: list[str], depth: int = 0) -> None:
    """Every number in the tree is finite. Depth-limited: a manifest is wide, not deep."""
    if len(bad) > 20 or depth > 12:
        return
    if isinstance(o, dict):
        for k, v in o.items():
            _walk(v, f"{path}.{k}", bad, depth + 1)
    elif isinstance(o, list):
        for i, v in enumerate(o[:5000]):
            _walk(v, f"{path}[{i}]", bad, depth + 1)
    elif not _finite(o):
        bad.append(path)


def verify(site_dir: Path) -> dict:
    slug = site_dir.name
    errors: list[str] = []
    warnings: list[str] = []
    web = site_dir / "web" / "manifest.json"
    if not web.exists():
        return {"slug": slug, "errors": ["no web/manifest.json"], "warnings": [], "ok": False}
    raw = web.read_text()

    # 1. a browser must be able to read it at all
    for token in ("NaN", "Infinity", "-Infinity"):
        if f": {token}" in raw or f"{token}," in raw or f"[{token}" in raw:
            errors.append(f"literal {token} in the manifest: JSON.parse refuses the entire file")
            break
    try:
        m = json.loads(raw)
    except Exception as exc:
        return {"slug": slug, "errors": errors + [f"unparseable: {exc}"], "warnings": [], "ok": False}
    nonfinite: list[str] = []
    _walk(m, "", nonfinite)
    if nonfinite:
        errors.append(f"{len(nonfinite)} non-finite number(s), first at {nonfinite[0]}")

    # 2. the bake that produced it actually finished
    if not (site_dir / "manifest.json").exists():
        errors.append("web/ was exported but manifest.json is absent: this is a partial bake and will load with no trees or structures")

    # 3. the layers it claims exist on disk
    layers = m.get("layers") or {}
    if not layers:
        errors.append("no layers at all")
    for name, L in layers.items():
        if name == "tiles":
            tdir = site_dir / "web" / (L.get("dir") or "tiles/0")
            missing = [f"{t['x']}_{t['y']}" for t in L.get("list", []) if not (tdir / f"{t['x']}_{t['y']}.dem.png").exists()]
            if missing:
                errors.append(f"{len(missing)} tile(s) listed with no dem.png on disk, e.g. {missing[0]}")
            noz = [t for t in L.get("list", []) if not (t.get("dem") or {}).get("zscale")]
            if noz:
                errors.append(f"{len(noz)} tile(s) with no dem.zmin/zscale: heights cannot be decoded")
            if not L.get("list"):
                errors.append("layers.tiles has an empty list")
        elif isinstance(L, dict) and L.get("file") and not (site_dir / "web" / L["file"]).exists():
            errors.append(f"layer {name} names {L['file']}, which is not on disk")

    # 4. a network's roads are keyed consistently, and every road is a road
    if m.get("network"):
        branches = m.get("branches") or []
        ids = [b.get("id") for b in branches]
        if any(i is None for i in ids):
            errors.append(f"{sum(1 for i in ids if i is None)} branch(es) with no id")
        if len(ids) != len(set(ids)):
            errors.append("duplicate branch ids: profiles cannot be attributed")
        sp = site_dir / "spine_utm.json"
        if sp.exists():
            spine = json.loads(sp.read_text())
            sib = {s.get("id"): s.get("ident") for s in spine.get("siblings", [])}
            mism = [(b.get("id"), b.get("ident"), sib.get(b.get("id"))) for b in branches if b.get("id") in sib and b.get("ident") != sib[b.get("id")]]
            if mism:
                errors.append(f"{len(mism)} branch(es) whose ident disagrees with spine_utm.json, e.g. {mism[0]} — a profile is on the wrong road")
            dropped = [i for i in sib if i not in set(ids)]
            if dropped:
                warnings.append(f"{len(dropped)} road(s) in spine_utm.json are not in the manifest's branches")
        noprof = [b.get("ident") for b in branches if not b.get("profile")]
        if noprof:
            warnings.append(f"{len(noprof)} branch(es) with no profile (no road grade), e.g. {noprof[0]}")
        for b in branches:
            zs = [c[2] for c in (b.get("coords") or [])]
            if zs and max(zs) - min(zs) > 200:
                warnings.append(f"branch {b.get('ident')} spans {max(zs) - min(zs):.0f} m of height: check its profile")

    # 5. the road itself
    spine = m.get("spine") or {}
    if not spine.get("coords"):
        errors.append("no spine coords")
    if (m.get("lidar") or {}).get("dataset") is None:
        warnings.append("no lidar: no trees, no structures, no cut faces")
    for key in ("cuts", "rock", "water"):
        v = m.get(key)
        if v is not None and not isinstance(v, dict):
            errors.append(f"{key} is not an object")

    return {"slug": slug, "errors": errors, "warnings": warnings, "ok": not errors}


def main() -> None:
    import sys

    from .__main__ import DATA

    slugs = sys.argv[1:] or [d.name for d in sorted((DATA / "sites").glob("*")) if d.is_dir()]
    bad = 0
    for slug in slugs:
        d = DATA / "sites" / slug
        if not d.is_dir():
            continue
        r = verify(d)
        mark = "ok  " if r["ok"] else "FAIL"
        extra = f" ({len(r['warnings'])} warning{'s' if len(r['warnings']) != 1 else ''})" if r["warnings"] else ""
        print(f"{mark} {r['slug']:26s}{extra}")
        for e in r["errors"]:
            print(f"       ERROR   {e}")
        for w in r["warnings"]:
            print(f"       warning {w}")
        bad += 0 if r["ok"] else 1
    print(f"\n{len(slugs) - bad}/{len(slugs)} sites safe to publish")
    raise SystemExit(bad)


if __name__ == "__main__":
    main()
