"""Backfill the geodetic frame into every already-exported manifest.

frame.epsg + frame.origin make site metres exactly invertible to geodetic, so this adds the
anchor without re-baking or re-exporting anything. Writes atomically; touches only `frame`.
"""
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from corridor.geo import Frame

root = pathlib.Path('/workspaces/apex-conduit/tools/corridor/data/sites')
n = 0
for mf in sorted(root.glob('*/web/manifest.json')):
    m = json.loads(mf.read_text())
    fr = m.get('frame')
    if not fr or 'epsg' not in fr or 'origin' not in fr:
        print(f'  skip {mf.parent.parent.name}: no usable frame'); continue
    if fr.get('kind'):
        print(f'  skip {mf.parent.parent.name}: already has kind={fr["kind"]}'); continue
    fm = Frame(fr['epsg'], tuple(fr['origin'])).manifest_frame()
    # this tree's coordinates were written BEFORE the ENU conversion: they are UTM site metres.
    # Only a re-export makes them "enu".
    fm['kind'] = 'utm'
    m['frame'] = fm
    tmp = mf.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(m, separators=(',', ':')))
    tmp.replace(mf)
    a = m['frame']['anchor']
    print(f"  {mf.parent.parent.name:26} anchor {a['lon']:11.6f},{a['lat']:10.6f}  conv {m['frame']['utm_convergence_deg']:+.4f} deg")
    n += 1
print(f'{n} manifests backfilled')
