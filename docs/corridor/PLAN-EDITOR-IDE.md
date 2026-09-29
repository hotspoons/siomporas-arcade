# The editor: a web IDE over the ECS, the assets, the map — and now physics

**Status:** brief, 2026-09-28. The physics engine it plans against is **built and tested**
(`packages/engine/src/physics/`, 117 headless assertions); the corridor wiring is not.
**Audience:** the agent working on the corridor editor.
**Companion:** [`PLAN-PHYSICS.md`](PLAN-PHYSICS.md) — the same subject from the engine's side, and
the place to read *why* the physics API looks the way it does before wrapping it in UI.

---

## The ask

> There is an agent working on the editor — we'll want to expose APIs and presets and of course let
> you define your own physics for individual games, write up a plan for the editor that includes a
> web IDE on top of an ECS API and asset generator and world and map builder so we can apply physics
> to things.

Four things, and **three of them already exist**. That is the single most important fact in this
document: this is not a new editor. Monaco is in, with real generated types. The ECS config is real.
The map builder saves worlds and bakes them as Jobs. The catalog and the asset service are real. What
is missing is that none of them has anything to say about mass, or grip, or what happens when you
hit it.

So this plan is mostly **five new seams through existing surfaces**, and one genuinely new thing.

---

## 0. What exists, so nothing gets built twice

| the ask | what is already there |
|---|---|
| **web IDE** | `src/ui/codeeditor.ts` (Monaco, lazy, real TS diagnostics), `src/generated/program-types.json` emitted by `scripts/gen-program-types.mjs` with a test that fails when stale, `src/ui/programpanel.ts`, `src/ui/filetree.ts` + `files.ts`, `src/ui/shellpanel.ts` (browser shell), `src/ui/agentpanel.ts` |
| **ECS API** | `src/actors.ts` (components, relations, named sets), `src/actorworld.ts` (fixed-step world, systems, spawn helpers), `src/ecsconfig.ts` (archetypes, populations, brushes, bindings, a validator that reports *every* problem rather than the first) |
| **asset generator** | `src/assetsvc.ts`, `public/assets/catalog.json`, `src/ui/assets.ts`, `src/ui/meshview.ts`, `ext/assetlib` |
| **world and map builder** | `src/worldedit/` — draw a world on a map, bake it as a Job, publish it; `src/editor/` — areas, place, grow/autogen, structures |
| **presets** | `src/presets.ts` — the three-layer resolve (world ← level ← live tuning) with tweening, no THREE, no DOM, testable headlessly |
| **program layer** | `src/program.ts` — `GameApi`, zones, facts, scoring, the run loop, and nothing thrown by a program escapes it |

Read `PLAN-GAME-PIPELINE.md` for the seven stages these sit in. Physics is not an eighth stage. It
threads through stages 3, 4, 5 and 6.

---

## 1. The engine API you are wrapping

Import from `@apex/engine/physics/*`. Nothing outside `packages/engine/src/physics/` may import
`@dimforge/rapier3d-compat` — two copies of the wasm in one bundle is two heaps and handles from one
that are garbage in the other.

```ts
import { loadRapier }             from '@apex/engine/physics/rapier'
import { PhysicsWorld, Impact }   from '@apex/engine/physics/world'
import { Vehicle, VehicleSpec }   from '@apex/engine/physics/vehicle'
import { PROFILES, profile, blendProfiles, DriveProfile } from '@apex/engine/physics/profiles'
import { Terrain, addStatic, addTree } from '@apex/engine/physics/terrain'
import { Breakables, Debris, explode } from '@apex/engine/physics/destruction'
import { Deformable, DeformableBody }  from '@apex/engine/physics/deform'
import { Ragdoll }                from '@apex/engine/physics/ragdoll'
import { LAYER, QUERY }           from '@apex/engine/physics/layers'
```

The five profiles are `stunts`, `taxi`, `street`, `rush`, `sim`. `DriveProfile` is a **flat record of
numbers** on purpose: the tuning panel, the preset library, the level document and a form can all
walk it without a schema written three times. `profile(id, overrides)` is how a level says
`"street", but grippier` without carrying a copy of forty numbers that stops tracking the base.

`blendProfiles(a, b, t)` exists for the editor specifically — let somebody see what lives *between*
Rush and the simulator instead of making them pick a side.

---

## 2. Seam one: physics in the catalog (stage 5, binding)

**A model is not a collider, and guessing is worse than asking.**

Each entry in `public/assets/catalog.json` gains an optional `physics` block:

```json
{
  "id": "stop-sign-01",
  "category": "furniture",
  "physics": {
    "shape": "box",              // box | cylinder | capsule | ball | hull
    "size": [0.08, 1.5, 0.4],    // half-extents, or [radius, halfHeight]
    "offset": [0, 1.5, 0],       // collider centre relative to the asset's origin
    "layer": "prop",             // see LAYER in layers.ts
    "mass": 14,                  // kg, once it is loose
    "breakable": { "threshold": 3000, "transfer": 0.35 }
  }
}
```

Three ways it gets filled in, in this order of preference:

1. **Measured from the GLB.** A bounding box is right for a sign, a bollard, a wall. The asset
   service should emit `shape: "box"` and the real half-extents at import, so *every* asset has a
   collider on day one and nothing silently has none. A missing `physics` block must be a **visible
   warning in the asset panel**, not a quiet absence — an asset with no collider is a thing you
   drive through, and the failure appears in play, not in the editor.
2. **Chosen in the editor.** A `Physics` section in `src/ui/assets.ts` beside the existing preview:
   shape picker, size fields, mass, layer, breakable toggle and threshold, with the collider drawn
   as a wireframe over the model in `meshview.ts`. This is the highest-value single panel in this
   whole plan, because it is the one that stops the game being full of scenery you pass through.
3. **Generated.** `ColliderDesc.convexHull` / `convexDecomposition` from the mesh, for the handful
   of assets a box genuinely lies about. Offer it as a button ("fit a hull"), show the triangle
   count, and let somebody say no.

**Mass and threshold need defaults per category, not per asset**, or nobody will ever fill them in:
furniture 15 kg / 3 kN·s, bollard 60 / 12 kN·s, tree — no entry at all, because a mature trunk
should end your run. Put the table in one place and say it is a table.

---

## 3. Seam two: physics in the ECS config (stage 4)

`src/ecsconfig.ts` has `COMPONENTS`, and the comment above it is the contract: *a table, not a
switch, so the list an archetype is validated against and the list that is actually applied cannot
drift apart*. Physics joins that table.

Add a `Physical` component in `actors.ts`:

```ts
/** Has a body in the physics world. `handle` is Rapier's; 0 means "not built yet". */
export const Physical = { handle: u32(), shape: u8(), mass: f32(), layer: u8(), mode: u8() }
```

`mode` is the interesting field and it is the one that decides whether a busy road is affordable:

| mode | meaning |
|---|---|
| `0` none | no body. Scenery, distant traffic, anything outside the physics radius |
| `1` kinematic | a collider that things bounce off, moved by the ECS. **This is what traffic is** |
| `2` dynamic | a real rigid body. Wreckage, debris, thrown things |
| `3` vehicle | a `Vehicle` with a `DriveProfile`. The player, and anything chasing them |

**Traffic is kinematic until it is hit.** A hundred IDM cars as dynamic bodies is a hundred vehicle
controllers and four hundred wheel rays, and it is not even desirable — a car following a lane model
should follow it, not fight a suspension. The transition to `dynamic` at the moment of a hard impact
is a `setBodyType` in place: same entity, same collider, same handle. `Breakables` already does
exactly this move for a sign; a car is the same thing with more mass.

Then the config grows one optional block per archetype:

```json
{
  "archetypes": {
    "commuter": {
      "components": ["Vehicle", "Autonomous", "Engine", "Physical"],
      "asset": "sedan-generic",
      "physics": { "mode": "kinematic", "mass": 1500, "wakeAt": 6000 }
    },
    "hostile-driver": {
      "components": ["Vehicle", "Hostile", "Physical"],
      "physics": { "mode": "vehicle", "profile": "street", "overrides": { "gripRear": 1.1 } }
    }
  }
}
```

`validateEcs` extends the same way it already validates components and assets: report **every**
problem, never the first. New errors worth having — an unknown profile id, a `mode: "vehicle"`
archetype with no `Vehicle` component, a mass of zero, an asset whose catalog entry has no `physics`
block. That last one is the warning that stops a level shipping full of ghosts.

---

## 4. Seam three: physics in `GameApi` (stage 6)

This is where "let you define your own physics for individual games" actually lands. `GameApi` gets
one new namespace. Keep it small — the API surface is the product, it is what an agent is prompted
against, and it has to stay still while everything under it moves.

```ts
readonly physics: {
  /** the player's handling, live. A power-up, a damage model, a difficulty setting */
  profile(id: string, overrides?: Partial<DriveProfile>): void
  /** blend toward another profile over `seconds` — the car gets looser as it takes damage */
  blend(id: string, t: number, opts?: { over?: number }): void

  /** a bomb. `at` in site metres; the rest is the engine's Blast */
  explode(at: Vec3, opts: { radius: number; impulse: number; lift?: number; lineOfSight?: boolean; breakAt?: number }): number
  /** a missile: a projectile body that detonates on contact or after `fuse` seconds */
  missile(from: Vec3, dir: Vec3, opts: { speed: number; fuse?: number; radius: number; impulse: number }): number

  /** shove one entity */
  impulse(entity: number, v: Vec3): void
  /** break a named breakable, or everything in a zone */
  break(what: number | string): number

  /** what is solid along this ray. The primitive a "new exploration technique" needs */
  ray(from: Vec3, dir: Vec3, maxDistance: number): { entity: number; point: Vec3; normal: Vec3 } | null

  /** the player's car, read-only: speed, slide, slip, wheelslip, grounded, airborne, damage */
  car(): Readonly<VehicleState> | null

  /** something was hit hard enough to matter */
  onImpact(fn: (e: { a: number; b: number; point: Vec3; impulse: number }) => void): void
}
```

Four rules for it, each of which is a bug avoided:

- **Entities, not handles.** A program speaks the ECS's vocabulary. Rapier handles are an
  implementation detail and they are recycled.
- **Site metres in, site metres out.** The physics world runs in the THREE frame (x east, y **up**,
  z south); the simulation is in site metres (x east, y **north**, z up). The conversion happens
  once, at this boundary, exactly as it already does for `Transform`. A second convention inside a
  program is how something ends up mirrored across a road.
- **Nothing throws.** A program is code from a person or an agent. `api.physics.explode` with a
  radius of `NaN` must be one message and a stopped program, not a dead frame loop.
- **It must be steppable headlessly.** `program.ts` holds no THREE, no DOM and no fetch so a whole
  game can be stepped in a test. Physics arrives through `ProgramHost`, like everything else, and a
  test fakes it.

Then: **add `physics.ts`, `profiles.ts` and `vehicle.ts` to `ROOTS` in
`scripts/gen-program-types.mjs`**, so Monaco completes `api.physics.` and hovers the doc comments.
The test that fails when the bundle is stale already exists; it will cover the new roots for free.

---

## 5. Seam four: the tuning panel and presets

A `physics` tab in `src/tuning.ts`, **generated by walking `DriveProfile`'s keys**, not hand-written.
Forty knobs typed out by hand is forty chances to name one wrong, and the profile type is flat
precisely so this is a loop.

Scope matters and it is not decoration:

- **`world`**: everything in the profile. A level may say "in this game cars handle like this", and
  the tuning panel sits on top of it — which is the resolve `presets.ts` already implements, not a
  special case.
- **`machine`**: `PHYS_HZ`, `PHYS_RADIUS`, `PHYS_MAX_BODIES`, `PHYS_DEBRIS_BUDGET`. A preset that
  pins these is a level that says "your laptop must be this fast", which is the exact failure
  `TuneScope` was invented to prevent.

`lerp` matters too: most physics knobs are `linear`, but `drive` (`rwd`/`fwd`/`awd`) is `step` — it
cannot be interpolated, and naming that here is what lets the editor say so while somebody is
authoring a cutscene rather than have it discovered in one.

---

## 6. Seam five: the map and world builder

Two additions, both small, both high value.

**A physics preview in `src/editor/preview.ts`.** The preview dialog already drives the site from the
driver's seat. Give it: a profile picker (five entries plus "blend"), a *drop a crate* button, a
*detonate here* button, and a collider wireframe overlay. The point is not the toys. The point is
that the moment somebody can see the colliders they will find the six props that have none, and
right now there is no way to look.

**Physics-aware placement.** When an asset with a `physics` block is placed, draw its collider; warn
when two colliders interpenetrate; warn when a breakable is placed inside a building shell. The
editor already knows how to draw a footprint at real scale — this is the same code with a different
box.

---

## 7. The genuinely new thing: a verify loop

> Would be great to have a tool kit to test types and verify everything builds and all that too.
> — Rich, on the Monaco work

Types are done. What is missing is **running the thing**. Physics makes this sharply more valuable,
because "does this level work" stops being a matter of taste the moment there is a car that can end
up on its roof.

Propose: a **Verify** button in the program panel that runs the level headlessly in a worker —
`ActorWorld` + `PhysicsWorld` + `GameRun`, no renderer, which is exactly what all three were built
to allow — for N simulated seconds, and reports:

- did `setup` run without throwing;
- did the win condition *ever* become reachable (step it, check it fired);
- how many entities spawned, against what the populations asked for;
- did anything fall through the world (a body below the site's minimum ground height);
- did the physics step blow its budget (`phys.stats.stepMs`, `stats.dropped`);
- how many assets resolved to no collider.

That is a compile step for a *level*, and it is the difference between the agent loop Rich described
("let the agent go to town in a loop") converging and thrashing. An agent that can only look at
screenshots cannot tell whether it made the level better.

---

## 8. Order, and what to do first

1. **The catalog's `physics` block, and the asset panel section that edits it.** Everything else
   depends on assets having colliders, and this is the one panel that makes the absence visible.
2. **`Physical` in `actors.ts` + `COMPONENTS` + `validateEcs`.** No renderer work; testable at once.
3. **`api.physics` in `program.ts`, plus the new type roots.** Small, and it unblocks anyone writing
   a game.
4. **The generated `physics` tuning tab.**
5. **The preview's collider overlay and profile picker.** The first thing Rich will actually use.
6. **Verify.**

Items 1–4 are all in files the editor owns. Item 5 touches `preview.ts`, also the editor's. **The
main agent owns `src/physics.ts`, `car.ts`, `scene.ts` and the renderer-side instance swap for
broken props** — the two lanes meet at exactly two places: the catalog's `physics` schema, and the
`api.physics` surface. Agree both in writing before either side builds against them; everything else
can proceed in parallel.

`/workspaces/apex-conduit` is a shared tree. Name paths when you stage; never `git add -A`.

---

## 9. Things worth knowing before you start

- `edgeDistance` returns a **number**; `edgeInfo` returns the record. Reading `.d` off the number
  silently reports zero problems.
- A CSS `display` rule beats `[hidden]`; assert rendered height, not the attribute.
- `addUpdateRange` makes an upload **partial**, and never mix a ranged write with a full rewrite —
  which is the whole difficulty in pulling a broken sign out of its `InstancedMesh`.
- `tune.set` followed by a manual render measures the **old** uniform; await two rAFs.
- The seven silent Rapier traps are in `packages/engine/src/physics/README.md`. Read them before
  debugging anything that "just does nothing".
