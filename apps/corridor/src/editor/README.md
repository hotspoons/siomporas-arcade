# corridor editor

`/editor.html` on the same dev server as the viewer (`just corridor-view`, :5185). The viewer shows
what the bake measured; this page is where you say what the bake got wrong, and what to put beside
the road. It builds the scene with the viewer's own `buildSite` — read-only — because an editor
looking at anything other than what the game looks at is correcting the wrong thing.

Two files come out, written **beside** the bake (never inside `web/`, which the bake owns):

    tools/corridor/data/sites/<slug>/adjustments.json    areas
    tools/corridor/data/sites/<slug>/placements.json     objects

Saving is a `PUT` to the dev middleware in `vite.config.ts`, which whitelists exactly those two
names. Pointing the page at a published bucket with `?data=` disables saving.

| file | role |
|---|---|
| `main.ts` | scene, top-down orbit, one ground raycast per click, mode switching, save |
| `schema.ts` | both file formats, the vocabularies, load/save, point-in-polygon |
| `areas.ts` | mode 1: draw, select, slide, delete |
| `place.ts` | mode 2: arm an asset, click, drag, rotate, scale |
| `catalog.ts` | `public/assets/catalog.json` → a `.glb` or a labelled box at the real footprint |
| `drape.ts` | polygons made to lie on the ground rather than hover over it |
| `ui.ts` | the panel's sliders and rows |

Keys: `1`/`2` mode · `T` top · `F` fly to selection · `Ctrl+S` save.
**Areas**: `N` draw, click to add a vertex, click the first vertex or `Enter` to close, `Esc`
cancel, `Del` remove, drag a handle to nudge. **Place**: pick an asset then click the ground, drag
to move, `Q`/`E` or shift+wheel to rotate, `[` `]` to scale, `Del` remove.

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
- **Nothing stores a z.** Polygons are x/y and placements default to `z: null`. A re-bake with a
  better DEM then moves the authoring with the hillside instead of burying it.

## Seeding areas from the bake

`python -m corridor areas <slug|all>` proposes polygons rather than making you hunt for them: one
per stretch where the lidar canopy disagrees with the rest of its own side, one per structure, one
per surface-class run, every knob neutral. Ids encode position (`canopy-l-0420`, `struct-0500`) so
a re-run after a re-bake merges instead of duplicating, and it only ever appends ids it does not
already find — a hand-drawn `a-01` is never touched. See `tools/corridor/corridor/areas.py`.
