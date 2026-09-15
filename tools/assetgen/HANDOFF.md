# Handoff: regenerating Turbo Radrun's assets

*For the agent taking on the asset overhaul. The generation and reconstruction halves both work and
are committed; what is missing is the middle, and the judgement about what the game should look
like. Read `README.md` here first — it is the approach. This is the state of the world.*

## What already runs

Three pieces, all verified end to end tonight, none of them theoretical:

| piece | where | what it does |
|---|---|---|
| **flux.2-dev** | cluster, `default` ns | text → image, and image → image. ~25 s a view |
| **TRELLIS.2** | `tools/recon-service` | one keyed view → textured, UV-mapped `.glb`. **~7 s** warm |
| **blrig rigging** | `tools/rigging` | mesh → Rigify rig, weights, textures kept |

```
spec ──► flux.2-dev ──► keyed reference ──► TRELLIS.2 ──► .glb ──► rig ──► game
         text→image      our own chroma      image→3D      textured   (characters only)
```

Kestrel went the whole way: 2D art → 58k-triangle textured mesh → 706-bone rig with working
deformation. See `tools/photogrammetry/RESULTS.md` and `tools/rigging/README.md`.

## Where things live

```
tools/assetgen/assets.json          the design-language specs — 10 written, ~40 to go
tools/assetgen/README.md            why the specs are shaped the way they are. Read this.
tools/recon-service/                image→3D as a service: Dockerfile, API, Helm chart
tools/rigging/rig_character.py      headless Blender rigging
apps/coast/src/render/models.ts     ModelDef — the contract a generated asset must satisfy
apps/coast/src/render/procgen.ts    the hand-built hero car and buildings being replaced
apps/coast/public/assets/           the Kenney CC0 kits being replaced
```

## The integration point, which is kinder than it looks

You do **not** need to touch the renderer. `ModelDef` in `models.ts` takes either a GLB `file` or a
`build()` function, and the game bakes sprite atlases from it at runtime, at fixed yaws. Drop a
`.glb` into `apps/coast/public/assets/`, add a `ModelDef`, and it is in the game.

Note `apps/arcade/public/assets/` is a **mirror**, gitignored and rebuilt from each game's `public/`
by `scripts/sync-arcade-assets.mjs` on every dev and build. A model belongs to a game. Put it in
that game's `public/` and let the mirror carry it.

`spin` on a `ModelDef` matters and is easy to get wrong: yaw 0 means *seen from behind*, which is
right for a car driving away and exactly wrong for anything beside the road.

## The hero car is not an asset

It is `buildPrototype()` in `procgen.ts` — hand-coded boxes and wedges, flat shaded. That is why it
reads as one specific car (an Adams Brothers Probe 16 rather than the late-60s endurance prototype
it was aiming at). Replacing it means generating a `.glb` and switching that `ModelDef` from
`build:` to `file:`. The `LIVERIES` table stays; it is applied separately.

**While you are in there:** `LIVERIES` ships `gulf` and `martini`. Those are not generic colour
schemes, they are two companies' trademarks, and a livery is far more identifying than a roofline.
`assets.json` has no opinion on this yet and should.

## How to write a spec

The specs describe a design language, never a car. The temptation is to feed in photographs of a
330 P4 and ask for "something like this"; do not. It produces a copy with the badges filed off —
the exact thing this is trying to avoid — and it is also the worse technical route, because one
reference drags the generator toward reproducing that car and nothing else gets any attention.

What works, and what every entry is built around:

- **Name the era and the constraints that produced the shape.** "Regulation-limited windscreen
  height", "front-hinged clamshell over an exposed spaceframe". Facts about a period of
  engineering, not anyone's design.
- **Give real proportions in metres.** The single highest-leverage field. Generators have strong,
  wrong priors about proportion, and "low" barely moves them; a wheelbase-to-height ratio does.
- **Blend three influences.** Pulled toward one source it is a copy of that source.
- **Fill in `avoid`.** Marque badges, real sponsor marks, model numbers, legible brand names on
  signage. This is a real negative prompt and it is where identifiability actually lives.

## What to build

1. **`proportion.mjs`** — render a plain orthographic side/plan silhouette at the spec's exact
   metre dimensions, flat, no styling. Attach it to the generation as a second image. This is not
   optional polish: the fix for Kestrel's proportions was an attached reference image, not a better
   sentence. A text prompt alone could not pull her off naturalistic eight-heads.
2. **`generate.mjs`** — spec → flux → key the chroma → TRELLIS.2 → `.glb` into
   `ext/assetgen/<id>/` (gitignored). `--dry-run` should print the assembled prompts.
3. **The rest of `assets.json`** — ~13 more traffic cars, the roadside architecture, signage,
   nature. Ten are written as worked examples.

## Things that will bite you

- **flux has three camera modes — front, profile, back — and no continuous rotation.** "Rotate 90
  degrees" works; "45 degrees" silently returns a front view. Do not spend generations chasing
  intermediate angles through the prompt.
- **It always returns the same flank.** To get the other one: `-flop` the reference, generate,
  `-flop` the result back. The two flips cancel and asymmetric detail lands correctly.
- **Name what you want kept.** An edit prompt that only describes the change treats everything
  unmentioned as negotiable — asking for a pose change dropped a character's wrist jewellery
  entirely.
- **Send keyed cut-outs to TRELLIS.** It keeps an alpha channel when one is present and skips its
  own background remover. Our chroma key is better than anything it would infer.
- **Rigging is characters only.** Vehicles and props do not need it — they are baked to sprites.
  `blrig` does have `rig_wheel` and `rig_turret` if a car ever needs turning wheels.
- **A reconstruction will not weight until it is watertight.** Only relevant if you rig something:
  see `tools/rigging/README.md`, where 315 open edges out of 103,000 were enough to inflate a mesh
  thirty-fold when one arm moved.

## Verifying your own work

`arcade.siomporas.com/models` (source: `apps/arcade/public/models.html`) loads any `.glb` by path,
URL, or drag-and-drop, and reports what actually came out of the file — triangles, materials,
whether textures survived, real dimensions. "It rendered" and "it is correct" are different claims.
Re-run `node scripts/model-catalogue.mjs` after adding models or the bundled list goes stale.

## Who else is on this

Notes pass as files in `/tmp/messages/inbox`, moved to `read/` on receipt. **image generator** owns
the art pipeline and `scripts/flux-art.mjs`; ask rather than editing the art path. **retro game
spelunker** owns the ROM measurement tools. Three agents share one checkout: stage commits by path,
never `git add -A`, and name another agent's file in a message rather than editing it.
