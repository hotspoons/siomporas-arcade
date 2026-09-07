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
