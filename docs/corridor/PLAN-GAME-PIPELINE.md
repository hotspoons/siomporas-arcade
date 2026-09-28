# The game pipeline: from a real place to a playable level

**Status:** design, 2026-09-28. Nothing here is built yet except where marked *exists*.
**Audience:** whoever picks this up next — a person or an agent.

---

## The goal, in Rich's words

> Define a map, edit the map's world settings, place props and furniture, apply an ECS config,
> bind assets to entities, apply a goal and actual game over top with a program (which can choose
> to do things like hide street names, alter modes of transport, even define new exploration
> techniques), then bake it in an iterative loop.
>
> Like trying to speedrun the scope of a AAA game by borrowing from the real world to set the
> stage.

And the range it has to serve:

> As lightweight (tell an agent hooked up via the patapsco AI platform or zip ties that I have this
> vision of this game level with these goals and it takes place in this environment, and let the
> agent go to town in a loop) or heavyweight (farm-to-table TypeScript written by a human, 3D
> assets modelled by a human and uploaded) as a user would want to be.

That second half is the constraint that decides the architecture. **Every stage has to be a file
a human can write and an agent can generate, addressed the same way by both.** If the agent path
needs its own representation, there are two products.

---

## The seven stages

Each is a document on the volume. Each has a validator. Each can be produced by hand, by the
editor's forms, or by an agent — and nothing downstream can tell which.

| # | Stage | Document | Today |
|---|-------|----------|-------|
| 1 | **Define a map** | `worlds/<slug>.json` | *exists* — drag a box, measure, save |
| 2 | **World settings** | `worlds/<slug>.json#look` + **preset** | partial: style/season/relief/water only |
| 3 | **Props and furniture** | `sites/<slug>/placements.json`, `areas.json`, `structures.json` | *exists* — the Place mode |
| 4 | **ECS config** | `levels/<id>.json#simulations` | stub: a `kind` and a `seed`, nothing reads richer |
| 5 | **Bind assets to entities** | `catalog.json` + a binding table | partial: a catalog exists, binding does not |
| 6 | **Goal and program** | `levels/<id>.json#scenario` + `programs/<id>.ts` | scenario primitives exist; **no program layer** |
| 7 | **Bake, iteratively** | a Job, watched | *exists* for the world; not for stages 3–6 |

The ordering is real but not a wizard. You go back to stage 2 after playing stage 7 constantly;
that is what "iterative loop" means and the UI should make going backwards free.

---

## Stage 2 in detail: the presets manager

> We need a presets manager that lets us use all of the realtime adjustable rendering options and
> set them as the default for a world, including season, trees, grass, car dynamics, engines, time
> and time dilation, weather, etc. We should then be able to apply a preset for the level; end
> users with the tuning panel can override these, but the tuning panel needs to apply over top of
> the level settings.

### Three layers, resolved in one place

```
  world defaults      worlds/<slug>.json#look        "this place looks like this"
        ↓ overridden by
  level preset        levels/<id>.json#preset        "this game is set at dusk in the rain"
        ↓ overridden by
  live tuning         the F6 panel, in the browser   "I am looking at something right now"
```

The rule Rich stated — *the tuning panel applies over the top* — means the panel is not a fourth
store, it is **the top layer of the same store**, and the resolved value is what the renderer
reads. One function:

```ts
resolve(world.look, level.preset, session.overrides) -> Settings
```

### What a preset holds

Everything in `TUNE_TABS` that is a world-authoring decision rather than a machine capability.
That distinction matters and is the one judgement call here:

- **In**: season, weather, time of day, time dilation, sky and lighting, tree and grass density
  and species mix, water level, terrain relief, road paint and retroreflection, car dynamics,
  engine choice and gearbox, traffic density and signal programs.
- **Out**: render scale, shadow resolution, FXAA/SMAA, tile budgets, `ENGINE_SIM_HZ`, the LOD
  distances. These describe the machine, not the world, and baking them into a level means a
  level that is unplayable on a laptop.

`tuning.ts` already has the shape for this — every knob is declared with a range, a step and a
note — so the split is a flag on the declaration, not a second list to keep in step. **Add
`scope: 'world' | 'machine'` to `tune()` and the preset manager is a filter over what already
exists.** A knob with no scope is `machine`, so nothing leaks into a preset by being forgotten.

### A named library, and the transitions between its entries

Rich, 2026-09-28: **named library**, and — the part that changes the design —

> We need to be able to apply these scripted from game interactions. In a long running story it
> might all of a sudden become night and there might be a cut scene with rigged characters acting.
> We need to be able to tween between environment states smoothly, so it goes from sun to dark and
> from clear to rainy and hills grow into mountains and it goes from summer to winter with a foot
> of snow, in a smooth motion that can be controlled and defined by an API.

So a preset is not a setting, it is a **keyframe**. The library holds snapshots of state and the
API moves between them:

```ts
api.preset('dusk-rain', { over: 8, ease: 'inOut' })   // seconds
api.preset('midwinter', { over: 60 })                 // during a cutscene
api.preset(api.groundState)                           // back to where we started
```

**A ground state is inferred at start and is what reinitialization returns to.** It is the
resolved `world.look ← level.preset` with no session overrides — captured once at load, so a
program that tweens away from it always has somewhere to come home to, and a level that crashes
mid-transition reloads into a defined state rather than wherever the tween had got to.

#### What tweening actually requires

This is the hard part and it is not uniform. Three kinds of knob:

| Kind | Examples | How it moves |
|---|---|---|
| **Continuous** | sun angle, fog density, wetness, water level, relief, time dilation | interpolate; free |
| **Cross-faded** | season tint, grass and tree species mix, road wetness masks | two states rendered and blended, or a shader `mix` on a uniform |
| **Discrete** | tree *models*, snow *geometry*, an engine script, a signal program | cannot interpolate — needs a transition |

"Hills grow into mountains" is `relief`, which is continuous and already a knob — that one is
nearly free. "A foot of snow" is not: it is geometry and a different ground material, so it needs
either a displacement parameter that exists from the start (preferred: bake the capability, tween
the amount) or a cross-fade between two built states.

**The design rule that falls out: a preset may only contain knobs that can be tweened, and every
knob declares how.** Add `lerp: 'linear' | 'mix' | 'step'` alongside the `scope` flag on `tune()`.
A `step` knob in a tween snaps at the midpoint and says so in the editor, so an author finds out
while authoring rather than in a cutscene.

### Import, export, manage

Same shape as the world bundles that already work: a `.corridor.json` envelope with a `kind`, a
version and an array. A preset is a document, so it exports, imports, diffs and round-trips with
the machinery that is already written and probed.

### The prototype slice

Rich corrected what I had assumed here. Not a code sandbox — **a small subset of a larger map to
test tuning presets against**:

> If you go to bake a big map, maybe grab a section as close to the middle along the inferred
> spine, of at least half a mile, before doing the whole bake — so you have an area to prototype
> while you wait for a longer running process to complete.

That is a much better idea than a preview pane, because it is the real renderer on real baked
data, and it costs nothing extra in wall-clock: the big bake is running anyway.

```
  bake requested
    ├─ slice bake   ~half a mile centred on the spine   minutes  → prototype here
    └─ full bake    the whole square                    hours    → the real thing
```

The slice is centred on the **inferred spine** — the primary road the world is measured against,
which the preview already computes — and at least half a mile so there is somewhere to drive. It
is a world in its own right (`<slug>-slice`), so nothing new has to understand it: the viewer, the
Place mode and the preset panel all open it as they open anything else.

When the full bake lands, the slice is the thing you have already tuned against, and the preset
carries over unchanged because it is a document, not a property of the bake.

---

## Stage 4 and 5: ECS config and asset binding

The ECS is real and chosen (bitECS, MPL-2.0, measured at 57× the alternative). What is missing is
the **configuration** layer: today a level can say `simulations: [{kind, seed}]` and nothing reads
more than that.

What the pipeline needs:

```jsonc
{
  "ecs": {
    "archetypes": {
      "commuter":  { "components": ["Vehicle", "Autonomous", "Engine"], "asset": "sedan-generic" },
      "pedestrian":{ "components": ["Human", "Walking"],                "asset": "person-casual" }
    },
    "populations": [
      { "archetype": "commuter", "brush": "traffic", "density": 12, "seed": 7 }
    ]
  }
}
```

**Binding is a table from archetype to catalog id**, and it is the join between stage 3's catalog
and stage 4's entities. It belongs in the level rather than in the world, because the same street
is a commute in one game and a car chase in another.

The traffic brush Rich asked for earlier is a `populations` entry with a region, and the signal
programs already have a declarative form (`SignalProgram`/`DUMB`) that is exactly this shape.

---

## Stage 6: the program layer

This is the piece with nothing behind it today, and the one that makes it a game rather than a
diorama.

> Apply a goal and actual game over top with a program — which can choose to do things like hide
> street names, alter modes of transport, even define new exploration techniques.

Those three examples are deliberately different in kind and they set the bar:

1. **Hide street names** — a render flag. A declarative setting could do it.
2. **Alter modes of transport** — swapping the player's controller. Not a setting; a choice
   between implementations.
3. **Define new exploration techniques** — arbitrary new behaviour. Only code can do this.

So the program layer is **code**, and the declarative scenario primitives are the vocabulary it is
written against rather than a replacement for it. The existing `scenario` — facts, conditions,
actions — stays as the simple path, and a program is what you write when the simple path runs out.

```ts
// programs/<id>.ts — the heavyweight path, written by a human or an agent
export default defineGame({
  setup(world, api) {
    api.hide('street-names')
    api.transport('parkour')            // swaps the controller
    api.on('enters', 'zone:rooftop', () => api.award(50))
  },
})
```

**The API surface is the product here.** It is what an agent is prompted against, what a human
reads the types of, and what stays stable while everything under it moves. It should be small,
declarative where it can be, and give straight access to the ECS where it cannot.

### Sandboxing

A program is code from a person or an agent, running in the viewer. It runs in the page, so it can
do anything the page can. That is acceptable for an author running their own level and **not**
acceptable for playing a level somebody else published. The split:

- Authoring: run it directly, fast iteration, no sandbox.
- Published: either a Worker with a message-passing API, or a review gate.

Decide this before anything is published, not after.

---

## The thing that makes it a loop, not a pipeline

Every stage has to be re-enterable from the one after it, cheaply:

- **Re-baking a world is already minutes rather than hours** because the sources are cached.
- Stages 3–6 do not need a bake at all — they are documents the viewer reads at load.
- So the loop is: change a document, reload the viewer, play. Seconds.

The only stage with a real cost is 1→2, and that is where the agent loop pays for itself: an agent
can run twenty iterations of stages 3–6 while a person sleeps, because none of them costs a bake.

---

## The light-to-heavy spectrum

The same documents, three ways in:

| | Lightweight | Middle | Heavyweight |
|---|---|---|---|
| **Stage 1–2** | "somewhere hilly near the coast" → agent picks and draws | the editor's forms | hand-written JSON |
| **Stage 3** | agent places from the catalog | the Place mode | hand-authored placements |
| **Stage 5** | agent generates missing assets | the Assets panel | modelled in Blender, uploaded |
| **Stage 6** | agent writes the program from a description | scenario primitives in Stage | hand-written TypeScript |

**The agent is not a mode of the editor. It is another client of the same API.** That is what
makes both ends of the spectrum work: the agent uses the endpoints the forms use, so anything it
produces is editable by hand afterwards and anything a human produces is legible to it.

This is also why the in-editor agent must be the embedded **patapsco remote** client rather than a
bespoke chat box (see the separate note on that work): the agent picker, session manager and ACP
client already exist, and the editor's job is to hand them the workspace and the tools — which is
where **Blender compiled for arm64 and the blender MCP tools** come in, for the heavyweight path's
rigging.

---

## Publishing is a bundle, not a button on every object

> Everything has a push to S3 button — that is the wrong shape. As part of the next iteration we
> want to accumulate a bundle then publish the bundle, not an individual model or a map with no
> world mechanics defined. (You could just bake a map and push the default viewer up I guess, but
> the UI should not encourage this.)

Today "Push to S3" appears on the asset panel, and publish appears on the bake panel, and each
sends one thing. That teaches the wrong model: it makes an asset and a world look like products,
when the product is **a playable level and everything it needs**.

So: a **release** is the unit. It names a world, a level, the preset library it uses, and the
assets bound to its entities — and publishing resolves that closure and pushes it as one thing.

```jsonc
{ "kind": "corridor-release", "version": 1,
  "world": "crofton-triangle", "level": "midnight-run",
  "presets": ["dusk-rain", "midwinter"],
  "assets": ["rx7-fd", "roadside-mailbox"],     // resolved from the binding table
  "program": "programs/midnight-run.ts" }
```

The UI follows: a staging area that accumulates, shows what is missing (a level with no goal, an
entity bound to an asset that has no mesh), and one publish action. Pushing a bare baked map stays
*possible* — it is a legitimate thing to want — but it is the outcome of a release that happens to
have no mechanics, not a button that invites it.

This also gives the iterative loop a natural unit: a release is what you hand to a player, and
what an agent's loop produces at the end of a run.

---

## What has to be folded in first

> We don't need an external service that will be wiped on a fresh clone sticking around, everything
> needs to be folded in here.

`ext/assetlib` is 4.2 GB and **`ext/*` is gitignored — nothing under it is in the repo.** On a
fresh clone the tool and the library both vanish. It holds the 3D viewer, the asset browser, the
materials work and the hero cars; it serves `/api/assets` and `/api/materials`, which is a
different API from `tools/assetsvc` (`/health`, `/specs`, `/catalog`, `/jobs`). Pointing the
editor's `WORLDEDITOR_ASSETSVC` at it does nothing but produce the same "not answering" screen,
because the editor probes `/health` and gets a 404.

The fold:

1. **The tool is code and belongs in the repo.** ~2,300 lines across ten files. `viewer.html` and
   `turntable.mjs` become the 3D preview in the Assets panel — corridor already vendors three and
   the Draco decoder, and a DRACOLoader is mandatory because `finish.mjs` emits Draco and
   GLTFLoader rejects rather than warning.
2. **The pipeline scripts** (`build`, `candidates`, `glass`, `fillholes`, `style`, `materials`)
   merge into `tools/assetsvc`, which already has the job runner and the model resolver.
3. **The library is data and belongs on the volume**, addressed like a baked world: import and
   export as an archive, publish to the bucket. 4.1 GB of `out/` is not a git problem to solve.
4. **One API.** `tools/assetsvc`'s, because the editor and the chart already speak it. assetlib's
   `/api/assets` becomes a view over the same catalog.

Until this is done the Assets panel is showing whichever service it was pointed at, and today that
was a scratch directory with one test car in it.

---

## Order of work

1. **Fold assetlib in.** Nothing else is safe while the content lives outside the repo.
2. **Presets** — stage 2, the smallest complete vertical slice, and the one that proves the
   three-layer resolve.
3. **The sandbox preview**, once presets have something to preview.
4. **ECS config and binding** — stages 4 and 5.
5. **The program layer** — stage 6, the API surface first and the sandboxing decision with it.
6. **The agent as a client** of all of the above.

Steps 2 and 3 are worth doing before 4–6 because they are the shortest path to *seeing* a change,
and every later stage is judged by looking at it.

---

## Feeding the asset queue

> We need to be able to import a big list of objects to build with prompts and all that,
> optionally base64 images, and the agent should be able to do prompt expansion based on a user's
> request to build out assets and make this file to feed to the asset generator queue.

The queue's input is a document like everything else, so a human writes it, an agent writes it, or
the editor's form writes one row of it:

```jsonc
{ "kind": "corridor-assetlist", "version": 1,
  "defaults": { "class": "street-furniture", "chroma": "magenta" },
  "assets": [
    { "id": "roadside-mailbox", "subject": "US roadside mailbox on a wooden post" },
    { "id": "rx7-fd", "subject": "compact 1990s Japanese rotary sports coupe",
      "prompt": "...", "negative": "...",
      "reference": "data:image/png;base64,..." }     // optional, for "like this"
  ] }
```

`defaults` merged over each entry is the shape the existing roster files already use — worth
saying because guessing it wrong once found 0 of 120 entries silently.

**Prompt expansion is the agent's job, and its output is this file.** A person says "I need the
street furniture for a 1990s American suburb" and the agent produces sixty entries with full
prompts and negatives, which a person can then read, edit and cut before anything is generated.
That ordering matters: the expensive step is generation, so the reviewable artefact has to come
before it, not after.

Two traps already paid for, recorded so the next writer does not re-find them:

- Prohibitions belong in `negative_prompt` **as nouns**, not as "no X" in the prompt.
- `buildPrompt` returns an object with its own `length` field, so `rec.prompt.length` reads like
  a string length and is not.

---

## Modes of transport: a library of controllers

> Definitely need a first person and third person character mode. The driving (first person)
> already feels very GTA5-ish with late 80s/early 90s stunt simulator physics which I am a big fan
> of. I'd like a more focused driving simulator mode but that comes later. Also basic
> helic/omnic/ornith-opter and jet and plane and UFO flying dynamics too, so we have a library of
> interaction types.

This is stage 6's "alter modes of transport", and it is the concrete form of it: **a controller is
a named implementation a level selects**, not a branch inside the camera code.

| Controller | State | Note |
|---|---|---|
| `drive` | *exists* | keep the arcade feel — it is the one he likes |
| `drive-sim` | later | a focused simulator; a second controller, not a knob on the first |
| `fly` (free camera) | *exists* | authoring tool today, could be a mode |
| `walk` | *exists*, thin | first person on foot, already used by the kids' games |
| `walk-third` | **needed** | third person character — needs a rigged character and a follow camera |
| `helicopter` / `omnicopter` / `ornithopter` | **needed** | collective + cyclic; the ornithopter is flap-driven lift |
| `plane` / `jet` | **needed** | lift from airspeed; the jet differs in thrust and authority, not in kind |
| `ufo` | **needed** | no aerodynamics at all — direct velocity control, which makes it the easiest |

They share one interface — sample input, integrate, produce a transform and a camera pose — so
the level says `transport: 'helicopter'` and nothing else changes. The engine audio already works
this way: whatever holds an `Engine` component gets voiced, and the spatial layer does not know
what is carrying it.

`walk-third` is the one with a dependency outside this list: it needs a rigged character, which is
what the Blender-in-the-image work is for.

---

## Decisions taken

Asked and answered, 2026-09-28:

1. **Presets: a named library**, holding snapshots, with a scripted tween API between them and an
   inferred ground state to return to on reinitialization.
2. **"Sandbox" means a prototype slice** of a big map — half a mile along the inferred spine,
   baked first so there is somewhere to tune while the full bake runs. Not a code sandbox:
   *"users will be at the peril of the author"*, so a program runs unsandboxed.
3. **assetlib: migrate and retire.** One catalog, one API, in this repo.
4. **The 4.1 GB**: symlinked for local development; everything gets re-baked once this runs
   properly in the cluster, and the old output is deleted then. Not a problem to design around.
5. **Publishing is a bundle**, not a button per object.

## Still open

- Where a release's closure is resolved — client-side from the documents, or a server endpoint
  that returns the manifest. Leaning server: it already knows what is baked.
- Whether `walk-third` waits for real rigged characters or ships with a capsule first. Shipping a
  capsule gets the camera and the controller right early, and they are the harder half.
