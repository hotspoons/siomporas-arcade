# assetlib — the pipeline that draws and reconstructs an asset

The scripts that turn a spec into a finished `.glb`: draw it on flux, key the backdrop out,
reconstruct it on TRELLIS, and finish it. `tools/assetsvc` is the service around this; these are
the parts it calls and the ones you run by hand when you are working on the pipeline itself.

```
node tools/assetlib/build.mjs --id rx7-fd --dry-run   # the prompt only, nothing spent
node tools/assetlib/build.mjs --id rx7-fd             # draw, key, reconstruct, finish
node tools/assetlib/candidates.mjs --id civic-eg --n 6
node tools/assetlib/glass.mjs --id nsx-na1            # glazing into KHR_materials_transmission
node tools/assetlib/turntable.mjs --id rx7-fd         # look at it; proportion is not shape
```

`specs/` holds the rosters — the hero cars, the traffic vehicles, the building materials, and the
buildings dressing kit. `ASSETLIB_DATA` points `specs/`, `out/` and `candidates/` at a volume;
unset, they sit beside these files.

## This used to live outside the repo

These scripts were developed in `ext/assetlib/`, which is gitignored — so on a fresh clone neither
the tool nor the 4 GB library existed, and the editor was reading whichever service happened to be
running (Rich, 2026-09-28: "we don't need an external service that will be wiped on a fresh clone
sticking around, everything needs to be folded in here").

Folding them in found two pieces of measured work that existed only in the untracked copy, both
from the night of the 27th:

- **Which chroma key survives reconstruction**, traced through all three stages: red keeps 4.75% of
  the atlas with a peak dominance of 0.894, while blue and green both come back at **0.00%**.
  TRELLIS is trained on photographs and red glazing is in-distribution; blue and green are not, and
  it regresses them to plausible greys. Survivability now ranks ahead of hue separation when
  picking a key — a key that is maximally contrasting and *gone* is worth less than one that is
  merely contrasting and still there.
- **Continuous transmission from TRELLIS's own alpha**, rather than a binary glass/not-glass split.
  A threshold makes every windscreen uniformly transparent with an aliased boundary; the model
  predicts a per-texel alpha that already knows a screen is clearer at its centre than at its frit.
  `KHR_materials_transmission` takes a `transmissionTexture`, so the prediction is used as it
  stands.

The library's OUTPUT is not in the repo and should not be: `tools/assetsvc/import-assetlib.mjs`
brings an existing one into the service's catalog, symlinked rather than copied.
