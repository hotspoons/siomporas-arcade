"""docs/corridor/SITES.md, generated from the bakes — never typed.

    .venv/bin/python -m corridor.sitesdoc [--log <newbakes.log>] [--out docs/corridor/SITES.md]

Per site directory under data/sites: the road OSM identified, the lidar project (name, year,
which ASPRS classes the vendor actually populated, whether class 17 was trusted), the DEM source
tiles and their publication dates when the manifest kept them, the NAIP fetch (the service does
not report an acquisition date; the imagery is the current USGSNAIPPlus mosaic), the OSM tags on
the spine that matter to paint and width, the detected structures and formations, and what is
MISSING against the full file set. Sites in sites.json with no directory, or a directory with no
manifest, are listed as not baked / in progress, with the last error found for them in the bake
log when one is given.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("CORRIDOR_DATA", HERE / "data"))
SITES = Path(os.environ.get("CORRIDOR_SITES", HERE / "sites.json"))
ROOT = HERE.parent.parent

EXPECTED = ["site.json", "spine_utm.json", "osm.geojson", "crossings.json", "dem_1m.tif", "naip.tif", "horizon_30m.tif", "geology.json", "lidar/dtm.tif", "lidar/chm.tif", "profile.json", "surface.json", "web/manifest.json", "web/dem_2m.png", "web/chm_2m.png", "web/naip_1m.jpg", "web/horizon_60m.png"]
PAINT_TAGS = ("highway", "lanes", "lanes:forward", "lanes:backward", "oneway", "maxspeed", "surface", "turn:lanes", "overtaking", "shoulder", "width")
# The sixteen queued 2026-09-21 (the cadre brief); everything else is a day-one site.
NEW16 = ["patuxent-river-rd", "bacon-ridge-rd", "chesterfield-rd", "crownsville-rd", "underwood-rd", "waterbury-rd", "rutland-rd", "rossback-rd", "hawkins-rd", "bell-branch-rd", "st-stephens-church-rd", "bonnie-branch-rd", "ragged-point-ca1", "bixby-bridge-ca1", "ecola-or", "acadia-ocean-dr"]


NAIP_ID = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/identify"


def naip_date(slug: str, lat: float | None, lon: float | None) -> dict | None:
    """The NAIP tile under the site point, from the image service's catalog (`identify` with
    `returnCatalogItems`): tile name, acquisition date, resolution. Cached per site under
    data/cache/naipdate/; a network failure leaves the row blank rather than failing the doc."""
    if lat is None or lon is None:
        return None
    hit = DATA / "cache" / "naipdate" / f"{slug}.json"
    if hit.exists():
        return json.loads(hit.read_text())
    try:
        import requests

        r = requests.get(NAIP_ID, params={"geometry": json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}}), "geometryType": "esriGeometryPoint", "returnCatalogItems": "true", "returnGeometry": "false", "pixelSize": json.dumps({"x": 0.6, "y": 0.6}), "f": "json"}, timeout=60)
        r.raise_for_status()
        feats = [f["attributes"] for f in r.json().get("catalogItems", {}).get("features", []) if f["attributes"].get("Category") == 1]
        out = None
        if feats:
            a = feats[0]
            ms = a.get("acquisition_date")
            out = {"tile": a.get("Name"), "year": a.get("Year"), "date": time.strftime("%Y-%m-%d", time.gmtime(ms / 1000)) if ms else None, "res_m": a.get("resolution_value"), "state": a.get("State")}
        hit.parent.mkdir(parents=True, exist_ok=True)
        hit.write_text(json.dumps(out))
        return out
    except Exception as exc:  # the doc must still build offline
        print(f"  naip date {slug}: {exc}")
        return None


def lidar_year(dataset: str | None) -> str:
    if not dataset:
        return "—"
    m = re.search(r"_D(\d{2})\b", dataset)
    if m:
        return "20" + m.group(1)
    m = re.search(r"(20\d{2})", dataset)
    return m.group(1) if m else "?"


def log_blocks(log: Path | None) -> dict[str, dict]:
    """Per slug: the last block's status line and error, from the bake log's '=== <slug>' headers."""
    out: dict[str, dict] = {}
    if not log or not log.exists():
        return out
    cur = None
    for line in log.read_text(errors="replace").splitlines():
        m = re.match(r"^=== (\S+)", line)
        if m:
            cur = m.group(1)
            out[cur] = {"lines": [], "done": False, "error": None}
            continue
        if cur is None:
            continue
        b = out[cur]
        b["lines"].append(line)
        if line.startswith("  done"):
            b["done"] = True
        # the LAST exception line, not the first "Traceback" — a bake that retried three mirrors
        # and then died on a LAS header should say so, and "Traceback (most recent call last):" in
        # a table tells nobody anything.
        if re.match(r"^[A-Za-z_.]*(Error|Exception)\b", line) or re.search(r"\b(failed|SystemExit)\b", line):
            b["error"] = line.strip()[:200]
    return out


def tag_summary(spine: dict) -> dict[str, list[str]]:
    tags: dict[str, set[str]] = {}
    for g in spine.get("segments", []):
        for k, v in g.get("tags", {}).items():
            if k in PAINT_TAGS:
                tags.setdefault(k, set()).add(str(v))
    return {k: sorted(v) for k, v in tags.items()}


def site_row(slug: str, d: Path, entry: dict | None, logb: dict | None) -> dict:
    row: dict = {"slug": slug, "note": (entry or {}).get("note"), "lat": (entry or {}).get("lat"), "lon": (entry or {}).get("lon"), "photos": len((entry or {}).get("photos", []))}
    if not d.exists():
        row["status"] = "not baked"
    elif not (d / "manifest.json").exists():
        row["status"] = "in progress" if not (logb and logb.get("error")) else "failed"
    else:
        row["status"] = "baked"
    if logb:
        row["log_error"] = logb.get("error")
        row["log_done"] = logb.get("done")
        row["log_tail"] = [ln for ln in logb["lines"] if ln.strip()][-3:]
    present = {p for p in EXPECTED if (d / p).exists()} if d.exists() else set()
    row["missing"] = [p for p in EXPECTED if p not in present]
    row["naip_tile"] = naip_date(slug, row.get("lat"), row.get("lon")) if d.exists() else None
    row["has"] = {"adjustments": (d / "adjustments.json").exists(), "placements": (d / "placements.json").exists(), "structures": (d / "structures.json").exists()}
    if (d / "manifest.json").exists():
        m = json.loads((d / "manifest.json").read_text())
        sp, li = m.get("spine", {}), m.get("lidar", {})
        row.update({
            "ident": sp.get("ident"), "length_m": sp.get("length_m"), "snap_m": sp.get("snap_distance_m"), "trimmed": sp.get("trimmed"),
            "fetched": m.get("fetched"), "seconds": m.get("seconds"),
            "lidar_dataset": li.get("dataset"), "lidar_points": li.get("points_in_corridor"), "lidar_classes": li.get("classes") or {}, "lidar_quality": li.get("classification") or {}, "lidar_zf": li.get("z_factor"),
            "structures": li.get("structures") or [],
            "dem_sources": [(s.get("title"), s.get("date")) for s in (m.get("dem") or {}).get("sources", [])] if isinstance(m.get("dem"), dict) else [],
            "dem_cached": bool(isinstance(m.get("dem"), dict) and m["dem"].get("cached")),
            "naip": m.get("naip"), "horizon": m.get("horizon"),
            "formations": (m.get("geology") or {}).get("named_formations", []),
            "osm_features": (m.get("osm") or {}).get("features"), "crossings": (m.get("osm") or {}).get("crossings"),
        })
    if (d / "spine_utm.json").exists():
        row["tags"] = tag_summary(json.loads((d / "spine_utm.json").read_text()))
    if (d / "surface.json").exists():
        row["surface"] = json.loads((d / "surface.json").read_text()).get("summary")
    if (d / "web" / "manifest.json").exists():
        w = json.loads((d / "web" / "manifest.json").read_text())
        row["web"] = {"layers": list(w.get("layers", {})), "buildings": len(w.get("buildings", [])), "pois": len(w.get("pois", [])), "landuse": len(w.get("landuse", []))}
    return row


def fmt_classes(cls: dict) -> str:
    if not cls:
        return "—"
    total = sum(cls.values()) or 1
    keep = [(k, v) for k, v in sorted(cls.items(), key=lambda kv: -kv[1]) if v / total >= 0.001]
    return ", ".join(f"{k} {100 * v / total:.0f}%" for k, v in keep[:6])


def render(rows: list[dict], log: Path | None) -> str:
    now = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    L: list[str] = []
    L.append("# Corridor sites — what each bake actually holds\n")
    L.append(f"*Generated {now} by `python -m corridor.sitesdoc` from `tools/corridor/data/sites/*/manifest.json`, `spine_utm.json`, `surface.json` and the bake log{' `' + str(log) + '`' if log else ''}. Do not edit by hand; re-run it. Lidar year is read off the project name (`_D21` = 2021 delivery). The fetch itself does not record the NAIP acquisition date, so it is looked up here from the image service's catalog under the site point (the tile that covers the photo; a long corridor can straddle two flight dates). A DEM listed as \"cached\" was reused from an earlier run and its source tiles were not re-recorded (a `__main__.py` gap reported to main).*\n")
    baked = [r for r in rows if r["status"] == "baked"]
    other = [r for r in rows if r["status"] != "baked"]
    L.append(f"**{len(baked)} baked, {len(other)} not yet** ({', '.join(r['slug'] + ' (' + r['status'] + ')' for r in other) or 'none'}).\n")

    L.append("## Summary\n")
    L.append("| site | road | km | lidar project (year) | class 17 | veg classes | NAIP | DEM | structures | formations | missing |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        if r["status"] != "baked":
            L.append(f"| `{r['slug']}` | *{r['status']}* | | | | | | | | {r.get('log_error') or ''} |")
            continue
        ident = " ".join(f"{v}" for v in (r.get("ident") or {}).values()) or "?"
        cls = r["lidar_classes"]
        veg = "yes" if any(k in cls for k in ("veg_low", "veg_med", "veg_high")) else "no (unassigned)"
        q = r["lidar_quality"]
        c17 = "trusted" if q.get("class17_trusted") else ("demoted" if q else "—")
        dem = "cached" if r["dem_cached"] else (", ".join(f"{t} ({dt})" for t, dt in r["dem_sources"][:2]) or "—")
        st = r["structures"]
        kinds = {}
        for s in st:
            kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
        stx = ", ".join(f"{v} {k}" for k, v in sorted(kinds.items())) or "none"
        L.append(f"| `{r['slug']}` | {ident} | {(r.get('length_m') or 0) / 1000:.1f} | {r['lidar_dataset'] or '—'} ({lidar_year(r['lidar_dataset'])}) | {c17} | {veg} | {(r.get('naip_tile') or {}).get('date') or '?'} | {dem} | {stx} | {', '.join(r['formations'][:3])}{'…' if len(r['formations']) > 3 else ''} | {', '.join(r['missing']) or '—'} |")
    L.append("")

    L.append("## The sixteen queued 2026-09-21\n")
    L.append("| site | status | where it stands |")
    L.append("|---|---|---|")
    by = {r["slug"]: r for r in rows}
    for slug in NEW16:
        r = by.get(slug, {"slug": slug, "status": "not in sites.json"})
        where = r.get("log_error") or (", ".join(r.get("log_tail", [])[-1:]) if r.get("log_tail") else "") or (r.get("note") or "")
        if r["status"] == "baked":
            where = f"baked {r.get('fetched')} in {r.get('seconds')} s; {r['lidar_dataset'] or 'no lidar'}, {len(r['structures'])} structures"
        L.append(f"| `{slug}` | {r['status']} | {where} |")
    L.append("")

    L.append("## Per site\n")
    for r in rows:
        L.append(f"### `{r['slug']}`\n")
        if r.get("note"):
            L.append(f"*{r['note']}*  ")
        L.append(f"fix {r.get('lat')}, {r.get('lon')} · {r.get('photos', 0)} photo(s) · status **{r['status']}**\n")
        if r["status"] != "baked":
            if r.get("log_tail"):
                L.append("Last bake log lines:\n")
                L.append("```")
                L.extend(r["log_tail"])
                L.append("```")
            if r["missing"]:
                L.append(f"Missing: {', '.join(r['missing'])}\n")
            continue
        snap = r.get("snap_m") or 0
        warn = "  ⚠ **check the road**: the fix snapped this far, which usually means it landed on a different road" if snap > 250 else ""
        L.append(f"- **road**: {r.get('ident')} · {r.get('length_m')} m · snap {r.get('snap_m')} m{warn} · trimmed {r.get('trimmed')} · fetched {r.get('fetched')} ({r.get('seconds')} s)")
        L.append(f"- **lidar**: `{r['lidar_dataset']}` ({lidar_year(r['lidar_dataset'])}) · {r['lidar_points']:,} pts in corridor · z factor {r.get('lidar_zf')} · classes: {fmt_classes(r['lidar_classes'])} · class 17: {r['lidar_quality'].get('class17_share')} ({'trusted' if r['lidar_quality'].get('class17_trusted') else 'demoted'}){' — ' + r['lidar_quality']['note'] if r['lidar_quality'].get('note') else ''}")
        dem = "reused from cache (sources not re-recorded)" if r["dem_cached"] else ("; ".join(f"{t} — {dt}" for t, dt in r["dem_sources"]) or "—")
        L.append(f"- **DEM**: {dem}")
        n = r.get("naip") or {}
        nt = r.get("naip_tile") or {}
        L.append(f"- **NAIP**: {'reused from cache' if n.get('cached') else f'fetched at {n.get('res_m')} m, {n.get('size')} px'} · tile under the fix `{nt.get('tile') or '?'}` flown {nt.get('date') or '?'} at {nt.get('res_m') or '?'} m")
        L.append(f"- **OSM**: {r.get('osm_features')} features, {r.get('crossings')} crossings; spine tags: " + ("; ".join(f"`{k}`={'/'.join(v)}" for k, v in (r.get('tags') or {}).items()) or "none"))
        st = r["structures"]
        L.append(f"- **structures** ({len(st)}): " + ("; ".join(f"{s['kind']} s={s['s_start']:.0f}–{s['s_end']:.0f} ({s['length_m']} m{', clearance ' + str(s['clearance_m']) + ' m' if s.get('clearance_m') is not None else ''}{', ' + str(s['height_above_ground_m']) + ' m above ground' if s.get('height_above_ground_m') is not None else ''}, {s.get('source')})" for s in st) or "none"))
        L.append(f"- **surface** (per 20 m): {r.get('surface') or '—'}")
        L.append(f"- **geology**: {', '.join(r['formations']) or 'no named formation (Macrostrat coarse units only)'}")
        w = r.get("web") or {}
        L.append(f"- **web**: layers {w.get('layers')} · {w.get('buildings')} buildings · {w.get('pois')} POIs · {w.get('landuse')} landuse rings · authored: {', '.join(k for k, v in r['has'].items() if v) or 'none'}")
        L.append(f"- **missing**: {', '.join(r['missing']) or 'nothing'}")
        L.append("")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "corridor" / "SITES.md")
    a = ap.parse_args()
    entries = {s["slug"]: s for s in json.loads(SITES.read_text())} if SITES.exists() else {}
    slugs = sorted(set(entries) | {d.name for d in (DATA / "sites").glob("*") if d.is_dir()})
    blocks = log_blocks(a.log)
    rows = [site_row(s, DATA / "sites" / s, entries.get(s), blocks.get(s)) for s in slugs]
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(render(rows, a.log))
    print(f"{sum(r['status'] == 'baked' for r in rows)} baked / {len(rows)} sites -> {a.out}")


if __name__ == "__main__":
    main()
