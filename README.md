# siomporas-arcade

A collection of games inspired by my favourites from the 80s and 90s. Three of
them so far, in TypeScript and three.js, playable in a browser and on a phone.

| Game | Owes it to | Play |
|---|---|---|
| **Turbo Radrun** | OutRun, Turbo OutRun, Rad Mobile | https://radrun.siomporas.com |
| **Drivin’** | Hard Drivin’, Stunts | https://drivin.siomporas.com |
| **Apex Conduit** | S.T.U.N. Runner | https://apex.siomporas.com |

They share one runtime and two ways of looking: a modern post-processed one, and
a deliberately low-res flat-shaded CRT one on the same frame. Apps never import
each other and `packages/engine` never imports an app, so any one of them could
leave on its own. Publishing is [DEPLOY.md](DEPLOY.md): a push to `main` builds
all three and puts each on its own address.

| Path | What | Dev port |
|---|---|---|
| [`apps/conduit`](apps/conduit) | **APEX CONDUIT** — tunnel racer-shooter (wall-riding craft, roof laser, shockwave, checkpoints, VR, phone tilt) | 5180 |
| [`apps/drivin`](apps/drivin) | **DRIVIN’** — stunt-track driving game with a tile-grid track editor (loops, corkscrews, banked turns, splits/joins, jumps, tunnels), crash replays | 5181 |
| [`apps/coast`](apps/coast) | **TURBO RADRUN** — OutRun-lineage sprite-scaling road racer: forks, checkpoints, turbo, chase and cockpit views, radio; sprites baked from CC0 models | 5182 |
| [`packages/engine`](packages/engine) | `@apex/engine` — fixed-step loop, modern/retro styles, input sources, menus, settings store, math, sky, particles, dev bridge | — |

## Run

Open in the dev container (VS Code → *Reopen in Container*), then:

```bash
just dev conduit      # or: just dev drivin / just dev coast
just check            # oxlint + tsc -b + vitest across the workspace
just build            # all apps → apps/*/dist
just tunnel drivin    # anonymous HTTPS tunnel to an app's dev server (phones)
just bridge-dev conduit && just bridge 'apex.snap.vehicle.s'   # live JS shell into the page
just                  # every recipe
```

Each app has its own README, MILESTONE, DECISIONS and HANDOFF.

## Tuning panel (all games)

Press **F6** (or Settings → **TUNING PANEL**) for live sliders over every gameplay
and camera constant worth tuning. Changes apply instantly and persist per browser
(`localStorage` `apex-<game>.tune.v1`). **Copy JSON** puts a document like
`{"game":"coast","changed":{"MAX_SPEED_HI":{"from":96,"to":110}},"values":{…}}`
on the clipboard — paste it into chat and the `changed` block becomes the new
defaults in `src/sim/Tuning.ts` / `src/render/RenderTuning.ts`. **Paste JSON**
accepts the same document (or a flat `{NAME: value}` map); **Reset all** returns
to shipped defaults. `P` pauses in every game alongside Escape.

## Fonts

Each app bundles its own free typefaces under `apps/<app>/public/fonts` (latin woff2 subsets from Google Fonts, all OFL or Apache 2.0, license texts alongside). Regenerate with `node scripts/fetch-fonts.mjs`. Drivin: Yellowtail + VT323 + Press Start 2P. Coast: Pacifico + Racing Sans One + Righteous + Press Start 2P. Conduit: Audiowide + Orbitron + Rajdhani + Press Start 2P.

## Drivin track editor

Open it from the title menu. It is an unbounded grid: wheel zooms under the pointer, middle-drag / space-drag / shift-wheel pan, click outside the grid to grow it (the world shifts if you go negative). Pieces: click to place the primed piece (Z/X rotate, M mirror, Q/E level; a piece dropped beside an open connector turns to meet it, and palette entries can be dragged onto the grid), click to select and drag to move, ⌘/Ctrl-click to multi-select, ⇧-click to select the connected run, ⌥-click or Delete to remove, ⌘⇧-click to force-insert (also lays a bridge at another level over a road), ⌘⌥-click to rotate, ⇧⌥ click / right-click to raise / lower, right-click for the menu, ⌘Z / ⌘⇧Z undo / redo, ⌘S save (save-over or save-as; titles are unique). Connectors: click a red connector and then another and a spline road links them; select a link and use , / . for tightness, B for camber, Delete to unlink. Landscape (G): drag raises, ⌥/right-drag lowers, ⇧-drag flattens to the primed level, [ ] sets the brush. Scenery pieces (water, trees, buildings, gas) block or sink the car; drawbridge halves jump the gap between them.
