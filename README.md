# apex — two arcade games, one engine

A workspace of browser games in TypeScript + three.js that share a runtime and
two presentation styles (a modern post-processed look and a deliberate
low-res flat-shaded CRT look). Built to be split into separate repos later:
apps never import each other, and `packages/engine` never imports an app.

| Path | What | Dev port |
|---|---|---|
| [`apps/conduit`](apps/conduit) | **APEX CONDUIT** — tunnel racer-shooter (wall-riding craft, roof laser, shockwave, checkpoints, VR, phone tilt) | 5180 |
| [`apps/drivin`](apps/drivin) | **working title "DRIVIN"** — stunt-track driving game with a tile-grid track editor (loops, corkscrews, banked turns, splits/joins, jumps, tunnels), crash replays | 5181 |
| [`apps/coast`](apps/coast) | **working title "COASTLINE"** — OutRun-lineage sprite-scaling road racer: forks, checkpoints, turbo, chase and cockpit views, radio; sprites baked from CC0 models | 5182 |
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
