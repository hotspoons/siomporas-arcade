# Handoff: building a library of car models

**For:** a new agent picking up 3D asset generation in `/workspaces/apex-conduit`.
**Written:** 2026-09-27.

Rich wants a library of cars for games in this repo. **He will describe the cars** — the marques,
the eras, the silhouettes, the liveries. Your job is the pipeline: turn each description into a
textured 3D model a game here can load, and do it repeatably enough that the roster can grow.

This document orients you. It is not a plan; the plan is yours to write once you have read the two
documents in §7 and run one asset end to end.

---

## 1. The chain, in one line

**spec → proportion reference → FLUX (2D) → chroma key → TRELLIS.2 (3D) → finish → catalog entry**

Every step already exists and has been run. Nothing here is speculative except the one open
blocker in §5, which matters more for cars than for anything else this pipeline has made.

---

## 2. The tools

Everything lives in `tools/assetgen/`. It was **built for vehicles** — cars are its original
purpose, not an adaptation of it.

| file | what it is |
|---|---|
| `generate.mjs` | the whole chain: spec → prompt → FLUX → chroma key → POST to recon → `meta.json` |
| `proportion.mjs` | spec dimensions in metres → a flat orthographic side elevation, attached to the generation |
| `finish.mjs` | raw reconstruction → shippable glb (see §6) |
| `card.mjs` | a one-quad unlit billboard. **Not for cars** — "a card seen from the side is an edge" |
| `slim.mjs` | post-hoc face reduction; `--check` reports what a model currently costs |
| `assets.json` | 57 specs plus shared defaults. 14 are already `class: "vehicle"` |
| `liveries.json` | original paint schemes, written to replace two trademarked ones |

The commands you will actually use:

```bash
node tools/assetgen/proportion.mjs --id <id> --annotate      # check the proportions first
node tools/assetgen/generate.mjs --class vehicle --dry-run   # prompts only, nothing spent
node tools/assetgen/generate.mjs --id <id>                   # end to end
node tools/assetgen/generate.mjs --recon --class vehicle     # cut-outs already on disk
node tools/assetgen/generate.mjs --audit                     # exits 1 on a paint/backdrop clash
node tools/assetgen/finish.mjs --id <id> --out <game>/public/assets/generated
node tools/assetgen/slim.mjs --check
```

Output lands in `ext/assetgen/<id>/` (gitignored): the proportion sheet, each view, each keyed
cut-out, the raw glb, the finished glb, and `meta.json`. **Nothing writes into a game.** Promoting
an asset is a deliberate copy, and that is on purpose.

There is also `tools/assetsvc/`, the same chain as a service with a job queue and a catalog. It is
built and published but **not deployed**. Use `generate.mjs` directly unless you have a reason.

The closest working templates for a batch of related assets are `probes/editor-assets.mjs` and
`probes/terrain-rockkit.mjs` (28 rocks across 7 lithologies). A car kit will look like those.

---

## 3. The endpoints

Both services run on the **`gh200-1`** cluster, which is the current default kubeconfig context.

**FLUX — `flux.2-dev`, deployment `high-brine`**

- public: `https://high-brine.richard-siomporas.basedweights.com`
- in-cluster: `http://high-brine-high-brine-flux2-dev-lws-api.default.svc`, pod port 8000
- OpenAI images API: `POST /v1/images/generations` (JSON), `POST /v1/images/edits` (multipart)

**TRELLIS.2 — service `recon`**

- public: `https://recon.richard-siomporas.basedweights.com`
- in-cluster: `http://recon.default.svc`
- `POST /reconstruct` multipart, repeated `images` field → `202 {job, poll}`; `GET /jobs/<id>`
  until `done`; `GET /jobs/<id>/asset` is the glb. No auth.

Three things about these that will cost you an afternoon each:

1. **`/v1/images/edits` returns 404 through the public hostname.** The gateway routes on a header
   derived from a JSON body's `model` field, and a multipart form never carries one. Text→image
   over the public URL is fine; **anything with an attachment must go through the in-cluster
   service or a port-forward.** Extra views are edits, so this is not optional for cars.
2. **`generate.mjs` still hard-codes the OLD recon cluster** (`recon.bradley-hartlove-gh200…`).
   Always set `RECON_HOST` explicitly.
3. **The attachment field name is documented two different ways** in this repo — `image` versus
   `image[]`, and the two sources disagree about which model wants which. Settle it with one cheap
   request before you spend a batch.

Port-forwards, when you need the in-cluster path:

```bash
kubectl port-forward -n default svc/high-brine-high-brine-flux2-dev-lws-api 18090:80
kubectl port-forward -n default svc/recon 8500:80
```

Throughput: about 25 seconds for a 1024² view, and **90 seconds to two minutes per reconstruction,
serialised** — recon is one replica behind one GPU lock. A roster of fifty cars is an unattended
couple of hours, and there is no fan-out helper in the repo. Scaling means more nodes, not more
replicas.

---

## 4. What FLUX will and will not do

All of this was measured here, and none of it yields to better prompting:

- **Camera angles work only at cardinals.** Front, profile and back. "A three-quarter view, 45
  degrees" returns the plain front view — measured at a 424px bounding box against the front's
  425, i.e. the same picture.
- **The same flank comes back every time.** Mirror the input in and the output back out to get the
  other side.
- **Tall subjects are cropped whatever you ask.** Adding a sentence naming a margin made the
  subject narrower and cropped it by exactly as much. The fix was an attached reference image, not
  a better sentence. This is what `proportion.mjs` is for.
- **An attachment's layout transfers**, so attach one panel, never a contact sheet.
- **Name the paint colour explicitly** or the car takes its body colour from the backdrop. Three
  specs painted themselves the colour of their own chroma card and dissolved to 8% ink in the
  keyer; `--audit` now fails on that.
- **The prompt budget is about 1900 characters.** Past roughly 2000 the model starts trading one
  instruction for another.
- **Two text→image generations from one spec are two different cars.** Extra views must be
  *edits* of view 1. Never a second prompt.

---

## 5. The open blocker, and it is a car problem

**Multi-view reconstruction is effectively single-view.** The recon service accepts a list of
images, but TRELLIS.2's `run()` wraps a single image before conditioning, so a list raises
`AttributeError: 'list' object has no attribute 'mode'`. Every asset in this repo today — including
every existing car — is reconstructed from **one** view, with the unseen half invented.

For a rock or a bush nobody notices. For a car that a game will show from twelve or sixteen yaws,
the far flank and the back are guesswork. The upstream fix is reportedly one line, and
`get_cond` is already typed for a list, but it has not landed.

**Decide this early**, because it shapes everything after it: fix the service so multi-view works,
or accept single-view and design the roster around what a single view can carry. Do not discover
it halfway through a batch of forty.

---

## 6. Finishing, and what a consumer needs

`finish.mjs` runs three `@gltf-transform/cli@4` passes in this order, and the order matters:

1. `simplify --ratio 0.05 --error 0.001` — **meshoptimizer, never a collapse decimator.** Blender's
   decimate at the same target cracked the hero car: black tears across the bodywork, windscreen
   blown white. 19:1 pulls UV seams apart and the texture rips along them.
2. `unlit` — TRELLIS bakes lighting into base colour and the sprite bake lights it again. **Must
   run before Draco**, or it decompresses to do its work and undoes the compression.
3. `optimize --texture-compress webp --texture-size 1024 --compress draco`

Result: a **Draco-compressed** glb, roughly 20k faces and 0.8–1.2 MB, down from about 25 MB raw.

Three things every consumer must handle:

- **A `DRACOLoader` is mandatory and there is no way to skip it.** A `GLTFLoader` without one does
  not warn, it rejects — so any `.catch(() => fallback)` quietly turns a real model into a box.
- **No scale and no units.** TRELLIS normalises to about a 1m box. The consumer rescales.
- **No canonical facing.** The model faces wherever reconstruction left it. Corridor corrects it
  per asset with `yaw_offset_deg`; coast calls the same thing `spin`, where `spin: 0` means seen
  from behind — right for a car driving away, wrong for a roadside object.

And a standing rule in this repo: **never hand-type a model's width.** Four separate hand-written
width tables accumulated here and every one was wrong, some by a factor of sixteen. Measure with
`scripts/roadside-check.mjs --write`.

---

## 7. Read these two before you touch anything

- **`tools/assetgen/README.md`** — the approach. Why a spec describes a design language rather
  than a specific car, what the proportion reference is for, and why the two servers have
  opposite strengths.
- **`tools/assetgen/HANDOFF.md`** — the state of the world, what has been measured, and what each
  finding cost to learn.

Then: `docs/corridor/PIPELINE.md` §Part 3 for where props slot into corridor, and
`tools/recon-service/README.md` for the service itself.

---

## 8. Where the cars will live

This is **not decided**, and it is worth asking Rich rather than assuming.

- **Coast / Turbo Radrun** already has generated cars: `apps/coast/public/assets/generated/` holds
  a hero prototype in four liveries, a formula single-seater, and eight traffic bodies. Cars there
  bake to a **sprite atlas** at twelve yaws by four pitches (sixteen for the hero) and the game
  downloads no glb at runtime.
- **Corridor**, the driving world, has a **procedural** car — `apps/corridor/src/car.ts` builds a
  4.4m silhouette in code. No generated car is loaded there, and the catalog at
  `apps/corridor/public/assets/catalog.json` has **no `car` or `vehicle` category** yet. Corridor
  is also about to grow a traffic system (`docs/corridor/PLAN-TRAFFIC-AND-RAGE.md`), which wants
  many cheap car bodies and one detailed player car.

The two targets want different things: coast wants sprite-bakeable models at many yaws, corridor
wants low-cost instanced bodies plus a catalog category. Find out which before you set a face
budget.

Corridor's catalog entry format, for reference:

```json
{ "id": "overpass-01", "name": "Concrete overpass span", "category": "bridge",
  "footprint_m": [30, 12], "height_m": 2.6, "glb": "assets/overpass-01.glb",
  "fit": "span", "yaw_offset_deg": 90 }
```

An entry with no `glb` draws a labelled box of exactly that size, so **the catalog can grow ahead
of the models** — a useful way to agree the roster with Rich before spending GPU hours on it.

---

## 9. Suggested first moves

1. Read the two documents in §7.
2. `node tools/assetgen/generate.mjs --class vehicle --dry-run` and read the prompts it builds for
   the fourteen vehicle specs that already exist.
3. Settle the attachment-field question (§3.3) with one cheap edit request.
4. Take **one** existing vehicle spec all the way through to a finished glb and look at it —
   `apps/arcade/public/models.html`, served at `arcade.siomporas.com/models`, reports triangles,
   materials, whether the textures survived, and the real dimensions.
5. Decide the multi-view question (§5) and tell Rich what it costs either way.
6. Only then propose a roster format and ask Rich for the car descriptions.

## 10. One warning about trust

Two fields in this pipeline lie, and both have misled someone already:

- **`meta.json` records the wrong model name** when an engine override is used. It writes the
  module-level default, not the engine that actually drew the asset — which is why every existing
  car's `meta.json` claims a model it was not generated with.
- **`finish.mjs --ratio` is a fraction, not a target.** Five per cent of a raw mesh that varies
  between two and twelve million faces is itself a variable. That is why `slim.mjs` exists, and
  why a bush once shipped at 276,000 faces.
