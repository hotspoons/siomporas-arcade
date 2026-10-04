# Credits and third-party licences

This project is released under the [Apache License 2.0](LICENSE), Copyright 2026
Rich Siomporas. What follows is everything in the repository that someone else
made, what it is licensed under, and where it came from. The short version: the
third-party code is MIT, Zlib and Apache-2.0; the art and models are CC0; the
fonts are OFL or Apache-2.0. Nothing here is copyleft and nothing conflicts with
the Apache-2.0 release.

Machine-readable copies of the licence texts ship alongside the files they cover
and are served by the deployed site:

- `apps/<app>/public/fonts/LICENSES.txt` — the full text of every font licence
- `apps/<app>/public/assets/LICENSES.md` — the model and texture provenance

## Software dependencies

A short list of third-party code reaches the browser. Everything else is build
tooling that never leaves this machine.

| Shipped to the browser | Licence | |
|---|---|---|
| [three.js](https://threejs.org) | MIT | the renderer, and most of the engine's maths |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Zlib | bloom, SMAA and the effect composer behind the modern style |
| [ez-tree](https://github.com/dgreenheck/ez-tree) | MIT | corridor's procedural near trees |
| [Heroicons](https://heroicons.com) | MIT | corridor's interface icons. The package itself is dev-only; `scripts/heroicons.mjs` inlines the path data of the ~35 icons used into `apps/corridor/src/ui/icons.ts`, so what ships is that generated file, not the 1,300-icon package |
| [Engine Simulator](https://github.com/ange-yaghi/engine-sim) — with [piranha](https://github.com/ange-yaghi/piranha) and [simple-2d-constraint-solver](https://github.com/ange-yaghi/simple-2d-constraint-solver) | MIT | the engine you hear in corridor. Compiled to WebAssembly and shipped as `packages/enginesim/wasm/enginesim.wasm` — see below |

| Build-time only | Licence | Reached via |
|---|---|---|
| [Vite](https://vite.dev), [Vitest](https://vitest.dev), [TypeScript](https://www.typescriptlang.org), [Playwright](https://playwright.dev), [ws](https://github.com/websockets/ws) | MIT / Apache-2.0 | direct dev dependencies |
| [oxlint](https://oxc.rs) | MIT | direct dev dependency |
| [Emscripten](https://emscripten.org), [CMake](https://cmake.org), [Flex](https://github.com/westes/flex), [GNU Bison](https://www.gnu.org/software/bison/) | MIT / BSD-3-Clause / GPL-2.0-or-later | only to rebuild `packages/enginesim/wasm`, which is committed. Bison is GPL but its **output** carries the [Bison exception](https://www.gnu.org/software/bison/manual/html_node/Conditions.html), so the generated Piranha parser does not become GPL |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and the Cloudflare toolchain | MIT **or** Apache-2.0 (we take Apache-2.0) | direct dev dependency |
| [lightningcss](https://lightningcss.dev) | MPL-2.0 | Vite's CSS minifier |
| [sharp](https://sharp.pixelplumbing.com) and its libvips binaries | Apache-2.0 / LGPL-3.0-or-later | Wrangler → Miniflare |

Two of those carry weak copyleft and neither is a problem. **lightningcss**
(MPL-2.0) is file-level copyleft on its own source; we neither modify nor
redistribute it, and minified CSS is output, not a derivative work.
**libvips** (LGPL-3.0-or-later) arrives as a prebuilt native binary inside a
dev-only dependency of the local Workers emulator — it is never linked into
anything, never redistributed, and never present in a deployed bundle.

The deployed Worker contains our own code, three.js, postprocessing, ez-tree,
the inlined Heroicons path data, and the engine simulator's WebAssembly module.

### The engine simulator

Corridor's engine sound is a real combustion simulation rather than a sample
set: [Engine Simulator](https://github.com/ange-yaghi/engine-sim) by
**AngeTheGreat (Ange Yaghi), MIT, Copyright 2022**, compiled to WebAssembly and
driven from an audio worklet. `packages/enginesim/README.md` explains how and
why; what matters here is what is in the shipped binary.

`enginesim.wasm` is a single 1.28 MB artifact and everything inside it is MIT,
Copyright 2022 Ange Yaghi:

| Inside the wasm | What it is |
|---|---|
| `engine-sim` core | the simulation and the synthesiser |
| `simple-2d-constraint-solver` | the rigid-body solver underneath it |
| `piranha` | the scripting language the engine definitions are written in |
| `assets/engines/**.mr` | the twenty engine definitions in the picker |
| `assets/es/**` | the Piranha standard library and the impulse-response library (the `.wav` files the exhaust is convolved against) |

Two notes for anyone auditing this. First, we build against
[Open Engine Simulator](https://github.com/zabayone/open-engine-sim), the
community fork, because the original's browser support was never published as
source; the fork is MIT, preserves upstream's copyright notice, and is pinned by
commit in `packages/enginesim/scripts/build-wasm.mjs`. Second, `piranha` had no
`LICENSE` file at the commit the fork pins — it was added to that repository
later. The file now present on its default branch is MIT, Copyright 2022 Ange
Yaghi, and GitHub reports the repository as MIT; the same author released the
rest of the project under the same terms at the same time.

Our own code in `packages/enginesim` — the C API in `native/`, the worklet, the
gearbox, the bench — is Apache-2.0 like the rest of this repository. We do not
modify upstream's sources: the build fetches them and links against them.

### Water

Corridor's water shader is our own code, but three of its ideas are ported from
[tuxalin/water-shader](https://github.com/tuxalin/water-shader), **MIT,
Copyright (c) 2017 tuxalin**:

- the summed **Gerstner wave** normal (from GPU Gems 1 ch. 1, the same source
  tuxalin cites), which replaces the earlier scrolling value noise with waves
  that travel along a wind — or, for a stream, along the channel itself;
- **wavelength-dependent colour extinction** through the water column, so depth
  darkens and blues the surface per channel instead of flattening it to one
  albedo;
- **shore foam** placed by water depth behind an animated noisy edge.

No file, texture or shader source from that repository is used verbatim. The
waves are evaluated analytically in `apps/corridor/src/world/waterShader.ts`,
driven by a per-vertex `(depth, flow direction)` attribute corridor bakes at
build time in `water.ts`, so a stream's ripples travel along its channel. The
MIT notice travels in that file's header and in [NOTICE](NOTICE).

## Models and textures

Turbo Radrun draws no hand-made sprite. It loads low-poly models at startup and
renders each into a sprite atlas from several angles, so every roadside object
and rival car you see began as one of these:

| Used for | Pack | Licence |
|---|---|---|
| traffic and rival cars | [Kenney — Car Kit 3.1](https://kenney.nl/assets/car-kit) | CC0 1.0 |
| barriers, billboards, grandstands, light posts, pylons | [Kenney — Racing Kit 2.0](https://kenney.nl/assets/racing-kit) | CC0 1.0 |
| trees, rocks, cacti, bushes, stumps | [Kenney — Nature Kit 2.1](https://kenney.nl/assets/nature-kit) | CC0 1.0 |
| `textures/asphalt.jpg` | [ambientCG — Asphalt010](https://ambientcg.com/view?id=Asphalt010) | CC0 1.0 |

The lobby's cabinet is not one of these. Its side profile — the base, the control
panel, the nineteen-degree monitor, the speaker panel, the sign — was **measured**
off a third-party STL of an Ikari Warriors upright of unstated licence, by
projecting its silhouette and reading the front edge at every height. No mesh,
vertex or texture from that file is in this repository or in the deployed site;
the cabinet is built from those measurements in
[apps/arcade/src/lobby/Cabinet.ts](apps/arcade/src/lobby/Cabinet.ts), and the
dimensions of a 1980s arcade cabinet are facts about a machine rather than
anyone's creative work. The file itself stays in `ext/`, which is not committed.

CC0 waives the attribution requirement. [Kenney](https://kenney.nl) asks for
credit anyway and has earned it — these kits are the reason the game had
roadside scenery on day one. [ambientCG](https://ambientcg.com) likewise.

## Fonts

Each app bundles latin `woff2` subsets pulled from Google Fonts by
`scripts/fetch-fonts.mjs`. Nothing is hotlinked; no request leaves the browser
for a font, or for anything else.

| Font | Licence | By | In |
|---|---|---|---|
| [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) | OFL 1.1 | CodeMan38 | all three |
| [Yellowtail](https://fonts.google.com/specimen/Yellowtail) | Apache-2.0 | Astigmatic | Stuntin’ |
| [VT323](https://fonts.google.com/specimen/VT323) | OFL 1.1 | Peter Hull | Stuntin’ |
| [Pacifico](https://fonts.google.com/specimen/Pacifico) | OFL 1.1 | The Pacifico Project Authors | Turbo Radrun |
| [Racing Sans One](https://fonts.google.com/specimen/Racing+Sans+One) | OFL 1.1 | Pablo Impallari, Rodrigo Fuenzalida | Turbo Radrun |
| [Righteous](https://fonts.google.com/specimen/Righteous) | OFL 1.1 | Brian J. Bonislawsky, Astigmatic | Turbo Radrun |
| [Audiowide](https://fonts.google.com/specimen/Audiowide) | OFL 1.1 | Brian J. Bonislawsky, Astigmatic | Apex Conduit |
| [Orbitron](https://fonts.google.com/specimen/Orbitron) | OFL 1.1 | Matt McInerney, The League of Moveable Type | Apex Conduit |
| [Rajdhani](https://fonts.google.com/specimen/Rajdhani) | OFL 1.1 | Indian Type Foundry | Apex Conduit |
| [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans) | OFL 1.1 | IBM / Mike Abbink, Bold Monday | corridor |
| [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) | OFL 1.1 | IBM / Mike Abbink, Bold Monday | corridor |

The OFL's one real condition is that the licence text travel with the font, and
it does — `LICENSES.txt` sits in the same directory as the `woff2` files and is
served with them. No font is sold by itself or renamed.

## Made here

- **All game code**, the engine, the shell and the track editor.
- **Every sound.** There is not an audio file in the repository. Engines, tyres,
  impacts, lasers and the radio are synthesised in WebAudio at runtime by each
  game's `src/audio/AudioWorld.ts`.
- **Every texture the games actually draw** — road surfaces, skies, tunnels and
  the CRT treatment are procedural, written as shaders.
- **The cabinet artwork** in `apps/arcade/public/cabinets/`, generated to the
  templates described in [apps/arcade/ART.md](apps/arcade/ART.md), and the
  favicons.

## The games they owe something to

Turbo Radrun, Stuntin’ and Apex Conduit are original games written from scratch
in homage to OutRun, Turbo OutRun and Rad Mobile (Sega), Hard Drivin’ and
S.T.U.N. Runner (Atari Games), and Stunts (Broderbund). No code, art, audio,
level data or other asset is taken from any of them. Those names are the
trademarks of their respective owners, are used here only to say honestly what
these games are descended from, and imply no affiliation with or endorsement by
anyone.
