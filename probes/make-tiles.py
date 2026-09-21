"""Slice a baked site's single-image layers into the agreed tile schema, so the streaming code can
be written and measured before the first tiled bake lands.

    tools/corridor/.venv/bin/python probes/make-tiles.py <src-slug> [tile_m]

Writes apps/corridor/public/testdata/sites/<slug>-tiled/web/ — inside this worktree, served by
Vite's public/ and loaded with `?data=/testdata`, so the shared bake in tools/corridor/data is
never touched. This is NOT a bake step: it re-cuts what export.py already wrote, at the same
resolutions and the same encodings, purely as a fixture.

Schema (main + terrain-and-data, 2026-09-21):
  manifest.layers.tiles = {size_m, origin: [x0, y0], res: {dem, naip, chm},
                           list: [{x, y, dem: {zmin, zscale}}]}
  files web/tiles/0/<x>_<y>.dem.png | .naip.jpg | .chm.png
Tiles with no data are simply absent from the list.
"""
import json, math, os, shutil, sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
SRC = sys.argv[1] if len(sys.argv) > 1 else 'arrowhead-farms-network'
TILE_M = float(sys.argv[2]) if len(sys.argv) > 2 else 1000.0
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_WEB = f'/workspaces/apex-conduit/tools/corridor/data/sites/{SRC}/web'
DST = os.path.join(HERE, 'apps/corridor/public/testdata/sites', f'{SRC}-tiled')
DST_WEB = os.path.join(DST, 'web')
TILES = os.path.join(DST_WEB, 'tiles/0')

man = json.load(open(f'{SRC_WEB}/manifest.json'))
L = man['layers']
os.makedirs(TILES, exist_ok=True)

# the tile lattice is anchored on the DEM layer's own bbox, so tile edges fall on DEM cell edges
x0, y0, x1, y1 = L['dem']['bbox']
nx = math.ceil((x1 - x0) / TILE_M)
ny = math.ceil((y1 - y0) / TILE_M)
print(f'{SRC}: {x1 - x0:.0f} x {y1 - y0:.0f} m -> {nx} x {ny} tiles of {TILE_M:.0f} m')

imgs = {k: Image.open(f'{SRC_WEB}/{L[k]["file"]}') for k in ('dem', 'chm', 'naip') if k in L}
for k, im in imgs.items():
    print(f'  {k}: {im.size} {im.mode}  res {L[k]["res"]}')


def crop(key, tx, ty):
    """Pixel window of tile (tx, ty) in layer `key`, cropped exactly on cell boundaries."""
    lay = L[key]
    lx0, ly0, lx1, ly1 = lay['bbox']
    res = lay['res']
    w, h = lay['size']
    # tile bounds in the site frame
    tx0, ty0 = x0 + tx * TILE_M, y0 + ty * TILE_M
    tx1, ty1 = tx0 + TILE_M, ty0 + TILE_M
    # -> pixel window (row 0 is ymax)
    c0 = int(round((tx0 - lx0) / res))
    c1 = int(round((tx1 - lx0) / res))
    r0 = int(round((ly1 - ty1) / res))
    r1 = int(round((ly1 - ty0) / res))
    c0, c1 = max(0, c0), min(w, c1)
    r0, r1 = max(0, r0), min(h, r1)
    if c1 <= c0 or r1 <= r0:
        return None, None
    return imgs[key].crop((c0, r0, c1, r1)), (c1 - c0, r1 - r0)


out = []
for ty in range(ny):
    for tx in range(nx):
        dem, size = crop('dem', tx, ty)
        if dem is None:
            continue
        dem.save(f'{TILES}/{tx}_{ty}.dem.png')
        entry = {'x': tx, 'y': ty, 'dem': {'zmin': L['dem'].get('zmin', 0), 'zscale': L['dem'].get('zscale', 0.01)}}
        if 'chm' in L:
            chm, _ = crop('chm', tx, ty)
            if chm is not None:
                chm.save(f'{TILES}/{tx}_{ty}.chm.png')
                entry['chm'] = True
        if 'naip' in L:
            naip, _ = crop('naip', tx, ty)
            if naip is not None:
                naip.convert('RGB').save(f'{TILES}/{tx}_{ty}.naip.jpg', quality=88)
                entry['naip'] = True
        out.append(entry)

man['layers']['tiles'] = {
    'size_m': TILE_M,
    'origin': [x0, y0],
    'res': {'dem': L['dem']['res'], 'naip': L['naip']['res'] if 'naip' in L else None, 'chm': L['chm']['res'] if 'chm' in L else None},
    'list': out,
}
man['slug'] = f'{SRC}-tiled'
# the horizon layers stay single-image; copy them and drop the single dem/naip/chm so the viewer
# HAS to go through the tile path (that is the point of the fixture)
for k in ('horizon', 'horizon_naip'):
    if k in L:
        shutil.copy(f'{SRC_WEB}/{L[k]["file"]}', f'{DST_WEB}/{L[k]["file"]}')
json.dump(man, open(f'{DST_WEB}/manifest.json', 'w'))

idx_dir = os.path.dirname(DST)
idx = {'sites': [{'slug': man['slug'], 'ident': man.get('ident'), 'length_m': man['spine']['length_m'],
                  'structures': len(man.get('structures') or []), 'formations': [], 'layers': list(man['layers']), 'photos': []}]}
json.dump(idx, open(f'{idx_dir}/index.json', 'w'))
mb = sum(os.path.getsize(os.path.join(TILES, f)) for f in os.listdir(TILES)) / 1e6
print(f'wrote {len(out)} tiles, {len(os.listdir(TILES))} files, {mb:.1f} MB -> {DST_WEB}')
print(f'open http://127.0.0.1:5202/?data=/testdata#{man["slug"]}')
