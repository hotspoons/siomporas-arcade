# corridor editor

`/editor.html` on the same dev server as the viewer (`just corridor-view`, :5185). The viewer shows
what the bake measured; this page is where you say what the bake got wrong, and what to put beside
the road. It builds the scene with the viewer's own `buildSite` — read-only — because an editor
looking at anything other than what the game looks at is correcting the wrong thing.

Three files come out, written **beside** the bake (never inside `web/`, which the bake owns):

    tools/corridor/data/sites/<slug>/adjustments.json    areas
    tools/corridor/data/sites/<slug>/placements.json     objects
    tools/corridor/data/sites/<slug>/structures.json     what the road does along an interval

Saving is a `PUT` to the dev middleware in `vite.config.ts`, which whitelists exactly those three
names. Pointing the page at a published bucket with `?data=` disables saving.

| file | role |
|---|---|
| `main.ts` | scene, top-down orbit, one ground raycast per click, mode switching, save, preview |
| `schema.ts` | both file formats, the vocabularies, load/save, point-in-polygon |
| `areas.ts` | mode 1: draw, select, slide, delete |
| `place.ts` | mode 2: arm an asset, click, drag, rotate, scale |
| `structures.ts` | mode 4: two clicks on the road → an interval on the spine; a bridge over it, a grade to flatten, a detection to ignore |
| `grow.ts` | mode 3: run autogen, and keep your corrections across a re-run |
| `autogen.ts` | the rules from `tools/corridor/AUTOGEN.md`, over the bake's buildings/landuse/pois |
| `preview.ts` | the dialog: the same site from the driver's seat |
| `corridor.ts` | along-track/lateral coordinates, and every sign convention in one place |
| `catalog.ts` | `public/assets/catalog.json` → a `.glb` or a labelled box at the real footprint |
| `drape.ts` | polygons made to lie on the ground rather than hover over it |
| `ui.ts` | the panel's sliders and rows |

Keys: `1`/`2`/`3`/`4` mode · `T` top · `F` fly to selection · `V` preview · `Ctrl+S` save.
**Areas**: `N` draw, click to add a vertex, click the first vertex or `Enter` to close, `Esc`
cancel, `Del` remove, drag a handle to nudge. **Place**: pick an asset then click the ground, drag
to move, `Q`/`E` or shift+wheel to rotate, `[` `]` to scale, `Del` remove. **Grow**: `G` generate;
the items it makes are ordinary placements, so mode 2 edits them. **Preview**: `W`/`S`/`A`/`D`
drive, `Space` handbrake, drag to look, `Tab` fly, `R` reset, `Esc` close. **Structures**: `N`
then click the road twice (start, then end), drag an end sphere along the spine, `Q`/`E` turn a
bridge, `Del` remove.

## Structures are intervals, not polygons

Bowie's horse bridge is the case: a covered bridleway crosses Race Track Road at s≈2351, the 2014
lidar under it is junk, and OSM knows only that *something* crosses. Nothing measured will ever
put a dark timber box over the road there, so a human says "a bridge, here, this high" — as an
along-track interval `[s_start, s_end]` on the spine plus a `kind`, never as an x/y footprint. A
re-bake that moves the centreline sideways keeps the bridge over the road.

```json
{ "version": 1, "items": [
  { "id": "st-01", "name": "flat under the horse bridge", "kind": "flatten", "s_start": 2300, "s_end": 2420 },
  { "id": "st-02", "name": "horse bridge", "kind": "bridge_over", "s_start": 2340, "s_end": 2362,
    "clearance_m": 4.3, "asset": "horsebridge-01", "span_m": 19.3, "yaw_offset_deg": 0 } ] }
```

`flatten`: the grade between the ends becomes a straight line — the viewer applies it to the
spline *before* anything is built, so the strip, paint and car follow. `suppress`: detected
structures inside the interval are ignored. `bridge_over`: the catalog asset (any entry with
`category: "bridge"`) sits at mid-interval, long axis across the road plus `yaw_offset_deg`,
scaled so its long axis is `span_m`, underside at road + `clearance_m`, abutments to the ground.
The four bridge keys exist only on a `bridge_over`; switching kind adds or strips them. The
viewer's consumer is `src/structures.ts` (the main agent's); the key set is a contract with it.

How the mode works: a click snaps to the spine through a 2 m station table refined to the exact
foot on the segment (the panel shows `s · paved width · road z` live while you pick). A new item
defaults to `bridge_over`, clearance 4.5 m, the first bridge asset, and `span = pavedWidth(lanes,
twoWay) + 6` at mid-interval — the pavement plus a verge and an abutment each side. Each item is a
translucent ribbon on the pavement (orange bridge, yellow flatten, red suppress; teal selected)
with a draggable sphere at each end. Bridges are drawn by the viewer's own `buildBridges`, called
per item, so the editor shows exactly the bridge the game shows. A `flatten` cannot be previewed
live — the spline is already built — so its ribbon marks the interval and the grade changes on
the next reload (the preview does one).

Why key `4`: BRIEF-2 made structures the third mode, but a second session had already shipped
`3 · grow` by the time this landed, and renumbering someone else's line while they are typing in
the same file is how two editors end up with no key `3` at all. Cosmetic; swap when both are quiet.

### Bridge assets are spans only

`bridge_over` puts the fitted model's *base* at road + clearance and builds concrete abutments to
the ground itself, so a model that carried its own piers or legs would stand on them at deck
height and float the whole bridge by their height. flux.2-dev would not omit supports however it
was asked (the overpass came back on two pairs of piers, the horse bridge on legs), so
`probes/editor-trim.mjs` cuts them off after the fact: a histogram of vertex height has a cliff at
the deck's underside (supports are thin, the deck is dense), and everything below the cliff is
clamped up to it — the supports fold into slivers coplanar with the underside, no triangles are
removed, nothing tears. Then `finish()` as usual. Both entries carry `fit: "span"` so the long axis
is what gets scaled, not the height.

## The preview is the editor's own site

Not a second one built beside it. A second `buildSite` would double the memory — a corridor is a
22 MP drape, a fine terrain strip and up to 120k trees — and, worse, it would be a second thing
that can disagree with the first. The bug you would never catch is a preview showing you something
the game does not.

So pressing preview **saves both files and reloads the site**, then shows you that. It has to:
`buildSite` reads `adjustments.json` and `placements.json` off the server, and bakes the canopy
corrections into the height model as it decodes the CHM. `retune()` re-picks trees and re-seeds
grass, but nothing can un-bake a canopy scale. The reload also passes the renderer, which bakes
the far-tree impostor atlas — the editor opens without it, because the editor hides the trees and
the bake is not free, but a preview whose far trees are lollipops is a preview of something else.

Rendering is one renderer scissored to the dialog's viewport rect, so nothing is duplicated on the
GPU. `setViewport`/`setScissor` take CSS pixels (three multiplies by the pixel ratio itself) and
measure Y from the BOTTOM, hence `innerHeight - rect.bottom`.

## Things that were learned the hard way

- **Drape on `site.groundAt`, not `site.heightAt`.** `heightAt` is the raw 2 m DEM; `groundAt` is
  the graded corridor strip near the road and the DEM beyond — the surface the car drives on. They
  differ by metres beside the pavement, which is exactly where everything gets authored.
- **A missing optional file does not 404 in dev.** The bake middleware calls `next()`, Vite's SPA
  fallback answers `index.html` with a 200, and `r.json()` dies on `<!doctype`. `schema.ts::load`
  sniffs for a leading `{`. A body that *does* start with `{` and still fails to parse throws —
  returning "empty" there would silently overwrite the human's file on the next save.
- **A filled polygon has to be subdivided before it is lifted.** Triangulating a ring and lifting
  only its own vertices puts a lid over every cutting the polygon crosses. `drape.ts` splits until
  no edge is longer than 24 m, then lifts.
- **Vertex handles only appear on polygons of 40 vertices or fewer.** A seeded 4 km band has 128,
  and 128 draggable spheres is not authoring.
- **flux.2-dev will not be talked out of its framing.** A tall subject (the water tower) comes back
  with its feet off the bottom edge, and TRELLIS then invents them. Naming a margin *size* and
  naming the bottom of the object explicitly changed the width and not the crop — measured twice.
  Same class of failure `tools/assetgen/README.md` reports for proportion, where the fix was an
  attached reference rather than a better sentence. Wide subjects frame themselves fine.
- **Two sign conventions, and both bite.** A placement's `yaw_deg` is a compass bearing and
  renders as `rotation.y = -yaw·π/180` — the first cut of `place.ts` used `+`, so the editor drew
  every asymmetric model mirrored against the viewer and the selection arrow disagreed with the
  model it was attached to. Separately, `buildings[].rect.yaw_deg` from the bake is a MATH angle
  from east describing an axis, so aligning a box's long side with a footprint is
  `yaw = -rect.yaw_deg`. Both live in `corridor.ts` now (`bearingOf`, `yawForLongAxis`) with the
  derivations written out, because a mirrored town looks entirely plausible on its own.
- **Nothing stores a z.** Polygons are x/y and placements default to `z: null`. A re-bake with a
  better DEM then moves the authoring with the hillside instead of burying it.
- **flux will not make a thing long, either.** "22 m long, 3.5 m wide, 4.5 m tall, six times
  longer than tall" produced a 1.5:1 pavilion when the sentence said *box-truss bridleway bridge*
  and a 3:1 one when it said *classic American covered bridge* — the noun's prior did more than
  the numbers. The shipped horse bridge is that 3:1 model with `--stretch 1.5` along its long axis
  (`editor-trim.mjs`); vertical board siding stretches gracefully, so it reads as a longer bridge.
  Same finding as `tools/assetgen/README.md`'s: proportion is fixed by a reference, not a sentence.
- **A stance stores yesterday's road height.** The viewer's `?stance=` carries the car's world
  position as it was; a `flatten` or a re-profile moves the road, and a probe that puts the camera
  at the stored height then looks up at the pavement from underneath. `editor-shot.mjs`'s
  `stance:` action stands on today's `groundAt` and keeps only x/z and the yaw.

## Mode 3 · grow

`G` runs `autogen.ts` over the bake's `buildings` / `landuse` / `pois` and drops `g-` placements
into the same document mode 2 edits. The rules are `tools/corridor/AUTOGEN.md`; what makes it a
loop rather than a one-shot is that a generated id is derived from its SOURCE BUILDING INDEX, so
the same input lands on the same id every run:

- touch a `g-` item → `locked: true`, and the next generate leaves it alone
- delete one → its id goes in `autogen.deleted`, and the next generate does not bring it back
- hand-placed items are `p-` and are never autogen's business

Two corrections to the first version, both measured rather than reasoned:

- **Identity beats size.** Scoring every catalog entry on shape with a small penalty for the wrong
  category puts a well-proportioned wrong thing ahead of a badly-proportioned right one: the
  output had a water tower on a 156 m² apartment block, a gas station on Dutch's Daughter
  Restaurant and a bridge span on a Public Storage unit. Candidates are now the entries of the
  classified category; substitutes only when the catalog has none of that kind at all; and the
  scale is clamped rather than used to reject, with a `stretched` tag when the clamp bit.
- **A POI is a point, and OSM hangs it on whatever polygon contains it.** "Big Papi's Tacos" is
  tagged on the 5324 m² shopping centre it is a unit inside, so a tag only wins while the
  footprint is a plausible size for it (`PLAUSIBLE_MAX`).

## Two things about the preview that look like bugs and are not

- **The green band above the corridor from a few hundred metres up** is the horizon layer, not
  trees. `layers.horizon` is ±30 km at 60 m/px, so everything past the near bbox (2.1 × 3.4 km on
  frederick-i70) is that mesh, compressed by perspective and tinted by `LOOK[season].ground`; the
  straight edge below it is the near terrain's bbox. The viewer draws it identically — it just
  never shows, because the viewer is normally at eye height on the road. If it ever wants fixing
  it is a look question (the 60 m drape is greener than the 1 m drape it abuts), not a bug.
- **Fog is nearly a no-op at the shipped densities.** `scene.fog` must exist before the first
  `buildSite` — grass and the impostors are custom shaders and take fog at compile time, so
  handed `null` they are built without a fog term and nothing set later reaches them. But at
  `LOOK.summer.fog = 1.8e-5`, fog over the whole impostor range is under a thousandth. Set it for
  consistency with the viewer, not because you will see it.

## Adding a mode

Mark your scene group with `markOverlay()` from `preview.ts`. The preview hides every direct
child of the scene carrying `userData.editorOverlay` and restores it on close — a flag rather
than a list, because a list is the thing a new mode forgets to join, which is how the preview
came to paint area fills and structure ribbons over the road in its first version.

## Seeding areas from the bake

`python -m corridor areas <slug|all>` proposes polygons rather than making you hunt for them: one
per stretch where the lidar canopy disagrees with the rest of its own side, one per structure, one
per surface-class run, every knob neutral. Ids encode position (`canopy-l-0420`, `struct-0500`) so
a re-run after a re-bake merges instead of duplicating, and it only ever appends ids it does not
already find — a hand-drawn `a-01` is never touched. See `tools/corridor/corridor/areas.py`.
