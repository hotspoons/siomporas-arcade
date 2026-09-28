#!/usr/bin/env python3
"""Does reading a LAZ tile in chunks give the same points, for a fraction of the memory?

Rich's t-section bake was killed by the kernel on the fifth of seventeen tiles with 3 GB free, and
the runner reported `exited null`. `laspy.read` holds the whole tile: one 213 MiB delivery is 36.5
million points and peaks at 2.44 GB — the point record, then x and y as float64, then the
reprojected pair, then z. 72 bytes of peak per point, for a tile of which a 9.5 km² corridor keeps
about 3.5 million.

TWO CLAIMS, and the second is the one that matters. The memory is easy to check and easy to buy by
accident — dropping a field, or a mask applied in the wrong order, would also make it smaller. So
this runs the OLD reader verbatim beside the new one and compares the output element for element.
A bake that differs from every bake before it is a worse problem than the memory was.

    tools/corridor/.venv/bin/python probes/corridor-lazchunk.py [tile.laz]
"""
import resource
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "corridor"))

import laspy  # noqa: E402
import numpy as np  # noqa: E402
import shapely  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

from corridor.geo import Frame  # noqa: E402
from corridor.lidar import LAZ_CHUNK, _read_laz_tile  # noqa: E402

#: what the chunked reader may peak at, in GB, for any tile. Generous against the 0.72 measured.
CEILING_GB = 1.25


def old_reader(path, frame, bbox, clip):
    """The whole-tile reader, verbatim as it was before the chunking, for the comparison."""
    las = laspy.read(path)
    crs = las.header.parse_crs()
    rx, ry = np.asarray(las.x), np.asarray(las.y)
    tr = Transformer.from_crs(crs, frame.crs, always_xy=True)
    x, y = tr.transform(rx, ry)
    x, y = np.asarray(x), np.asarray(y)
    xmin, ymin, xmax, ymax = bbox
    m = (x >= xmin) & (x < xmax) & (y >= ymin) & (y < ymax)
    if clip is not None and m.any():
        idx = np.flatnonzero(m)
        inside = shapely.contains_xy(clip, x[idx], y[idx])
        m[idx[~inside]] = False
    if not m.any():
        return None
    z = np.asarray(las.z)[m]
    try:
        unit = crs.axis_info[0].unit_name if crs.axis_info else "metre"
    except Exception:
        unit = "metre"
    if "foot" in unit or "feet" in unit:
        z = z * 0.3048006096
    return {
        "x": x[m], "y": y[m], "z": z,
        "cls": np.asarray(las.classification)[m].astype(np.uint8),
        "rn": np.asarray(las.return_number)[m].astype(np.uint8),
        "nr": np.asarray(las.number_of_returns)[m].astype(np.uint8),
        "i": np.asarray(las.intensity)[m].astype(np.uint16),
    }


def find_tile() -> Path | None:
    laz = ROOT / "tools" / "corridor" / "data" / "cache" / "laz"
    tiles = sorted(laz.rglob("*.laz"), key=lambda p: -p.stat().st_size)
    return tiles[0] if tiles else None


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else find_tile()
    if path is None or not path.exists():
        print("SKIP: no cached LAZ tile to read; fetch a site with lidar first")
        return 0

    # a bbox and a diagonal corridor through the middle of this tile — the shape a real site has,
    # because a bbox that keeps everything exercises neither the mask nor the clip
    with laspy.open(path) as r:
        crs = r.header.parse_crs()
        cx = (r.header.mins[0] + r.header.maxs[0]) / 2
        cy = (r.header.mins[1] + r.header.maxs[1]) / 2
        n_total = r.header.point_count
    frame = Frame(26918, (0.0, 0.0))
    tx, ty = Transformer.from_crs(crs, frame.crs, always_xy=True).transform(cx, cy)
    bbox = (tx - 500, ty - 500, tx + 500, ty + 500)
    clip = Polygon([(tx - 500, ty - 300), (tx + 500, ty + 100), (tx + 500, ty + 300), (tx - 500, ty - 100)])

    peak = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576  # noqa: E731
    print(f"{path.name}: {path.stat().st_size / 2**20:.0f} MiB, {n_total:,} points, chunk {LAZ_CHUNK:,}")

    new = _read_laz_tile(path, frame, bbox, clip)
    new_peak = peak()
    print(f"  chunked      {len(new['x']) if new else 0:,} points kept, peak {new_peak:.2f} GB")

    old = old_reader(path, frame, bbox, clip)
    print(f"  whole tile   {len(old['x']) if old else 0:,} points kept, peak {peak():.2f} GB")

    bad = []
    if (new is None) != (old is None):
        bad.append(f"one reader returned points and the other did not: chunked={new is not None}")
    elif new is not None:
        if len(new["x"]) != len(old["x"]):
            bad.append(f"kept {len(new['x']):,} points against {len(old['x']):,}")
        else:
            for k in old:
                if k not in new:
                    bad.append(f"the chunked reader dropped {k!r}")
                elif new[k].dtype != old[k].dtype:
                    bad.append(f"{k}: dtype {new[k].dtype} against {old[k].dtype}")
                elif not np.array_equal(new[k], old[k]):
                    d = int((new[k] != old[k]).sum())
                    bad.append(f"{k}: {d:,} of {len(old[k]):,} values differ")
    if not bad:
        print(f"  identical    {len(new['x']):,} points, every field, element for element")
    if new_peak > CEILING_GB:
        bad.append(f"peaked at {new_peak:.2f} GB, over the {CEILING_GB} GB ceiling")
    # a run over a tile the corridor misses entirely proves nothing about either claim
    if new is not None and len(new["x"]) < 10_000:
        bad.append(f"only {len(new['x'])} points fell in the test corridor — this run measured nothing")

    if bad:
        print("\nFAIL:\n  " + "\n  ".join(bad))
        return 1
    print(f"\nPASS: same points, peak {new_peak:.2f} GB against {peak():.2f} GB for the whole tile")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
