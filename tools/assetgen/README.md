# Generating original assets from a described design language

Turbo Radrun's hero car is a hand-built pile of boxes in
[`procgen.ts`](../../apps/coast/src/render/procgen.ts), and it reads as one specific car: the
wedge-and-fin silhouette lands somewhere near an Adams Brothers Probe 16 rather than the late-60s
endurance prototype it is aiming at. The rest of the world is Kenney's CC0 kits, which are good and
free and look like Kenney's CC0 kits.

This is the path to replacing both with assets of our own: a written design language in, a textured
`.glb` out.

```
  spec (assets.json)  ──►  flux.2-dev   ──►  keyed reference view  ──►  TRELLIS.2  ──►  .glb
  era, proportions,        text→image        transparent, on our        image→3D       + textures
  cues, materials,         + proportion       own chroma key
  what to avoid              reference
```

```bash
node proportion.mjs --id hero-prototype --annotate   # the measured outline, dimensioned for reading
node generate.mjs --class vehicle --dry-run          # every prompt that would be sent, nothing spent
node generate.mjs --id hero-prototype                # one asset, end to end
node generate.mjs --audit                            # which of the game's kinds still have no spec
node generate.mjs --recon --class nature             # mesh what is already keyed, no generation
```

Outputs land in `ext/assetgen/<id>/` — gitignored — as the proportion reference, the generated view,
the keyed cut-out, the mesh and a `meta.json` recording what was asked for and what came back.
Promoting one into the game is a deliberate second step: copy the `.glb` into the owning game's
`public/`, add a `ModelDef` to `apps/coast/src/render/models.ts`, re-run
`node scripts/model-catalogue.mjs`, and let the existing sprite bake do the rest. Nothing here
writes into a game.

**The two servers are port-forwards, not public URLs.** `FLUX_HOST` (default `:18090`) wants
flux.2-dev — not the klein the fighter pipeline uses, and the two take their attachments under
different field names. `RECON_HOST` is `tools/recon-service`.

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
- **List what must not appear.** `avoid` is where marque badges, team liveries, model numbers and
  sponsor marks get excluded by name. A car is identifiable far more by its livery and badge than
  by its roofline. (It is assembled into `negative_prompt`, which on a guidance-distilled model
  does nothing unless `--true-cfg 2` turns real CFG on, at twice the time. The load-bearing part of
  it is repeated in the positive prompt, which always applies.)
- **Say what colour it is.** `paint`. The first hero generation came back GREEN: the backdrop was
  the only colour named anywhere in the prompt, so the model took the body colour from it, and the
  chroma key then ate the car.

`liveries.json` is the same argument applied to paint schemes. `LIVERIES` in `procgen.ts` currently
ships `gulf` and `martini`, which are not generic colour combinations — they are two companies'
trademarks, and the most recognisable thing about the cars that wore them. Four originals are
proposed there, with the two generic existing ones kept.

## The proportion reference

Generated figures and vehicles drift toward the model's own idea of proportion. The fix that worked
on Kestrel — whose first pass came out at naturalistic eight-heads next to five-head arcade
sprites — was not a better sentence; it was attaching a reference image. `proportion.mjs` renders
one per spec: a plain orthographic side elevation at the exact metre dimensions, flat, with no text,
no grid and no styling in it at all.

**One panel, and that was measured.** The first draft drew the plan below the elevation, because a
plan carries width information an elevation cannot. Attaching it produced a generation with *two
cars in it*, one per panel, with dimension leader lines and garbled numbers in the margins: the
model read the attachment's layout as the layout of the answer, exactly as the fighter pipeline
reports for grids. `--plan` still draws both for reading by eye; `generate.mjs` never attaches that
form. The width goes in the prompt, as metres.

## Cards, for everything the game bakes at one angle

`card.mjs` wraps a keyed cut-out in a `.glb`: one quad, standing on the ground at the spec's metres,
with an unlit alpha-masked texture. Forty of the game's kinds now load one.

This is not a stand-in for the mesh, for those kinds. Every nature, prop and architecture entry in
`models.ts` is declared `yaws: [0]`: the game photographs it from exactly ONE angle, through a 6.5x
lens at nine degrees above the horizon, and shows that sprite for the whole approach. A card
foreshortens by cos(9°) — a hundredth of its height — and the mesh a reconstruction would give us
is thrown into the same 128-pixel cell at the same angle. What the card cannot do is turn: cars are
baked at twelve yaws across four pitches and the hero at sixteen, and a card seen from the side is
an edge. Those need the real mesh.

The material is `KHR_materials_unlit`, which three's loader turns into a MeshBasicMaterial. A
cut-out is a photograph and carries its own light; letting the bake's lamps fall on it again gives a
palm lit from two directions. It also keeps `SpriteAtlas`'s material pass — which flattens shading
on every MeshStandardMaterial it finds — from touching these at all.

## Two servers, and they have opposite strengths

Measured, not assumed, and the asymmetry is the whole reason `engineByClass` exists.

**dev reads what you attach — so literally that it copies it.** A two-panel outline came back as a
two-panel technical drawing; a style sheet came back as the style sheet. Everywhere else that is the
failure mode, and for a vehicle it is exactly what is wanted: asked for a mid-engined prototype
against a plain envelope box, every server returns a long-nosed front-engined sports racer, through
six rewordings. Give dev a DRAWN PROFILE (`profile` on a spec) and it traces it. Dev discards
`reference_image` silently, so there is no style guide on that side.

**klein ignores attachments entirely.** Two completely different outlines under `image` produced
BYTE-IDENTICAL output — which is how the wasted batch was found. It reads `reference_image`, which
refers rather than copies, so klein is where the style guide works and where proportion is only as
good as the sentence describing it. Right for scenery: generic shapes, and the look is everything.

So vehicles go to dev with a drawn profile, scenery to klein with the style guide, and a spec can
override with its own `engine`.

## The style guide has no objects in it

`--make-bible` generates it, from a prompt in `assets.json` so it is reproducible. The first one was
what you would expect — a sheet of arcade cars, palms and pines in the right look — and attaching it
returned THE SHEET, every time. So did a second version made of recognisable primitives. What works
is a palette-and-finish chart: spheres, cubes and cones in the arcade palette, nothing anyone could
copy, which conveys colour, surface and shading and contains no object to reproduce.

On klein it rides in `reference_image`, composed with this asset's own outline — the only channel
that side reads.

## Two chroma colours, because a third of the manifest is vegetation

Everything keys onto flat green except `class: "nature"`, which keys onto magenta. A green screen
behind a leaf is the one case where the backdrop and the subject are the same colour, and the prompt
has to say the object is never the key colour — so the first palm came back with brown fronds, and
obediently so. On magenta it comes back green. Per-spec `chroma` overrides the class default: put a
red car on green, never on magenta.

The key itself reads **green (or magenta) dominance**, not distance from a sampled colour, because
the model draws a contact shadow whatever the prompt says and that shadow arrives nearly black —
further from the backdrop than a white car is. See `keyChroma` in `generate.mjs` for the two tests
and why each is there.

## What the prompt budget is for

`generate.mjs` assembles to 1900 characters and gives way at the end of the cue list when it runs
over, saying so. That is not the model's ceiling — the cluster patched dev's text encoder to 2048
tokens — it is the point past which the fighter pipeline measured the model trading one rule for
another. Six or seven cues is the working size. A spec that will not fit is usually a spec with two
cues that are one cue.

## Verifying your own work

Two checks are built in, and both answer questions that "it rendered" does not:

- `--audit` compares the specs against the ModelDef kinds the game actually renders, in both
  directions: kinds with no spec, and specs with no slot to be promoted into.
- After a **profile** view, the keyed bounding box is measured against the spec's own metres and the
  difference reported. A rotation is relative to its source, so a profile rotated out of a
  three-quarter view is not square-on and is not measured — measuring the wrong thing confidently
  is worse than not measuring.

For the mesh, `arcade.siomporas.com/models` loads any `.glb` by path, URL or drag-and-drop and
reports what actually came out of the file: triangles, materials, whether textures survived, real
dimensions.
