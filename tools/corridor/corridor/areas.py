"""corridor areas — a first pass at `adjustments.json`, proposed from what the bake measured.

An adjustment area is a polygon in the SITE FRAME (metres, x east, y north) plus a small bag of
multipliers the viewer applies to whatever it infers inside it. The data is right most of the
time and wrong in stretches: a lidar flight that caught a hillside leaf-off reads no canopy at
all, so the trees come out as stubs; a surface classifier votes concrete across a bridge that is
asphalt. Rather than make the human hunt for those stretches, this proposes a handle over each
one, with every knob NEUTRAL. The human drags the slider; the polygon is already drawn.

Three proposers, each keyed to something the bake already measured:

    canopy   a run of stations where profile.canopy on ONE side departs from the local baseline
             (the rolling median of both sides over +-300 m) — the "reads low"/"reads high" case
    struct   one per manifest.structures entry — bridges and overpasses are where the terrain,
             the trees and the pavement all need local help at once
    surface  one per run of a single surface class — the handle for "no, this stretch is asphalt"

Ids encode WHERE, not the order they were found (`canopy-l-0420`, `struct-0500`), so re-running
after a re-bake lands on the same ids and merges instead of duplicating. Areas already in the
file are never touched: this only ever appends ids that are missing, unless --overwrite.

    python -m corridor areas <slug|all> [--overwrite] [--dry-run]
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# The key set the editor authors and the viewer consumes. Keep in step with apps/corridor/src/editor.
NEUTRAL: dict = {
    "canopy_scale": 1.0,
    "canopy_offset_m": 0.0,
    "tree_density": 1.0,
    "grass_height": 1.0,
    "grass_density": 1.0,
    "ground_offset_m": 0.0,
    "surface_class": None,
    "species": None,
}

CANOPY_WINDOW_M = 300.0   # half-width of the same-side baseline window
CANOPY_SMOOTH_M = 50.0    # a treeline wiggles station to station; smooth before comparing
CANOPY_MIN_RUN_M = 150.0  # shorter than this is a gap in the trees, not a stretch of bad data
CANOPY_GAP = 2            # stations of disagreement a run may swallow
CANOPY_FLOOR_M = 3.0      # absolute deviation that counts, whatever the baseline
CANOPY_REL = 0.6          # ...or this fraction of the baseline, whichever is larger
CANOPY_BASE_MIN_M = 1.5   # below this there is no canopy to be anomalous against
CANOPY_PER_SIDE = 6       # keep only the strongest handles; the human wants a few, not fifty
CANOPY_LOPSIDED = 0.4     # one side under this fraction of the other, site-wide, is a flight gap


class Spine:
    """The road centreline as an along-track lookup: position and unit tangent at s metres."""

    def __init__(self, coords: list[list[float]]):
        self.p = np.asarray(coords, dtype=float)[:, :2]
        step = np.linalg.norm(np.diff(self.p, axis=0), axis=1)
        self.s = np.concatenate([[0.0], np.cumsum(step)])
        self.length = float(self.s[-1])

    def at(self, s: float) -> tuple[np.ndarray, np.ndarray]:
        s = float(np.clip(s, 0.0, self.length))
        x = np.interp(s, self.s, self.p[:, 0])
        y = np.interp(s, self.s, self.p[:, 1])
        h = max(1.0, self.length * 1e-4)
        a = max(0.0, s - h)
        b = min(self.length, s + h)
        d = np.array([np.interp(b, self.s, self.p[:, 0]) - np.interp(a, self.s, self.p[:, 0]),
                      np.interp(b, self.s, self.p[:, 1]) - np.interp(a, self.s, self.p[:, 1])])
        n = float(np.linalg.norm(d))
        return np.array([x, y]), (d / n if n > 1e-9 else np.array([1.0, 0.0]))

    def offset(self, s: float, lateral: float) -> list[float]:
        """A point `lateral` metres LEFT of travel at s (negative = right), as [x, y]."""
        p, d = self.at(s)
        q = p + np.array([-d[1], d[0]]) * lateral
        return [round(float(q[0]), 1), round(float(q[1]), 1)]


def band(spine: Spine, s0: float, s1: float, left: float, right: float, samples: int | None = None) -> list[list[float]]:
    """A polygon following the spine from s0 to s1, `left` metres out on one side and `right` on
    the other (both signed, left of travel positive). Points that fold back on the inside of a
    curve are dropped, so the ring stays simple.

    Sample spacing matters more than it looks: a band down a 4 km site drawn with a dozen points
    cuts every corner, and the two edges cross where the road bends — an invalid ring. One point
    per 60 m keeps the chords inside the offset.
    """
    s0, s1 = max(0.0, min(s0, s1)), min(spine.length, max(s0, s1))
    if samples is None:
        samples = int(round((s1 - s0) / 60.0)) + 2
    n = max(2, min(64, int(samples)))
    ss = np.linspace(s0, s1, n)

    def edge(lateral: float, forward: bool) -> list[list[float]]:
        out: list[list[float]] = []
        order = ss if forward else ss[::-1]
        last = None
        for s in order:
            p, d = spine.at(float(s))
            q = p + np.array([-d[1], d[0]]) * lateral
            # on the inside of a tight curve the offset edge can walk backwards; skip those
            if last is not None and float(np.dot(q - last, d if forward else -d)) <= 0.05:
                continue
            out.append([round(float(q[0]), 1), round(float(q[1]), 1)])
            last = q
        return out

    ring = edge(left, True) + edge(right, False)
    return ring if len(ring) >= 3 else [spine.offset(s0, left), spine.offset(s1, left), spine.offset(s1, right), spine.offset(s0, right)]


def runs(mask: np.ndarray, gap: int = 0, min_len: int = 1) -> list[tuple[int, int]]:
    """Inclusive [i, j] runs of True, merging runs separated by at most `gap` False stations."""
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    out: list[list[int]] = [[int(idx[0]), int(idx[0])]]
    for k in idx[1:]:
        if k - out[-1][1] <= gap + 1:
            out[-1][1] = int(k)
        else:
            out.append([int(k), int(k)])
    return [(a, b) for a, b in out if b - a + 1 >= min_len]


def _rolling(values: np.ndarray, half: int, fn) -> np.ndarray:
    """fn over a +-half station window. Small n; a loop is clearer than a stride trick."""
    n = values.size
    out = np.zeros(n)
    for i in range(n):
        out[i] = float(fn(values[max(0, i - half) : min(n, i + half + 1)]))
    return out


def _canopy_sides(profile: dict) -> dict[str, np.ndarray] | None:
    """Canopy height per side, averaged over the offsets the profile measured (15 m and 40 m)."""
    c = profile.get("canopy") or {}
    sides = {}
    for side, keys in (("left", ("left_15", "left_40")), ("right", ("right_15", "right_40"))):
        cols = [np.asarray(c[k], dtype=float) for k in keys if k in c]
        if not cols:
            return None
        sides[side] = np.nan_to_num(np.nanmean(np.vstack(cols), axis=0))
    return sides


def _drop_overlaps(found: list[dict]) -> list[dict]:
    """Strongest first; a weaker run that overlaps one already kept is the same stretch twice."""
    kept: list[dict] = []
    for f in sorted(found, key=lambda f: -f["weight"]):
        if any(f["i"] <= k["j"] and k["i"] <= f["j"] for k in kept):
            continue
        kept.append(f)
    return kept


def canopy_areas(spine: Spine, profile: dict) -> list[dict]:
    """Where the canopy the lidar measured disagrees with itself.

    Two different disagreements, and they need different shapes of answer:

    * a STRETCH that departs from the same side's rolling median — a clearing the flight caught
      as bare, or a hedgerow it read as forest. One polygon over that stretch.
    * a whole SIDE that reads far lower than the other across the entire site — a leaf-off swath,
      a flight line that ended at the carriageway. One polygon down the whole side; thirty little
      ones would be thirty sliders for one mistake.
    """
    sides = _canopy_sides(profile)
    if sides is None:
        return []
    s = np.asarray(profile["s"], dtype=float)
    if s.size < 8:
        return []
    ds = float(np.median(np.diff(s))) or 10.0
    half = max(1, int(round(CANOPY_WINDOW_M / ds)))
    smooth = max(1, int(round(CANOPY_SMOOTH_M / ds)) // 2)
    min_run = max(2, int(round(CANOPY_MIN_RUN_M / ds)))
    out: list[dict] = []

    # --- one side dead against the other, over the whole site ---------------------------------
    # The MEAN, not the median: half of a corridor is mown verge, so a side with a solid wood
    # over a third of its length still has a median of zero. The mean is "how much forest is on
    # this side", which is the quantity the two sides should roughly agree on.
    med = {k: float(np.mean(v)) for k, v in sides.items()}
    for side, other in (("left", "right"), ("right", "left")):
        if med[other] >= 3.0 and med[side] <= med[other] * CANOPY_LOPSIDED:
            lateral = 1.0 if side == "left" else -1.0
            out.append({
                "id": f"canopy-{side[0]}-site",
                "name": f"whole {side} side reads bare ({med[side]:.1f} m vs {med[other]:.1f} m on the {other})",
                "source": "canopy",
                "polygon": band(spine, 0.0, spine.length, *sorted((lateral * 6.0, lateral * 55.0), reverse=lateral > 0)),
                "adjust": dict(NEUTRAL),
            })

    # --- stretches that depart from their own side's baseline ----------------------------------
    for side, lateral in (("left", 1.0), ("right", -1.0)):
        if any(a["id"] == f"canopy-{side[0]}-site" for a in out):
            continue  # the whole side is already one handle; do not also chop it up
        val = _rolling(sides[side], smooth, np.mean)
        base = _rolling(sides[side], half, np.median)
        dev = val - base
        thresh = np.maximum(CANOPY_FLOOR_M, base * CANOPY_REL)
        worth = base >= CANOPY_BASE_MIN_M
        found = []
        for sense, mask in (("low", worth & (dev <= -thresh)), ("high", worth & (dev >= thresh))):
            for i, j in runs(mask, gap=CANOPY_GAP, min_len=min_run):
                span = float(s[min(j, s.size - 1)]) - float(s[i])
                if span < CANOPY_MIN_RUN_M:
                    continue
                found.append({"i": i, "j": j, "sense": sense, "weight": float(np.mean(np.abs(dev[i : j + 1]))) * span})
        for f in sorted(_drop_overlaps(found), key=lambda f: -f["weight"])[:CANOPY_PER_SIDE]:
            i, j = f["i"], f["j"]
            s0, s1 = float(s[i]), float(s[min(j, s.size - 1)])
            measured = float(np.mean(sides[side][i : j + 1]))
            expected = float(np.mean(base[i : j + 1]))
            out.append({
                "id": f"canopy-{side[0]}-{int(round(s0)):04d}",
                "name": f"canopy reads {f['sense']} on the {side}, {s0:.0f}–{s1:.0f} m ({measured:.1f} m vs {expected:.1f} m along the rest of that side)",
                "source": "canopy",
                "polygon": band(spine, s0 - 20, s1 + 20, *sorted((lateral * 6.0, lateral * 55.0), reverse=lateral > 0)),
                "adjust": dict(NEUTRAL),
            })
    return out


def structure_areas(spine: Spine, structures: list[dict]) -> list[dict]:
    """One per bridge, overpass or gantry: where ground, trees and pavement all want local help."""
    out = []
    for st in structures:
        s0 = float(st.get("s_start", 0.0))
        s1 = float(st.get("s_end", s0))
        kind = st.get("kind", "structure")
        pad = 40.0 if kind != "gantry" else 25.0
        out.append({
            "id": f"struct-{int(round(s0)):04d}",
            "name": f"{kind} at {s0:.0f}–{s1:.0f} m",
            "source": "structure",
            "polygon": band(spine, s0 - pad, s1 + pad, 70.0, -70.0, samples=10),
            "adjust": dict(NEUTRAL),
        })
    return out


def surface_areas(spine: Spine, surface: dict) -> list[dict]:
    """One per run of a single surface class, so 'no, this stretch is asphalt' is one drag."""
    segs = [sg for sg in (surface.get("segments") or []) if sg.get("class")]
    if not segs:
        return []
    merged: list[dict] = []
    for sg in sorted(segs, key=lambda g: g["s_start"]):
        if merged and merged[-1]["class"] == sg["class"] and sg["s_start"] - merged[-1]["s_end"] < 1.0:
            merged[-1]["s_end"] = float(sg["s_end"])
        else:
            merged.append({"class": sg["class"], "s_start": float(sg["s_start"]), "s_end": float(sg["s_end"])})
    out = []
    for m in merged:
        if m["s_end"] - m["s_start"] < 30.0:
            continue
        out.append({
            "id": f"surface-{int(round(m['s_start'])):04d}",
            "name": f"{m['class']} run, {m['s_start']:.0f}–{m['s_end']:.0f} m",
            "source": "surface",
            "polygon": band(spine, m["s_start"], m["s_end"], 30.0, -30.0),
            "adjust": dict(NEUTRAL),
        })
    return out


def propose(manifest: dict) -> list[dict]:
    """Every proposer, run over one web manifest, ids made unique."""
    coords = (manifest.get("spine") or {}).get("coords") or []
    if len(coords) < 2:
        return []
    spine = Spine(coords)
    out: list[dict] = []
    if manifest.get("profile"):
        out += canopy_areas(spine, manifest["profile"])
    out += structure_areas(spine, manifest.get("structures") or [])
    if manifest.get("surface"):
        out += surface_areas(spine, manifest["surface"])
    seen: set[str] = set()
    for a in out:
        base = a["id"]
        k = 1
        while a["id"] in seen:
            a["id"] = f"{base}-{k}"
            k += 1
        seen.add(a["id"])
    return out


def write_site(site_dir: Path, overwrite: bool = False, dry_run: bool = False) -> dict:
    """Merge proposals into <site_dir>/adjustments.json. Existing areas are never modified."""
    web = site_dir / "web" / "manifest.json"
    if not web.exists():
        return {"slug": site_dir.name, "skipped": "no web/manifest.json"}
    manifest = json.loads(web.read_text())
    proposed = propose(manifest)
    out = site_dir / "adjustments.json"
    existing: list[dict] = []
    if out.exists() and not overwrite:
        try:
            existing = json.loads(out.read_text()).get("areas", [])
        except json.JSONDecodeError:
            existing = []
    have = {a.get("id") for a in existing}
    added = [a for a in proposed if a["id"] not in have]
    doc = {"version": 1, "areas": existing + added}
    if not dry_run:
        tmp = out.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=1))
        tmp.replace(out)
    by = {}
    for a in added:
        by[a.get("source", "?")] = by.get(a.get("source", "?"), 0) + 1
    return {"slug": site_dir.name, "kept": len(existing), "added": len(added), "by_source": by, "path": str(out)}


def main(sites_dir: Path, slug: str, overwrite: bool = False, dry_run: bool = False) -> None:
    dirs = [d for d in sorted(sites_dir.glob("*")) if d.is_dir() and (slug == "all" or d.name == slug)]
    if not dirs:
        raise SystemExit(f"no site {slug!r} under {sites_dir}")
    for d in dirs:
        r = write_site(d, overwrite=overwrite, dry_run=dry_run)
        if "skipped" in r:
            print(f"{r['slug']:24s} skipped: {r['skipped']}")
        else:
            by = ", ".join(f"{v} {k}" for k, v in sorted(r["by_source"].items())) or "nothing new"
            print(f"{r['slug']:24s} kept {r['kept']:3d}  added {r['added']:3d}  ({by})")
