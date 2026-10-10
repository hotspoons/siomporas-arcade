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
| `main.ts` | scene, one ground raycast per click, mode switching, save, preview |
| `view/nav.ts` | the camera: trailworks' map navigation (see *Navigating* below) |
| `view/navmath.ts` | its maths, pure — zoom/orbit about a point, grab pan, ray march, clamps |
| `view/navrail.ts` | the on-screen rail: +, −, compass, frame the world, the scale |
| `view/maproads.ts` | every road as a map line by tier, and the road names (`maplabels.ts` places them) |
| `view/mapbuildings.ts` | building footprints around the view, the *Buildings* layer |
| `store/schema.ts` | both file formats, the vocabularies, load/save, point-in-polygon |
| `author/areas.ts` | mode 1: draw, select, slide, delete |
| `author/place.ts` | mode 2: arm an asset, click, drag, rotate, scale |
| `author/structures.ts` | mode 4: two clicks on the road → an interval on the spine; a bridge over it, a grade to flatten, a detection to ignore |
| `author/grow.ts` | mode 3: run autogen, and keep your corrections across a re-run |
| `author/autogen.ts` | the rules from `tools/corridor/AUTOGEN.md`, over the bake's buildings/landuse/pois |
| `view/preview.ts` | the dialog: the same site from the driver's seat |
| `author/corridor.ts` | along-track/lateral coordinates, and every sign convention in one place |
| `author/catalog.ts` | `public/assets/catalog.json` → a `.glb` or a labelled box at the real footprint |
| `view/drape.ts` | polygons made to lie on the ground rather than hover over it |
| `author/ui.ts` | the panel's sliders and rows |
| `view/emphasis.ts` | every mode's things drawn in every mode: the active one full strength, the rest quieter |
| `view/pickorder.ts` | which thing a click means when several modes have one under it |
| `view/labels.ts` | the active mode's names on the map |
| `store/framecheck.ts` | is a document in the bake's frame? measured against the roads (pure) |
| `store/frameguard.ts` | that check wired to a loaded site: the silent stamp, and the one banner left |
| `store/docwatch.ts` | a document changed on disk (an MCP tool wrote it) is reloaded into its mode |

Keys: `1`…`7` mode · `T` frame the world · `C` fly to selection · `V` preview · `Ctrl+S` save
(the camera's own keys are under *Navigating*).
**Areas**: `N` draw, click to add a vertex, click the first vertex or `Enter` to close, `Esc`
cancel, `Del` remove, drag a handle to nudge. **Place**: pick an asset then click the ground, drag
to move, `Q`/`E` or shift+wheel to rotate, `[` `]` to scale, `Del` remove. **Grow**: `G` generate;
the items it makes are ordinary placements, so mode 2 edits them. **Preview**: `W`/`S`/`A`/`D`
drive, `Space` handbrake, drag to look, `Tab` fly, `R` reset, `Esc` close. **Structures**: `N`
then click the road twice (start, then end), drag an end sphere along the spine, `Q`/`E` turn a
bridge, `Del` remove.

## Navigating

Rich, 2026-10-10: *"The place editor does not scale up to something like the DC area for map
navigation … adopt the full navigation experience from trailworks, including point-based zooms
and pivots, the whole thing."* So the camera is trailworks' (`view/nav.ts` lists every behaviour
it ports and where), and it works from a 60 km overview to two metres over a kerb with no mode
switch:

| do | and |
|---|---|
| **drag** | grabs the ground: the point you pressed stays under the cursor, and a flick coasts |
| **wheel** | zooms toward the point under the cursor; move the mouse mid-zoom to steer it |
| **right-drag** | zooms about the point you pressed (drag up to close in) |
| **middle-drag**, or **shift+drag** | orbits and tilts about the point you pressed — it holds its pixel |
| **two fingers** | pinch zooms, twist turns, both fingers up or down tilts; one finger grabs |
| **double-tap** · **two-finger double-tap** | zoom in ×0.55 · out ×1.8 toward the tap |
| `W` `A` `S` `D` / arrows | slide the view, faster as you go higher; shift is faster still |
| `Q` `E` · `R` `F` | turn about the eye · rise and drop |
| `+` `−` | zoom about the centre (the rail's buttons) |
| `Home` / the compass | north up, straight down |
| `T` / the frame button | the whole world, north up |
| `C` | fly to the selection |

A cyan ring marks the point a zoom or an orbit is turning about. Every glide stops the moment you
press, scroll or touch a movement key. Where you were in each world comes back on reload.
`probes/corridor-editor-nav.mjs` holds it to its promises with real mouse input (each measured at
0 px of drift on dc-metro-take-2), and `test/editor-nav.test.ts` states the maths.

The tools still come first: a press on a vertex handle, a gizmo or a stunt piece belongs to that
tool, exactly as it did under OrbitControls (`orbit.enabled`); while an area or a traffic zone is
being drawn the ground holds still and only zooming is allowed. Shift+wheel on a selected
placement still rotates it.

### The map layer

Three toggles in the layers panel, group *Map*. **Roads** are drawn as a map draws them — a line a
few pixels wide with a dark casing, the same width at every zoom: motorways, trunks and primaries
always; secondary, tertiary and residential streets from the z14 scale down (≤ 10 m a pixel — the
rail shows the scale); service roads and tracks from 2.5 m a pixel. Close in, where the photograph
shows the asphalt itself, the lines fade back. **Road names** are laid along their roads, the
important road first and the one nearest the middle of the screen next, never overlapping, a name
not repeated within a few hundred pixels, at most 45 / 90 / 120 at the three zooms. **Buildings**
(off by default) are footprints around the view below 3 m a pixel.

The roads come from the bake's `context.json` (every road, class and name — the file the game's
minimap reads), parsed in a worker while the site builds; a world baked before it falls back to
its manifest's spine and branches, and a tiled one to the branches of the vector tiles around the
view. Nothing new is fetched. Over the ground, the editor drives the LOD pyramid from the camera
(the game does it from the car), draws the overview photograph as an underlay under every tile,
and shows a tile only once it has a photograph of its own — see `editorGround` in `main.ts`.

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

## What an area can say (the `adjust` keys)

An area is a polygon plus a bag of overrides. `null` on any of them means "as the bake inferred
it", which is why they are all optional — an area is a correction, not a description.

| key | values | consumed by |
|---|---|---|
| `canopy_scale`, `canopy_offset_m` | numbers | baked into the CHM at load; changes tree heights AND the tree list |
| `tree_density` | 0–1, thins only | there are no canopy cells to grow extra trees from |
| `grass_height`, `grass_density` | numbers | the grass ring, live |
| `ground_offset_m` | ±10 m | deforms the corridor strip off the pavement |
| `surface_class` | the `tools/surfaces` set names | the road texture at spine stations inside the polygon |
| `species` | oak, ash, aspen, pine | which tree the near field grows |
| `markings` | none, class, full | how much paint. Site default is the `ROAD_MARKINGS` knob |
| `centre_line` | dashed, solid, solid_left, solid_right | where overtaking is allowed |
| `cover` | crop, pasture, orchard, scrub, bare | what grows where it is not roadside verge |
| `crop` | corn, soy, wheat, hay, fallow | only read when `cover` is crop |
| `row_heading_deg`, `row_spacing_m` | numbers | the rows themselves |

**Composition where areas overlap** (`src/adjust.ts`, the viewer's): scales multiply, offsets add,
and every CATEGORICAL key — including the four new strings, and the two crop numbers, which are
field attributes rather than corrections — goes to the SMALLEST polygon. That matches what the
editor selects on a click, so the area you can see yourself picking is the one that wins.

**Why these are area keys and not a new interval file.** road-and-car asked for `centre_line` as
an interval with `s_start`/`s_end`. An area polygon already IS a stretch of road, and
`python -m corridor areas` already emits a band polygon along the spine for every surface-class
run — so the shapes exist, are drawn, and are draggable. A new file would have been a new mode, a
new save path and a new composition rule for one enum.

**Picking `cover: crop` defaults `row_heading_deg` to the road's bearing** at that polygon's
centroid. A field's rows are never random and almost never due north, and the road is the one
direction we know.

## Per-site knobs — `tuning.json`

`tools/corridor/data/sites/<slug>/tuning.json`, `{ version: 1, values: { KNOB: number } }`.
Sideling Hill is closed forest on a mountain grade, Bowie is a suburban arterial, Ecola is a
coast; one `GRASS_RADIUS` cannot be right for all of them.

- **The file beats the browser.** `TunePanel` persists every knob to localStorage when it is
  constructed — that is the scratch pad while driving. The site file is applied after the site
  loads, so it lands on top. Copy JSON in a panel is how a scratch value is promoted into a file.
- **A file is undone when you leave the site.** Without that, frederick's `GRASS_RADIUS=44`
  survives into south-mountain for the rest of the session and looks like a bug in
  south-mountain, which is where someone would go hunting.
- **Only differences from the CODE defaults are stored**, and the baseline is captured before the
  panels restore localStorage. Capture it later and you are diffing against a scratch pad; store
  all 112 knobs and every future default change is a merge conflict.
- An unknown knob is reported in the status line, not swallowed.

## Every mode's things, in every mode

Rich, 2026-10-10: *"all of the tabs assets [should be] visible from all other tabs in the place
editor, so traffic zones will show up when you are in the structures tab … The active tab's items
should appear bolder than other tabs items and be first on selection when clicking."*

- **Drawn always.** No mode's group is hidden by the mode switch any more (the Settings layer
  toggles still hide areas, placements and authored structures if you ask). After every `refresh`
  `applyEmphasis` makes the active mode's group full strength and every other one *passive*: its
  unlit marks at 55 % of the opacity their mode chose, outlines at 60 % of their width, grab
  handles hidden, the place and stunt gizmos detached. Lit materials (a placed diner, a loop, a
  bridge) are the world and are never faded. The pass remembers what each mode set, so a mode
  that redraws while passive comes out quiet without knowing it is passive.
- **Bolder means wider.** Area and zone outlines are `Line2` fat lines (2.5 px, 4 px selected);
  WebGL draws `gl.LINES` one pixel wide whatever `linewidth` says.
- **Names.** The active mode's things carry their names (`view/labels.ts`); the passive ones do not.
- **Clicks.** Every mode answers `pick(pt)` without taking the click. The active mode's thing wins,
  then the smallest of the rest; **a second click on the same spot takes the next thing there**, so
  a loop standing inside a corridor-wide canopy area is still reachable from the Areas tab.
  Choosing another mode's thing switches to that mode with it selected and its row in view. A tool
  mid-gesture (drawing, armed, picking an interval) still keeps every click.
- **Hover.** What a click would take is outlined in white before you click, across modes.
- **Off disk.** Every eight seconds, while the editor is on screen, it re-reads the seven authored
  documents; one whose text changed (an agent's `traffic_zone_add`) is reloaded into its mode,
  unless that mode has unsaved edits — then it says so and leaves them alone.

## Frames are measured, not dated

A document with no frame stamp used to get a red banner: "authored before frames were stamped …
if these were drawn before 2026-09-22 they … will sit off the road". dc-metro-take-2's five
Beltway zones were written over MCP on 2026-10-08 in exactly the bake's frame and got it anyway
(Rich: *"This screenshot about zones.json is bullshit"*). Now an unstamped (or `utm`-stamped)
document is measured against the roads (`store/framecheck.ts`): how much road its polygons cover,
or whether its points are within 20 m of one, as written and after the old UTM→ENU turn the
manifest records (`utm_convergence_deg`, `utm_scale`).

- **fits** — stamped in memory, written at the next save, and nothing is shown;
- **old** — at least half the things sit clearly better after the turn: a banner with the numbers
  and a *Move them into this frame* button (positions turned, headings with them; save to keep);
- **unknown** — the roads cannot tell (nothing near a road, or too near the anchor for the turn to
  matter): nothing is shown, because that is not evidence of anything.

Polygons are scored by *how much* road they cover, not whether they cover any: the Beltway circles
dc-metro's anchor, so the turn slides a zone mostly along it. Measured: z-01 covers 1000 stations
as written and 528 after the turn; an off-frame copy covers 509 and 1000. The MCP tools that write
zones and points stamp the bake's frame now, so the question should not come up for them again.

## Adding a mode

Give it `pick(pt)` (what is here, without taking the click), `select(id)`, `outline(id)` (for the
hover ring) and, if its things have names, `labels()`; then add it to `hitsAt`, `selectHit`,
`emphasiseLayers` and `docs()` in `main.ts`. Draw its marks with unlit materials and its grab
handles with `handleMesh`, and the emphasis pass does the rest; flag anything that is a real
object rather than a mark with `userData.emphasisKeep`.


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
