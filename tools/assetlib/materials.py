"""Mid-Atlantic building materials: tileable PBR sets for walls, roofs and commercial façades.

    tools/corridor/.venv/bin/python ext/assetlib/tool/materials.py            # everything
    tools/corridor/.venv/bin/python ext/assetlib/tool/materials.py brick_colonial_red
    tools/corridor/.venv/bin/python ext/assetlib/tool/materials.py --list

This is the sibling of tools/surfaces/gen.py and it deliberately IMPORTS that module's three hard
parts rather than restating them: `flux_image`, `make_tileable` (roll the tile half a period and
blend the resulting cross seam, which works because the statistics are stationary) and
`normal_from_albedo` (wrap-around Sobel on an albedo-derived height field, plus inverted blurred
albedo as roughness). Those were paid for on road surfaces; a second copy would only drift.

WHAT IS DIFFERENT HERE IS SCALE, and it is the whole game for architecture. Pavement is scaleless —
one patch of asphalt looks like any other at any size. A wall is not: a brick course is 65 mm plus
a 10 mm joint, clapboard shows about 150 mm, a CMU block is 400x200. Get `metres_per_tile` wrong and
a house reads as a doll's house or a cathedral. So every prompt states the real size of the area it
is drawing, every entry records the same number, and the consumer scales UVs by it. Never eyeball it
in the shader — see the standing note about hand-typed widths.

STATIONARITY IS A HARD REQUIREMENT of the roll-and-blend tiler: a single big feature in the frame
comes back as a cross-shaped smear down the middle of the tile. gen.py learned this when an
asphalt-patch prompt produced one large patch. For masonry it means "evenly distributed variation
edge to edge, no feature larger than a hand", stated in every prompt.

GLASS IS NOT A TEXTURE. A curtain wall's mullion grid is opaque and belongs here; the glass between
is KHR_materials_transmission with an ior, and no albedo can stand in for it. Entries marked with a
`glass` block therefore also emit `glass_mask.png` — the dark regions of the albedo, which are the
panes — so a consumer can split the façade into an opaque frame and a transmissive pane set instead
of pretending a dark jpg is a window.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools" / "surfaces"))

import numpy as np                                   # noqa: E402
from PIL import Image, ImageFilter                   # noqa: E402
from scipy import ndimage                            # noqa: E402
from gen import flux_image, make_tileable, normal_from_albedo   # noqa: E402

LIB = Path(__file__).resolve().parents[1]
OUT = LIB / "surfaces"
SPECS = LIB / "specs" / "materials-buildings.json"


def draw_curtain_wall(spec: dict, size: int = 1024) -> tuple[Image.Image, Image.Image]:
    """Draw a mullion grid exactly, instead of asking flux for one.

    A curtain wall defeats the roll-and-blend tiler outright. That tiler assumes STATIONARY
    statistics — brick and shingle qualify, a storey-high spandrel band does not — so the blend
    smears the large feature into a bright cross straight down the middle of the tile. It is
    clearly visible in the first attempt.

    It is also the one material here that does not need a generative model at all. A mullion grid
    is regular geometry: drawing it gives exact real-world bay spacing, a perfectly tileable result
    by construction, and a pane mask that is exact rather than thresholded. Procedural beats
    generative whenever the subject is a grid.
    """
    m = spec["metres_per_tile"]
    px = size / m                                    # pixels per metre
    g = spec["procedural"]
    bay_w, bay_h, mull = g["bay_w"], g["bay_h"], g["mullion"]
    frame = np.array(g["frame_colour"], dtype=np.float32)
    pane = np.array(g["pane_colour"], dtype=np.float32)

    # Snap the bay to a whole number across the tile, or the grid will not wrap.
    nx = max(1, round(m / bay_w))
    ny = max(1, round(m / bay_h))
    step_x, step_y = size / nx, size / ny
    half = max(1.0, mull * px / 2)

    img = np.zeros((size, size, 3), dtype=np.float32)
    img[:] = pane
    # Per-pane tint variation: real glazing is never one flat colour across a façade.
    rng = np.random.default_rng(g.get("seed", 3))
    for j in range(ny):
        for i in range(nx):
            y0, y1 = int(j * step_y), int((j + 1) * step_y)
            x0, x1 = int(i * step_x), int((i + 1) * step_x)
            img[y0:y1, x0:x1] *= 1.0 + rng.normal(0, g.get("pane_variation", 0.06))
    # A soft vertical gradient inside each pane reads as sky reflection without naming a sky.
    grad = np.linspace(1.12, 0.9, int(step_y))[:, None, None]
    for j in range(ny):
        y0 = int(j * step_y)
        y1 = min(size, y0 + grad.shape[0])
        img[y0:y1] *= grad[: y1 - y0]

    mask = np.full((size, size), 255, dtype=np.uint8)
    # Mullions last, so they sit over the panes and the mask is their exact complement. Drawn with
    # wraparound at 0 so the grid lines at the tile edge are whole, not half.
    for i in range(nx):
        c = i * step_x
        for off in (-size, 0):
            lo, hi = int(round(c + off - half)), int(round(c + off + half))
            lo, hi = max(0, lo), min(size, hi)
            if hi > lo:
                img[:, lo:hi] = frame
                mask[:, lo:hi] = 0
    for j in range(ny):
        c = j * step_y
        for off in (-size, 0):
            lo, hi = int(round(c + off - half)), int(round(c + off + half))
            lo, hi = max(0, lo), min(size, hi)
            if hi > lo:
                img[lo:hi, :] = frame
                mask[lo:hi, :] = 0

    rgb = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    return rgb, Image.fromarray(mask)


def apply_overlay(base: Image.Image, spec: dict) -> Image.Image:
    """Draw regular structure on top of a stationary generated base.

    THE SAME LESSON AS THE CURTAIN WALL, generalised. The roll-and-blend tiler needs stationary
    statistics. Brick, stucco and plain weathered zinc qualify. Tudor half-timbering, a standing
    seam roof and corrugated sheet do not: each is dominated by one large regular feature, and the
    tiler smeared every one of them into a visible cross.

    They are also all trivially describable as geometry. So flux draws only the MATERIAL — plain
    stucco, plain oxidised zinc — which tiles cleanly, and the structure is drawn here at exact
    real-world spacing, wrapping by construction. Generative for texture, procedural for grids.
    """
    a = np.asarray(base.convert("RGB")).astype(np.float32)
    size = a.shape[0]
    px = size / spec["metres_per_tile"]
    o = spec["overlay"]
    kind = o["type"]

    if kind == "corrugate":
        # A sine across the sheet, shaded as if lit from the upper left. Whole periods only, or the
        # wave steps at the tile edge.
        n = max(1, round(spec["metres_per_tile"] / o["period"]))
        x = np.arange(size, dtype=np.float32) / size
        shade = 1.0 + o.get("depth", 0.35) * np.sin(2 * np.pi * n * x + o.get("phase", 0.0))
        a *= shade[None, :, None]

    elif kind == "vseams":
        # Standing seams: a raised rib every `spacing` metres, with a highlight on one side and a
        # shadow on the other so it reads as relief rather than a painted stripe.
        n = max(1, round(spec["metres_per_tile"] / o["spacing"]))
        step = size / n
        half = max(1.0, o.get("width", 0.03) * px / 2)
        for i in range(n):
            c = i * step
            for off in (-size, 0, size):
                lo, hi = int(round(c + off - half)), int(round(c + off + half))
                lo, hi = max(0, lo), min(size, hi)
                if hi <= lo:
                    continue
                a[:, lo:hi] *= 1.0 + o.get("highlight", 0.22)
                sh0, sh1 = hi, min(size, hi + int(half))
                if sh1 > sh0:
                    a[:, sh0:sh1] *= 1.0 - o.get("shadow", 0.18)

    elif kind == "halftimber":
        # A frame of dark members over the render: a sill, a head, studs, and a brace per bay.
        tim = np.array(o.get("colour", [64, 44, 30]), dtype=np.float32)
        t = max(2, int(o.get("width", 0.16) * px))
        bays = max(1, int(o.get("bays", 2)))
        step = size / bays

        def band(y0, y1, x0, x1):
            y0, y1 = max(0, int(y0)), min(size, int(y1))
            x0, x1 = max(0, int(x0)), min(size, int(x1))
            if y1 > y0 and x1 > x0:
                a[y0:y1, x0:x1] = tim

        band(0, t, 0, size); band(size - t, size, 0, size)       # head and sill, wrapping
        for i in range(bays + 1):
            band(0, size, i * step - t / 2, i * step + t / 2)      # studs
        # One diagonal brace per bay, drawn as a thick line.
        for i in range(bays):
            x0 = i * step
            for k in range(int(step)):
                yy = int(size - 1 - k * (size / step))
                xx = int(x0 + k)
                if 0 <= yy < size and 0 <= xx < size:
                    band(yy - t / 2, yy + t / 2, xx - t / 2, xx + t / 2)

    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def glass_mask(img: Image.Image, cut: float = 0.34) -> Image.Image:
    """Panes are the dark, low-saturation regions; mullions and spandrels are not.

    The same two tests glass.mjs uses on a mesh, in two dimensions: luma below a cut AND low
    saturation, so a dark slate spandrel panel is kept as frame while the glazing is separated.
    Closed by a small median to drop the speckle that JPEG leaves along a mullion edge.
    """
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
    luma = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    sat = a.max(-1) - a.min(-1)
    m = ((luma < cut) & (sat < 0.22)).astype(np.uint8) * 255
    return Image.fromarray(m).filter(ImageFilter.MedianFilter(5))


def build(key: str, spec: dict, seed: int) -> dict:
    d = OUT / key
    d.mkdir(parents=True, exist_ok=True)
    if not (d / "albedo.jpg").exists():
        if "procedural" in spec:
            print(f"{key}: drawing the grid…", flush=True)
            rgb, mask = draw_curtain_wall(spec)
            # Already tileable by construction; make_tileable would only blur it.
            rgb.save(d / "albedo.jpg", quality=95)
            mask.save(d / "glass_mask.png", optimize=True)
        else:
            print(f"{key}: drawing…", flush=True)
            raw = flux_image(spec["prompt"], seed)
            raw.save(d / "raw.jpg", quality=92)
            tiled = make_tileable(raw)
            # Structure goes on AFTER tiling: the overlay wraps by construction and must not be
            # fed through a blend that would soften exactly the edges it exists to provide.
            if "overlay" in spec:
                tiled = apply_overlay(tiled, spec)
            tiled.save(d / "albedo.jpg", quality=92)
    if not (d / "normal.png").exists():
        normal, rough = normal_from_albedo(Image.open(d / "albedo.jpg"),
                                           strength=spec.get("relief", 2.5))
        normal.save(d / "normal.png", optimize=True)
        rough.save(d / "roughness.jpg", quality=88)

    entry = {
        "id": key,
        "category": spec["category"],
        "name": spec["name"],
        # The real-world size of the square this tile covers. Everything downstream scales by it.
        "metres_per_tile": spec["metres_per_tile"],
        "albedo": f"surfaces/{key}/albedo.jpg",
        "normal": f"surfaces/{key}/normal.png",
        "roughness": f"surfaces/{key}/roughness.jpg",
        "seed": seed,
        "prompt": spec["prompt"],
    }
    if "glass" in spec:
        if not (d / "glass_mask.png").exists():
            glass_mask(Image.open(d / "albedo.jpg")).save(d / "glass_mask.png", optimize=True)
        cov = np.asarray(Image.open(d / "glass_mask.png")).mean() / 255
        entry["glass_mask"] = f"surfaces/{key}/glass_mask.png"
        entry["glass_coverage"] = round(float(cov), 3)
        # Parameters, not pixels: what the consumer binds to a MeshPhysicalMaterial.
        entry["glass"] = {"transmission": 1.0, "ior": 1.5, "roughness": 0.05,
                          "thickness": 0.012, **spec["glass"]}
    return entry


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    doc = json.loads(SPECS.read_text())
    sets, seed = doc["materials"], doc.get("seed", 11)
    if "--list" in sys.argv:
        for k, v in sets.items():
            print(f"  {k:28s} {v['category']:12s} {v['metres_per_tile']:>4} m  {v['name']}")
        return
    names = args or list(sets)
    OUT.mkdir(parents=True, exist_ok=True)
    cat = {}
    if (OUT / "materials.json").exists():
        cat = {e["id"]: e for e in json.loads((OUT / "materials.json").read_text())["materials"]}
    for n in names:
        if n not in sets:
            print(f"  ! no such material: {n}")
            continue
        cat[n] = build(n, sets[n], seed)
    (OUT / "materials.json").write_text(
        json.dumps({"materials": list(cat.values())}, indent=1) + "\n")
    print(f"{len(cat)} materials -> {OUT / 'materials.json'}")


if __name__ == "__main__":
    main()
