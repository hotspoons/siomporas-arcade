"""Is this site safe to publish? One command, every invariant a consumer relies on.

    .venv/bin/python -m corridor.verify [slug ...]      # all sites when no slug is given

Written after three bugs in one evening that a viewer would have rendered perfectly:

  * a literal `NaN` in `web/manifest.json` from a VRT's nodata — `JSON.parse` refuses the WHOLE
    file, so one bad number is a site that does not exist;
  * branch profiles keyed by POSITIONAL chain ids, which shifted when the chain set changed, so 21
    of 39 roads carried another road's grade;
  * a re-profile that matched the old file by those ids and wrote records with no `id` at all,
    which then took the manifest's entire `branches` block down.

and two more found by the checks themselves once they existed: a published centreline that leaves
the real road on a switchback, and a published centreline SHORTER than the line every along-track
`s` is measured on, which displaces every structure and authored interval near the far end.

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
            # a tile's heights are either a packed blob (`<x>_<y>.pack`, the current bake) or the
            # original `<x>_<y>.dem.png`. Checking only for the PNG made every tiled site fail
            # after main packed the tiles, which is a false alarm that teaches people to ignore this
            # command — the one thing a verifier must never do.
            missing = [f"{t['x']}_{t['y']}" for t in L.get("list", [])
                       if not (tdir / f"{t['x']}_{t['y']}.pack").exists() and not (tdir / f"{t['x']}_{t['y']}.dem.png").exists()]
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

    # 4b. a junction has to lie ON the road that claims it
    #
    # `export_branches` copies each junction record out of branches.json unchanged, so a
    # branches.json written before the ENU migration keeps handing UTM-relative junctions to a
    # freshly exported manifest FOREVER — a re-export does not repair it, only re-running the OSM
    # stage does. The signature is an offset that grows linearly with distance from the origin (it
    # is the grid convergence), and on crofton-triangle it reached 69 m while every road, tile and
    # building around it was correct. The viewer feeds these straight into the junction paint-
    # suppression circles, so lane markings get erased in an empty field and drawn through the real
    # crossroads.
    if m.get("branches"):
        offs = []
        for b in m["branches"]:
            cs = b.get("coords") or []
            if len(cs) < 2:
                continue
            for j in b.get("junctions") or []:
                if j.get("x") is None or j.get("y") is None:
                    continue
                d = min(math.hypot(c[0] - j["x"], c[1] - j["y"]) for c in cs)
                if d > 5.0:
                    offs.append((b.get("ident"), j.get("node"), round(d, 1)))
        if offs:
            worst = max(offs, key=lambda t: t[2])
            total = sum(len(b.get("junctions") or []) for b in m["branches"]) or 1
            frac = len(offs) / total
            # TWO different faults land here and they need different answers, so tell them apart by
            # how MANY junctions are wrong rather than by how far:
            #   a frame mismatch is systematic — it moves every junction, by an amount that grows
            #     with distance from the origin, and it is fixed by re-running the OSM stage;
            #   the smoothing residual is local — it moves a handful of junctions on short or
            #     sharply-bent chains, because the published centreline is a smoothed resample of
            #     the line the junction was projected onto.
            # Calling the second one a frame error sends you to re-bake a site that is fine.
            if frac > 0.3:
                errors.append(
                    f"{len(offs)} of {total} junctions ({frac:.0%}) are not on the road that claims them, worst {worst[2]} m on {worst[0]}: "
                    f"that is systematic, so the junction records are in a different frame from `coords`. A re-export will NOT fix it — "
                    f"re-run the OSM stage (`python -m corridor.network {slug}`) so branches.json is rewritten, then export."
                )
            else:
                warnings.append(
                    f"{len(offs)} of {total} junctions sit up to {worst[2]} m off their own road ({worst[0]}): the published centreline is "
                    f"a smoothed resample, and on a short or sharply-bent chain it leaves the line the junction was projected onto"
                )

    # 5. the published centreline against the road it was measured from
    spine = m.get("spine") or {}
    if not spine.get("coords"):
        errors.append("no spine coords")
    sp_p = site_dir / "spine_utm.json"
    if spine.get("coords") and sp_p.exists():
        try:
            import shapely
            from shapely.geometry import LineString

            site = json.loads((site_dir / "site.json").read_text())
            ox, oy = site["frame"]["origin"]
            rawline = LineString(json.loads(sp_p.read_text())["coords"])
            pub = [[c[0] + ox, c[1] + oy] for c in spine["coords"]]
            publine = LineString(pub)
            # (a) how far the DRAWN road sits from the real one. Smoothing is bounded per vertex,
            # but a long segment between two clamped vertices can still chord across a bend.
            dev = shapely.distance(shapely.points([q[0] for q in pub], [q[1] for q in pub]), rawline)
            if float(dev.max()) > 3.0:
                warnings.append(f"the published centreline leaves the real road by up to {float(dev.max()):.1f} m (smoothing); it reads as the road beside its own trace in the air photo")
            # (b) every `s` in this manifest is measured on the RAW line and resolved as arclength
            # along the PUBLISHED one, so a length mismatch displaces every structure and interval.
            drift = publine.length - rawline.length
            if rawline.length > 0 and abs(drift) / rawline.length > 0.002:
                worst = abs(drift)
                warnings.append(f"published centreline is {drift:+.1f} m ({100 * drift / rawline.length:+.2f} %) against the line every `s` is measured on: features near the far end are displaced by up to {worst:.0f} m")
        except Exception as exc:
            warnings.append(f"could not compare the centreline against spine_utm.json ({exc})")
    if (m.get("lidar") or {}).get("dataset") is None:
        warnings.append("no lidar: no trees, no structures, no cut faces")
    # flora: the viewer picks a tree species and a ground cover from this, and gets neither the
    # regional palette nor the fallback right if the shares do not add up or the grid is not the
    # size the manifest claims. A missing block is a warning (old bakes); a broken one is an error.
    fl = m.get("flora")
    if fl is None:
        warnings.append("no flora: every tree falls back to the mid-Atlantic hardwood mix and the ground to plain grass")
    else:
        classes = (fl.get("evt") or {}).get("classes") or []
        if not classes:
            errors.append("flora has no EVT classes")
        share = sum(c.get("share", 0) for c in classes)
        if not 0.98 <= share <= 1.02:
            errors.append(f"flora EVT class shares sum to {share:.3f}, not 1")
        lay = (m.get("layers") or {}).get("flora")
        if lay is None:
            warnings.append("flora has no class grid: species and ground cover are uniform over the whole site")
        else:
            png = site_dir / "web" / lay["file"]
            if not png.exists():
                errors.append(f"flora layer {lay['file']} is in the manifest but not on disk")
            else:
                try:
                    from PIL import Image

                    with Image.open(png) as im:
                        if list(im.size) != list(lay["size"]):
                            errors.append(f"flora grid is {im.size} but the manifest says {tuple(lay['size'])}")
                except Exception as exc:
                    errors.append(f"flora grid unreadable: {exc}")
        ref = (fl.get("canopy") or {}).get("ref") or {}
        for c in classes:
            for sp in c.get("species", []):
                if sp["key"] not in ref:
                    errors.append(f"flora class {c['value']} names species {sp['key']!r} that is not in canopy.ref")
                    break
        if not (fl.get("climate") or {}).get("ppt_mm"):
            warnings.append("flora has no climate: the ground cover cannot cure on the right months")

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
