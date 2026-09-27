# Styles, play knobs, and the first two games

**Status:** design, 2026-09-26. Rich: "we should be able to control the render styling so instead
of late summer tired dark green trees and drab looking box houses, we can pick from a palette of
style including alien, fantasy, medieval, etc. — we don't need to build this all out now, but
let's build one that is definitely not trying to pretend to be crofton. And we should be able to
have fun with areas, like exaggerate terrain, set water levels high and make waterworld."

And the first use cases, from his nine-year-old: a squishy-hunting exploration game over Crofton
(realistic and fantasy, multiplayer with friends, hints to the next haul at real stores), and a
parkour/gymnastics/archer game (tricks off real houses and trees, a bow, enemies, first-person
when it gets close).

## The style axis

Every colour in the viewer already flows through one object. `season.ts` defines a `SeasonLook`
per season — leaf tints per leaf kind, the grass ramp, litter, the ground tint on the imagery,
sky, fog, sun and ambient — `siteLook()` shifts it by the site's climate, `weather.ts` modifies
it, and `Site.setSeason()` fans it out to trees, grass, strips, terrain, horizon and impostors.
The sky dome (`sky.ts`) reads the same object. Nothing draws a colour it did not get from there.

So a style is a **third input to that one function**, not a second rendering path:

```
look = style(weather(siteLook(season)))
```

`style.ts` holds a `Style` per name with, initially, only what a palette needs:

| field | realistic | fantasy (the first one) |
|---|---|---|
| leaf tints per kind | as season | violet oak, teal ash, gold aspen, indigo pine, magenta live |
| grass base/tip | as season | lilac base, pale-pink tip |
| litter | as season | plum |
| ground (imagery tint) | as season | pulled toward mauve, desaturated 40 % |
| sky zenith/horizon, clouds | as season+weather | deep violet zenith, peach horizon, pink-lit clouds |
| sun colour | warm white | rose gold |
| water | blue-green | turquoise, opaque |
| building walls / roofs | the seven sidings / four roofs | pale stone, sandstone, whitewash / slate blue, copper green |
| roof shape | gable ≤ 500 m² | steep gable (1.4× rise), spire on anything under 60 m² |
| road paint | yellow / white | white / pale gold |

The imagery is the one input a palette cannot recolour honestly — an air photo of Crofton is an
air photo of Crofton. The fantasy style therefore **lowers the imagery's weight**: the strip's
turf textures run further out (the grass zone becomes the ground), the terrain's imagery is tinted
hard toward the palette, and the horizon drape is tinted the same. It stops looking like a
photograph, which is the point.

Buildings are the one place a style needs geometry, not colour: `buildings.ts` bakes vertex
colours from two arrays and a gable rule. Those become fields on the style. A medieval or alien
style would go further (roof pitch, tower footprints, no lane paint) and that is the second entry
in the table, later.

Where it lives in the UI: the season picker gains a style picker beside it; the stance carries
`style`; the world editor's world record carries a default style so a published world opens as
the author meant it.

## Play knobs

Two already exist and one is missing:

- **water level** — `WATER_LEVEL_M` is trailworks' flooding mechanic in one number; the sea plane
  is always drawn and rises to it. Waterworld is that knob plus the fantasy palette's turquoise.
- **season / weather** — already stance and tuning state.
- **terrain exaggeration** — built 2026-09-26 (`apps/corridor/src/relief.ts`). One affine map
  `z' = z0 + k·(z − z0)` with `z0` the spine's median grade, applied ONCE at load to every
  absolute height: the rasters through `decodeHeights` (tiles, overview, horizon) and the
  manifest's own z (spine and branch profiles, junctions, decks, water, parking, sidewalks,
  driveways, barriers, power, signs, masts, bars; `ground_rel` scales by k, a building's height
  does not). Because it is the same map everywhere, everything that lay on the ground still does,
  only steeper: the car gets real hills and the strip stays drivable. `?relief=3`, the stance
  carries it, the world record's `look.relief` sets a world's default, and the viewer has a Relief
  select (a change reloads the site — it is geometry, not a uniform). `probes/corridor-relief.mjs`
  loads a site twice and asserts the mechanism: datum fixed, off-road ground moved by k·(z−z0),
  road surface = exaggerated profile + the strip's measured lift, water moved with the ground.
  The first version of that probe failed on a sample that sat on a road, because the strip's
  0.4 m lift is a thing on the terrain and does not scale — the probe now measures the lift.

## Squishy Hunt

What the bake already knows: `manifest.pois` — crofton-triangle has 237, of which 5 supermarkets,
7 convenience stores, 8 fuel stations, 21 fast food, 24 restaurants, 25 playgrounds, 9 parks,
182 named. Every haul has a real address and a real building to stand in front of.

- **Hauls** are placed at a subset of POIs (stores, fuel, playgrounds), a handful "active" at a
  time. Each is a floating squishy (a catalogue asset: the flux→TRELLIS chain makes one in a
  minute) with a pickup radius.
- **Hints** are the game: "somewhere with a red roof near the school", "past the third pond on
  Crofton Parkway" — generated from the POI's own tags (`shop=convenience`, the nearest named
  road, the nearest park) and distance banding. The minimap shows a direction arc, not a pin.
- **Movement**: on foot (the fly camera at eye height with ground clamp — a walk mode is a few
  lines on `fly.ts`) and the car.
- **Multiplayer** — built 2026-09-26: `tools/worldeditor/rooms.mjs`, a relay on the world-editor
  service. Server-Sent Events push room state, players POST a pose four times a second and a
  claim when they pick up; first claim wins and a late one is refused. `?room=name&player=Ava`
  joins. Friends are capsules with their name over their head; a squishy a friend claims vanishes
  for everyone with a toast. In memory, no dependencies, no authority beyond "who claimed it".
- **Two worlds, one bake**: the same site with `style: realistic` and `style: fantasy`.

Sits in the arcade catalog as a fourth cabinet; the corridor viewer is its engine, the game is a
mode of it (`apps/corridor/src/games/squishy.ts`), not a new app.

## Parkour / Archer

The bigger one. What is new is a **character**:

- third-person controller: run, jump, vault (mantle onto a surface whose top is within reach —
  the buildings' massing and the strip give real edges), wall-run along a facade for a short
  distance, roll on landing.
- **tricks**: airtime and rotation scored — a pirouette off a roof is a jump with yaw input while
  airborne, scored by degrees turned and height cleared, landed clean or not (roll input within a
  window).
- **bow**: a projectile with gravity, drawn from third person, first person while aiming.
- **enemies**: a handful of patrol/chase agents on the road network (the network graph is in the
  bake), knocked down by arrows, close-range switches to first person.

The character controller, the animation set and the enemy behaviour are the work; the world,
the collision surfaces (`groundAt`, `edgeDistance`, `treesNear`, building footprints) and the
scoring geometry are already there. Same engine, same catalog entry pattern.

## Order

1. `style.ts` with `realistic` and `fantasy`; the picker; the stance field. One evening.
2. ~~`WATER_LEVEL_M` exposed on the world record~~ done 2026-09-26: a world carries `look:
   {style, season, water_level_m}`; the editor's Define form has a Look group; the service writes
   it into the site's `tuning.json` (on save, and again when a bake finishes, since the bake never
   writes that file) and the viewer applies it unless the URL says `?style`/`?season`. Terrain
   exaggeration: done the same day, `look.relief` (see Play knobs).
3. ~~Squishy Hunt: hauls + hints + walk mode single-player, then the relay.~~ Done 2026-09-26; the world-editor pod needs redeploying for the relay to exist outside a dev box.
4. Parkour: ~~the character, then tricks, then the bow, then enemies.~~ First pass 2026-09-26
   (`apps/corridor/src/games/parkour.ts`, `?game=parkour` or P): a capsule runner on the real
   ground, the bake's buildings as solids with mantle-able roofs, jump + air spin scored (half
   turn, pirouette, roof landing, big air, clean roll on a second Space), a bow with falling
   arrows, six goblins that wander, chase within 25 m, knock back on contact and drop to an arrow;
   first person within arm's reach. No rigged figure or animation yet — that is the next visible
   step, and a Mixamo-style rig on the same controller is the honest way to get it.

## Grass, 2026-09-26 (later)

- **Where it grows**: the road-distance gate, the OSM lots and walks, and now the tile photo:
  `vegmask.ts` classifies each 0.6–1 m tile jpg (excess green, 3×3 majority) lazily around the
  eye, and the generator plants nothing where the photo is not green. The car park OSM never
  mapped went bare. NDVI from NAIP's NIR band in the bake is the honest successor.
- **How it looks**: `zoning.ts` — KEPT (inside or within 40 m of a built-up landuse polygon, or
  beside a residential/living/service road) is a trimmed lawn everywhere and does not sway;
  RURAL (farmland, meadow, forest, or beside an unclassified/tertiary/secondary/primary road)
  is a `GRASS_RURAL_MOW_LINE` shoulder and then rough grass `GRASS_RURAL_TALL` times taller.
- **No pop**: a tile's blades and cards grow in over `GRASS_GROW_S` from the tile's birth time
  (`aExtra`), on top of the rim fade; wind already stills below `GRASS_WIND_STILL_BELOW` m/s.

## Trees, 2026-09-26

Density was a property of the SITE, not of the ground: `treesFromCanopy` coarsened its sampling
cell (6, 8, 10 … 40 m) until the whole site's tree count fitted one global budget, so
arrowhead-farms (0.68 km²) planted one tree per 6.1 m of canopy and crofton-crownsville
(355 km²) one per 34.2 m — the same Maryland woods, 31× thinner.

Now the cell is fixed (`TREE_CELL_M`) and the budget is spent around the eye: candidates within
`TREE_PLANT_RADIUS_M`, nearest first, replanted when the eye leaves that centre by
`TREE_REPLANT_M`. The lattice is world-aligned and every jitter is a hash of the cell indices, so
a replant puts every tree back exactly where it was — only the set near the eye changes. The
record array is mutated in place, so `NearTrees.reindex()`, the collision grid and the impostor
slots re-index rather than rebuild (the impostor capacity is the budget, not the first planting).
Trees also plant from the tiles' 2 m CHM where a tile is resident, not the 8 m overview.

Measured after (`probes/corridor-treedensity.mjs`, trees per CANOPY km², which is the comparable
number): 27,519 crownsville / 27,053 crofton-triangle / 27,318 arrowhead; implied cell
6.0 / 6.1 / 6.1 m. A replant costs ~200 ms under swiftshader and is the next thing to chunk
through the grading pump if it is felt on a real GPU.

## Two more, and the system under both (2026-09-27)

Rich's tractor beam (lift the car doing 38 in a no-passing zone over your roof and set it down
behind you) and the Carmageddon-style rage simulator (stuck on Route 3, fire missiles, discover
that wreckage jams the road worse than traffic did) are written up in
[PLAN-TRAFFIC-AND-RAGE.md](PLAN-TRAFFIC-AND-RAGE.md).

The short version: both are thin layers over **traffic that behaves like traffic**, and the bake
already carries what that needs — 408 junctions on crofton-triangle with per-approach stop lines,
lane counts, priority and signal phases. IDM plus MOBIL plus the baked phases gives stop-and-go
waves as an emergent property rather than a scripted effect, and every other mode in this engine
gets better the moment the roads have cars on them.
