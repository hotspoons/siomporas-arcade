"""Road surface texture sets from flux, with normal and roughness maps derived here.

    .venv/bin/python tools/surfaces/gen.py                # every set in SETS, skipping ones that exist
    .venv/bin/python tools/surfaces/gen.py asphalt_new    # one

Each set lands in apps/corridor/public/surfaces/<name>/ as albedo.jpg, normal.png, roughness.jpg,
plus surfaces.json cataloguing them with the class label tools/corridor's surface.py emits — that
is the join: the bake says `asphalt_aged` at a station, the viewer looks up `asphalt_aged` here.

TILEABILITY. flux does not make seamless tiles on request reliably, so the albedo is made tileable
after the fact: the image is offset by half in both axes and the resulting cross-shaped seam is
blended over a 96 px band. For asphalt and concrete, whose statistics are stationary, this is
invisible; it would smear a texture with a strong direction, which none of these have.

NORMALS. A height field is estimated from the albedo (dark = low, which is right for asphalt
aggregate and concrete pits, and wrong for white paint, which these tiles do not contain), blurred
to kill JPEG noise, and Sobel-differentiated into a tangent-space normal map. It is a stand-in for
DeepBump or a real material model; the file names and packing stay the same when that lands.

ROUGHNESS is inverted, contrast-stretched albedo: aggregate crowns are the glossier (worn) parts.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import urllib3

# The platform gateway serves a Let's Encrypt STAGING certificate today; trust it like curl -k does.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
VERIFY = os.environ.get("FLUX_VERIFY", "0") == "1"

import numpy as np
import requests
from PIL import Image, ImageFilter
from scipy import ndimage

FLUX = os.environ.get("FLUX_URL", "https://high-brine.richard-siomporas.basedweights.com")
OUT = Path(__file__).resolve().parent.parent.parent / "apps" / "corridor" / "public" / "surfaces"
SIZE = 1024
BAND = 96  # seam blend width, px

COMMON = (
    "Top-down orthographic photograph of a road surface, camera pointing straight down, uniform flat "
    "overcast lighting, no shadows, no objects, no paint markings, no lane lines, no cracks larger than "
    "a hand, edge to edge texture only, photorealistic, sharp, 1 metre square of pavement"
)
SETS = {
    "asphalt_new": "fresh black asphalt laid this year, dense-graded hot mix, dark charcoal aggregate with a faint blue-black sheen, fine even texture. " + COMMON,
    "asphalt_aged": "aged grey asphalt after ten years of traffic, exposed light grey and tan aggregate stones with dark binder between them, slightly oxidised, fine oil stains. " + COMMON,
    # statistics must be STATIONARY for the roll-and-blend tiler: one big patch in the frame comes
    # back as a cross-shaped smear. Many small repairs spread evenly tile cleanly.
    "asphalt_patched": "worn grey asphalt with many small irregular dark sealed crack lines and several palm-sized black patch repairs scattered evenly across the whole frame, no single large feature, uniform density edge to edge. " + COMMON,
    "concrete": "portland cement concrete highway pavement, light warm grey, transverse tined grooves for drainage running horizontally, fine surface pitting, one straight sawn joint. " + COMMON,
    "chipseal": "chip seal road surface, coarse angular gravel chips half embedded in dark bitumen, high relief, varied grey and brown stones. " + COMMON,
    "shoulder_gravel": "compacted crushed limestone gravel shoulder, light grey and white angular stones with fine dust between, some larger stones. " + COMMON,
    # ground under the blades: what a highway verge looks like straight down, at two metres a tile
    "grass_mown": "Top-down orthographic photograph of a freshly mown highway verge, dense short green turf grass with a few clover leaves and some thin brown thatch showing through, uniform flat overcast lighting, no shadows, no objects, edge to edge texture only, photorealistic, two metre square",
    "grass_rough": "Top-down orthographic photograph of rough unmown roadside grass and weeds, mixed tall grass stems lying in different directions, dandelion and plantain leaves, some dry straw-coloured stems, uniform flat overcast lighting, no shadows, no objects, edge to edge texture only, photorealistic, two metre square",
}


def flux_image(prompt: str, seed: int) -> Image.Image:
    r = requests.post(
        f"{FLUX}/v1/images/generations",
        json={"model": "flux.2-dev", "prompt": prompt, "size": f"{SIZE}x{SIZE}", "n": 1, "seed": seed, "response_format": "b64_json"},
        timeout=600,
        verify=VERIFY,
    )
    r.raise_for_status()
    import base64

    return Image.open(io.BytesIO(base64.b64decode(r.json()["data"][0]["b64_json"]))).convert("RGB")


def make_tileable(img: Image.Image) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    h, w, _ = a.shape
    rolled = np.roll(np.roll(a, h // 2, axis=0), w // 2, axis=1)
    # blend the cross seam (now at the centre) with the original content at the same place
    yy, xx = np.mgrid[0:h, 0:w]
    dy = np.abs(yy - h // 2)
    dx = np.abs(xx - w // 2)
    wgt = np.clip(np.minimum(dy, dx) / BAND, 0, 1)[..., None]  # 0 on the seam, 1 away from it
    # on the seam use the ORIGINAL (unrolled) image, which is continuous there; away from it use the
    # rolled image, whose outer edges are now the original's continuous centre — the whole tile wraps
    out = wgt * rolled + (1 - wgt) * a
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def normal_from_albedo(img: Image.Image, strength: float = 2.5) -> tuple[Image.Image, Image.Image]:
    g = np.asarray(img.convert("L")).astype(np.float32) / 255.0
    height = ndimage.gaussian_filter(g, 1.2)
    height = (height - height.min()) / max(1e-6, height.max() - height.min())
    # wrap-around gradients keep the normal map tileable too
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength * 20
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength * 20
    nz = np.ones_like(gx)
    n = np.stack([-gx, gy, nz], axis=-1)  # OpenGL/three convention: +Y up in the map
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))
    rough = 1.0 - (g - g.min()) / max(1e-6, g.max() - g.min())
    rough = 0.55 + 0.4 * ndimage.gaussian_filter(rough, 2.0)
    roughness = Image.fromarray((np.clip(rough, 0, 1) * 255).astype(np.uint8))
    return normal, roughness


MACRO_COMMON = (
    "Top-down aerial photograph of an eight metre square of a highway travel lane, camera straight down, "
    "flat overcast light, no vehicles, no lane markings, no paint. Large-scale variation only: two darker "
    "polished wheel tracks running vertically, lighter worn centre, faint oil drips, subtle patches and "
    "sealed crack lines, gradual colour drift across the frame, soft, low contrast, photorealistic"
)
MACRO = {
    "asphalt_new": "fresh dark asphalt. " + MACRO_COMMON,
    "asphalt_aged": "aged grey asphalt. " + MACRO_COMMON,
    "asphalt_patched": "old asphalt with several rectangular patch repairs of different ages. " + MACRO_COMMON,
    "concrete": "light grey portland concrete with transverse joints every few metres and rust-brown joint staining. " + MACRO_COMMON,
    "chipseal": "chip seal with worn smoother wheel tracks where the chips have polished. " + MACRO_COMMON,
    "shoulder_gravel": "gravel shoulder with a faint wheel rut and grass creeping in from one edge. " + MACRO_COMMON,
}
MACRO_METRES = 8.0


def build_macro(name: str, d: Path, seed: int) -> None:
    """The scale ABOVE the detail tile: an 8 m variation map that multiplies the 1 m albedo so the
    same square metre never reads the same twice. Stored low-frequency; the shader samples it at
    uv/8 as a luminance and tint modulation around neutral grey."""
    if (d / "macro.jpg").exists():
        return
    print(f"{name}: macro…", flush=True)
    raw = flux_image(MACRO[name], seed + 100)
    # NOT roll-blended: on a low-frequency map the blend band itself becomes the visible feature (a
    # cross through the middle). The viewer wraps the macro with MirroredRepeat instead, which is
    # seamless by construction and invisible at 8 m on a map with no sharp detail.
    a = np.asarray(raw).astype(np.float32)
    low = np.stack([ndimage.gaussian_filter(a[..., c], 6) for c in range(3)], axis=-1)  # the detail tile owns everything under ~0.5 m
    low = low - low.mean(axis=(0, 1), keepdims=True) + 128  # mid-grey = leave the detail alone
    Image.fromarray(np.clip(low, 0, 255).astype(np.uint8)).resize((512, 512), Image.LANCZOS).save(d / "macro.jpg", quality=88)


VARIANTS = 3  # a LIBRARY per class: the hex tiler picks one per cell, so no square metre repeats


def build(name: str, seed: int = 11) -> dict:
    d = OUT / name
    d.mkdir(parents=True, exist_ok=True)
    # variant 0 keeps the legacy names (albedo.jpg / normal.png / roughness.jpg); 1.. are suffixed
    for v in range(VARIANTS):
        sfx = "" if v == 0 else f"_{v}"
        if (d / f"albedo{sfx}.jpg").exists():
            continue
        print(f"{name}: variant {v}…", flush=True)
        raw = flux_image(SETS[name], seed + 7 * v)
        raw.save(d / f"raw{sfx}.jpg", quality=92)
        make_tileable(raw).save(d / f"albedo{sfx}.jpg", quality=90)
    for v in range(VARIANTS):
        sfx = "" if v == 0 else f"_{v}"
        if (d / f"normal{sfx}.png").exists():
            continue
        normal, rough = normal_from_albedo(Image.open(d / f"albedo{sfx}.jpg"))
        normal.save(d / f"normal{sfx}.png", optimize=True)
        rough.save(d / f"roughness{sfx}.jpg", quality=85)
    if name in MACRO:
        build_macro(name, d, seed)
    return {
        "name": name,
        "albedo": f"surfaces/{name}/albedo.jpg", "normal": f"surfaces/{name}/normal.png", "roughness": f"surfaces/{name}/roughness.jpg",
        "variants": [{"albedo": f"surfaces/{name}/albedo{'' if v == 0 else f'_{v}'}.jpg", "normal": f"surfaces/{name}/normal{'' if v == 0 else f'_{v}'}.png", "roughness": f"surfaces/{name}/roughness{'' if v == 0 else f'_{v}'}.jpg"} for v in range(VARIANTS)],
        "macro": f"surfaces/{name}/macro.jpg" if name in MACRO else None, "metres_per_tile": 2.0 if name.startswith("grass") else (1.0 if name != "asphalt_patched" else 3.0), "macro_metres": MACRO_METRES, "prompt": SETS[name], "seed": seed,
    }


def main() -> None:
    names = sys.argv[1:] or list(SETS)
    cat = {}
    if (OUT / "surfaces.json").exists():
        cat = {e["name"]: e for e in json.loads((OUT / "surfaces.json").read_text())["sets"]}
    for n in names:
        cat[n] = build(n)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "surfaces.json").write_text(json.dumps({"sets": list(cat.values())}, indent=1))
    print(f"{len(cat)} sets -> {OUT / 'surfaces.json'}")


if __name__ == "__main__":
    main()
