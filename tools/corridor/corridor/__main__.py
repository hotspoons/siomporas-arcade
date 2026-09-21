"""corridor — a strip of real road and everything the public record knows about it.

    python -m corridor sites                      # photos in ext/ref-driving -> sites.json
    python -m corridor fetch <slug|all> [opts]    # build data/sites/<slug>/ for each site
    python -m corridor report [slug]              # one-screen summary of what was found
    python -m corridor areas <slug|all>           # seed data/sites/<slug>/adjustments.json

A site directory is the contract with the game side:

    site.json          the photo fix(es), the frame (UTM EPSG + origin), the corridor bbox
    spine.geojson      the carriageway we drove, trimmed to ±half-length, WGS84 (game reads
                       spine_utm.json — same line, metres, plus per-way OSM tags by along-track m)
    osm.geojson        every tagged feature in the corridor, raw tags
    crossings.json     ways crossing the spine, with OSM's over/under guess
    dem_1m.tif         bare-earth DEM, 1 m, site frame
    naip.tif           30 cm imagery, site frame
    lidar/             corridor.laz + dtm/dsm/chm/deck rasters at 1 m
    profile.json       along-track: road z, ground beside the road at 5 offsets, canopy at 5
                       offsets, and structures (bridge/overpass) measured from bridge-deck returns
    geology.json       Macrostrat units under the spine
    preview.png        imagery with the spine, crossings and structures drawn on
    manifest.json      what was fetched, from where, when
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
# In the container these point at the mounted volume; in the devcontainer at tools/corridor/data.
DATA = Path(os.environ.get("CORRIDOR_DATA", HERE / "data"))
CACHE = DATA / "cache"
SITES = Path(os.environ.get("CORRIDOR_SITES", HERE / "sites.json"))
PHOTOS = Path(os.environ.get("CORRIDOR_PHOTOS", HERE.parent.parent / "ext" / "ref-driving"))


def cmd_sites(_: argparse.Namespace) -> None:
    from . import sites

    sites.main(PHOTOS, SITES)



def _keep_provenance(previous: dict | None, fresh: dict) -> dict:
    """A cached re-fetch returns {"file", "cached": true}; keep the first run's source tiles and
    dates under it instead of losing them (terrain-and-data agent, 2026-09-21)."""
    if fresh.get("cached") and previous and not previous.get("cached"):
        return {**previous, "cached": True}
    if fresh.get("cached") and previous:
        return {**previous, **fresh}
    return fresh

def fetch_site(site: dict, half_length: float, half_width: float, lidar_half_width: float, skip: set[str]) -> None:
    from shapely.geometry import mapping

    from . import dem, geo, geology, lidar, naip, osm

    slug = site["slug"]
    out = DATA / "sites" / slug
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print(f"=== {slug}  ({site['lat']:.5f}, {site['lon']:.5f})")
    frame = geo.Frame.at(site["lon"], site["lat"])
    # a partial re-run (--skip ...) updates the manifest it finds rather than forgetting the rest
    manifest: dict = json.loads((out / "manifest.json").read_text()) if (out / "manifest.json").exists() else {}
    manifest |= {"slug": slug, "frame": {"epsg": frame.epsg, "origin": frame.origin}, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "params": {"half_length_m": half_length, "half_width_m": half_width, "lidar_half_width_m": lidar_half_width, "horizon_radius_m": float(os.environ.get("CORRIDOR_HORIZON_M", "30000"))}}

    sp = osm.spine(site, frame, CACHE / "overpass", half_length, half_length + 800)
    line = sp["line"]
    print(f"  spine   {sp['ident']}  {sp['length_m']} m, photo at s={sp['photo_s']} (snap {sp['snap_distance_m']} m), {len(sp['segments'])} ways, {len(sp['siblings'])} sibling chains")
    corridor = line.buffer(half_width, cap_style="flat")
    lidar_corridor = line.buffer(lidar_half_width, cap_style="flat")
    bbox = geo.snap_bbox(corridor.bounds)
    xs, ys = np.array(line.coords)[:, 0], np.array(line.coords)[:, 1]
    lon, lat = frame.to_wgs(xs, ys)
    (out / "spine.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {**sp["ident"], "photo_s": sp["photo_s"]}, "geometry": {"type": "LineString", "coordinates": np.column_stack([lon, lat]).round(7).tolist()}}]}))
    (out / "spine_utm.json").write_text(json.dumps({"epsg": frame.epsg, "coords": np.array(line.coords).round(2).tolist(), "photo_s": sp["photo_s"], "segments": sp["segments"], "siblings": [{**s, "geometry": s["geometry"]} for s in sp["siblings"]]}))
    manifest["spine"] = {k: v for k, v in sp.items() if k not in ("line", "segments", "siblings")}

    feats = osm.features(corridor, frame, CACHE / "overpass")
    (out / "osm.geojson").write_text(json.dumps(feats))
    cross = osm.crossings(line, feats, sp["ident"], frame, sp["segments"])
    (out / "crossings.json").write_text(json.dumps(cross, indent=1))
    print(f"  osm     {len(feats['features'])} features, {len(cross)} crossings: " + ", ".join(f"{c['kind']}@{c['s']:.0f}m {c['relation']}" for c in cross[:12]))
    manifest["osm"] = {"features": len(feats["features"]), "crossings": len(cross)}

    site_json = {**site, "frame": manifest["frame"], "bbox_utm": bbox, "corridor": mapping(corridor), "ident": sp["ident"]}
    (out / "site.json").write_text(json.dumps(site_json))

    if "dem" not in skip:
        manifest["dem"] = _keep_provenance(manifest.get("dem"), dem.fetch_dem(frame, bbox, out / "dem_1m.tif", CACHE))
    if "naip" not in skip:
        manifest["naip"] = _keep_provenance(manifest.get("naip"), naip.fetch_naip(frame, bbox, out / "naip.tif", CACHE))
    if "horizon" not in skip:
        from . import horizon

        manifest["horizon"] = _keep_provenance(manifest.get("horizon"), horizon.fetch_horizon(frame, out / "horizon_30m.tif", CACHE, radius_m=a_radius(manifest)))
    if "geology" not in skip:
        g = geology.along_spine(line, frame, site, CACHE, out)
        (out / "geology.json").write_text(json.dumps(g, indent=1))
        print(f"  geology {len(g['units'])} units; named: {', '.join(g['named_formations'][:6])}")
        manifest["geology"] = {"units": len(g["units"]), "named_formations": g["named_formations"]}
    if "lidar" not in skip:
        ldir = out / "lidar"
        ldir.mkdir(exist_ok=True)
        lbbox = geo.snap_bbox(lidar_corridor.bounds)
        pts, meta = lidar.fetch_points(frame, lbbox, CACHE, clip=lidar_corridor)
        if (out / "dem_1m.tif").exists():
            f = lidar.check_units(pts, out / "dem_1m.tif")
            if f != 1.0:
                pts["z"] = pts["z"] * f
            meta["z_factor"] = f
        meta["classification"] = lidar.classification_quality(pts)
        r = lidar.rasters(pts, lbbox, frame, lidar_corridor, ldir)
        prof = lidar.profile(line, r["dtm"], r["chm"], r["transform"], r["pts"])
        (out / "profile.json").write_text(json.dumps(prof))
        cls = r["classes"]
        print(f"  lidar   {r['points_in_corridor']:,} pts in corridor; ground {cls.get('ground', 0):,} veg {cls.get('veg_high', 0) + cls.get('veg_med', 0) + cls.get('veg_low', 0):,} building {cls.get('building', 0):,} bridge_deck {cls.get('bridge_deck', 0):,}")
        for st in prof["structures"]:
            print(f"  struct  {st['kind']:8s} s={st['s_start']:.0f}..{st['s_end']:.0f} m ({st['length_m']} m)  clearance={st['clearance_m']}  above_ground={st['height_above_ground_m']}")
        manifest["lidar"] = {**meta, "points_in_corridor": r["points_in_corridor"], "classes": cls, "rasters": r["rasters"], "structures": prof["structures"]}
    try:
        from . import preview

        preview.render(out)
    except Exception as exc:  # a preview is a courtesy, never the reason a fetch fails
        print(f"  preview failed: {exc}")
    manifest["seconds"] = round(time.time() - t0, 1)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    if "surface" not in skip:
        try:
            from . import surface

            sf = surface.measure(out)
            if sf:
                print(f"  surface {sf['summary']}")
                manifest["surface"] = sf["summary"]
        except Exception as exc:
            print(f"  surface failed: {exc}")
    try:
        from . import export

        ex = export.export_site(out)
        export.write_index(DATA / "sites")
        print(f"  web     {', '.join(ex['layers'])} ({ex['bytes'] / 2**20:.1f} MiB)")
    except Exception as exc:
        print(f"  web export failed: {exc}")
    # written again: the surface summary is measured after the first write above
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    print(f"  done    {manifest['seconds']} s -> {out}")


def a_radius(manifest: dict) -> float:
    return float(manifest.get("params", {}).get("horizon_radius_m", 30000.0))


def cmd_fetch(a: argparse.Namespace) -> None:
    sites = json.loads(SITES.read_text())
    wanted = sites if a.slug == "all" else [s for s in sites if s["slug"] == a.slug]
    if not wanted:
        sys.exit(f"no site {a.slug!r}; run `python -m corridor sites` and pick from: {[s['slug'] for s in sites]}")
    skip = set(filter(None, a.skip.split(",")))
    for s in wanted:
        fetch_site(s, a.half_length, a.half_width, a.lidar_half_width, skip)


def cmd_report(a: argparse.Namespace) -> None:
    for d in sorted((DATA / "sites").glob("*")):
        m = d / "manifest.json"
        if not m.exists():
            continue
        j = json.loads(m.read_text())
        sp = j.get("spine", {})
        li = j.get("lidar", {})
        print(f"{j['slug']:24s} {sp.get('ident')} {sp.get('length_m')} m  osm {j.get('osm', {}).get('features')}  lidar {li.get('points_in_corridor', 0):,} pts  structures {len(li.get('structures', []))}  geology {j.get('geology', {}).get('named_formations')}")


def cmd_export(a: argparse.Namespace) -> None:
    from . import export, surface

    for d in sorted((DATA / "sites").glob("*")):
        if (d / "site.json").exists() and (a.slug == "all" or d.name == a.slug):
            if not (d / "surface.json").exists() or a.resurface:
                sf = surface.measure(d)
                if sf:
                    print(f"{d.name:24s} surface {sf['summary']}")
            ex = export.export_site(d)
            print(f"{d.name:24s} {', '.join(ex['layers'])}  {ex['bytes'] / 2**20:.1f} MiB")
    print(export.write_index(DATA / "sites"))


def cmd_areas(a: argparse.Namespace) -> None:
    from . import areas

    areas.main(DATA / "sites", a.slug, overwrite=a.overwrite, dry_run=a.dry_run)


def cmd_publish(a: argparse.Namespace) -> None:
    from . import publish

    publish.sync(DATA / "sites", a.slug, a.prefix, dry_run=a.dry_run)


def main() -> None:
    p = argparse.ArgumentParser(prog="corridor")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sites").set_defaults(fn=cmd_sites)
    f = sub.add_parser("fetch")
    f.add_argument("slug")
    f.add_argument("--half-length", type=float, default=3219.0, help="metres along the road each way from the photo (default 2 miles)")
    f.add_argument("--half-width", type=float, default=300.0, help="OSM/DEM/NAIP corridor half-width, metres")
    f.add_argument("--lidar-half-width", type=float, default=200.0, help="point-cloud corridor half-width, metres")
    f.add_argument("--skip", default="", help="comma list of dem,naip,lidar,geology,horizon,surface")
    f.set_defaults(fn=cmd_fetch)
    sub.add_parser("report").set_defaults(fn=cmd_report)
    ex = sub.add_parser("export", help="(re)write web/ layers + sites/index.json for the viewer")
    ex.add_argument("slug", nargs="?", default="all")
    ex.add_argument("--resurface", action="store_true", help="re-measure surface.json even if present")
    ex.set_defaults(fn=cmd_export)
    ar = sub.add_parser("areas", help="propose adjustment-area polygons into <site>/adjustments.json")
    ar.add_argument("slug", nargs="?", default="all")
    ar.add_argument("--overwrite", action="store_true", help="replace the file instead of appending missing ids")
    ar.add_argument("--dry-run", action="store_true")
    ar.set_defaults(fn=cmd_areas)
    pub = sub.add_parser("publish", help="sync data/sites to an S3-compatible bucket (R2); env CORRIDOR_S3_* / AWS_*")
    pub.add_argument("slug", nargs="?", default="all")
    pub.add_argument("--prefix", default=os.environ.get("CORRIDOR_S3_PREFIX", "corridor"))
    pub.add_argument("--dry-run", action="store_true")
    pub.set_defaults(fn=cmd_publish)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
