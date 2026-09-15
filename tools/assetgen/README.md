# Generating original assets from a described design language

Turbo Radrun's hero car is a hand-built pile of boxes in
[`procgen.ts`](../../apps/coast/src/render/procgen.ts), and it reads as one specific car: the
wedge-and-fin silhouette lands somewhere near an Adams Brothers Probe 16 rather than the late-60s
endurance prototype it is aiming at. The rest of the world is Kenney's CC0 kits, which are good and
free and look like Kenney's CC0 kits.

This is the path to replacing both with assets of our own: a written design language in, a rigged
and textured `.glb` out.

```
  spec (assets.json)  ──►  flux.2-dev   ──►  keyed reference view  ──►  TRELLIS.2  ──►  .glb
  era, proportions,        text→image        transparent, on our        image→3D       + textures
  cues, materials,         + proportion       own chroma key
  what to avoid              reference
```

Both ends already work. `tools/recon-service` is the TRELLIS.2 half; the flux half is the same
server that generated Kestrel. This is the middle.

## Why the specs describe a language and not a car

The temptation is to feed in photographs of a 330 P4 and ask for "something like this". Do not. It
produces the one thing we are explicitly trying not to produce — a copy with the badges filed off —
and it is *also the worse technical route*, because a single reference drags the generator toward
reproducing that exact car and nothing else in the frame gets any attention.

What works instead, and what every entry in `assets.json` is built around:

- **Name the era and the constraints that produced the shape**, not the car. "Regulation-limited
  windscreen height", "long-tail bodywork for a high-speed circuit", "front-hinged clamshell over
  an exposed spaceframe" are facts about a period of engineering. They generate the right forms
  without naming anyone's design.
- **Give real proportions in metres.** This is the single highest-leverage field. Generators have
  strong, wrong priors about vehicle proportion, and words like "low" barely move them; a
  wheelbase-to-height ratio does.
- **Blend at least three influences, weighted.** A shape pulled toward one source is a copy of that
  source. Pulled between three, it is its own thing.
- **List what must not appear.** `avoid` is a real negative prompt, and it is where marque badges,
  actual team liveries, model numbers and sponsor marks get excluded by name. A car is identifiable
  far more by its livery and badge than by its roofline.

One thing to flag on that last point: `LIVERIES` in `procgen.ts` currently ships `gulf` and
`martini`, which are not generic colour schemes — they are the trademarks of two companies, and are
the most recognisable thing about the cars that wore them. The shapes here are being made original;
the liveries want the same treatment, and `liveries.json` proposes four that carry the same
period read without borrowing anyone's marks.

## The proportion reference

Generated figures and vehicles drift toward the model's own idea of proportion. The fix that worked
on Kestrel — whose first pass came out at naturalistic eight-heads next to five-head arcade
sprites — was not a better sentence; it was attaching a reference image with the proportions drawn
on it. `proportion.mjs` renders one per spec: a plain orthographic side and plan silhouette at the
exact metre dimensions, on a flat ground, with nothing stylistic in it at all. It goes into the
generation as a second image.

## Running it

```bash
node generate.mjs --id hero-prototype          # one asset, end to end
node generate.mjs --class vehicle --dry-run    # what would be generated, and the prompts
```

Outputs land in `ext/assetgen/<id>/` — gitignored — as the reference view, the keyed cut-out, and
the mesh. Promoting one into the game is a deliberate second step: copy the `.glb` into the owning
game's `public/`, add a `ModelDef` to `apps/coast/src/render/models.ts`, and let the existing
sprite bake do the rest. Nothing here writes into a game directly.
