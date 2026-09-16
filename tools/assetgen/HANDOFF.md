# Handoff: regenerating Turbo Radrun's assets

*State of the world for whoever picks this up next. The pipeline is now end to end in code and
verified as far as this machine can reach; what remains is mesh reconstruction, which needs a host
that can see the recon service, and the judgement calls listed at the bottom. Read `README.md`
first — it is the approach. This is what exists and what is known.*

## What runs

| piece | where | state |
|---|---|---|
| **flux.2-dev** | cluster, port-forward `:18090` | text→image and image→image. ~25 s a view. **Exercised** |
| **proportion.mjs** | here | spec → measured orthographic outline, attached to the generation. **Exercised** |
| **generate.mjs** | here | spec → prompt → flux → keyed cut-out → TRELLIS.2 → `.glb`. **Exercised to the cut-out** |
| **card.mjs** | here | keyed cut-out → a `.glb` the game loads, for single-yaw kinds |
| **finish.mjs** | here | reconstruction → 1.2 MB: meshopt simplify, unlit, WebP + Draco |
| **TRELLIS.2** | `tools/recon-service` | one keyed view → textured `.glb`, ~7 s warm. **Not deployed anywhere** |
| **blrig rigging** | `tools/rigging` | mesh → Rigify rig. Characters only; nothing here needs it |

```
spec ──► proportion.mjs ──► flux.2-dev ──► keyed cut-out ──► TRELLIS.2 ──► .glb ──► game
         measured outline    text→image    dominance key     image→3D      textured
```

`assets.json` now describes **57 assets** covering every ModelDef kind the game renders except
`signDrive` and `signBay`, which share one blank board with `signCoast` and differ only in the
wording the game paints on. `node generate.mjs --audit` prints that comparison; keep it at zero.

## The recon leg: it runs, and it takes exactly one view

`svc/recon` is deployed in `default` on the bradley cluster (`KUBECONFIG=~/.kube/config.bradley`,
`kubectl port-forward -n default svc/recon 8500:80`). I recorded earlier in this file that it was
not deployed anywhere; that was wrong — it was up and I missed it in a cluster-wide listing. It
belongs to the photogrammetry agent: ask rather than redeploying it underneath them.

`generate.mjs --recon` posts the cut-outs already on disk and writes the mesh beside them, so
nothing has to be regenerated to get geometry out of art that already exists.

**One view, and this is a property of the model, not of the service.** TRELLIS.2's pipeline exposes
`run(image: Image.Image)` and nothing else — the whole public surface is `cpu, cuda, decode_latent,
decode_shape_slat, decode_tex_slat, device, from_pretrained, get_cond, model_names_to_load,
preprocess_image, run, sample_shape_slat, sample_shape_slat_cascade, sample_sparse_structure,
sample_tex_slat, to`. TRELLIS 1's `run_multi_image` is gone. Sending several views today returns
`AttributeError: 'list' object has no attribute 'mode'`, from `preprocess_image` asking a list for
its mode.

It is close, though: inside `run()` the call is `self.get_cond([image], 512)`, and `get_cond` is
typed `Union[torch.Tensor, list[Image.Image]]` and documented as "the image prompts", plural. The
conditioning stack takes a view set; only `run()` wraps one image on the way in. Reported to the
photogrammetry agent, whose service and CI it is. Every subject here is keyed at three views and
waiting for the day it lands.

**The output is 26 MB a subject** — around 400k faces after the service's own decimation, with two
2048px PBR maps. That is right for a reconstruction and roughly fifty times what a sprite bake in a
256-pixel cell can resolve. `finish.mjs` takes it to about 1.2 MB: simplify, unlit, compress.

**Simplify with meshoptimizer, never with a collapse decimator.** The first version used Blender's
decimate modifier at the same 20k target and the hero car came back CRACKED — black tears across the
bodywork, the windscreen blown to white — while the raw mesh was clean. Nineteen-to-one pulls UV
seams apart and the texture rips along them. Blender is no longer in this path at all.

So the `.glb` half of `generate.mjs` is written against the service's actual API
(`tools/recon-service/app/main.py`: POST `/reconstruct` with `images`, poll `/jobs/<id>`, GET
`/jobs/<id>/asset`) and has never been run.

**What shipped instead** is `card.mjs`, and for the forty roadside kinds it is not a workaround —
see README.md. The cars are what still want meshes.

## What was measured, and cost a generation each to learn

These are the findings this session added. The general flux behaviour — three camera modes, the
flank trick, naming what must be kept in an edit — is in `apps/fighter/ART.md` and still holds.

- **An attachment's LAYOUT transfers, not just its content.** The proportion reference was
  originally two panels, elevation over plan. The generation came back as a two-panel technical
  drawing: two cars, dimension leader lines, garbled numbers in the margins. The prompt said "draw
  the object, never the outline" and it changed nothing. One panel fixed it completely.
- **A rotation is relative to its source view.** Asking a three-quarter view for "a full side
  profile, rotated exactly 90 degrees" returns the same car turned about that far — roughly fifteen
  degrees off a true profile. The cardinals the model understands are cardinals *of the source
  frame*. Harmless for reconstruction, which only wants consistent views; fatal for measuring
  anything off the result, so `proportionCheck` refuses to measure those.
- **Name the colour or the backdrop will.** The first hero came back green, because the chroma was
  the only colour mentioned in the prompt. Every vehicle spec now carries `paint`.
- **Vegetation cannot go on a green screen.** The prompt has to say the subject is never the key
  colour, and the model obeys: the first palm had brown fronds. `class: "nature"` keys on magenta
  instead and comes back green.
- **The model draws a contact shadow whatever you say.** Three wordings — flat shadowless lighting,
  "floats against the colour", "no ground under it" — each shrank it and none removed it. It is
  removed in the key instead, by a relative-dominance test: the shadow is a darkened backdrop, so it
  is still green-dominant *relative to its own brightness* where a black tyre is not.
- **Muted magenta is a weak key.** The model returns rose, not `#ff00ff`. `min(r,b) - g` scores 0.13
  on it, close enough to the threshold that noise freckles the cut-out; `(r+b)/2 - g` scores 0.27
  and still reads negative on every vegetation colour.

## Where things live

```
tools/assetgen/assets.json        57 design-language specs. The `$comment` block documents the fields
tools/assetgen/liveries.json      four original liveries, to replace the two trademarked ones
tools/assetgen/proportion.mjs     spec → measured outline PNG
tools/assetgen/generate.mjs       spec → prompts → flux → keyed cut-out → mesh
tools/recon-service/              image→3D as a service: Dockerfile, API, Helm chart
apps/coast/src/render/models.ts   ModelDef — the contract a generated asset must satisfy
apps/coast/src/render/procgen.ts  the hand-built hero car, architecture and LIVERIES being replaced
apps/coast/public/assets/         the Kenney CC0 kits being replaced
```

## Promotion, which is kinder than it looks

You do **not** need to touch the renderer. `ModelDef` takes either a GLB `file` or a `build()`
function, and the game bakes sprite atlases from it at runtime at fixed yaws. Drop a `.glb` into
`apps/coast/public/assets/`, add a `ModelDef`, and it is in the game. `apps/arcade/public/assets/`
is a **mirror**, gitignored and rebuilt by `scripts/sync-arcade-assets.mjs`; a model belongs to a
game, so put it in that game's `public/` and let the mirror carry it.

`spin` matters and is easy to get wrong: yaw 0 means *seen from behind*, which is right for a car
driving away and exactly wrong for anything beside the road.

Verify with `arcade.siomporas.com/models` (source: `apps/arcade/public/models.html`), which loads a
`.glb` by path, URL or drag-and-drop and reports triangles, materials, whether textures survived and
real dimensions. Re-run `node scripts/model-catalogue.mjs` after adding models.

## What is left

1. **Fix the recon image build, then run the recon leg.** The cars cannot be cards: traffic is
   baked at twelve yaws across four pitches, the hero at sixteen.
2. **The hero car, properly.** `buildPrototype()` is the thing this was started for. Generating it
   is one command; deciding it is good enough to replace a hand-built model that the handling
   already looks right against is a judgement call, and the `LIVERIES` swap rides along with it.
3. **Five specs have no game slot** — `traffic-convertible`, `traffic-bus`, `traffic-tanker`,
   `traffic-camper`, `sign-pylon`. Each needs a `ModelDef` and a place in a scene's roadside or
   landmark list in `apps/coast/src/world/scenes.ts`. They were written because the road is short of
   variety, not because anything asked for them.
4. **The signs keep their text step.** `buildSign()` paints wording onto a canvas texture; three
   sign kinds differ only in that string. Generate the board blank — as `sign-highway` specifies —
   and keep the canvas step, or lose the ability to restyle a sign per stage.

## Who else is on this

Notes pass as files in `/tmp/messages/inbox`, moved to `read/` on receipt. **image generator** owns
the art pipeline and `scripts/flux-art.mjs`; ask rather than editing the art path — nothing here
imports it, deliberately, because dev and klein take attachments under different field names.
**retro game spelunker** owns the ROM measurement tools. **photogrammetry** owns the recon service
and the rigging. Several agents share one checkout: stage commits by path, never `git add -A`, and
name another agent's file in a message rather than editing it.
