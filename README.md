# siomporas-arcade

A collection of games inspired by my favourites from the 80s and 90s. Three of
them so far, in TypeScript and three.js, playable in a browser and on a phone —
in one arcade, at https://arcade.siomporas.com.

| Game | Owes it to | Play |
|---|---|---|
| **Turbo Radrun** | OutRun, Turbo OutRun, Rad Mobile | https://arcade.siomporas.com/radrun |
| **Stuntin’** | Hard Drivin’, Stunts | https://arcade.siomporas.com/stuntin |
| **Apex Conduit** | S.T.U.N. Runner | https://arcade.siomporas.com/apex |

They share one runtime and two ways of looking: a modern post-processed one, and
a deliberately low-res flat-shaded CRT one on the same frame. Publishing is
[DEPLOY.md](DEPLOY.md): a push to `main` builds and puts up one Worker.

## The arcade

The landing page is a room: the cabinets stood in a row, marquees lit, scrolled
left and right with the arrows, a swipe, the wheel or a gamepad. It is drawn in
three.js by the same engine the games use, and it is mounted by the same shell
that mounts them.

There are two ways round it. The row is for choosing a game — whichever cabinet
is selected stands square on, and clicking its screen leans you in against the
glass. **Walk the aisle** (the button top right, or `F`) is for looking at the
machines: the row stops sliding and stands still with room to get in beside one,
and you move instead — WASD or the arrows, drag to look, click a machine to walk
over to it. That is the only view that shows you the side art, which is most of
what a cabinet wears. `Esc` or `F` again comes back to the row, standing at
whatever you walked to.

Selecting a cabinet does not reload the page. `apps/arcade/src/Shell.ts` owns the
URL and exactly one mounted module at a time; a game is a lazily-imported chunk
that gets a fresh container and canvas on the way in and gives back its loop, its
GL context, its audio and its listeners on the way out. three and the engine are
shared by all four, so they are downloaded once — the first game costs about
300 kB on top of the lobby, the second and third rather less.

The URL is the whole of the app's state. `/` is the lobby, `/radrun` is a game,
and `/radrun/settings/controls` is that game two menus deep, so the browser's
Back button escapes one menu, then the game, then the site. Menus get this for
free by calling `menus.bindRouter(host.router, host.route)`; see
[`packages/engine/src/app/Router.ts`](packages/engine/src/app/Router.ts).

Each game keeps its own `index.html` and dev server — `just dev coast` still
serves Turbo Radrun on its own at :5182, which is where the tuning panel, the
operator bridge and the smoke harness live. `apps/arcade` is the only thing that
is deployed, and it is the only app allowed to import another: the games still
know nothing of each other or of the shell.

Cabinet artwork, and the prompt that generates more of it, is
[apps/arcade/ART.md](apps/arcade/ART.md).

The fighter is wired in but deliberately not on show: `UNLISTED` in
[`apps/arcade/src/catalog.ts`](apps/arcade/src/catalog.ts) is the shell's second
list, resolved by the URL and ignored by the lobby. Its stand-in renderer draws
each attacking limb out of the move's own hitbox — the most useful view of frame
data in the repo, and not something to put on a lit sign. It joins the row by
moving one entry from `UNLISTED` to `GAMES`.

There is also a workbench page at
[arcade.siomporas.com/modem](https://arcade.siomporas.com/modem), which
models what a 2400 bit/s call sounds like: both carriers, the guard tone, the
scrambler, and a V.22 bis handshake whose every duration is the Blue Book's. It
measures its own claims out of the signal it just synthesised — nothing on it is
a recording.

**Worth trying next:** the shell gives every game a *fresh* WebGL context rather
than sharing one, which costs a few hundred milliseconds on each switch and is
the reason for the fade. Sharing a single renderer would make it instant, but
each `RenderWorld` would have to stop owning its renderer first, and one game's
leftover GPU state showing up in the next is a nasty class of bug. The teardown
had to exist either way; that is what is in place now.

| Path | What | Dev port |
|---|---|---|
| [`apps/arcade`](apps/arcade) | **the arcade** — 3D lobby, router, mount/unmount shell. The only deployable | 5183 |
| [`apps/conduit`](apps/conduit) | **APEX CONDUIT** — tunnel racer-shooter (wall-riding craft, roof laser, shockwave, checkpoints, VR, phone tilt) | 5180 |
| [`apps/stuntin`](apps/stuntin) | **STUNTIN’** — stunt-track driving game with a tile-grid track editor (loops, corkscrews, banked turns, speedbowls, splits/joins, jumps, tunnels), crash replays | 5181 |
| [`apps/coast`](apps/coast) | **TURBO RADRUN** — OutRun-lineage sprite-scaling road racer: forks, checkpoints, turbo, chase and cockpit views, radio; sprites baked from CC0 models | 5182 |
| [`apps/fighter`](apps/fighter) | **CONCRETE CROWN** — 2D fighting game: motion inputs, frame data, hit detection, rounds. Mounted but **unlisted** — it has no cabinet in the lobby until it has sprites, so it lives at `/crown` and nowhere else | 5184 |
| [`packages/engine`](packages/engine) | `@apex/engine` — fixed-step loop, modern/retro styles, input sources, menus, settings store, math, sky, particles, dev bridge | — |

## Run

Open in the dev container (VS Code → *Reopen in Container*), then:

```bash
just dev              # the arcade, everything, :5183
just dev conduit      # or: just dev stuntin / just dev coast — one game, on its own
just check            # lockfile + oxlint + tsc -b + vitest across the workspace
just build            # everything → apps/*/dist
just tunnel stuntin   # anonymous HTTPS tunnel to an app's dev server (phones)
just bridge-dev conduit && just bridge 'apex.snap.vehicle.s'   # live JS shell into the page
just                  # every recipe
```

Each app has its own README, MILESTONE, DECISIONS and HANDOFF.

## Dependencies across machines

Several dependencies ship a native binary per platform (oxlint, esbuild,
rolldown, sharp, workerd) and the lockfile has to list all of them, because the
dev container here is arm64 and CI is x64. **`npm install` writes a lockfile
describing only the machine it ran on** — do that after deleting the lockfile and
CI installs cleanly and then finds the linter has no binary to run. So regenerate
it whole:

```bash
rm package-lock.json && npm install --package-lock-only && npm install
```

`just check` and CI both run `npm run check:lockfile`, which fails with the
missing platforms listed rather than letting it reach the runner.

## Tuning panel (all games)

Press **F6** (or Settings → **TUNING PANEL**) for live sliders over every gameplay
and camera constant worth tuning. Changes apply instantly and persist per browser
(`localStorage` `apex-<game>.tune.v1`). **Copy JSON** puts a document like
`{"game":"coast","changed":{"MAX_SPEED_HI":{"from":96,"to":110}},"values":{…}}`
on the clipboard — paste it into chat and the `changed` block becomes the new
defaults in `src/sim/Tuning.ts` / `src/render/RenderTuning.ts`. **Paste JSON**
accepts the same document (or a flat `{NAME: value}` map); **Reset all** returns
to shipped defaults. Turbo Radrun's `MODELS_3D` swaps sprites for the meshes they
were baked from: `1` poses them exactly where the sprites were, `2` puts a real
perspective camera on them, so poses are continuous and roadside things are seen
from the side. `P` pauses in every game alongside Escape.

## Credits and licences

Every sound is synthesised and every texture the games draw is procedural, but
the roadside scenery and the typefaces are other people's work. Turbo Radrun's
cars, props and trees are [Kenney](https://kenney.nl)'s CC0 low-poly kits, baked
into sprite atlases at startup; each app bundles latin woff2 subsets from Google
Fonts under `apps/<app>/public/fonts`, all OFL or Apache 2.0, with the licence
texts served alongside them (regenerate with `node scripts/fetch-fonts.mjs`).

Who made what, under which licence, and where it came from — assets and
software dependencies both — is [CREDITS.md](CREDITS.md).

## Stuntin’ track editor

Open it from the title menu. It is an unbounded grid: wheel zooms under the pointer, middle-drag / space-drag / shift-wheel pan, click outside the grid to grow it (the world shifts if you go negative). Pieces: click to place the primed piece (Z/X rotate, M mirror, Q/E level; a piece dropped beside an open connector turns to meet it, and palette entries can be dragged onto the grid), click to select and drag to move, ⌘/Ctrl-click to multi-select, ⇧-click to select the connected run, ⌥-click or Delete to remove, ⌘⇧-click to force-insert (also lays a bridge at another level over a road), ⌘⌥-click to rotate, ⇧⌥ click / right-click to raise / lower, right-click for the menu, ⌘Z / ⌘⇧Z undo / redo, ⌘S save (save-over or save-as; titles are unique). Connectors: click a red connector and then another and a spline road links them; select a link and use , / . for tightness, B for camber, Delete to unlink. Landscape (G): drag raises, ⌥/right-drag lowers, ⇧-drag flattens to the primed level, [ ] sets the brush. Scenery pieces (water, trees, buildings, gas) block or sink the car; drawbridge halves jump the gap between them.
