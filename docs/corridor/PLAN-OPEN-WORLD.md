# From a corridor to a world

**Status:** design, 2026-09-27.

Rich:

> Honestly this started as a corridor-based project along stretches of highway I thought looked
> awesome on a drive back from western MD last weekend, hence the name, and now is starting to
> look like a stage for an open-world experience based loosely on the real world with best guess
> procedural techniques and a lot of knobs and dials.
>
> Let's do any rebake with the idea that proximity to a road shouldn't really dictate tree
> mappings and ground textures — let's build the full world out for a given network. Obviously
> most details go into the streets.

The name is now wrong and the shape of the bake is now wrong. This is about the second one.

---

## 1. What "corridor" means today

A network bake takes every road it found, buffers each one by `half_width_m` (150 m), unions them,
and calls that the corridor. **Every raster is clipped to it.** Three of those clips are exactly
what Rich is describing:

| layer | clipped to | what it decides |
|---|---|---|
| NAIP 1 m imagery | the corridor | the ground you see, and the paving classifier |
| lidar points → CHM | the corridor (≤ 150 m) | **where trees exist at all** |
| LANDFIRE EVT 30 m | masked to the corridor, 255 outside | **which species, and what ground cover** |

Everything else is already fine: the DEM is fetched over the bbox and not clipped, the horizon is
a 30 km ring, geology and water follow each chain, and the OSM feature query already uses the
corridor's convex *hull* rather than the corridor.

So "trees stop 150 m from a road" is three lines, not an architecture.

## 2. What it costs to stop doing that

Measured on `crofton-triangle`, whose network is a dense suburban grid:

| | area | ratio |
|---|---|---|
| corridor (150 m per road) | 32.3 km² | 1.00 |
| convex hull of the network | 52.5 km² | 1.62 |
| **the site's own bbox** | **67.6 km²** | **2.09** |

The corridor already covers **48 %** of the site's bounding box, because the network is dense. So
building the whole rectangle is a **two-fold** increase, not a ten-fold one.

| | corridor | full |
|---|---|---|
| NAIP at 1 m | 32.3 Mpx | 67.6 Mpx |
| lidar DEM at 2 m | 8.1 Mpx | 16.9 Mpx |
| 1 km delivery tiles | 33 | 72 |

And a bake of this site currently takes **147 seconds**. Doubling the raster work is not a reason
to hesitate about anything.

On a sparser network — a single highway through open country — the ratio would be far worse, and
that is the case where the corridor idea earns its keep. So this is a **per-site choice**, not a
global one.

## 3. The design

Keep two regions and stop conflating them.

**`corridor`** — the union of road buffers, as now. It still means "near a road", and things that
genuinely are road-local keep using it: the lidar profile extraction along each chain, the
near-road point accounting, structures and clearances.

**`region`** — the world. The rectangle the network spans, plus a margin so you do not drive to a
hard edge the moment you leave the outermost street. This is what NAIP, lidar and EVT are clipped
to. A rectangle rather than a hull because a hull gives the world ragged diagonal edges for no
benefit, and the bbox is only 1.29× the hull here.

A site opts in with `world: true` in `site.json`; without it the bake behaves exactly as it does
today, so no existing site changes underneath anyone.

## 4. What changes, in order

| # | change | where | done when |
|---|---|---|---|
| 1 | compute `region` from the network's bounds + `world_margin_m`, write it to `site.json` beside `corridor` | `network.py` `write_vectors` | `site.json` carries both, and the manifest records which was used |
| 2 | clip imagery, lidar and EVT to `region` instead of `corridor` | `network.py`, `network_tiles.py`, `flora.py` | a probe finds canopy and an EVT class 1 km from the nearest road |
| 3 | re-bake `crofton-world` as a new slug, leaving `crofton-triangle` alone | — | the two sit side by side and can be compared |
| 4 | raise `radius_m` so the network is not cut mid-junction | `sites.json` | the US 3 × Johns Hopkins junction is in the road graph (`docs/corridor/LANES-AND-SIGNALS.md`) |
| 5 | grass follows the EYE, not the road | `tuning.ts` `GRASS_MAX_FROM_ROAD` | walking into a field does not walk out of the grass |
| 6 | trees plant across the region, not the corridor | `scene.ts` `treesFromCanopy` | a wood away from any road has trees in it |

Steps 5 and 6 are viewer work and are the point of steps 1 to 4: baking the data is no use if the
renderer still spends its whole budget on the verge. `GRASS_MAX_FROM_ROAD` is commented "spend the
budget on the verge, where the eye is" — which was true of a corridor and is false of a world.

## 5. What does NOT change

**Detail still concentrates on the streets**, which is what Rich said and what the engine is
already built to do. None of this touches the things that make a road a road: the stations, the
paint, the kerbs, the junction meet, the signals, the blades. The budget machinery — the near-set
capacity, the grass rings, the impostor horizon, the lazy build pump — is all eye-relative
already, so it spends itself on whatever you are looking at whether that is a junction or a field.

The corridor does not go away either. A bake of one beautiful stretch of highway through the
mountains is still the right thing for a stretch of highway through the mountains.

## 6. The thing to watch

A world twice the size with the same tree and grass budgets is a world half as dense. The budgets
are per-eye and not per-site, so nothing should change in front of you — but that is an assertion,
and `probes/corridor-treedensity.mjs` already measures trees per canopy km². It should read the
same before and after, and if it does not, the budget is being spent on area rather than on
distance and that is the bug to chase.
